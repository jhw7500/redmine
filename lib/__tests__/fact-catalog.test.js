const { test } = require("node:test");
const assert = require("node:assert");
const { buildFactCatalog, formatFactCatalogForPrompt } = require("../fact-catalog");

test("catalog binds test and counter facts to stable source locations", () => {
  const raw = [
    "#### 조현우",
    "- 보드 실행 5/8 PASS",
    "- 플릿 16건 저장소 전면 배포",
  ].join("\n");
  const systemFacts = [{ type: "meeting_date", raw: "2026-08-26", subject: "meeting date" }];

  const first = buildFactCatalog(raw, systemFacts);
  const second = buildFactCatalog(raw, systemFacts);
  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.facts.find((fact) => fact.id === "T0001").raw, "5/8 PASS");
  assert.deepStrictEqual(first.facts.find((fact) => fact.id === "T0001").semantic, {
    pass: 5, total: 8, fail: 3,
  });
  assert.strictEqual(first.facts.find((fact) => fact.id === "Q0001").raw, "16건");
  assert.strictEqual(first.facts.find((fact) => fact.id === "Q0001").subject, "저장소");
  assert.strictEqual(first.facts.find((fact) => fact.id === "S0001").raw, "2026-08-26");
  assert.match(formatFactCatalogForPrompt(first), /\[\[fact:T0001\|5\/8 PASS\]\]/);
});

test("catalog keeps duplicate surfaces as separate source occurrences", () => {
  const catalog = buildFactCatalog("A 3건 작업\nB 3건 작업\n");
  const quantities = catalog.facts.filter((fact) => fact.id.startsWith("Q"));
  assert.deepStrictEqual(quantities.map((fact) => fact.id), ["Q0001", "Q0002"]);
  assert.deepStrictEqual(quantities.map((fact) => fact.sourceLocation.line), [1, 2]);
});
