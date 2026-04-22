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

function mapCategory(title, projectMapping) {
  const lower = title.toLowerCase();
  for (const [keyword, category] of Object.entries(projectMapping)) {
    if (lower.includes(keyword.toLowerCase())) {
      return category;
    }
  }
  return null;
}

// 메타/구조 페이지 필터
const EXCLUDE_PATTERNS = [
  /^(AI Workspace|Knowledge Base|Projects|References|Decision Log|내 작업)$/i,
  /^(Claude Code|oh-my-claudecode|bkit|compound-engineering|superpowers|비-플러그인|claude-code-settings)/i,
  /^(독립 작업|롤백 가능|응답 끝에|Notion 저장|폐기|Notion Workflow)/i,
  /^(figma|linear|playwright|episodic-memory|codex|coderabbit)/i,
];

function isExcluded(title) {
  return EXCLUDE_PATTERNS.some((p) => p.test(title));
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

async function searchPages(apiKey, startDate, endDate) {
  const queries = [
    "iMX93", "wlan", "pim", "pcap", "sc16is7xx",
    "redmine", "email", "jhw-notion", "automation",
  ];

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

  // 1. DB Query: Projects
  console.log("[notion-api] Querying Projects DB...");
  const projectPages = await queryDatabase(apiKey, DATABASES.projects, startDate, endDate);
  for (const page of projectPages) {
    const title = extractTitle(page);
    if (!title || isExcluded(title)) continue;
    const desc = extractRichText(page, "description");
    items.push({
      source: "notion",
      title,
      summary: desc || undefined,
      category: mapCategory(title, projectMapping) || undefined,
      date: page.created_time?.slice(0, 10),
    });
  }
  console.log(`[notion-api] Projects: ${projectPages.length} pages, ${items.length} items`);

  // 2. DB Query: Decision Log
  console.log("[notion-api] Querying Decision Log DB...");
  const decisions = await queryDatabase(apiKey, DATABASES.decisionLog, startDate, endDate);
  const beforeCount = items.length;
  for (const page of decisions) {
    const title = extractTitle(page);
    if (!title || isExcluded(title)) continue;
    const project = extractRichText(page, "project");
    const rationale = extractRichText(page, "rationale");
    items.push({
      source: "notion",
      title,
      summary: rationale || undefined,
      category: mapCategory(title + " " + project, projectMapping) || undefined,
      date: page.created_time?.slice(0, 10),
    });
  }
  console.log(`[notion-api] Decision Log: ${decisions.length} pages, ${items.length - beforeCount} items`);

  // 3. DB Query: Knowledge Base
  console.log("[notion-api] Querying Knowledge Base DB...");
  const kbPages = await queryDatabase(apiKey, DATABASES.knowledgeBase, startDate, endDate);
  const beforeKb = items.length;
  for (const page of kbPages) {
    const title = extractTitle(page);
    if (!title || isExcluded(title)) continue;
    const summary = extractRichText(page, "summary");
    items.push({
      source: "notion",
      title,
      summary: summary || undefined,
      category: mapCategory(title, projectMapping) || undefined,
      date: page.created_time?.slice(0, 10),
    });
  }
  console.log(`[notion-api] Knowledge Base: ${kbPages.length} pages, ${items.length - beforeKb} items`);

  // 4. Search: 기타 non-DB 페이지
  console.log("[notion-api] Searching non-DB pages...");
  const searchPages_ = await searchPages(apiKey, startDate, endDate);
  const beforeSearch = items.length;
  const seenTitles = new Set(items.map((i) => i.title.toLowerCase()));
  for (const page of searchPages_) {
    const title = extractTitle(page);
    if (!title || isExcluded(title)) continue;
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
  if (!items.length) {
    console.log("[notion-api] No items collected");
    return;
  }

  const outPath = path.join(outputDir, "notion-items.json");
  fs.writeFileSync(outPath, JSON.stringify(items, null, 2), "utf8");
  console.log(`[notion-api] Saved ${items.length} items to ${outPath}`);
}

module.exports = { collectNotionItems, collectAndSave };
