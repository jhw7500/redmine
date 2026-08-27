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

test("catalog preserves lexical Korean counted targets without guessing particles", () => {
  const catalog = buildFactCatalog("- 3 신뢰도 확인\n");

  assert.strictEqual(catalog.facts[0].subject, "신뢰도");
});

test("catalog does not bind a trailing bare number to a Korean target on the next line", () => {
  const catalog = buildFactCatalog("- queue depth 4096\n방안 검토\n");

  assert.deepStrictEqual(
    catalog.facts.map(({ raw, type, subject }) => ({ raw, type, subject })),
    [{ raw: "4096", type: "quantity", subject: "queue depth" }]
  );
});

test("schema v2 catalog never combines protected facts across source lines", () => {
  const dimensions = buildFactCatalog("queue depth 4096\nx 1080");
  assert.deepStrictEqual(
    dimensions.facts.map(({ raw, type, subject }) => ({ raw, type, subject })),
    [
      { raw: "4096", type: "quantity", subject: "queue depth" },
      { raw: "1080", type: "quantity", subject: "x" },
    ]
  );

  const counted = buildFactCatalog("작업 3건\n방안 검토");
  assert.strictEqual(counted.facts[0].raw, "3건");
  assert.strictEqual(counted.facts[0].subject, "작업");
});

test("schema v2 catalog preserves allowed same-line spaces and tabs", () => {
  const catalog = buildFactCatalog([
    "- tests PASS\t5 /\t8",
    "- rollout 3건\t방안 적용",
    "- success 62.5\t%",
    "- frame 1920\t× 1080",
    "- latency 4\tms",
    "- released v3.4.5",
    "- ratio 5\t/ 8",
  ].join("\n"));

  assert.deepStrictEqual(catalog.facts.map((fact) => fact.raw), [
    "PASS\t5 /\t8",
    "3건",
    "62.5\t%",
    "1920\t× 1080",
    "4\tms",
    "v3.4.5",
    "5\t/ 8",
  ]);
  assert.strictEqual(catalog.facts[1].subject, "방안");
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

test("schema v2 catalog keeps numeric signs inside maximal protected surfaces", () => {
  const raw = [
    "- bare -5",
    "- decimal +2.5",
    "- success -62.5%",
    "- frame -1920x+1080",
    "- latency +4 ms",
    "- ratio -5/+8",
    "- rollout -16건 저장소 배포",
    "- completed 2026-05-08",
    "- released v3.4.5",
    "- mask 0x10",
    "- tests 7/9 PASS",
  ].join("\n");

  const catalog = buildFactCatalog(raw);
  assert.deepStrictEqual(
    catalog.facts.map((fact) => fact.raw),
    [
      "-5",
      "+2.5",
      "-62.5%",
      "-1920x+1080",
      "+4 ms",
      "-5/+8",
      "-16건",
      "2026-05-08",
      "v3.4.5",
      "0x10",
      "7/9 PASS",
    ]
  );
  const signedCounter = catalog.facts.find((fact) => fact.raw === "-16건");
  assert.strictEqual(signedCounter.type, "counted_quantity");
  assert.strictEqual(signedCounter.subject, "저장소");
});

test("schema v2 catalog classifies signed hexadecimal as one maximal V surface", () => {
  const catalog = buildFactCatalog([
    "- numeric -0x10",
    "- alpha +0xFF",
    "- unsigned 0x2A",
  ].join("\n"));

  assert.deepStrictEqual(
    catalog.facts.map(({ id, raw, type }) => ({ id, raw, type })),
    [
      { id: "V0001", raw: "-0x10", type: "protected_token" },
      { id: "V0002", raw: "+0xFF", type: "protected_token" },
      { id: "V0003", raw: "0x2A", type: "protected_token" },
    ]
  );
});
