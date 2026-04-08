// Design Ref: §4.3 — CC 세션 이력에서 주간 작업 내용 추출
// 이 모듈은 CC 스킬(/redmine-report)에서 episodic-memory MCP 결과를
// CollectedItem[] 형식의 JSON으로 변환하는 유틸리티입니다.
// MCP 도구 호출 자체는 스킬 레이어에서 수행합니다.

/**
 * episodic-memory 검색 결과를 CollectedItem[] 형식으로 변환
 *
 * @param {Object} searchResultsByKeyword - { keyword: [results] } 형태
 * @param {Object} config - loadConfig() 결과
 * @returns {CollectedItem[]}
 */
function parseSessionResults(searchResultsByKeyword, config) {
  if (!searchResultsByKeyword || typeof searchResultsByKeyword !== "object") return [];

  const repos = config.repos || {};
  const grouped = new Map();

  for (const [keyword, results] of Object.entries(searchResultsByKeyword)) {
    if (!Array.isArray(results) || !results.length) continue;

    // 키워드 → 카테고리 매핑 (repos에서 조회)
    let category = "etc";
    if (repos[keyword] && repos[keyword].category) {
      category = repos[keyword].category;
    }

    const key = `${keyword}:${category}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        project: keyword,
        category,
        source: "session",
        items: [],
      });
    }

    const seen = new Set();
    for (const result of results) {
      // 세션 결과에서 핵심 작업 내용 추출
      const snippet = extractWorkSummary(result);
      if (!snippet) continue;

      const normalized = snippet.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      grouped.get(key).items.push(snippet);
    }
  }

  return Array.from(grouped.values());
}

/**
 * 개별 세션 검색 결과에서 핵심 작업 요약 1줄 추출
 */
function extractWorkSummary(result) {
  if (!result) return null;

  // snippets 필드가 있으면 첫 번째 사용
  if (result.snippets && Array.isArray(result.snippets) && result.snippets.length) {
    const snippet = result.snippets[0];
    return cleanSnippet(typeof snippet === "string" ? snippet : snippet.text || "");
  }

  // summary 필드
  if (result.summary) return cleanSnippet(result.summary);

  // content 필드
  if (result.content) return cleanSnippet(result.content);

  return null;
}

function cleanSnippet(text) {
  if (!text) return null;
  // 불필요한 마크다운/태그 제거, 120자 제한
  let cleaned = text
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/#{1,6}\s*/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > 120) cleaned = cleaned.slice(0, 117) + "...";
  return cleaned;
}

module.exports = { parseSessionResults };
