const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { resolveReportDepth } = require("../config");
const {
  buildAiPrompt,
  buildDepthGuidance,
  warnDepthShape,
} = require("../publisher");

const rawConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "repo-config.json"), "utf8")
);

function promptConfig(reportDepth) {
  return {
    env: {
      reportDepth,
      sectionHeader: rawConfig.defaults.sectionHeader,
    },
    depthProfiles: rawConfig.depthProfiles,
    reportFilter: {
      ...rawConfig.reportFilter,
      rawExcludeSubsectionPatterns: rawConfig.reportFilter.excludeSubsectionPatterns,
    },
  };
}

function promptForDepth(reportDepth) {
  return buildAiPrompt(
    "원본",
    promptConfig(reportDepth),
    new Date("2026-08-26T00:00:00")
  );
}

test("depth2 profile preserves the original standard guidance", () => {
  const guidance = buildDepthGuidance({
    env: { reportDepth: 2 },
    depthProfiles: rawConfig.depthProfiles,
  });

  assert.match(guidance, /들여쓰기 최대 3단/);
  assert.match(guidance, /서브카테고리당 최대 3줄/);
  assert.doesNotMatch(guidance, /30~36줄/);
});

test("depth3 profile targets the midpoint between standard and detail", () => {
  const guidance = buildDepthGuidance({
    env: { reportDepth: 3 },
    depthProfiles: rawConfig.depthProfiles,
  });

  assert.match(guidance, /30~36줄/);
  assert.match(guidance, /최대 38줄/);
  assert.match(guidance, /들여쓰기 최대 4단/);
  assert.match(guidance, /테마별 세부 bullet은 최대 1줄/);
});

test("depth2 production prompt excludes later common shape rules", () => {
  const prompt = promptForDepth(2);

  assert.match(prompt, /전체 불릿.*24~28줄/);
  assert.match(prompt, /최대 30줄/);
  assert.match(prompt, /pim-check.*4단.*예외/s);
  assert.doesNotMatch(prompt, /전체 보고서 50~60줄/);
  assert.doesNotMatch(prompt, /서브카테고리당 최대 50개/);
  assert.doesNotMatch(prompt, /하위에 구체 변경 2~4줄/);
  assert.match(prompt, /엄격한 카테고리 매핑/);
});

test("depth3 production prompt keeps its own budget without common shape rules", () => {
  const prompt = promptForDepth(3);

  assert.match(prompt, /30~36줄/);
  assert.match(prompt, /최대 38줄/);
  assert.match(prompt, /사실 보존과 source coverage 계약은 덮어쓰지 않는다/);
  assert.doesNotMatch(prompt, /섹션 누락 금지.*충돌하면 우선/);
  assert.doesNotMatch(prompt, /전체 보고서 50~60줄/);
  assert.doesNotMatch(prompt, /서브카테고리당 최대 50개/);
  assert.doesNotMatch(prompt, /하위에 구체 변경 2~4줄/);
  assert.match(prompt, /엄격한 카테고리 매핑/);
});

test("depth4 production prompt retains the common detailed shape rules", () => {
  const prompt = promptForDepth(4);

  assert.match(prompt, /전체 보고서 50~60줄/);
  assert.match(prompt, /서브카테고리당 최대 50개/);
  assert.match(prompt, /하위에 구체 변경 2~4줄/);
});

test("depth4 profile keeps the existing unrestricted detailed prompt", () => {
  assert.strictEqual(
    buildDepthGuidance({
      env: { reportDepth: 4 },
      depthProfiles: rawConfig.depthProfiles,
    }),
    ""
  );
});

test("production prompt removes work-thread duplicates without merging distinct functions", () => {
  const prompt = promptForDepth(3);

  assert.match(prompt, /구현 커밋.*리뷰 반영.*후속 수정.*결과 중심.*하나의 항목/s);
  assert.match(prompt, /동일한 source marker.*여러 문장.*반복하지/);
  assert.match(prompt, /줄 수.*맞추기.*서로 다른 기능.*합치지/);
  assert.match(prompt, /서로 다른 기능\/모듈은 합치지 않는다/);
});

test("production prompt keeps protected quantity subjects and canonical headings intact", () => {
  const prompt = buildAiPrompt(
    "원본",
    promptConfig(3),
    new Date("2026-08-26T00:00:00"),
    { factInputMode: "inline_refs", factCatalog: { facts: [] } }
  );

  assert.match(prompt, /Q reference.*각 reference의 원본 대상 구절.*각각.*유지/);
  assert.match(prompt, /canonical section.*heading.*밑줄을 치지 않는다/);
});

test("report depth validation accepts the new depth4 level", () => {
  assert.strictEqual(resolveReportDepth("4", 2), 4);
});

test("depth shape budget emits an advisory warning without rejecting content", () => {
  const warnings = [];
  const content = Array.from({ length: 31 }, (_, index) => `- 항목 ${index + 1}`).join("\n");

  const result = warnDepthShape(
    content,
    promptConfig(2),
    (warning) => warnings.push(warning)
  );

  assert.deepStrictEqual(result, {
    reportDepth: 2,
    bulletCount: 31,
    advisoryMaxBullets: 30,
    exceeded: true,
  });
  assert.deepStrictEqual(warnings, ["[depth] advisory depth=2 bullets=31 max=30"]);
});

test("depth shape budget stays silent within the advisory maximum", () => {
  const warnings = [];
  const content = Array.from({ length: 30 }, (_, index) => `  - 항목 ${index + 1}`).join("\n");

  const result = warnDepthShape(
    content,
    promptConfig(2),
    (warning) => warnings.push(warning)
  );

  assert.strictEqual(result.exceeded, false);
  assert.strictEqual(result.bulletCount, 30);
  assert.deepStrictEqual(warnings, []);
});
