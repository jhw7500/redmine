const { test } = require("node:test");
const assert = require("node:assert");
const {
  reportLabel,
  buildSubject,
  buildDescription,
  hasMarker,
  renderNotesBlock,
} = require("../notion-issue-publisher");

test("reportLabel", () => {
  assert.strictEqual(reportLabel("wlan-bsp"), "WLAN-BSP");
  assert.strictEqual(reportLabel(""), "GEN");
});

test("buildSubject", () => {
  assert.strictEqual(
    buildSubject({ report: "wlan-bsp", title: "regulatory.db 커널 임베드" }),
    "[WLAN-BSP] regulatory.db 커널 임베드"
  );
});

test("buildDescription embeds marker + source", () => {
  const d = buildDescription({ pageId: "abc-123", notionUrl: "http://n/abc" }, "# 본문\n내용", "2026-07-02");
  assert.match(d, /# 본문/);
  assert.match(d, /Notion-Page-Id: abc-123/);
  assert.match(d, /출처: Notion KB — http:\/\/n\/abc/);
  assert.ok(hasMarker(d, "abc-123"));
  assert.ok(!hasMarker(d, "zzz-999"));
});

test("renderNotesBlock", () => {
  assert.strictEqual(renderNotesBlock([]), "");
  const b = renderNotesBlock([{ id: 12, title: "regulatory.db 커널 임베드" }]);
  assert.match(b, /\*\*발표노트\(상세\)\*\*/);
  assert.match(b, /- regulatory\.db 커널 임베드 — #12/);
});
