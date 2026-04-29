// Design Ref: §4.5 — 소스 통합 + 중복 제거 + 카테고리 매핑
const fs = require("fs");

function normalizeForDedup(line) {
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

function loadJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(`[merger] JSON 로드 실패: ${filePath} — ${err.message}`);
    return [];
  }
}

// reportFilter.excludeNotionTitlePatterns로 사소한/개인용 항목 제거
function filterByReportRules(items, reportFilter) {
  if (!reportFilter) return items;
  const patterns = reportFilter.excludeNotionTitlePatterns || [];
  if (!patterns.length) return items;
  const kept = [];
  const dropped = [];
  for (const item of items) {
    const title = (item.title || "") + " " + (item.summary || "");
    const match = patterns.find((re) => re.test(title));
    if (match) {
      dropped.push(item.title);
    } else {
      kept.push(item);
    }
  }
  if (dropped.length) {
    console.log(`[merger] reportFilter dropped ${dropped.length} Notion items`);
  }
  return kept;
}

// 카테고리별 최대 N개로 제한 (최신 날짜 우선)
// etc는 다수의 독립 프로젝트가 혼재하므로 cap 미적용 (AI 프롬프트에 위임)
function capPerCategory(items, cap) {
  if (!cap || cap <= 0) return items;
  const byCat = new Map();
  for (const item of items) {
    const cat = item.category || "etc";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(item);
  }
  const result = [];
  for (const [cat, list] of byCat) {
    if (cat === "etc") {
      // etc는 AI가 프로젝트별로 판단 (maxItemsPerEtcProject 가이드)
      result.push(...list);
      continue;
    }
    list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const capped = list.slice(0, cap);
    if (capped.length < list.length) {
      console.log(`[merger] cat=${cat}: ${list.length}→${capped.length} (cap ${cap})`);
    }
    result.push(...capped);
  }
  return result;
}

// 날짜 범위 필터 — 캐시 파일에 stale 데이터가 남아도 보고 범위 밖 항목은 차단
// dateRange: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" } 또는 null
function filterByDateRange(items, dateRange) {
  if (!dateRange || !dateRange.start || !dateRange.end) return items;
  const kept = [];
  let dropped = 0;
  for (const item of items) {
    const d = item.date;
    // date 없는 항목은 안전하게 통과 (정보 손실 방지)
    if (!d) {
      kept.push(item);
      continue;
    }
    if (d >= dateRange.start && d <= dateRange.end) {
      kept.push(item);
    } else {
      dropped += 1;
    }
  }
  if (dropped) {
    console.log(`[merger] dateRange filter dropped ${dropped} items (out of ${dateRange.start}~${dateRange.end})`);
  }
  return kept;
}

// Plan SC: SC-04 — 기존 autoContent 형식 유지 (publisher.js 호환)
function mergeIntoAutoContent(gitResult, notionPath, sessionPath, config, dateRange) {
  let notionItems = loadJsonSafe(notionPath);
  let sessionItems = loadJsonSafe(sessionPath);

  // 1차 방어선: 날짜 범위 필터 (stale 캐시의 이전 주 항목 차단)
  notionItems = filterByDateRange(notionItems, dateRange);
  sessionItems = filterByDateRange(sessionItems, dateRange);

  // reportFilter 적용 (수집 단계에서 놓친 개인용/사소한 항목 차단)
  const reportFilter = config.reportFilter || {};
  notionItems = filterByReportRules(notionItems, reportFilter);
  sessionItems = filterByReportRules(sessionItems, reportFilter);

  // 카테고리당 최대 개수 제한 (팀 보고에 적절한 양 유지)
  notionItems = capPerCategory(notionItems, reportFilter.maxItemsPerSubcategory);

  if (!notionItems.length && !sessionItems.length) return gitResult;

  // gitResult의 기존 텍스트에서 중복 체크용 키워드 추출
  const gitKeywords = new Set();
  for (const text of Object.values(gitResult)) {
    for (const line of String(text).split("\n")) {
      const trimmed = line.replace(/^[\s\-*]+/, "").trim();
      if (trimmed) gitKeywords.add(normalizeForDedup(trimmed));
    }
  }

  // 카테고리 → templateKey 매핑
  const catToTemplate = {};
  for (const [catKey, catDef] of Object.entries(config.categories || {})) {
    if (catDef.templateKey) {
      catToTemplate[catKey] = `{{${catDef.templateKey}}}`;
    }
  }

  const result = { ...gitResult };
  const notionMapping = (config.sources && config.sources.notion && config.sources.notion.projectMapping) || {};

  // repo 이름/displayName 정규화 맵 (Notion 항목이 repo와 같은 프로젝트를 가리키면 displayName으로 통일)
  const repoNormalizer = [];
  for (const [repoName, repoDef] of Object.entries(config.repos || {})) {
    if (repoDef.displayName) {
      // repoName (예: cts-ta-mcp-server) 또는 displayName(예: HiWorks 근태 관리) 포함 시 displayName으로 치환
      repoNormalizer.push({
        pattern: new RegExp(`\\b${repoName.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i"),
        displayName: repoDef.displayName,
      });
    }
  }

  function normalizeProjectName(text) {
    if (!text) return text;
    for (const rule of repoNormalizer) {
      if (rule.pattern.test(text)) {
        return text.replace(rule.pattern, rule.displayName);
      }
    }
    return text;
  }

  function resolveCategory(item) {
    let category = item.category;
    if (!category || !catToTemplate[category]) {
      const text = (item.title || "") + " " + (item.summary || "");
      for (const [keyword, cat] of Object.entries(notionMapping)) {
        if (text.toLowerCase().includes(keyword.toLowerCase())) {
          category = cat;
          break;
        }
      }
    }
    return category || "etc";
  }

  function addItem(item, sourceTag) {
    const category = resolveCategory(item);
    const templateKey = catToTemplate[category];
    if (!templateKey) return;

    let lines = item.items;
    if (!lines || !Array.isArray(lines) || !lines.length) {
      const fallback = item.title || item.summary;
      lines = fallback ? [fallback] : [];
    }

    // repo 이름을 displayName으로 정규화 (동일 프로젝트 중복 표기 방지)
    lines = lines.map(normalizeProjectName);

    for (const line of lines) {
      const normalized = normalizeForDedup(line);
      if (gitKeywords.has(normalized)) continue;

      const existing = result[templateKey] || "";
      const indent = category === "etc"
        ? `  - ${sourceTag} ${line}`
        : `    - ${sourceTag} ${line}`;

      if (existing && existing !== `    - (변경 없음)` && existing !== `  - (변경 없음)`) {
        result[templateKey] = existing + "\n" + indent;
      } else {
        result[templateKey] = indent;
      }

      gitKeywords.add(normalized);
    }
  }

  // 1단계: Notion 항목 추가
  for (const item of notionItems) {
    addItem(item, "[Notion]");
  }

  // 2단계: 세션 항목 — git/Notion이 커버하지 못한 카테고리만 보충
  const coveredCategories = new Set();
  for (const [templateKey, text] of Object.entries(result)) {
    if (text && text !== `    - (변경 없음)` && text !== `  - (변경 없음)`) {
      coveredCategories.add(templateKey);
    }
  }

  for (const item of sessionItems) {
    const category = resolveCategory(item);
    const templateKey = catToTemplate[category];
    if (!templateKey) continue;

    if (coveredCategories.has(templateKey)) continue;
    addItem(item, "[CC]");
  }

  return result;
}

module.exports = { mergeIntoAutoContent };
