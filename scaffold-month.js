// 엔트리포인트 — 대상 월의 모든 수요일 주간회의 페이지를 미리 생성.
// 사용: TARGET_MONTH=YYYY-MM (기본=현재 월), DRY_RUN=1 (미리보기),
//       FORCE=1 (이미 있는 페이지를 새 양식으로 덮어쓰기 — 기존 내용 소실 주의),
//       SKIP_INDEX=1 (시작 페이지 인덱스 갱신 생략), WIKI_PARENT (기본 Wiki).
const { loadConfig } = require("./lib/config");
const { scaffoldMonth } = require("./lib/scaffold-month");

async function main() {
  const config = loadConfig();
  await scaffoldMonth(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
