const { test } = require("node:test");
const assert = require("node:assert");

const { buildFactCatalog } = require("../fact-catalog");
const {
  annotateFactReferences,
  expandFactReferences,
  formatSystemFactReferences,
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
