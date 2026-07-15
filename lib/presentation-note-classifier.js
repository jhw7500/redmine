const DEFAULT_THRESHOLD = 5;
const POSITIVE_PATTERNS = [
  /완료|구축|출시|달성|해결|적용|통합|개선/i,
  /검증|테스트|PASS|FAIL|성능|회귀/i,
  /장애|원인|재발|안정화|보안/i,
];
const PERSONAL_PATTERNS = [
  /redmine|주간\s*보고|notion|claude|codex|세션\s*요약|personal\s*ai/i,
];

function hasPresentationTag(item) {
  return Array.isArray(item.tags) && item.tags.includes("발표노트");
}

function classifyItem(item, options = {}) {
  const threshold = Number(options.threshold || DEFAULT_THRESHOLD);
  const text = `${item.title || ""} ${item.summary || ""}`.trim();
  const reasons = [];
  let score = 0;
  const tagged = hasPresentationTag(item);

  if (tagged) {
    score = Math.max(score, threshold);
    reasons.push("Notion 발표노트 태그");
  }
  if (/^(pim|wlan)/i.test(item.category || "")) {
    score += 2;
    reasons.push("제품 도메인 작업");
  }
  if (item.report && !["etc", "none"].includes(String(item.report).toLowerCase())) {
    score += 1;
    reasons.push("팀 보고 카테고리 지정");
  }
  for (const pattern of POSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      score += 2;
      reasons.push(`발표 가치 신호: ${pattern.source}`);
    }
  }
  for (const pattern of PERSONAL_PATTERNS) {
    if (pattern.test(text)) {
      score -= 4;
      reasons.push("개인 자동화 주제 감점");
    }
  }
  if (text.length >= 60) score += 1;

  return {
    sourceId: item.sourceId,
    pageId: item.pageId,
    title: item.title,
    summary: item.summary,
    notionUrl: item.url || item.notionUrl,
    report: item.report,
    category: item.category,
    tagged,
    score,
    threshold,
    candidate: tagged || score >= threshold,
    reasons,
  };
}

function classifyPresentationNotes(items, options = {}) {
  return (items || [])
    .filter((item) => item.sourceDb === "knowledgeBase" && item.pageId)
    .map((item) => classifyItem(item, options))
    .filter((item) => item.tagged || item.candidate)
    .sort((a, b) => Number(b.tagged) - Number(a.tagged) || b.score - a.score ||
      String(a.title || "").localeCompare(String(b.title || "")));
}

function selectPresentationNotes(candidates, mode) {
  if (mode === "off") return [];
  const selected = mode === "auto"
    ? (candidates || []).filter((item) => item.tagged || item.candidate)
    : (candidates || []).filter((item) => item.tagged);
  const seen = new Set();
  return selected.filter((item) => {
    if (!item.pageId || seen.has(item.pageId)) return false;
    seen.add(item.pageId);
    return true;
  });
}

module.exports = {
  DEFAULT_THRESHOLD,
  classifyItem,
  classifyPresentationNotes,
  hasPresentationTag,
  selectPresentationNotes,
};
