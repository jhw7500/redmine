const { test } = require("node:test");
const assert = require("node:assert");

const {
  buildGenerationPlan,
  mergeProjectOutputs,
} = require("../report-generation-plan");

const HEADER = '#### <span style="color:blue">조현우</span>';

function config(scope = "project") {
  return {
    env: {
      aiGenerationScope: scope,
      sectionHeader: HEADER,
    },
    categories: {
      pimApp: { parent: "PIM" },
      pimTest: { parent: "PIM" },
      wlanApp: { parent: "Wireless Lan" },
      etc: { parent: "ETC" },
    },
  };
}

function fixtureSource({ wireless = true } = {}) {
  return [
    HEADER,
    "",
    "- PIM",
    "  - Application",
    "    - PIM 작업 [[source:N0001]]",
    ...(wireless ? [
      "",
      "- Wireless Lan",
      "  - Driver",
      "    - WLAN 작업 [[source:N0002]]",
    ] : []),
    "",
    "- ETC [[source:C0003]]",
    "  - Redmine 주간 보고 자동화",
    "    - ETC 작업 [[source:N0003]]",
    "",
    "*작성: Claude Code | 승인: hwjo*",
    "---",
    "",
  ].join("\n");
}

function promptBuilder(source, _config, _meetingDate, options) {
  return `scope=${options.generationRoot || "whole"}\n${source}`;
}

test("project plan isolates PIM, Wireless Lan, and ETC in configured order", () => {
  const plan = buildGenerationPlan(
    fixtureSource(),
    config(),
    new Date("2026-08-26T00:00:00"),
    {},
    promptBuilder
  );

  assert.strictEqual(plan.scope, "project");
  assert.deepStrictEqual(plan.calls.map((call) => call.id), ["PIM", "Wireless Lan", "ETC"]);
  assert.match(plan.calls[0].source, /^#### .*조현우.*\n\n- PIM/m);
  assert.doesNotMatch(plan.calls[0].source, /Wireless Lan|^- ETC/m);
  assert.match(plan.calls[1].source, /^#### .*조현우.*\n\n- Wireless Lan/m);
  assert.doesNotMatch(plan.calls[1].source, /^- PIM|^- ETC/m);
  assert.match(plan.calls[2].source, /^#### .*조현우.*\n\n- ETC \[\[source:C0003\]\]/m);
  assert.doesNotMatch(plan.calls[2].source, /\*작성:|^---$/m);
  assert.match(plan.calls[0].prompt, /^scope=PIM/);
  assert.match(plan.promptHash, /^[0-9a-f]{64}$/);
});

test("project plan skips a root that is absent from this week's source", () => {
  const plan = buildGenerationPlan(
    fixtureSource({ wireless: false }),
    config(),
    new Date("2026-08-26T00:00:00"),
    {},
    promptBuilder
  );

  assert.deepStrictEqual(plan.calls.map((call) => call.id), ["PIM", "ETC"]);
});

test("whole plan preserves one full-source call", () => {
  const source = fixtureSource();
  const plan = buildGenerationPlan(
    source,
    config("whole"),
    new Date("2026-08-26T00:00:00"),
    {},
    promptBuilder
  );

  assert.strictEqual(plan.scope, "whole");
  assert.strictEqual(plan.calls.length, 1);
  assert.strictEqual(plan.calls[0].id, "whole");
  assert.strictEqual(plan.calls[0].source, source);
  assert.match(plan.calls[0].prompt, /^scope=whole/);
});

test("project outputs merge under one header in the planned order", () => {
  const merged = mergeProjectOutputs([
    { id: "PIM", content: `${HEADER}\n- PIM\n  - PIM 결과\n` },
    { id: "Wireless Lan", content: `${HEADER}\n- Wireless Lan\n  - WLAN 결과\n` },
    { id: "ETC", content: `${HEADER}\n- ETC [[source:C0003]]\n  - ETC 결과\n` },
  ], HEADER);

  assert.strictEqual(merged, [
    HEADER,
    "",
    "- PIM",
    "  - PIM 결과",
    "",
    "- Wireless Lan",
    "  - WLAN 결과",
    "",
    "- ETC [[source:C0003]]",
    "  - ETC 결과",
    "",
  ].join("\n"));
});

test("project merge rejects output that adds another top-level root", () => {
  assert.throws(
    () => mergeProjectOutputs([{
      id: "PIM",
      content: `${HEADER}\n- PIM\n  - PIM 결과\n- ETC\n  - 끼워 넣은 결과\n`,
    }], HEADER),
    (error) => error && error.code === "AI_SCOPE_OUTPUT"
  );
});
