const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildFactCatalog } = require("../fact-catalog");
const { annotateFactReferences, expandFactReferences } = require("../fact-references");
const { validateAnnotatedReport } = require("../fact-validator");
const { hashObject } = require("../report-artifact");
const { createFactContextProjection } = require("../fact-context-projection");

const header = '#### <span style="color:blue">조현우</span>';
const options = { sectionHeader: header, reportDepth: 3 };
const report = (line) => `${header}\n- ${line}\n`;
const annotate = (raw, catalog) => expandFactReferences(annotateFactReferences(raw, catalog), catalog);
const validate = (raw, content, catalog, overrides = {}) =>
  validateAnnotatedReport(raw, content, catalog, { ...options, ...overrides }).validation;

test("unlabelled references bind their source clause while other prose can be rewritten", () => {
  const sourceLine = "[Notion] sd-mount 진단과 actions.log 유지, #140·#141 진단 범위";
  const raw = report(`${sourceLine}\n- 이전 문서 정리`);
  const catalog = buildFactCatalog(raw);
  assert.deepEqual(catalog.facts.map(({ raw: value, type, subject }) => [value, type, subject]), [
    ["140", "reference_number", "hash_reference"],
    ["141", "reference_number", "hash_reference"],
  ]);
  assert.deepEqual(catalog.facts[0].semantic.referenceContext, ["조현우", sourceLine]);
  const preserved = annotate(raw, catalog).replace("이전 문서 정리", "운영 문서의 설명을 보강");
  assert.equal(validate(raw, preserved, catalog).status, "PASS");
  const marked = report("actions.log 유지와 진단 범위 정리 (#[[fact:Q0001|140]]·#[[fact:Q0002|141]])");
  assert.equal(validate(raw, marked, catalog).status, "FAIL");
});

test("hash reference lists allow Korean particles and display-only underline markup", () => {
  for (const separator of ["·", ", ", " / "]) {
    const raw = report(`[Notion] 진단 범위: #140${separator}#141은 기록에 연결`);
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

test("labelled references reject markup, incomplete tokens, and inherited destinations", () => {
  for (const label of ["PR", "이슈", "issue"]) {
    const raw = report(`${label} #140`);
    const catalog = buildFactCatalog(raw);
    const marked = `${label} #[[fact:Q0001|140]]`;
    for (const line of [
      `[${marked}](https://example.test/wrong)`, `![${marked}](https://example.test/wrong)`,
      `[기록](${marked})`, `[기록]: ${marked}`, `[기록]:\n- ${marked}`,
      `<a href="https://example.test/wrong">${marked}</a>`,
      `<a href="\n- ${marked}\n">기록</a>`, `\`${marked}\``,
      `\`\`\`text\n- ${marked}\n\`\`\``, `[기록](\n- ${marked}\n)`,
      `${marked}/../../wrong`, `${marked}.md`, `${marked}?view=diff`, `${marked}#section`,
      `${marked}\\path`, `${marked}abc`, `${marked}\u200d`,
      `\\${marked}`, `${label} \\#[[fact:Q0001|140]]`, `repo/${marked}`,
    ]) {
      const validation = validate(raw, report(line), catalog);
      assert.equal(validation.status, "FAIL", `${label}: ${line}`);
      assert.ok(validation.issues.some(issue => issue.code === "fact_subject_mismatch"), line);
    }
    for (const content of [
      `${header}\n    ${marked}\n`, `${header}\n    - ${marked}\n`, report(`    ${marked}`),
    ]) {
      assert.equal(validate(raw, content, catalog).status, "FAIL", content);
    }
  }
});

test("plain labelled references preserve safe lists, canonical text, and sentence rewrites", () => {
  for (const label of ["PR", "이슈", "issue"]) {
    const raw = report(`[Notion] 검증 (${label} #140·#141)`);
    const catalog = buildFactCatalog(raw);
    assert.ok(catalog.facts.every(fact => fact.type === "reference_number"));
    const content = report(`<u>후속 확인 (${label} #[[fact:Q0001|140]]·#[[fact:Q0002|141]])</u>`);
    assert.equal(validate(raw, content, catalog).status, "PASS", label);
    for (const text of [`${label} #140`, `${label}#140`]) {
      const plain = buildFactCatalog(text);
      assert.equal(plain.facts[0].type, "reference_number", text);
      assert.equal(validate(text, report(`${label} #[[fact:Q0001|140]] 확인`), plain).status, "PASS", text);
    }
  }
});

test("indented headings and their continuations make an unlabelled owner non-terminal", () => {
  for (const indent of ["", "  "]) {
    const raw = `${header}\n${indent}- 진단 범위 (#140)\n`;
    const catalog = buildFactCatalog(raw);
    const marked = annotate(raw, catalog);
    for (const child of [
      `${indent}  ### ticket\n`, `${indent}  ### ticket\n${indent}    작업 설명\n`,
      `${indent}\t### ticket\n`,
    ]) {
      const validation = validate(raw, marked + child, catalog);
      assert.equal(validation.status, "FAIL", child);
      assert.ok(validation.issues.some(issue => issue.code === "fact_subject_mismatch"));
    }
    assert.equal(validate(raw, marked + "## 다음 항목\n- 별도 설명\n", catalog).status, "PASS");
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

test("unlabelled reference markers cannot become Markdown destinations or rich markup", () => {
  const raw = report("진단 범위 (#140)");
  const catalog = buildFactCatalog(raw);
  const ref = "#[[fact:Q0001|140]]";
  for (const line of [
    `[기록](${ref})`, `[기록](<${ref}>)`, `[기록](\n  ${ref}\n)`,
    `[${ref}](https://example.test/)`, `![기록](${ref})`,
    `[기록]: ${ref}`, `[기록]:\n  ${ref}`,
    `[기록](\n  - ${ref}\n)`, `[기록](\n- ${ref}\n)`, `\`${ref}\``,
    `<a href="${ref}">기록</a>`, `<a href="\n  - ${ref}\n">기록</a>`,
    `<a href="\n- ${ref}\n">기록</a>`, `[기록]:\n- ${ref}`,
    `<a href=">\n- ${ref}\n">기록</a>`,
    `[기록](https://example.test/ "제목 )\n- ${ref}\n")`,
    `\`\`\`text\n- ${ref}\n\`\`\``,
  ]) {
    const validation = validate(raw, report(line), catalog);
    assert.equal(validation.status, "FAIL", line);
    assert.ok(validation.issues.some((issue) => issue.code === "fact_subject_mismatch"), line);
  }
});

test("unlabelled reference lists reject complete path and URL tokens for every member", () => {
  const raw = report("진단 범위 (#140·#141)");
  const catalog = buildFactCatalog(raw);
  const first = "#[[fact:Q0001|140]]", second = "#[[fact:Q0002|141]]";
  for (const line of [
    `${first}/foo`, `${first}.md`, `${first}?view=diff`, `${first}#section`,
    `${first}\\foo`, `mailto:${first}`, `https:${first}`, `(${first}).md`,
    `${first}/${second}/foo`, `${first}·${second}.md`, `${first}, ${second}?view=diff`,
  ]) {
    const validation = validate(raw, report(line), catalog);
    assert.equal(validation.status, "FAIL", line);
    for (const factId of ["Q0001", ...(line.includes(second) ? ["Q0002"] : [])]) {
      assert.ok(validation.issues.some((issue) =>
        issue.code === "fact_subject_mismatch" && issue.factId === factId), `${factId}: ${line}`);
    }
  }
});

test("unlabelled references cannot gain labels through punctuation or parent context", () => {
  const raw = report("진단 범위 (#140·#141)");
  const catalog = buildFactCatalog(raw);
  const first = "#[[fact:Q0001|140]]", second = "#[[fact:Q0002|141]]";
  for (const line of [
    `PR: ${first}`, `PR(${first})`, `issue — (${first})`, `이슈：${first}`,
    `PR: (${first}·${second})`, `ISSUE {${first}/${second}}`,
    `${first} (PR)`, `PR:\n  - ${first}`, `issue —\n  - ${first}`,
    `PR:\n\n  - ${first}`, `**PR:**\n  - ${first}`, `P*R*: ${first}`,
    `P\u200dR: ${first}`, `P&#82;: ${first}`, `ＰＲ： ${first}`, `제목\n## PR\n- ${first}`,
    `pull request ${first}`, `ticket ${first}`, `작업 ${first}`,
    `merge request ${first}`, `검토건 ${first}`, `발표노트 ${first}`,
    `ticket:\n  - 진단 범위 (${first}·${second})`,
    `진단 범위 (${first}·${second})\n  - 작업`,
  ]) {
    const validation = validate(raw, report(line), catalog);
    assert.equal(validation.status, "FAIL", line);
    for (const factId of ["Q0001", ...(line.includes(second) ? ["Q0002"] : [])]) {
      assert.ok(validation.issues.some((issue) =>
        issue.code === "fact_subject_mismatch" && issue.factId === factId), `${factId}: ${line}`);
    }
  }
});

test("plain reference bullets retain parentheses, punctuation, lists, and safe parent sections", () => {
  for (const line of [
    "진단 범위 (#140·#141).",
    "진단 범위 #140, #141.",
    "진단 범위 (#140 / #141)은 기록에 연결",
  ]) {
    const raw = `${header}\n- PIM\n  - [Notion] ${line}\n  - 이전 설명\n`;
    const catalog = buildFactCatalog(raw);
    const content = annotate(raw, catalog).replace("[Notion] ", "").replace("이전 설명", "운영 설명을 보강");
    assert.equal(validate(raw, content, catalog).status, "PASS", line);
  }
});

test("ambiguous source contexts retain the original quantity grammar and canonical round trip", () => {
  for (const line of ["[기록](#140)", "#140/foo", "PR: #140", "issue — (#140)"]) {
    const raw = report(line);
    const catalog = buildFactCatalog(raw);
    if (line.startsWith("[") || line.includes("/foo")) {
      assert.ok(catalog.facts.every((fact) => fact.type !== "reference_number"), line);
    }
    assert.equal(validate(raw, annotate(raw, catalog), catalog).status, "PASS", line);
  }
});

test("unlabelled reference context cannot be omitted, forged, or upgraded in a sealed catalog", () => {
  const raw = report("진단 범위 (#140)");
  const original = buildFactCatalog(raw);
  for (const mutation of [
    fact => { delete fact.semantic.referenceContext; },
    fact => { fact.semantic.referenceContext = ["조현우", "ticket #140"]; },
    fact => { delete fact.subject; },
    fact => { fact.subject = ""; },
    fact => { fact.sourceLocation.start += 1; },
    fact => { fact.sourceLocation.line += 1; },
    fact => { fact.subject = "pull_request"; fact.semantic.referenceKind = "pull_request"; },
  ]) {
    const catalog = JSON.parse(JSON.stringify(original));
    mutation(catalog.facts[0]);
    catalog.catalogHash = hashObject({ schemaVersion: catalog.schemaVersion, facts: catalog.facts });
    const content = report("진단 범위 (#[[fact:Q0001|140]])");
    const validation = validate(raw, content, catalog);
    assert.equal(validation.status, "FAIL");
    assert.ok(validation.issues.some(issue => issue.code === "fact_evidence_mismatch"));
  }
});

test("only an exact branded projection permits code-owned regrouping of a bound reference clause", () => {
  const raw = `${header}\n- PIM\n  - 원문 분류\n    - 진단 범위 (#140)\n`;
  const knownPaths = [["PIM"]];
  const catalog = buildFactCatalog(raw, [], { knownPaths });
  const content = `${header}\n- PIM\n  - 보고서 구성\n    - 진단 범위 (#[[fact:Q0001|140]])\n`;
  assert.equal(validate(raw, content, catalog, { knownPaths }).status, "FAIL");
  const projection = value => createFactContextProjection(value, {
    catalogHash: catalog.catalogHash, sourceRecordsHash: "a".repeat(64), profile: "team_summary_v1",
  });
  const proof = projection(content);
  assert.equal(validate(raw, content, catalog, { knownPaths, factContextProjection: proof }).status, "PASS");
  for (const factContextProjection of [true, {}, JSON.parse(JSON.stringify(proof))]) {
    assert.equal(validate(raw, content, catalog, { knownPaths, factContextProjection }).status, "FAIL");
  }
  const changed = content.replace("진단 범위", "ticket");
  assert.equal(validate(raw, changed, catalog, { knownPaths, factContextProjection: proof }).status, "FAIL");
  const retyped = `${header}\n- PIM\n  - 보고서 구성\n    - PR #[[fact:Q0001|140]]\n`;
  assert.equal(validate(raw, retyped, catalog, { knownPaths, factContextProjection: projection(retyped) }).status, "FAIL");
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
