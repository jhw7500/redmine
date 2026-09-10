const { test } = require("node:test");
const assert = require("node:assert");
const { buildNotionBriefing } = require("../notion-briefing");
const { blocksToMd } = require("../notion-blocks-to-md");

for (const heading of [
  "검증",
  "실기 검증:",
  "# 검증",
  "## 검증",
  "### 검증",
  "#### 검증",
  "##### 검증",
  "###### 검증",
  "  ## 실기 검증 (보드)",
]) {
  test(`briefing retains verification under ${JSON.stringify(heading)}`, () => {
    const markdown = [
      "입력 조건이 달랐다.",
      "## 수정",
      "- 조건을 통일했다.",
      heading,
      "",
      "- 10/10 PASS",
    ].join("\n");

    assert.deepStrictEqual(buildNotionBriefing(markdown), {
      cause: "입력 조건이 달랐다.",
      fix: "조건을 통일했다.",
      verification: "10/10 PASS",
    });
  });
}

for (const heading of ["검증", "## 검증"]) {
  test(`empty ${JSON.stringify(heading)} section does not consume the next section`, () => {
    const markdown = [heading, "", "## 다음 작업", "- 아직 실행하지 않았다."].join("\n");
    assert.strictEqual(buildNotionBriefing(markdown).verification, undefined);
  });
}

for (const heading of ["## 검증기 설정", "## 사전 검증", "##검증", "####### 검증"]) {
  test(`briefing does not treat ${JSON.stringify(heading)} as a verification marker`, () => {
    assert.strictEqual(buildNotionBriefing(`${heading}\n- 검증 결과가 아니다.\n`).verification, undefined);
  });
}

for (const type of ["heading_1", "heading_2", "heading_3"]) {
  test(`Notion ${type} verification survives Markdown conversion`, () => {
    const markdown = blocksToMd([
      { type, [type]: { rich_text: [{ plain_text: "검증", annotations: {} }] } },
      {
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "10/10 PASS", annotations: {} }] },
      },
    ]);

    assert.deepStrictEqual(buildNotionBriefing(markdown), { verification: "10/10 PASS" });
  });
}
