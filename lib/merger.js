// Design Ref: §4.5 — 소스 통합 + 중복 제거 + 카테고리 매핑
const fs = require("fs");
const { hashObject } = require("./report-artifact");

function normalizeForDedup(line) {
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeProjectName(text, repos = {}) {
  if (!text) return text;
  for (const [name, repo] of Object.entries(repos)) {
    if (!repo.displayName) continue;
    const pattern = new RegExp(`\\b${name.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    if (pattern.test(text)) return text.replace(pattern, repo.displayName);
  }
  return text;
}

function notionBriefingLines(item, category) {
  if (!item || !item.briefing || typeof item.briefing !== "object") return [];
  const indent = category === "etc" ? "    " : "      ";
  const labels = { cause: "원인", fix: "수정", verification: "검증" };
  return Object.entries(labels).flatMap(([key, label]) => {
    const text = typeof item.briefing[key] === "string"
      ? item.briefing[key].replace(/\s+/g, " ").trim()
      : "";
    return text ? [`${indent}↳ ${label}: ${text}`] : [];
  });
}

function notionSummaryLines(item, category) {
  if (typeof item.summary !== "string" || !item.summary.trim()) return [];
  const indent = category === "etc" ? "    " : "      ";
  return item.summary.split(/\r?\n/).map(line => `${indent}↳ 출처 요약: ${line}`);
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
  const useTimestamp = String(dateRange.start).includes("T") || String(dateRange.end).includes("T");
  const startTime = useTimestamp ? new Date(dateRange.start).getTime() : null;
  const endTime = useTimestamp ? new Date(dateRange.end).getTime() : null;
  const kept = [];
  let dropped = 0;
  for (const item of items) {
    const d = item.date;
    if (useTimestamp && item.timestamp) {
      const timestamp = new Date(item.timestamp).getTime();
      if (!Number.isNaN(timestamp) && timestamp >= startTime && timestamp <= endTime) {
        kept.push(item);
      } else {
        dropped += 1;
      }
      continue;
    }
    // date 없는 항목은 안전하게 통과 (정보 손실 방지)
    if (!d) {
      kept.push(item);
      continue;
    }
    // timestamp가 없는 day-precision source는 UTC ISO의 날짜가 아니라 보고서 현지 날짜를 쓴다.
    const compareStart = dateRange.dayStart
      || (useTimestamp ? String(dateRange.start).slice(0, 10) : dateRange.start);
    const compareEnd = dateRange.dayEnd
      || (useTimestamp ? String(dateRange.end).slice(0, 10) : dateRange.end);
    if (d >= compareStart && d <= compareEnd) {
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
function mergeItemsIntoAutoContent(gitResult, notionInput, sessionInput, config, dateRange, summarySpans = []) {
  let notionItems = Array.isArray(notionInput) ? notionInput.slice() : [];
  let sessionItems = Array.isArray(sessionInput) ? sessionInput.slice() : [];

  // 1차 방어선: 날짜 범위 필터 (stale 캐시의 이전 주 항목 차단)
  notionItems = filterByDateRange(notionItems, dateRange);
  sessionItems = filterByDateRange(sessionItems, dateRange);

  // 발표노트 후보 수집용으로만 보존된 report=none/private KB 페이지는 보고 본문에서 제외한다.
  notionItems = notionItems.filter((item) => !item.reportExcluded);

  // reportFilter 적용 (수집 단계에서 놓친 개인용/사소한 항목 차단)
  const reportFilter = config.reportFilter || {};
  notionItems = filterByReportRules(notionItems, reportFilter);
  sessionItems = filterByReportRules(sessionItems, reportFilter);

  // 카테고리당 최대 개수 제한 (팀 보고에 적절한 양 유지)
  notionItems = capPerCategory(notionItems, reportFilter.maxItemsPerSubcategory);

  if (!notionItems.length && !sessionItems.length) return gitResult;

  // gitResult의 기존 텍스트에서 중복 체크용 키워드 추출
  const gitKeywords = new Set();
  const briefingKeywords = new Set();
  const summaryKeywords = new Set();
  for (const [templateKey, text] of Object.entries(gitResult)) {
    let parentTitle = "";
    for (const line of String(text).split("\n")) {
      const trimmed = line.replace(/^[\s\-*]+/, "").trim();
      if (!trimmed) continue;
      const normalized = normalizeForDedup(trimmed);
      gitKeywords.add(normalized);
      if (trimmed.startsWith("↳ ")) {
        briefingKeywords.add(JSON.stringify([templateKey, parentTitle, normalized]));
      } else {
        parentTitle = normalized;
      }
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

  const normalizeName = text => normalizeProjectName(text, config.repos);

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
    lines = lines.map(normalizeName);

    // 같은 문장도 다른 항목의 근거이면 각각 보존한다.
    const briefingTitle = normalizeForDedup(normalizeName(item.title) || lines[0] || "");
    let briefingAdded = false;
    for (const [itemLineIndex, line] of lines.entries()) {
      const normalized = normalizeForDedup(line);
      const briefing = sourceTag === "[Notion]" && !briefingAdded
        ? notionBriefingLines(item, category)
          .filter((detail) => !briefingKeywords.has(
            JSON.stringify([templateKey, briefingTitle, normalizeForDedup(detail)])
          ))
        : [];
      const summary = sourceTag === "[Notion]" && !briefingAdded
        ? notionSummaryLines(item, category) : [];
      // Keep a summary whole: a shared clause must not strip the result or
      // limitation from another summary attached to this same title.
      const summaryKey = JSON.stringify([templateKey, briefingTitle, summary]);
      const summaryOffset = briefing.length;
      let summaryAdded = false;
      if (summary.length && !summaryKeywords.has(summaryKey)) {
        briefing.push(...summary);
        summaryKeywords.add(summaryKey);
        summaryAdded = true;
      }
      if (gitKeywords.has(normalized) && !briefing.length) continue;

      const existing = result[templateKey] || "";
      const indent = category === "etc"
        ? `  - ${sourceTag} ${line}`
        : `    - ${sourceTag} ${line}`;
      const rendered = [indent, ...briefing].join("\n");
      const append = existing && existing !== `    - (변경 없음)` && existing !== `  - (변경 없음)`;
      if (append) {
        result[templateKey] = existing + "\n" + rendered;
      } else {
        result[templateKey] = rendered;
      }
      if (summaryAdded) {
        const parentLine = append ? existing.split("\n").length + 1 : 1;
        const parentLines = indent.split("\n");
        summarySpans.push({ kind: "notion_summary", templateKey,
          sourceIndex: notionInput.indexOf(item), sourceHash: hashObject(item),
          itemLineIndex,
          parentLine, parentText: parentLines[0],
          startLine: parentLine + parentLines.length + summaryOffset,
          endLine: parentLine + parentLines.length + summaryOffset + summary.length - 1,
        });
      }

      briefingAdded = briefingAdded || briefing.length > 0;
      gitKeywords.add(normalized);
      for (const detail of briefing) {
        briefingKeywords.add(JSON.stringify([templateKey, briefingTitle, normalizeForDedup(detail)]));
      }
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

function mergeIntoAutoContent(gitResult, notionPath, sessionPath, config, dateRange) {
  return mergeItemsIntoAutoContent(
    gitResult,
    loadJsonSafe(notionPath),
    loadJsonSafe(sessionPath),
    config,
    dateRange
  );
}

module.exports = { filterByDateRange, mergeIntoAutoContent, mergeItemsIntoAutoContent, normalizeProjectName };
