const { test } = require("node:test");
const assert = require("node:assert");
const { appendNotesBlock, sanitizeAiSection, stripNotesBlock } = require("../publisher");

test("appendNotesBlock replaces a previous generated notes block", () => {
  const original = [
    "#### 조현우",
    "- 내용",
    "",
    "**발표노트(상세)**",
    "- 이전 — #1",
  ].join("\n");
  const updated = appendNotesBlock(original, [{ id: 2, title: "신규" }]);

  assert.doesNotMatch(updated, /이전/);
  assert.match(updated, /- 신규 — #2/);
  assert.strictEqual((updated.match(/발표노트\(상세\)/g) || []).length, 1);
});

test("stripNotesBlock preserves the report body", () => {
  assert.strictEqual(
    stripNotesBlock("#### 조현우\n- 내용\n\n**발표노트(상세)**\n- 노트 — #3\n"),
    "#### 조현우\n- 내용"
  );
});

test("sanitizeAiSection removes AI preamble and trailing self-review", () => {
  const header = '#### <span style="color:blue">조현우</span>';
  const output = `정리했습니다.\n\n${header}\n- Wireless Lan\n  - 34/34 PASS\n\n—\n- 총 4줄`;
  assert.strictEqual(
    sanitizeAiSection(output, { env: { sectionHeader: header } }),
    `${header}\n- Wireless Lan\n  - 34/34 PASS\n`
  );
});
