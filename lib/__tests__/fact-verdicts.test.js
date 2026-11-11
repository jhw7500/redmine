const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildFactCatalog } = require("../fact-catalog");
const { annotateFactReferences, expandFactReferences } = require("../fact-references");
const { validateAnnotatedReport } = require("../fact-validator");
const { hashObject } = require("../report-artifact");
const { assertPublishable } = require("../../index");

const sectionHeader = '#### <span style="color:blue">조현우</span>';
const options = { sectionHeader, reportDepth: 3, meetingDate: "2026-11-11" };

function fixture(lines) {
  const raw = `${sectionHeader}\n${lines}\n`;
  const catalog = buildFactCatalog(raw);
  const annotated = expandFactReferences(annotateFactReferences(raw, catalog), catalog);
  const validate = (output = annotated) => validateAnnotatedReport(raw, output, catalog, options).validation;
  assert.equal(validate().status, "PASS", JSON.stringify(validate().issues));
  return { raw, catalog, annotated, validate };
}

test("standalone verdict changes fail even without a number or version", () => {
  for (const [before, after] of [["FAIL", "PASS"], ["PASS", "FAIL"], ["실패", "통과"], ["통과", "실패"]]) {
    const { annotated, validate } = fixture(`- jq 설치 ${before}`);
    assert.equal(validate(annotated.replace(before, after)).status, "FAIL", `${before} -> ${after}`);
  }
});

test("verdicts next to a marked version remain independently protected", () => {
  const { annotated, validate } = fixture("- jq 1.7.1 테스트 FAIL");
  assert.equal(validate(annotated.replace("FAIL", "PASS")).status, "FAIL");
});

test("a verdict cannot be reassigned to another test or command", () => {
  for (const result of ["PASS", "FAIL", "통과", "실패", "3 PASS"] ) {
    const { annotated, validate } = fixture(`- 보드검사 ${result}`);
    assert.equal(validate(annotated.replace("보드검사", "다른명령")).status, "FAIL", result);
  }
});

test("compact numeric test verdicts stay bound to their test without word boundaries", () => {
  for (const result of ["3PASS", "3pass", "PASS3/0", "pass3/0", "3/3PASS", "3건PASS·FAIL0건"]) {
    const { annotated, validate } = fixture(`- 보드검사 ${result}`);
    const moved = validate(annotated.replace("보드검사", "다른명령"));
    assert.equal(moved.status, "FAIL", result);
    assert.ok(moved.issues.some(issue => issue.code === "verdict_context_mismatch"), result);
    assert.throws(() => assertPublishable(moved, { env: { validationMode: "warn", validationOverride: true } }));
    const line = annotated.split("\n").find(line => line.includes("보드검사"));
    assert.equal(validate(`${annotated}${line}\n`).status, "FAIL", `${result} repeated`);
  }
});

test("changing the parent command of a nested verdict fails", () => {
  const { annotated, validate } = fixture("- 보드검사\n  - 결과 PASS");
  assert.equal(validate(annotated.replace("보드검사", "다른명령")).status, "FAIL");
});

test("an invented standalone verdict is rejected anywhere in the report", () => {
  const { annotated, validate } = fixture("- jq 설치 확인");
  for (const added of ["PASS", "FAIL", "통과", "실패"]) {
    assert.equal(validate(`${annotated}- 추가 확인 ${added}\n`).status, "FAIL", added);
  }
});

test("a numeric verdict fact cannot be reused for a second assertion", () => {
  const { annotated, validate } = fixture("- 보드검사 3 PASS");
  const line = annotated.split("\n").find((line) => line.includes("보드검사"));
  assert.equal(validate(`${annotated}${line}\n`).status, "FAIL");
});

test("the verdict cannot be removed from an otherwise selected test assertion", () => {
  const { annotated, validate } = fixture("- jq 1.7.1 설치 FAIL");
  const withoutVerdict = annotated.replace(/\[\[fact:T\d{4}\|FAIL\]\]|FAIL/, "").trimEnd() + "\n";
  assert.equal(validate(withoutVerdict).status, "FAIL");
});

test("verdict vocabulary respects identifiers but protects hyphenated outcomes and Korean stems", () => {
  const identifiers = buildFactCatalog("PASSWORD FAILURE bypass pass_count fail-closed");
  assert.equal(identifiers.facts.filter(fact => fact.type === "test_verdict").length, 0);
  for (const result of [
    "LOAD-FAIL", "test-PASS", "통과했고", "실패하지 않음",
    "검사 통과", "실패 0건", "통과했다", "실패함", "통과됨",
  ]) {
    const { annotated, validate } = fixture(`- 설치 ${result}`);
    assert.equal(validate(annotated.replace(/PASS|FAIL|통과|실패/, "완료")).status, "FAIL", result);
  }
});

test("verdict statements preserve negation and conditions rather than inferring a result", () => {
  for (const line of ["보드검사 통과하지 않음", "의존성 설치 시에만 보드검사 PASS"]) {
    const { annotated, validate } = fixture(`- ${line}`);
    for (const part of ["하지 않음", "설치 시에만 "]) {
      if (annotated.includes(part)) assert.equal(validate(annotated.replace(part, "")).status, "FAIL", line);
    }
  }
});

test("Korean verdict nouns remain exact protected values without verdict context ownership", () => {
  for (const nominal of [
    "실패 복원", "실패·복원", "실패 원인", "실패 처리", "통과 기준",
  ]) {
    const { catalog, annotated, validate } = fixture(`- 설치 ${nominal} 보강`);
    const fact = catalog.facts.find(candidate => candidate.raw === nominal.slice(0, 2));
    assert.equal(fact?.type, "protected_token", nominal);
    assert.equal(validate(annotated.replace(nominal.slice(0, 2), "완료")).status, "FAIL", nominal);
  }

  const incident = fixture(
    "- 기존 보드 고정 패키지 배포·백업·실패 복원 실행기와 빌드서버 인계 준비 완료. 실제 중앙 활성화 및 보드 배포·E2E는 승인 대기."
  );
  assert.equal(incident.catalog.facts.find(fact => fact.raw === "실패")?.type, "protected_token");
  assert.equal(
    incident.validate(incident.annotated.replace(" 완료. 실제", " 완료.\n  - 실제")).status,
    "PASS"
  );
});

test("ambiguous attached compounds fail closed as verdicts", () => {
  const { catalog } = fixture("- 설치 실패복원 보강");
  assert.equal(catalog.facts.find(fact => fact.raw === "실패")?.type, "test_verdict");
});

test("Korean outcome predicates stay bound to their target and condition", () => {
  for (const outcome of [
    "실패입니다",
    "실패임",
    "실패였다",
    "실패로 끝났다",
    "실패 보고",
    "실패였으며 원인을 기록했다",
  ]) {
    const source = `- PIM\n  - 조건A에서 TestA ${outcome}`;
    const { catalog, annotated, validate } = fixture(source);
    assert.equal(catalog.facts.find(fact => fact.raw === "실패")?.type, "test_verdict", outcome);
    for (const changed of [
      annotated.replace("TestA", "TestB"),
      annotated.replace("조건A", "조건B"),
    ]) {
      const result = validate(changed);
      assert.equal(result.status, "FAIL", `${outcome}: ${changed}`);
      assert.ok(result.issues.some(issue => issue.code === "verdict_context_mismatch"), outcome);
    }
  }
});

test("new Korean verdict nouns cannot borrow a source verdict or change its result", () => {
  const { annotated, validate } = fixture("- 보드검사 FAIL");
  for (const added of ["통과 결과", "통과 보고"]) {
    const result = validate(`${annotated}- ${added}\n`);
    assert.equal(result.status, "FAIL", added);
    assert.ok(result.issues.some(issue => issue.code === "unmarked_protected_fact"), added);
  }
});

test("new verdicts cannot hide behind HTML, entities, compatibility or invisible characters", () => {
  const { annotated, validate } = fixture("- 설치 확인");
  for (const verdict of ["PA<b></b>SS", "P\u200bASS", "ＰＡＳＳ", "P&#65;SS", "통<wbr>과", "P**AS**S", "P[A](https://example.invalid)SS", "P&zwj;ASS", 'P<span title=">"></span>ASS', "P<!-- hidden > -->ASS", "P&Ascr;SS", "&Pfr;&Afr;&Sscr;&Sscr;", "&Ffr;&Afr;&Ifr;&Lfr;", "P[A][verdict]SS\n[verdict]: https://example.invalid", "P[A][]SS\n[A]: https://example.invalid", "P[A]SS\n[A]: https://example.invalid"]) {
    assert.equal(validate(`${annotated}- 추가 ${verdict}\n`).status, "FAIL", verdict);
  }
});

test("source-owned entities and reference links remain valid without interpreting their displayed meaning", () => {
  fixture("- 출처 P&Ascr;SS\n- P[A][verdict]SS\n[verdict]: https://example.invalid");
});

test("Markdown projection limits cannot hide invented verdicts or permit override", () => {
  const { annotated, validate } = fixture("- 설치 확인");
  for (const depth of [33, 65, 256]) {
    const destination = "(".repeat(depth) + "source" + ")".repeat(depth);
    for (const [label, suffix] of [["P", "ASS"], ["F", "AIL"], ["통", "과"], ["실", "패"]]) {
      const result = validate(`${annotated}- 확인 [${label}](${destination})${suffix}\n`);
      assert.equal(result.status, "FAIL", `${depth}: ${label}+${suffix}`);
      assert.ok(result.issues.some(issue => issue.code === "verdict_context_mismatch"));
      assert.throws(() => assertPublishable(result, { env: { validationMode: "warn", validationOverride: true } }));
    }
  }
});

test("source-owned over-budget Markdown stays valid through exact row evidence", () => {
  const destination = "(".repeat(65) + "source" + ")".repeat(65);
  fixture(`- 원문 [P](${destination})ASS`);
});

test("verdicts permit closed version normalization and whole-line highlighting", () => {
  const { annotated, validate } = fixture("- jq 1.7.1 설치 PASS");
  assert.equal(validate(annotated.replace("|1.7.1]]", "|v1.7.1]]")).status, "PASS");
  assert.equal(validate(annotated.replace(/^- (.+)$/m, "- <u>$1</u>")).status, "PASS");
});

test("the collector's Notion provenance label may be omitted without changing a test assertion", () => {
  const { annotated, validate } = fixture("- [Notion] jq 설치 PASS");
  assert.equal(validate(annotated.replace("[Notion] ", "")).status, "PASS");
  assert.equal(validate(annotated.replace("[Notion] jq", "다른명령")).status, "FAIL");
});

test("a verdict statement cannot invent Notion provenance", () => {
  const { annotated, validate } = fixture("- jq 설치 PASS");
  assert.equal(validate(annotated.replace("- jq", "- [Notion] jq")).status, "FAIL");
});

test("complete independent verdict statements may be reordered without reassigning their IDs", () => {
  const { annotated, validate } = fixture("- 보드검사 PASS\n- 설치검사 FAIL");
  const lines = annotated.trimEnd().split("\n");
  assert.equal(validate([lines[0], lines[2], lines[1], ""].join("\n")).status, "PASS");
});

test("omitting an entire verdict record does not require selecting it in a summary", () => {
  const { validate } = fixture("- jq 1.7.1 설치 FAIL\n- 문서 정리");
  assert.equal(validate(`${sectionHeader}\n- 문서 정리\n`).status, "PASS");
});

test("a legacy catalog without verdict owners requires regeneration", () => {
  const { raw, catalog, annotated } = fixture("- jq 1.7.1 설치 FAIL");
  const legacy = { ...catalog, facts: catalog.facts.filter(fact => fact.type !== "test_verdict") };
  const result = validateAnnotatedReport(raw, annotated.replace(/\[\[fact:T\d{4}\|FAIL\]\]/, "FAIL"), legacy, options);
  assert.equal(result.validation.status, "FAIL");
  assert.ok(result.validation.issues.some(issue => issue.code === "verdict_catalog_mismatch"));
});

test("a hash-consistent legacy typed verdict retains its original row context", () => {
  const raw = `${sectionHeader}\n- 조건A에서 TestA 실패 복원 실행기와 E2E 준비 완료.\n`;
  const current = buildFactCatalog(raw);
  const facts = current.facts.map(fact => fact.raw === "실패"
    ? { ...fact, type: "test_verdict", semantic: { verdict: "실패" } }
    : fact);
  const legacy = {
    schemaVersion: current.schemaVersion,
    facts,
    catalogHash: hashObject({ schemaVersion: current.schemaVersion, facts }),
  };
  const annotated = expandFactReferences(annotateFactReferences(raw, legacy), legacy);
  const validate = output => validateAnnotatedReport(raw, output, legacy, options).validation;

  assert.equal(validate(annotated).status, "PASS");
  for (const changed of [
    annotated.replace("TestA", "TestB"),
    annotated.replace(" 실행기와 ", " 실행기와\n  - "),
  ]) {
    const result = validate(changed);
    assert.equal(result.status, "FAIL", changed);
    assert.ok(result.issues.some(issue => issue.code === "verdict_context_mismatch"), changed);
  }
});

test("a new parent cannot be inserted around a correctly marked verdict", () => {
  const { annotated, validate } = fixture("- 보드검사 PASS");
  const nested = annotated.replace("- 보드검사", "- 다른명령\n  - 보드검사");
  assert.equal(validate(nested).status, "FAIL");
});

test("changing a target nested below a verdict fails", () => {
  const { annotated, validate } = fixture("- 결과 PASS\n  - jq 설치검사");
  assert.equal(validate(annotated.replace("jq 설치검사", "다른명령")).status, "FAIL");
});

test("a selected parent fact cannot silently lose its nested verdict", () => {
  const { annotated, validate } = fixture("- jq 1.7.1 설치검사\n  - 결과 FAIL");
  const removed = annotated.split("\n").filter(line => !line.includes("결과")).join("\n");
  assert.equal(validate(removed).status, "FAIL");
});

test("a selected descendant fact cannot silently lose its ancestor verdict", () => {
  const statuses = [
    "- 결과 FAIL\n  - jq 1.7.1 설치검사",
    "- 결과 FAIL\n  - 설치 환경\n    - jq 1.7.1 설치검사",
  ].map(source => {
    const { annotated, validate } = fixture(source);
    const selectedLeaf = annotated.split("\n").find(line => line.includes("jq"));
    return validate(`${sectionHeader}\n${selectedLeaf.trimStart()}\n`).status;
  });
  assert.deepEqual(statuses, ["FAIL", "FAIL"]);
});
