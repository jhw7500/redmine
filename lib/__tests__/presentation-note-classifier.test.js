const { test } = require("node:test");
const assert = require("node:assert");
const {
  classifyPresentationNotes,
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
