// 팀장 회의 보고용 밑줄 강조(leaderHighlight) 단위 테스트.
// 실행: node scripts/leader-highlight-test.js
// AI/네트워크 호출 없음 — config 로드 + 프롬프트 빌더 순수 검증.
// repo-config 경로 정규화 테스트는 repo-config.json을 임시 수정 후 try/finally로 원복한다.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "repo-config.json");

process.env.REDMINE_API_KEY = process.env.REDMINE_API_KEY || "test-key";

let pass = 0;
let fail = 0;
function ok(label, cond) {
  console.log((cond ? "  PASS" : "  FAIL") + "  " + label);
  if (cond) pass += 1;
  else fail += 1;
}
function loadFresh() {
  delete require.cache[require.resolve("../lib/config.js")];
  return require("../lib/config.js").loadConfig();
}
function clearEnv() {
  delete process.env.LEADER_HIGHLIGHT;
  delete process.env.LEADER_HIGHLIGHT_MAX;
}

const pub = require("../lib/publisher.js");

// 1) buildLeaderHighlightGuidance 순수 검증 (파일 수정 없음)
console.log("[buildLeaderHighlightGuidance]");
ok(
  "off → 빈 문자열(프롬프트 불변)",
  pub.buildLeaderHighlightGuidance({ reportFilter: { leaderHighlight: { enabled: false } } }) === ""
);
{
  const g = pub.buildLeaderHighlightGuidance({
    reportFilter: { leaderHighlight: { enabled: true, maxLines: 0, guidance: "" } },
  });
  ok("on → <u> 마크업 지시 포함", g.includes("<u>"));
  ok("on maxLines:0 → 상한 없음 문구", g.includes("개수 상한 없음"));
}
{
  const g = pub.buildLeaderHighlightGuidance({
    reportFilter: { leaderHighlight: { enabled: true, maxLines: 3, guidance: "" } },
  });
  ok("on maxLines:3 → 최대 3줄 문구", g.includes("최대 3줄"));
}
{
  const g = pub.buildLeaderHighlightGuidance({
    reportFilter: { leaderHighlight: { enabled: true, maxLines: 0, guidance: "커스텀규칙ABC" } },
  });
  ok("string guidance → 본문 대체", g.includes("커스텀규칙ABC") && !g.includes("팀장이 팀장 회의에서 별도로"));
}
{
  let threw = false;
  let g = "";
  try {
    g = pub.buildLeaderHighlightGuidance({
      reportFilter: { leaderHighlight: { enabled: true, maxLines: 0, guidance: 123 } },
    });
  } catch (e) {
    threw = true;
  }
  ok("non-string guidance(123) → TypeError 없음", !threw);
  ok("non-string guidance → 코드 기본 규칙 사용", g.includes("팀장이 팀장 회의에서 별도로"));
}

// 2) buildFilterGuidance 주입 (off면 미주입, on이면 맨 끝)
console.log("[buildFilterGuidance 주입]");
{
  const base = {
    aiGuidance: {},
    rawExcludeSubsectionPatterns: [],
    maxItemsPerSubcategory: 5,
    maxItemsPerEtcProject: 4,
  };
  const off = pub.buildFilterGuidance({ reportFilter: { ...base, leaderHighlight: { enabled: false } } });
  ok("off → 밑줄 섹션 미주입", !off.includes("팀장 회의 보고용 중요 항목 표시"));
  const on = pub.buildFilterGuidance({
    reportFilter: { ...base, leaderHighlight: { enabled: true, maxLines: 0, guidance: "" } },
  });
  ok("on → 밑줄 섹션 맨 끝 주입", on.includes("팀장 회의 보고용 중요 항목 표시") && on.trimEnd().endsWith("둔다."));
}

// 3) config.js env 오버라이드 (현재 repo-config 기준)
console.log("[config.js env 오버라이드]");
clearEnv();
ok("env 없음 → repo-config 값 로드", typeof loadFresh().reportFilter.leaderHighlight.enabled === "boolean");
clearEnv();
process.env.LEADER_HIGHLIGHT = "1";
ok("LEADER_HIGHLIGHT=1 → enabled true", loadFresh().reportFilter.leaderHighlight.enabled === true);
clearEnv();
process.env.LEADER_HIGHLIGHT = "0";
ok("LEADER_HIGHLIGHT=0 → enabled false (config 덮음)", loadFresh().reportFilter.leaderHighlight.enabled === false);
clearEnv();
process.env.LEADER_HIGHLIGHT_MAX = "3";
ok("LEADER_HIGHLIGHT_MAX=3 → maxLines 3", loadFresh().reportFilter.leaderHighlight.maxLines === 3);
clearEnv();
process.env.LEADER_HIGHLIGHT_MAX = "3.7";
ok("LEADER_HIGHLIGHT_MAX=3.7 → maxLines 3 (정수화)", loadFresh().reportFilter.leaderHighlight.maxLines === 3);
clearEnv();
process.env.LEADER_HIGHLIGHT_MAX = "-5";
ok("LEADER_HIGHLIGHT_MAX=-5 → maxLines 0 (음수 차단)", loadFresh().reportFilter.leaderHighlight.maxLines === 0);
clearEnv();
process.env.LEADER_HIGHLIGHT_MAX = "abc";
ok("LEADER_HIGHLIGHT_MAX=abc → maxLines 0 (NaN 차단)", loadFresh().reportFilter.leaderHighlight.maxLines === 0);

// 4) config.js repo-config 경로 maxLines 정규화 (임시 수정, try/finally 원복)
console.log("[config.js repo-config 경로 정규화]");
const orig = fs.readFileSync(CONFIG_PATH, "utf8");
try {
  const cfg = JSON.parse(orig);
  cfg.reportFilter.leaderHighlight = { enabled: true, maxLines: 3.7, guidance: "" };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  clearEnv();
  ok("repo-config maxLines:3.7 → 3 (정수화)", loadFresh().reportFilter.leaderHighlight.maxLines === 3);
} finally {
  fs.writeFileSync(CONFIG_PATH, orig);
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
