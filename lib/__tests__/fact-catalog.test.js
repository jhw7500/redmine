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

test("catalog binds a bare number only to an immediately following Korean counted target", () => {
  const catalog = buildFactCatalog("- 3 방안 적용\n- queue depth 4096\n");

  assert.deepStrictEqual(
    catalog.facts.map(({ raw, type, subject }) => ({ raw, type, subject })),
    [
      { raw: "3", type: "counted_quantity", subject: "방안" },
      { raw: "4096", type: "quantity", subject: "queue depth" },
    ]
  );
});

test("schema v2 catalog selects complete longest occurrences for every protected fact form", () => {
  const raw = [
    "- queue depth 4096",
    "- threshold 2.5",
    "- released v3.4.5",
    "- ratio 5/8",
    "- success 62.5%",
    "- frame 1920x1080",
    "- latency 4 ms",
    "- tests 7/9 PASS",
    "- rollout 16건 저장소 배포",
    "- completed 2026-05-08",
    "- mask 0x10",
  ].join("\n");

  const catalog = buildFactCatalog(raw, [
    { type: "meeting_date", raw: "2026-08-26", subject: "meeting date" },
  ]);

  assert.deepStrictEqual(catalog.facts.map(({ id, raw: surface }) => [id, surface]), [
    ["Q0001", "4096"],
    ["V0001", "2.5"],
    ["V0002", "v3.4.5"],
    ["V0003", "5/8"],
    ["Q0002", "62.5%"],
    ["Q0003", "1920x1080"],
    ["Q0004", "4 ms"],
    ["T0001", "7/9 PASS"],
    ["Q0005", "16건"],
    ["V0004", "2026-05-08"],
    ["V0005", "0x10"],
    ["S0001", "2026-08-26"],
  ]);
  assert.deepStrictEqual(
    catalog.facts.filter((fact) => fact.sourceLocation && fact.sourceLocation.line === 10)
      .map((fact) => fact.raw),
    ["2026-05-08"]
  );
  assert.match(formatFactCatalogForPrompt(catalog), /\[\[fact:V0004\|2026-05-08\]\]/);
});
