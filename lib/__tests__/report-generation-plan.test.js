const { test } = require("node:test");
const assert = require("node:assert");

const {
  buildGenerationPlan,
  mergeProjectOutputs,
} = require("../report-generation-plan");
const { buildFactCatalog } = require("../fact-catalog");
const { annotateFactReferences } = require("../fact-references");
const { buildAiPrompt } = require("../publisher");
const { standaloneMeasurementFactIds } = require("../verdict-evidence");

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

test("project prompts retain later-root standalone measurements without advertising verdict-dependent ones", () => {
  const source = [
    HEADER,
    "- PIM",
    "  - 보드 검사 FAIL",
    "    - 오류 복구 시간 9→3초 단축",
    "- ETC",
    "  - 보고 자동화 응답 시간 10→5.2초 단축",
    "",
  ].join("\n");
  const teamConfig = {
    ...config(),
    env: { ...config().env, reportAudience: "team", reportDepth: 3 },
    depthProfiles: { 3: { label: "팀 업무보고", advisoryMaxBullets: 60 } },
    reportFilter: { teamReport: {}, leaderHighlight: { enabled: false, maxLines: 0 } },
  };
  const catalog = buildFactCatalog(source, [], { teamReport: true, knownPaths: [["PIM"], ["ETC"]] });
  const standalone = standaloneMeasurementFactIds(source, catalog);
  const plan = buildGenerationPlan(annotateFactReferences(source, catalog), teamConfig,
    new Date("2026-08-26T00:00:00"), {
      factCatalog: catalog,
      factInputMode: "inline_refs",
      standaloneMeasurementFactIds: standalone,
    }, buildAiPrompt);
  const pimPrompt = plan.calls.find(call => call.id === "PIM").prompt;
  const etcPrompt = plan.calls.find(call => call.id === "ETC").prompt;
  const pimEvidence = pimPrompt.match(/수치 근거 선택:\n([\s\S]*?)\n\n강조 기준:/)?.[1] || "";
  const etcEvidence = etcPrompt.match(/수치 근거 선택:\n([\s\S]*?)\n\n강조 기준:/)?.[1] || "";

  assert.doesNotMatch(pimEvidence, /오류 복구 시간 9→3초 단축|\[\[fact:M0001\]\]/);
  assert.match(etcEvidence, /\[\[fact:M0002\]\].*보고 자동화 응답 시간 10→5\.2초 단축/);
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

test("project merge rejects disguised sibling roots and alternate bullet markers", () => {
  const knownRoots = ["PIM", "Wireless Lan", "ETC"];
  const intrusions = [
    " - ETC\n   - 범위 밖",
    "  - ETC\n    - 범위 밖",
    "   - ETC\n     - 범위 밖",
    "* ETC\n  - 범위 밖",
    "  * ETC\n    - 범위 밖",
    "+ ETC\n  - 범위 밖",
  ];

  for (const intrusion of intrusions) {
    assert.throws(
      () => mergeProjectOutputs([{
        id: "PIM",
        content: `${HEADER}\n- PIM\n  - 정상\n${intrusion}\n`,
      }], HEADER, knownRoots),
      (error) => error && error.code === "AI_SCOPE_OUTPUT",
      intrusion
    );
  }
});
