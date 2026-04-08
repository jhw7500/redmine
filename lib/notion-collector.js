// Design Ref: §4.2 — Notion AI Workspace 주간 활동 수집
// 이 모듈은 CC 스킬(/redmine-report)에서 MCP 도구로 수집한 결과를
// CollectedItem[] 형식의 JSON으로 변환하는 유틸리티입니다.
// MCP 도구 호출 자체는 스킬 레이어에서 수행합니다.

/**
 * Notion 검색 결과를 CollectedItem[] 형식으로 변환
 *
 * @param {Array} searchResults - notion-search MCP 결과 배열
 * @param {Object} config - loadConfig() 결과
 * @returns {CollectedItem[]}
 */
function parseNotionResults(searchResults, config) {
  if (!Array.isArray(searchResults) || !searchResults.length) return [];

  const mapping = (config.sources && config.sources.notion && config.sources.notion.projectMapping) || {};
  const grouped = new Map();

  for (const result of searchResults) {
    const title = result.title || result.name || "";
    if (!title) continue;

    // 프로젝트명 매핑: projectMapping에서 키워드 매칭
    let matchedProject = null;
    let matchedCategory = "etc";

    for (const [keyword, category] of Object.entries(mapping)) {
      if (title.toLowerCase().includes(keyword.toLowerCase())) {
        matchedProject = keyword;
        matchedCategory = category;
        break;
      }
    }

    if (!matchedProject) {
      // repos에서 매칭 시도
      for (const [repoName, repoDef] of Object.entries(config.repos || {})) {
        if (title.toLowerCase().includes(repoName.toLowerCase())) {
          matchedProject = repoName;
          matchedCategory = repoDef.category || "etc";
          break;
        }
      }
    }

    const project = matchedProject || "etc";
    const key = `${project}:${matchedCategory}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        project,
        category: matchedCategory,
        source: "notion",
        items: [],
      });
    }

    // 활동 내용 추출
    const description = result.description || result.highlight || title;
    const item = description.length > 120
      ? description.slice(0, 117) + "..."
      : description;
    grouped.get(key).items.push(item);
  }

  return Array.from(grouped.values());
}

module.exports = { parseNotionResults };
