// Notion REST API를 직접 호출하여 주간 활동 항목을 수집한다.
// DB는 database query (정확한 날짜 필터), 나머지는 search API 사용.
const fs = require("fs");
const path = require("path");

const NOTION_VERSION = "2022-06-28";

// --- DB 정의 ---
const DATABASES = {
  projects: {
    id: "4430fcd4-bfba-4a46-9a1b-4520db86e883",
    dateProperty: "created_at",   // created_time 타입
    dateFilterType: "created_time",
    titleProp: "title",
  },
  decisionLog: {
    id: "6c9fbc24-c5fb-4ca9-aa61-781cacc7ecfd",
    dateProperty: "date",         // date 타입
    dateFilterType: "date",
    titleProp: "title",
  },
  aiPreferences: {
    id: "4e5ba7f0-b9cc-4171-84a7-f4e430abaf57",
    dateProperty: "created_at",   // created_time 타입
    dateFilterType: "created_time",
    titleProp: "title",
  },
  knowledgeBase: {
    id: "ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461",
    dateProperty: "created_at",   // created_time 타입
    dateFilterType: "created_time",
    titleProp: "title",
  },
  references: {
    id: "979a9412-73d9-4fa4-be0e-cbcafc0a2505",
    dateProperty: "created_at",   // created_time 타입
    dateFilterType: "created_time",
    titleProp: "title",
  },
};

// --- 공통 유틸 ---

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function extractTitle(page) {
  const props = page.properties || {};
  for (const prop of Object.values(props)) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text || "").join("");
    }
  }
  return "";
}

function extractRichText(page, propName) {
  const prop = (page.properties || {})[propName];
  if (!prop) return "";
  if (prop.type === "rich_text" && Array.isArray(prop.rich_text)) {
    return prop.rich_text.map((t) => t.plain_text || "").join("");
  }
  return "";
}

function extractSelect(page, propName) {
  const prop = (page.properties || {})[propName];
  if (!prop || prop.type !== "select" || !prop.select) return "";
  return prop.select.name || "";
}

// P0-1 정합성 fix: jhw-notion이 project를 relation으로 통일.
// Notion API의 relation 타입은 prop.relation = [{ id }, ...]로 반환된다.
function extractRelationIds(page, propName) {
  const prop = (page.properties || {})[propName];
  if (!prop || prop.type !== "relation") return [];
  return (prop.relation || []).map((r) => r.id).filter(Boolean);
}

// projects DB 전체를 한 번 조회해 ID → title 맵을 빌드.
// decisionLog/KB/References의 project relation을 카테고리 매핑용 텍스트로 변환할 때 사용.
// 비용: 페이지당 1회 (대부분 1~2 page_size). cursor 페이지네이션으로 누락 방지.
async function fetchAllProjectsTitleMap(apiKey) {
  const map = new Map();
  let cursor;
  do {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${DATABASES.projects.id}/query`,
      {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
      }
    );
    if (!res.ok) {
      console.warn(`[notion-api] projects title map query failed (${res.status})`);
      break;
    }
    const data = await res.json();
    for (const p of data.results || []) {
      const t = extractTitle(p);
      if (t) map.set(p.id, t);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return map;
}

// project 필드를 relation 우선, rich_text fallback으로 텍스트화.
// 신규 페이지(P0-1 이후)는 relation, legacy 페이지는 rich_text를 가질 수 있다.
function resolveProjectText(page, projectsTitleMap) {
  const ids = extractRelationIds(page, "project");
  if (ids.length > 0) {
    return ids
      .map((id) => projectsTitleMap.get(id) || "")
      .filter(Boolean)
      .join(" ");
  }
  return extractRichText(page, "project");
}

function mapCategory(title, projectMapping) {
  const lower = title.toLowerCase();
  for (const [keyword, category] of Object.entries(projectMapping)) {
    if (lower.includes(keyword.toLowerCase())) {
      return category;
    }
  }
  return null;
}

// P2-A: 'report' select → category 매핑 default. config(sources.notion.reportCategoryMapping) 우선.
// jhw-notion REPORT_VALUES (kebab-case)와 동기화 필요 — docs/03-analysis/jhw-notion-integration.md 참조.
const DEFAULT_REPORT_SELECT_TO_CATEGORY = {
  "pim-app": "pimApp",
  "pim-driver-cam": "pimDriverCam",
  "pim-driver-spi": "pimDriverSpiToUart",
  "pim-test": "pimTest",
  "wlan-bsp": "wlanBsp",
  "wlan-app": "wlanApp",
  "wlan-driver": "wlanDriver",
  "wlan-test": "wlanTest",
  "etc": "etc",
};

// P2-A: skip 값 default. config(sources.notion.reportSkipValues) 우선.
// 'none'/'private'/'note' 등이 들어오면 보고서에서 제외.
const DEFAULT_REPORT_SKIP_VALUES = ["none", "private", "note", "no-report", "skip"];

// 반환: { skip: true } | { category: 'wlanBsp' } | null (필드 없음/알 수 없음)
function extractReportField(page, mapping, skipSet) {
  const prop = page.properties?.report;
  if (!prop || prop.type !== "select" || !prop.select) return null;
  const name = (prop.select.name || "").trim().toLowerCase();
  if (!name) return null;
  const skips = skipSet || new Set(DEFAULT_REPORT_SKIP_VALUES);
  if (skips.has(name)) return { skip: true };
  const map = mapping || DEFAULT_REPORT_SELECT_TO_CATEGORY;
  const cat = map[name];
  if (cat) return { category: cat };
  return null;  // 알 수 없는 옵션 → fallback (keyword 매칭)
}

// P1: 메타/구조 페이지 필터 default — config(sources.notion.excludePatterns) 미설정 시 fallback.
const DEFAULT_EXCLUDE_PATTERNS = [
  /^(AI Workspace|Knowledge Base|Projects|References|Decision Log|내 작업)$/i,
  /^(Claude Code|oh-my-claudecode|bkit|compound-engineering|superpowers|비-플러그인|claude-code-settings)/i,
  /^(독립 작업|롤백 가능|응답 끝에|Notion 저장|폐기|Notion Workflow)/i,
  /^(figma|linear|playwright|episodic-memory|codex|coderabbit)/i,
];

// P1: search 키워드 default — config(sources.notion.searchKeywords) 미설정 시 fallback.
const DEFAULT_SEARCH_KEYWORDS = [
  "iMX93", "wlan", "pim", "pcap", "sc16is7xx",
  "redmine", "email", "jhw-notion", "automation",
];

function isExcluded(title, patterns) {
  return (patterns || DEFAULT_EXCLUDE_PATTERNS).some((p) => p.test(title));
}

// config에서 받은 string[] 정규식을 RegExp[]로 컴파일. 빈 배열이면 default 사용.
function compileExcludePatterns(rawPatterns) {
  if (!Array.isArray(rawPatterns) || rawPatterns.length === 0) {
    return DEFAULT_EXCLUDE_PATTERNS;
  }
  return rawPatterns.map((s) => new RegExp(s, "i"));
}

// --- DB Query ---

async function queryDatabase(apiKey, dbDef, startDate, endDate) {
  let filter;

  if (dbDef.dateFilterType === "created_time") {
    filter = {
      and: [
        { timestamp: "created_time", created_time: { on_or_after: startDate } },
        { timestamp: "created_time", created_time: { on_or_before: endDate } },
      ],
    };
  } else {
    // date 타입 프로퍼티
    filter = {
      and: [
        { property: dbDef.dateProperty, date: { on_or_after: startDate } },
        { property: dbDef.dateProperty, date: { on_or_before: endDate } },
      ],
    };
  }

  const res = await fetch(
    `https://api.notion.com/v1/databases/${dbDef.id}/query`,
    {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ filter, page_size: 100 }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.warn(`[notion-api] DB query failed (${res.status}): ${text}`);
    return [];
  }

  const data = await res.json();
  return data.results || [];
}

// --- Search API (Knowledge Base 등 non-DB 페이지용) ---

async function searchPages(apiKey, startDate, endDate, keywords) {
  const queries = (Array.isArray(keywords) && keywords.length)
    ? keywords
    : DEFAULT_SEARCH_KEYWORDS;

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const allPages = new Map();

  for (const query of queries) {
    try {
      const res = await fetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify({
          query,
          filter: { property: "object", value: "page" },
          page_size: 50,
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const page of data.results || []) {
        // DB 소속 페이지는 제외 (이미 DB query로 수집)
        if (page.parent?.type === "database_id") continue;
        const created = new Date(page.created_time);
        if (created >= start && created <= end && !allPages.has(page.id)) {
          allPages.set(page.id, page);
        }
      }
    } catch (err) {
      console.warn(`[notion-api] Search "${query}" failed: ${err.message}`);
    }
  }

  return Array.from(allPages.values());
}

// --- 메인 수집 ---

async function collectNotionItems(config, startDate, endDate) {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    console.warn("[notion-api] NOTION_API_KEY not set, skipping");
    return [];
  }

  const notionCfg = config.sources && config.sources.notion;
  if (!notionCfg || !notionCfg.enabled) {
    console.warn("[notion-api] Notion source disabled, skipping");
    return [];
  }

  const projectMapping = notionCfg.projectMapping || {};
  const items = [];

  // P1: config 외부화 — repo-config.json의 sources.notion.{searchKeywords,excludePatterns} 우선,
  // 미설정이면 DEFAULT_* 사용.
  const excludePatterns = compileExcludePatterns(notionCfg.excludePatterns);
  const searchKeywords = (Array.isArray(notionCfg.searchKeywords) && notionCfg.searchKeywords.length)
    ? notionCfg.searchKeywords
    : DEFAULT_SEARCH_KEYWORDS;

  // P2-A: report category 매핑 + skip 값을 config에서 가져옴 (미설정 시 default).
  const reportMapping = (notionCfg.reportCategoryMapping && Object.keys(notionCfg.reportCategoryMapping).length)
    ? notionCfg.reportCategoryMapping
    : DEFAULT_REPORT_SELECT_TO_CATEGORY;
  const reportSkipSet = new Set(
    (Array.isArray(notionCfg.reportSkipValues) && notionCfg.reportSkipValues.length)
      ? notionCfg.reportSkipValues.map((v) => String(v).trim().toLowerCase())
      : DEFAULT_REPORT_SKIP_VALUES
  );

  // P0-1 정합성 fix: projects DB의 ID→title 맵을 미리 빌드해
  // 다른 DB의 project relation을 카테고리 매핑용 텍스트로 변환한다.
  console.log("[notion-api] Building projects title map for relation resolution...");
  const projectsTitleMap = await fetchAllProjectsTitleMap(apiKey);
  console.log(`[notion-api] Cached ${projectsTitleMap.size} project titles.`);

  // 1. DB Query: Projects
  console.log("[notion-api] Querying Projects DB...");
  const projectPages = await queryDatabase(apiKey, DATABASES.projects, startDate, endDate);
  let projectsSkipped = 0;
  for (const page of projectPages) {
    const title = extractTitle(page);
    if (!title || isExcluded(title, excludePatterns)) continue;
    const desc = extractRichText(page, "description");
    const reportField = extractReportField(page, reportMapping, reportSkipSet);
    if (reportField?.skip) { projectsSkipped++; continue; }
    const category = reportField?.category
      || mapCategory(title + " " + (desc || ""), projectMapping)
      || undefined;
    items.push({
      source: "notion",
      title,
      summary: desc || undefined,
      category,
      date: page.created_time?.slice(0, 10),
    });
  }
  console.log(`[notion-api] Projects: ${projectPages.length} pages, ${items.length} items` + (projectsSkipped ? ` (${projectsSkipped} report=none skipped)` : ""));

  // 2. DB Query: Decision Log
  console.log("[notion-api] Querying Decision Log DB...");
  const decisions = await queryDatabase(apiKey, DATABASES.decisionLog, startDate, endDate);
  const beforeCount = items.length;
  let decisionsSkipped = 0;
  for (const page of decisions) {
    const title = extractTitle(page);
    if (!title || isExcluded(title, excludePatterns)) continue;
    const project = resolveProjectText(page, projectsTitleMap);
    const rationale = extractRichText(page, "rationale");
    const reportField = extractReportField(page, reportMapping, reportSkipSet);
    if (reportField?.skip) { decisionsSkipped++; continue; }
    const category = reportField?.category
      || mapCategory(title + " " + project + " " + (rationale || ""), projectMapping)
      || undefined;
    items.push({
      source: "notion",
      title,
      summary: rationale || undefined,
      category,
      date: page.created_time?.slice(0, 10),
    });
  }
  console.log(`[notion-api] Decision Log: ${decisions.length} pages, ${items.length - beforeCount} items` + (decisionsSkipped ? ` (${decisionsSkipped} report=none skipped)` : ""));

  // 3. DB Query: Knowledge Base
  console.log("[notion-api] Querying Knowledge Base DB...");
  const kbPages = await queryDatabase(apiKey, DATABASES.knowledgeBase, startDate, endDate);
  const beforeKb = items.length;
  let kbSkipped = 0;
  for (const page of kbPages) {
    const title = extractTitle(page);
    if (!title || isExcluded(title, excludePatterns)) continue;
    const summary = extractRichText(page, "summary");
    const projectText = resolveProjectText(page, projectsTitleMap);
    const reportField = extractReportField(page, reportMapping, reportSkipSet);
    if (reportField?.skip) { kbSkipped++; continue; }
    const category = reportField?.category
      || mapCategory(title + " " + projectText + " " + (summary || ""), projectMapping)
      || undefined;
    items.push({
      source: "notion",
      title,
      summary: summary || undefined,
      category,
      date: page.created_time?.slice(0, 10),
    });
  }
  console.log(`[notion-api] Knowledge Base: ${kbPages.length} pages, ${items.length - beforeKb} items` + (kbSkipped ? ` (${kbSkipped} report=none skipped)` : ""));

  // 3-2. DB Query: References (BSP/U-Boot/M33 등 기술 참조 메모)
  console.log("[notion-api] Querying References DB...");
  const refPages = await queryDatabase(apiKey, DATABASES.references, startDate, endDate);
  const beforeRef = items.length;
  let refSkipped = 0;
  for (const page of refPages) {
    const title = extractTitle(page);
    if (!title || isExcluded(title, excludePatterns)) continue;
    const summary = extractRichText(page, "summary");
    const projectText = resolveProjectText(page, projectsTitleMap);
    const reportField = extractReportField(page, reportMapping, reportSkipSet);
    if (reportField?.skip) { refSkipped++; continue; }
    const category = reportField?.category
      || mapCategory(title + " " + projectText + " " + (summary || ""), projectMapping)
      || undefined;
    items.push({
      source: "notion",
      title,
      summary: summary || undefined,
      category,
      date: page.created_time?.slice(0, 10),
    });
  }
  console.log(`[notion-api] References: ${refPages.length} pages, ${items.length - beforeRef} items` + (refSkipped ? ` (${refSkipped} report=none skipped)` : ""));

  // 4. Search: 기타 non-DB 페이지
  console.log("[notion-api] Searching non-DB pages...");
  const searchPages_ = await searchPages(apiKey, startDate, endDate, searchKeywords);
  const beforeSearch = items.length;
  const seenTitles = new Set(items.map((i) => i.title.toLowerCase()));
  for (const page of searchPages_) {
    const title = extractTitle(page);
    if (!title || isExcluded(title, excludePatterns)) continue;
    if (seenTitles.has(title.toLowerCase())) continue;
    seenTitles.add(title.toLowerCase());
    items.push({
      source: "notion",
      title,
      category: mapCategory(title, projectMapping) || undefined,
      date: page.created_time?.slice(0, 10),
    });
  }
  console.log(`[notion-api] Search: ${searchPages_.length} pages, ${items.length - beforeSearch} new items`);

  console.log(`[notion-api] Total: ${items.length} items`);
  return items;
}

async function collectAndSave(config, startDate, endDate, outputDir) {
  const items = await collectNotionItems(config, startDate, endDate);
  const outPath = path.join(outputDir, "notion-items.json");
  // 0개여도 항상 저장 — 이전 주의 stale 데이터가 캐시로 남는 것을 방지.
  fs.writeFileSync(outPath, JSON.stringify(items, null, 2), "utf8");
  if (!items.length) {
    console.log(`[notion-api] No items collected — wrote empty array to clear stale cache (${outPath})`);
  } else {
    console.log(`[notion-api] Saved ${items.length} items to ${outPath}`);
  }
}

module.exports = { collectNotionItems, collectAndSave };
