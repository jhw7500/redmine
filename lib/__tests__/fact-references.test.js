const { test } = require("node:test");
const assert = require("node:assert");

const { buildFactCatalog } = require("../fact-catalog");
const {
  annotateFactReferences,
  expandFactReferences,
  formatSystemFactReferences,
  restoreUnmarkedIdentifierReferences,
} = require("../fact-references");

test("source facts become opaque inline references and expand to exact markers", () => {
  const raw = [
    "보드 실행 5/8 PASS",
    "플릿 16건 저장소 배포",
  ].join("\n");
  const catalog = buildFactCatalog(raw, [
    { type: "meeting_date", raw: "2026-08-26", subject: "meeting date" },
  ]);

  const annotated = annotateFactReferences(raw, catalog);

  assert.strictEqual(
    annotated,
    "보드 실행 [[fact:T0001]]\n플릿 [[fact:Q0001]] 저장소 배포"
  );
  assert.strictEqual(
    expandFactReferences("결과 [[fact:T0001]]", catalog),
    "결과 [[fact:T0001|5/8 PASS]]"
  );
  assert.strictEqual(
    formatSystemFactReferences(catalog),
    "- meeting date: [[fact:S0001]]"
  );
});

test("source annotation uses the same astral-normalized view as the fact catalog", () => {
  const raw = "gst😀App 2채😀널 녹화";
  const catalog = buildFactCatalog(raw);

  assert.strictEqual(
    annotateFactReferences(raw, catalog),
    "gstApp [[fact:Q0001]]채널 녹화"
  );
});

test("source annotation rejects a catalog surface that no longer matches its source span", () => {
  const raw = "보드 실행 5/8 PASS";
  const catalog = buildFactCatalog(raw);
  catalog.facts[0].raw = "10/11 PASS";

  assert.throws(
    () => annotateFactReferences(raw, catalog),
    (error) => error.code === "FACT_SOURCE_MISMATCH"
  );
});

test("source annotation rejects overlapping catalog spans", () => {
  const raw = "12";
  const catalog = buildFactCatalog(raw);
  catalog.facts.push({
    ...catalog.facts[0],
    id: "Q0002",
    raw: "2",
    sourceLocation: {
      ...catalog.facts[0].sourceLocation,
      start: 1,
    },
  });

  assert.throws(
    () => annotateFactReferences(raw, catalog),
    (error) => error.code === "FACT_SOURCE_OVERLAP"
  );
});

test("duplicate surfaces retain their source-specific fact IDs", () => {
  const raw = "A 3건 작업\nB 3건 작업\n";
  const catalog = buildFactCatalog(raw);

  assert.strictEqual(
    annotateFactReferences(raw, catalog),
    "A [[fact:Q0001]] 작업\nB [[fact:Q0002]] 작업\n"
  );
});

test("unknown references remain visible for fail-closed marker validation", () => {
  const catalog = buildFactCatalog("보드 실행 5/8 PASS");

  assert.strictEqual(
    expandFactReferences("결과 [[fact:T9999]]", catalog),
    "결과 [[fact:T9999]]"
  );
});

test("exact pilot identifiers recover deterministic references after Claude drops every marker", () => {
  const catalog = buildFactCatalog([
    "docker build verifies aarch64",
    "prepare max9296 ABI validation",
    "align max9296 driver handling",
    "max9296 quiescence",
  ].join("\n"));
  const aiOutput = [
    "docker build artifact verified on aarch64",
    "align idle handling moved to max9296 driver",
  ].join("\n");

  assert.strictEqual(
    restoreUnmarkedIdentifierReferences(aiOutput, catalog),
    [
      "docker build artifact verified on [[fact:V0001|aarch64]]",
      "align idle handling moved to [[fact:V0003|max9296]] driver",
    ].join("\n")
  );
});

test("duplicate identifier recovery stays fail-closed when source context is ambiguous", () => {
  const catalog = buildFactCatalog([
    "alpha max9296 prepare",
    "beta max9296 quiescence",
  ].join("\n"));
  const aiOutput = "gamma max9296 result";

  assert.strictEqual(
    restoreUnmarkedIdentifierReferences(aiOutput, catalog),
    aiOutput
  );
});

test("v-prefixed identifiers stay fail-closed because versions and technical IDs are ambiguous", () => {
  const catalog = buildFactCatalog([
    "check V4L2 status",
    "run v2ray proxy",
    "embed v8js engine",
  ].join("\n"));
  const aiOutput = [
    "check V4L2 status",
    "run v2ray proxy",
    "embed v8js engine",
  ].join("\n");

  assert.strictEqual(
    restoreUnmarkedIdentifierReferences(aiOutput, catalog),
    aiOutput
  );
});

test("identifier recovery leaves numeric facts, invented identifiers, and marker bodies fail-closed", () => {
  const catalog = buildFactCatalog([
    "board 5/8 PASS on aarch64",
    "release v2-rc1 on 2026-08-31 with 31ms latency",
    "release v2-dev v2-preview1 v2-canary v2-nightly v2-pre1",
    "release v2_canary v2_beta v2_rc1",
    "release v1alpha2 v1beta3 v1rc4 v1preview5 v1dev6",
  ].join("\n"));
  const aiOutput = [
    "board 5/8 PASS on arm64",
    "board date 2026-08-31 with 31ms latency",
    "release v2-rc1",
    "release v2-dev v2-preview1 v2-canary v2-nightly v2-pre1",
    "release v2_canary v2_beta v2_rc1",
    "release v1alpha2 v1beta3 v1rc4 v1preview5 v1dev6",
    "case AARCH64",
    "known [[fact:V0001|aarch64]]",
    "unknown [[fact:V9999]]",
    "unknown full [[fact:V9999|aarch64]]",
    "malformed [[fact: V0001|aarch64]]",
  ].join("\n");

  assert.strictEqual(
    restoreUnmarkedIdentifierReferences(aiOutput, catalog),
    aiOutput
  );
});
