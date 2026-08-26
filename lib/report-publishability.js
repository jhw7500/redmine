// 게시를 막지 않는 warning은 여기 등록된 것뿐이다. open_status_pickaxe_unavailable은
// 코드 심볼이 없는 문장이라 pickaxe 자동 확인이 불가능할 뿐이며, 문구 수정으로 없앨 수
// 없어 게시를 영구 차단했다. 반면 해결 흔적 발견(open_status_resolution_evidence)이나
// git 확인 실패는 AGENTS.md의 stale "미해결" 방지 규율상 사람이 봐야 하므로 계속 막는다.
// 기본값이 "차단"이므로 새 warning code는 schema v1/v2 gate를 조용히 통과하지 않는다.
//
// [결정 · 2026-07-29] title check는 계속 수행되고, 해결 흔적이 실제로 발견되면
// open_status_resolution_evidence로 막힌다. 이 경고 자체를 차단하면 문구로 제거할 수 없는
// warning 하나 때문에 주간 게시가 영구 중단되므로 비차단으로 유지하고 수동 확인을 알린다.
const NON_BLOCKING_WARNING_CODES = new Set(["open_status_pickaxe_unavailable"]);

function blockingWarnings(validation) {
  return (validation.issues || []).filter(
    (issue) => issue.severity === "warning" && !NON_BLOCKING_WARNING_CODES.has(issue.code)
  );
}

function isPublishable(validation) {
  if (validation.status === "PASS") return true;
  if (validation.status !== "WARNING") return false;
  return blockingWarnings(validation).length === 0;
}

module.exports = {
  blockingWarnings,
  isPublishable,
};
