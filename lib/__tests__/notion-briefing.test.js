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

for (const label of [
  "검증", "검증:", "검증：", "실기 검증",
  "실기 검증:", "실기검증:", "실기 검증 :", "  실기 검증：  ",
]) {
  test(`Notion verification heading skips repeated paragraph label ${JSON.stringify(label)}`, () => {
    const markdown = blocksToMd([
      { type: "heading_2", heading_2: { rich_text: [{ plain_text: "검증", annotations: {} }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: label, annotations: {} }] } },
      {
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "10/10 PASS", annotations: {} }] },
      },
    ]);

    assert.strictEqual(buildNotionBriefing(markdown).verification, "10/10 PASS");
  });
}

for (const annotations of [
  { bold: true },
  { italic: true },
  { code: true },
  { bold: true, italic: true, code: true },
]) {
  for (const colonOutside of [false, true]) {
    test(`Notion formatted repeated label ${JSON.stringify(annotations)} with colon outside=${colonOutside} is not evidence`, () => {
      const richText = [{ plain_text: colonOutside ? "실기 검증" : "실기 검증:", annotations }];
      if (colonOutside) richText.push({ plain_text: ":", annotations: {} });
      const markdown = blocksToMd([
        { type: "heading_2", heading_2: { rich_text: [{ plain_text: "검증", annotations: {} }] } },
        { type: "paragraph", paragraph: { rich_text: richText } },
        {
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: [{ plain_text: "10/10 PASS", annotations: {} }] },
        },
      ]);

      assert.strictEqual(buildNotionBriefing(markdown).verification, "10/10 PASS");
    });
  }
}

test("formatted repeated labels preserve substantive formatted result text", () => {
  const markdown = ["## 검증", "**실기 검증:**", "**검증 완료**: `10/10 PASS`"].join("\n");
  assert.strictEqual(buildNotionBriefing(markdown).verification, "검증 완료: `10/10 PASS`");
});

for (const detail of [
  "검증 완료: 10/10 PASS",
  "검증 결과는 10/10 PASS였다.",
  "실기 검증: 10/10 PASS",
  "검증 (4/4 PASS)",
]) {
  test(`repeated labels preserve substantive verification detail ${JSON.stringify(detail)}`, () => {
    const markdown = ["## 검증", "실기 검증:", detail].join("\n");
    assert.strictEqual(buildNotionBriefing(markdown).verification, detail);
  });
}

for (const { name, lines, expected } of [
  {
    name: "multiple labels after a plain marker",
    lines: ["검증", "실기 검증:", "검증：", "- 10/10 PASS"],
    expected: "10/10 PASS",
  },
  {
    name: "label-only section at EOF",
    lines: ["## 검증", "실기 검증:"],
    expected: undefined,
  },
  {
    name: "next unrelated heading",
    lines: ["## 검증", "실기 검증:", "## 다음 작업", "- 결과가 아니다."],
    expected: undefined,
  },
  {
    name: "next verification heading remains a section boundary",
    lines: ["## 검증", "실기 검증:", "## 검증", "- 다음 섹션의 결과"],
    expected: undefined,
  },
  {
    name: "measured table after repeated label",
    lines: ["## 검증", "실기 검증:", "| 갈래 | 수정 전 | 수정 후 |",
      "| --- | --- | --- |", "| 카메라 | FAIL | PASS |"],
    expected: "카메라: 수정 전 FAIL → 수정 후 PASS",
  },
  {
    name: "fenced sample after repeated label",
    lines: ["## 검증", "실기 검증:", "```text", "검증", "예시 결과", "```", "- 10/10 PASS"],
    expected: "10/10 PASS",
  },
]) {
  test(`repeated verification labels handle ${name}`, () => {
    assert.strictEqual(buildNotionBriefing(lines.join("\n")).verification, expected);
  });
}

for (const type of ["paragraph", "heading_2"]) {
  for (const position of ["before marker", "inside section"]) {
    test(`Notion code ${position} cannot replace the ${type} verification result`, () => {
      const marker = {
        type, [type]: { rich_text: [{ plain_text: "실기 검증:", annotations: {} }] },
      };
      const code = {
        type: "code",
        code: {
          language: "markdown",
          rich_text: [{ plain_text: "## 검증\n- 실행하지 않은 예시 결과", annotations: {} }],
        },
      };
      const result = {
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "실측 10/10 PASS", annotations: {} }] },
      };
      const blocks = position === "before marker" ? [code, marker, result] : [marker, code, result];

      assert.strictEqual(buildNotionBriefing(blocksToMd(blocks)).verification, "실측 10/10 PASS");
    });
  }
}

for (const type of ["paragraph", "heading_2"]) {
  for (const position of ["before marker", "inside section"]) {
    for (const innerFence of ["```", "```````"]) {
      test(`Notion nested ${innerFence.length}-backtick code ${position} preserves ${type} verification`, () => {
        const marker = {
          type, [type]: { rich_text: [{ plain_text: "실기 검증:", annotations: {} }] },
        };
        const code = {
          type: "code",
          code: {
            language: "markdown",
            rich_text: [{
              plain_text: [innerFence + "js", "const example = 1;", innerFence,
                "## 검증", "- 실행하지 않은 예시 결과"].join("\n"),
              annotations: {},
            }],
          },
        };
        const result = {
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: [{ plain_text: "실측 10/10 PASS", annotations: {} }] },
        };
        const blocks = position === "before marker" ? [code, marker, result] : [marker, code, result];

        assert.strictEqual(buildNotionBriefing(blocksToMd(blocks)).verification, "실측 10/10 PASS");
      });
    }
  }
}

for (const { name, lines, expected } of [
  {
    name: "indented code fence",
    lines: ["  ```markdown", "## 검증", "- 예시 결과", "  ```", "검증", "- 실측 PASS"],
    expected: "실측 PASS",
  },
  {
    name: "tilde code fence",
    lines: ["~~~markdown", "## 검증", "- 예시 결과", "~~~", "검증", "- 실측 PASS"],
    expected: "실측 PASS",
  },
  {
    name: "shorter nested fence is not a closing fence",
    lines: ["````markdown", "```", "## 검증", "- 예시 결과", "````", "검증", "- 실측 PASS"],
    expected: "실측 PASS",
  },
  {
    name: "different fence character does not close code",
    lines: ["```markdown", "~~~", "## 검증", "- 예시 결과", "```", "검증", "- 실측 PASS"],
    expected: "실측 PASS",
  },
  {
    name: "fence with trailing text does not close code",
    lines: ["```markdown", "``` example", "## 검증", "- 예시 결과", "````", "검증", "- 실측 PASS"],
    expected: "실측 PASS",
  },
  {
    name: "unclosed code before a marker has no verification",
    lines: ["```markdown", "## 검증", "- 예시 결과"],
    expected: undefined,
  },
  {
    name: "unclosed code inside verification is not a result",
    lines: ["검증", "```text", "실행하지 않은 예시 결과"],
    expected: undefined,
  },
  {
    name: "code is skipped before the measured verification table",
    lines: [
      "## 검증", "```js", "const example = 1;", "```",
      "| 갈래 | 수정 전 | 수정 후 |", "| --- | --- | --- |", "| 카메라 | FAIL | PASS |",
    ],
    expected: "카메라: 수정 전 FAIL → 수정 후 PASS",
  },
]) {
  test(`verification ignores ${name}`, () => {
    assert.strictEqual(buildNotionBriefing(lines.join("\n")).verification, expected);
  });
}
