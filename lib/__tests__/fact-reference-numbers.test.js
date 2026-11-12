const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildFactCatalog } = require("../fact-catalog");
const { annotateFactReferences, expandFactReferences } = require("../fact-references");
const { validateAnnotatedReport } = require("../fact-validator");
const { hashObject } = require("../report-artifact");

const header = '#### <span style="color:blue">조현우</span>';
const options = { sectionHeader: header, reportDepth: 3 };
const report = (line) => `${header}\n- ${line}\n`;
const annotate = (raw, catalog) => expandFactReferences(annotateFactReferences(raw, catalog), catalog);
const validate = (raw, content, catalog, overrides = {}) =>
  validateAnnotatedReport(raw, content, catalog, { ...options, ...overrides }).validation;

test("unlabelled hash references preserve their identity across sentence rewrites", () => {
  const raw = report("[Notion] sd-mount 진단과 actions.log 유지, #140·#141 진단 범위");
  const catalog = buildFactCatalog(raw);
  assert.deepEqual(catalog.facts.map(({ raw: value, type, subject }) => [value, type, subject]), [
    ["140", "reference_number", "hash_reference"],
    ["141", "reference_number", "hash_reference"],
  ]);
  const marked = report("actions.log 유지와 진단 범위 정리 (#[[fact:Q0001|140]]·#[[fact:Q0002|141]])");
  assert.equal(validate(raw, marked, catalog).status, "PASS");
});

test("hash reference lists allow Korean particles and display-only underline markup", () => {
  for (const separator of ["·", ", ", " / "]) {
    const raw = report(`[Notion] #140${separator}#141 진단 범위`);
    const catalog = buildFactCatalog(raw);
    const content = report(`<u>진단 범위: #[[fact:Q0001|140]]${separator}#[[fact:Q0002|141]]은 기록에 연결</u>`);
    assert.equal(validate(raw, content, catalog).status, "PASS", separator);
  }
});

test("hash references cannot change value, lose their hash, or acquire a quantity unit", () => {
  const raw = report("진단 범위 (#140)");
  const catalog = buildFactCatalog(raw);
  const fact = catalog.facts[0];
  for (const line of [
    `진단 범위 (#[[fact:${fact.id}|142]])`,
    `진단 범위 ([[fact:${fact.id}|140]])`,
    `진단 범위 (#[[fact:${fact.id}|140]]ms)`,
    `진단 범위 (#[[fact:${fact.id}|140]]채널)`,
    `진단 범위 (#[[fact:${fact.id}|140]] 개 센서)`,
    "진단 범위 (#140)",
  ]) {
    assert.equal(validate(raw, report(line), catalog).status, "FAIL", line);
  }
});

test("a hash reference does not infer PR or issue kind in either direction", () => {
  for (const [source, output] of [
    ["진단 범위 (#140)", "진단 범위 (PR #140)"],
    ["진단 범위 (#140)", "진단 범위 (이슈 #140)"],
    ["진단 범위 (PR #140)", "진단 범위 (#140)"],
    ["진단 범위 (이슈 #140)", "진단 범위 (#140)"],
  ]) {
    const raw = report(source);
    const catalog = buildFactCatalog(raw);
    const fact = catalog.facts[0];
    const marked = report(output).replace("140", `[[fact:${fact.id}|140]]`);
    const validation = validate(raw, marked, catalog);
    assert.equal(validation.status, "FAIL", `${source} -> ${output}`);
    assert.ok(validation.issues.some((issue) => issue.code === "fact_subject_mismatch"));
  }
});

test("literal subject names cannot turn a reference marker into an ordinary quantity", () => {
  for (const [source, label] of [
    ["진단 범위 (#140)", "hash_reference"],
    ["진단 범위 (PR #140)", "pull_request"],
    ["진단 범위 (이슈 #140)", "issue"],
  ]) {
    const raw = report(source);
    const catalog = buildFactCatalog(raw);
    const fact = catalog.facts[0];
    const content = report(`${label} [[fact:${fact.id}|140]]`);
    const validation = validate(raw, content, catalog);
    assert.equal(validation.status, "FAIL", label);
    assert.ok(validation.issues.some((issue) => issue.code === "fact_subject_mismatch"));
  }
});

test("hash reference grammar does not absorb identifiers, escapes, paths, or attached units", () => {
  for (const token of [
    "queue#140", "repo/#140", "https://example.test/#140", "\\#140", "##140",
    "#140abc", "#140.5", "#140ms", "#140채널", "#140은색",
  ]) {
    const catalog = buildFactCatalog(report(`원문 ${token} 유지`));
    assert.ok(!catalog.facts.some((fact) => fact.type === "reference_number"), token);
  }
});

test("measurements, requirements, and ordinary counts still bind their source subjects", () => {
  for (const [source, from, to] of [
    ["restart 약 17초에서 약 9.5초로 단축", "restart", "boot"],
    ["요구 4·5 확인", "요구", "요구사항"],
    ["정확 키 단정 6곳 점검", "정확 키 단정", "다른 키 단정"],
    ["16개 센서 점검", "센서", "파일"],
    ["queue depth 140", "queue depth ", "진단 범위 #"],
  ]) {
    const raw = report(source);
    const catalog = buildFactCatalog(raw);
    const output = annotate(raw, catalog).replace(from, to);
    const validation = validate(raw, output, catalog);
    assert.equal(validation.status, "FAIL", `${from} -> ${to}`);
    assert.ok(validation.issues.some((issue) => issue.code === "fact_subject_mismatch"));
  }
});

test("sealed legacy hash-number quantities keep their original subject and target rules", () => {
  for (const [line, legacy] of [
    ["[Notion] 기록 #140", { type: "quantity", subject: "[Notion] 기록 #" }],
    ["[Notion] 기록 #140은", { type: "counted_quantity", subject: "[Notion] 기록 #", target: "은" }],
    ["[Notion] 기록 #140 진단", { type: "counted_quantity", subject: "진단" }],
  ]) {
    const raw = report(line);
    // A stored catalog owns the old classification; it must not be rebuilt or
    // silently upgraded when a later scanner recognizes new reference syntax.
    const catalog = buildFactCatalog(raw);
    const fact = catalog.facts.find((candidate) => candidate.raw === "140");
    Object.assign(fact, legacy, { semantic: { normalized: "140" } });
    catalog.catalogHash = hashObject({ schemaVersion: catalog.schemaVersion, facts: catalog.facts });
    const saved = JSON.stringify(catalog);
    const original = annotate(raw, catalog);
    assert.equal(validate(raw, original, catalog).status, "PASS", line);
    const changed = legacy.subject === "진단"
      ? original.replace("진단", "완료")
      : original.replace("기록", "다른 기록");
    assert.equal(validate(raw, changed, catalog).status, "FAIL", line);
    assert.equal(JSON.stringify(catalog), saved);
  }
});

test("unlabelled reference markers retain project ownership", () => {
  const knownPaths = [["PIM"], ["WirelessLan"]];
  const raw = `${header}\n- PIM\n  - 진단 범위 (#140)\n- WirelessLan\n  - 문서 정리\n`;
  const catalog = buildFactCatalog(raw, [], { knownPaths });
  const original = annotate(raw, catalog);
  assert.equal(validate(raw, original, catalog, { knownPaths }).status, "PASS");
  const moved = `${header}\n- PIM\n  - 문서 정리\n- WirelessLan\n  - 진단 범위 (#[[fact:Q0001|140]])\n`;
  const validation = validate(raw, moved, catalog, { knownPaths });
  assert.equal(validation.status, "FAIL");
  assert.ok(validation.issues.some((issue) => issue.code === "fact_section_mismatch"));
});
