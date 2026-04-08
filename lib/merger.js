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

// Plan SC: SC-04 — 기존 autoContent 형식 유지 (publisher.js 호환)
function mergeIntoAutoContent(gitResult, notionPath, sessionPath, config) {
  const notionItems = loadJsonSafe(notionPath);
  const sessionItems = loadJsonSafe(sessionPath);

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
  const allExtraItems = [...notionItems, ...sessionItems];

  for (const item of allExtraItems) {
    const templateKey = catToTemplate[item.category];
    if (!templateKey) continue;

    const sourceTag = item.source === "notion" ? "[Notion]" : "[CC]";

    for (const line of item.items || []) {
      // 중복 체크: git에 이미 있는 내용이면 건너뛰기
      const normalized = normalizeForDedup(line);
      if (gitKeywords.has(normalized)) continue;

      // 기존 텍스트에 추가
      const existing = result[templateKey] || "";
      const indent = item.category === "etc"
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

  return result;
}

module.exports = { mergeIntoAutoContent };
