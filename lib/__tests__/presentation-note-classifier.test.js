const { test } = require("node:test");
const assert = require("node:assert");
const {
  classifyPresentationNotes,
  describeEmptySelection,
  selectPresentationNotes,
} = require("../presentation-note-classifier");

test("explicit presentation tag always wins", () => {
  const candidates = classifyPresentationNotes([{
    sourceDb: "knowledgeBase",
    sourceId: "notion:1",
    pageId: "1",
    title: "짧은 메모",
    tags: ["발표노트"],
  }]);

  assert.strictEqual(candidates.length, 1);
  assert.ok(candidates[0].tagged);
  assert.strictEqual(selectPresentationNotes(candidates, "tagged").length, 1);
});

test("high-value WLAN validation note becomes an automatic candidate", () => {
  const candidates = classifyPresentationNotes([{
    sourceDb: "knowledgeBase",
    sourceId: "notion:2",
    pageId: "2",
    title: "온타겟 프로토콜 검증 스위트 구축 완료",
    summary: "실타깃 테스트 34건 PASS로 회귀 검증과 장애 원인 확인까지 완료했다.",
    category: "wlanTest",
    report: "wlan-test",
    tags: [],
  }]);

  assert.strictEqual(candidates.length, 1);
  assert.ok(candidates[0].candidate);
  assert.strictEqual(selectPresentationNotes(candidates, "suggest").length, 0);
  assert.strictEqual(selectPresentationNotes(candidates, "auto").length, 1);
});

test("personal Redmine automation note is not promoted automatically", () => {
  const candidates = classifyPresentationNotes([{
    sourceDb: "knowledgeBase",
    sourceId: "notion:3",
    pageId: "3",
    title: "Redmine 주간 보고 자동화 개선 완료",
    summary: "Notion과 Claude 세션 자동 수집을 구축했다.",
    category: "etc",
    report: "etc",
    tags: [],
  }]);

  assert.strictEqual(candidates.length, 0);
});

// #66 — 선택 0건은 로그가 전혀 남지 않아 태그 규약 붕괴를 2개월간 못 잡았다.
// 정상 주간(후보 자체가 없음)과 전량 탈락을 구분해 남긴다.

test("describeEmptySelection stays silent when publishing is disabled", () => {
  assert.strictEqual(describeEmptySelection([], "off"), null);
  assert.strictEqual(describeEmptySelection([{ tagged: false }], "off"), null);
});

test("describeEmptySelection names the tag gate when every candidate is untagged", () => {
  const msg = describeEmptySelection(
    [{ tagged: false }, { tagged: false }, { tagged: false }],
    "suggest"
  );
  assert.match(msg, /모두 태그 없음/);
  assert.match(msg, /suggest/);
  assert.match(msg, /3/);
});

test("describeEmptySelection distinguishes an empty pool from a tag gate", () => {
  const msg = describeEmptySelection([], "tagged");
  assert.match(msg, /후보 자체가 0건/);
  assert.doesNotMatch(msg, /모두 태그 없음/);
});

test("describeEmptySelection does not blame the tag gate in auto mode", () => {
  const msg = describeEmptySelection([{ tagged: false }, { tagged: false }], "auto");
  assert.doesNotMatch(msg, /모두 태그 없음/);
  assert.match(msg, /auto/);
});
