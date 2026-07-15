const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { resolveReportDepth } = require("../config");
const { buildDepthGuidance } = require("../publisher");

const rawConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "repo-config.json"), "utf8")
);

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
  assert.match(guidance, /테마별 세부 bullet은 최대 2줄/);
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

test("report depth validation accepts the new depth4 level", () => {
  assert.strictEqual(resolveReportDepth("4", 2), 4);
});
