const { test } = require("node:test");
const assert = require("node:assert");

const { buildFactCatalog } = require("../fact-catalog");
const { hasMarkerLikePrefixAt, parseAnnotatedDraft } = require("../annotated-draft");
const { normalizeFactSource, stripAstralChars } = require("../text-normalization");
const { extractSchemaV2FactOccurrences } = require("../fact-occurrences");
const { validateAnnotatedReport } = require("../fact-validator");
const {
  annotateFactReferences,
  expandFactReferences,
  formatSystemFactReferences,
  restoreUnmarkedCountedQuantityReferences,
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

test("identifier recovery never binds the Wireless iMX93 fact inside PIM", () => {
  const header = "#### 조현우";
  const knownPaths = [["PIM", "iMX8MP BSP"], ["Wireless Lan", "iMX93 BSP"]];
  const catalog = buildFactCatalog(
    `${header}\n- PIM\n  - iMX8MP BSP\n    - IIM-42652\n- Wireless Lan\n  - iMX93 BSP\n    - wlan-package\n`,
    [],
    { knownPaths }
  );
  const restored = restoreUnmarkedIdentifierReferences(
    `${header}\n- PIM\n  - iMX93 BSP\n`,
    catalog,
    { knownPaths }
  );
  assert.strictEqual(restored.includes("[[fact:"), false);
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

test("unique counted quantity context restores the exact source counter after Claude changes it", () => {
  const catalog = buildFactCatalog(
    "feat(scripts): PR 자동리뷰 3종 집계 게이트 추가 (#107)"
  );
  const aiOutput =
    "PR 자동리뷰 3자(Claude/Gemini/Codex) 집계 게이트 스크립트 신설";

  assert.strictEqual(
    restoreUnmarkedCountedQuantityReferences(aiOutput, catalog),
    "PR 자동리뷰 [[fact:Q0001|3]]종(Claude/Gemini/Codex) 집계 게이트 스크립트 신설"
  );
});

test("unique counted quantity context restores an attached Korean counter exactly", () => {
  const catalog = buildFactCatalog("플릿 16건 저장소 배포 완료");
  const aiOutput = "플릿 16개 저장소 배포 완료";

  assert.strictEqual(
    restoreUnmarkedCountedQuantityReferences(aiOutput, catalog),
    "플릿 [[fact:Q0001|16건]] 저장소 배포 완료"
  );
});

test("counted quantity recovery stays fail-closed for ambiguous context", () => {
  const catalog = buildFactCatalog([
    "alpha 자동리뷰 3종 집계 게이트 추가",
    "beta 자동리뷰 3종 집계 게이트 추가",
  ].join("\n"));
  const aiOutput = "자동리뷰 3자 집계 게이트 추가";

  assert.strictEqual(
    restoreUnmarkedCountedQuantityReferences(aiOutput, catalog),
    aiOutput
  );
});

test("counted quantity recovery never repairs a changed number or marker body", () => {
  const catalog = buildFactCatalog(
    "feat(scripts): PR 자동리뷰 3종 집계 게이트 추가"
  );
  const aiOutput = [
    "PR 자동리뷰 4자 집계 게이트 추가",
    "PR 자동리뷰 [[fact:Q0001|3]]종 집계 게이트 추가",
  ].join("\n");

  assert.strictEqual(
    restoreUnmarkedCountedQuantityReferences(aiOutput, catalog),
    aiOutput
  );
});

test("counted quantity recovery compares the complete decimal surface", () => {
  const catalog = buildFactCatalog("자동리뷰 3.5종 집계 게이트 추가");
  const changedNumber = "자동리뷰 3자 집계 게이트 추가";

  assert.strictEqual(
    restoreUnmarkedCountedQuantityReferences(changedNumber, catalog),
    changedNumber
  );
  assert.strictEqual(
    restoreUnmarkedCountedQuantityReferences("자동리뷰 3.5자 집계 게이트 추가", catalog),
    "자동리뷰 [[fact:Q0001|3.5]]종 집계 게이트 추가"
  );
});

test("a number right after a backslash stays an escape sequence, not a fact marker", () => {
  // 2026-11-04 weekly depth2: `tr '\000'` became `\[[fact:Q0072|000]]`, an escaped bracket.
  const raw = "게이트(`tr '\\000' '\\n' | grep -F x`) 플릿 16건 저장소 배포";
  const catalog = buildFactCatalog(raw, [
    { type: "meeting_date", raw: "2026-11-04", subject: "meeting date" },
  ]);

  const annotated = annotateFactReferences(raw, catalog);

  assert.strictEqual(
    annotated,
    "게이트(`tr '\\000' '\\n' | grep -F x`) 플릿 [[fact:Q0001]] 저장소 배포"
  );
  assert.deepStrictEqual(parseAnnotatedDraft(expandFactReferences(annotated, catalog)).errors, []);
});

test("only an escape body after an odd backslash run leaves the fact candidates", () => {
  const raws = (text) => extractSchemaV2FactOccurrences(text).map((occurrence) => occurrence.raw);
  for (const text of ["tr '\\000' x", "c \\033", "h \\x1F", "u \\u00e9"]) {
    assert.deepStrictEqual(raws(text), [], text);
  }
  // An escaped backslash and prose values keep their candidates (Tribunal A-R1-001).
  assert.deepStrictEqual(raws("p \\\\000"), ["000"]);
  assert.deepStrictEqual(raws("q \\99건 추가"), ["99건"]);
  assert.deepStrictEqual(raws("r \\0x1F 주소"), ["0x1F"]);
});

test("a backslash before a prose value does not hide an unmarked protected fact", () => {
  const raw = "- 플릿 16건 저장소 배포";
  const catalog = buildFactCatalog(raw, [
    { type: "meeting_date", raw: "2026-11-04", subject: "meeting date" },
  ]);
  const draft = expandFactReferences(annotateFactReferences(raw, catalog), catalog);
  assert.strictEqual(validateAnnotatedReport(raw, draft, catalog).validation.status, "PASS");
  for (const [extra, value] of [[" \\99건 추가", "99건"], [" \\0x1F 주소", "0x1F"]]) {
    const { validation } = validateAnnotatedReport(raw, draft + extra, catalog);
    assert.strictEqual(validation.status, "FAIL", extra);
    assert.ok(validation.issues.some((issue) =>
      issue.code === "unmarked_protected_fact" && issue.value === value), extra);
  }
});

test("AI input annotation neutralizes only the final ASCII backslash before each inserted fact marker", () => {
  const fixtures = [
    {
      raw: 'pgrep -c || echo 0 은 "0\\n0" 을 만든다',
      annotated: 'pgrep -c || echo [[fact:Q0001]] 은 "[[fact:Q0002]]∖[[fact:V0001]]" 을 만든다',
    },
    { raw: "\\99건", annotated: "∖[[fact:Q0001]]" },
    { raw: "C:\\v1.2.3", annotated: "C:∖[[fact:V0001]]" },
    { raw: "\\\\99건", annotated: "\\∖[[fact:Q0001]]" },
    { raw: "\\\\\\99건", annotated: "\\\\∖[[fact:Q0001]]" },
  ];

  assert.strictEqual("∖".normalize("NFKC"), "∖");
  for (const fixture of fixtures) {
    const rawBefore = fixture.raw;
    const catalog = buildFactCatalog(fixture.raw);
    const catalogBefore = structuredClone(catalog);
    const annotated = annotateFactReferences(fixture.raw, catalog);

    assert.strictEqual(annotated, fixture.annotated, fixture.raw);
    assert.deepStrictEqual(
      parseAnnotatedDraft(expandFactReferences(annotated, catalog)).errors,
      [],
      fixture.raw
    );
    assert.strictEqual(fixture.raw, rawBefore);
    assert.deepStrictEqual(catalog, catalogBefore, fixture.raw);
  }
});

test("raw backslash values and Markdown-escaped AI output markers remain fail-closed", () => {
  const raw = "경로 C:\\v1.2.3, 잔여 \\99건";
  const catalog = buildFactCatalog(raw);
  const annotated = annotateFactReferences(raw, catalog);
  const expanded = expandFactReferences(annotated, catalog);

  assert.deepStrictEqual(parseAnnotatedDraft(expanded).errors, []);
  const original = validateAnnotatedReport(raw, raw, catalog).validation;
  assert.strictEqual(original.status, "FAIL");
  assert.ok(original.issues.some((issue) => issue.code === "unmarked_protected_fact"));

  const escaped = expanded.replace("∖[[fact:V0001", "\\[[fact:V0001");
  const escapedValidation = validateAnnotatedReport(raw, escaped, catalog).validation;
  assert.strictEqual(escapedValidation.status, "FAIL");
  assert.ok(escapedValidation.issues.some((issue) => issue.code === "malformed_fact_marker"));
});

// 2026-11-11 rehearsal: a commit body quoting `\[[fact:Q0072]]` became `\[[fact:[[fact:V0005|Q0072]]]]`.
const markerQuotingBody = [
  "- Redmine 주간 보고 자동화",
  "  ↳ 변경: `lib/fact-occurrences.js`: `extractSchemaV2FactOccurrences`가 백슬래시 바로 뒤에서 시작하는 후보를 제외한다. 커밋 본문의 셸 코드 `tr '\\000' '\\n'`이 `\\[[fact:Q0072]]`로 표식되어 `malformed_fact_marker`·`unmarked_protected_fact`로 depth2가 차단되던 문제를 막는다.",
  "  ↳ 검증: 원문 표식 [[source:C0001]] 그대로 16건 확인",
].join("\n");
const meetingDateFact = { type: "meeting_date", raw: "2026-11-11", subject: "meeting date" };

test("fact and source marker syntax quoted in the source stays well formed through catalog, annotate, expand and parse", () => {
  const catalog = buildFactCatalog(markerQuotingBody, [meetingDateFact]);
  const protectedId = catalog.facts.find((fact) => fact.raw === "Q0072")?.id;
  assert.ok(protectedId, "the quoted value stays a protected fact");
  const annotated = annotateFactReferences(markerQuotingBody, catalog);
  assert.ok(annotated.includes(`\`\\⟦[fact:[[fact:${protectedId}]]]]\``), annotated);
  const sourceId = catalog.facts.find((fact) => fact.raw === "C0001")?.id;
  assert.ok(sourceId && annotated.includes(`⟦[source:[[fact:${sourceId}]]]]`), annotated);
  const expanded = expandFactReferences(annotated, catalog);
  assert.deepStrictEqual(parseAnnotatedDraft(expanded).errors, []);
});

test("an output that leaves the quoted protected value unmarked still fails closed", () => {
  const catalog = buildFactCatalog(markerQuotingBody, [meetingDateFact]);
  const output = "- Redmine 주간 보고 자동화\n  ↳ 변경: 커밋 본문의 Q0072 표식 오탐을 막는다.";
  const { validation } = validateAnnotatedReport(markerQuotingBody, output, catalog);
  assert.strictEqual(validation.status, "FAIL");
  assert.ok(validation.issues.some((issue) =>
    issue.code === "unmarked_protected_fact" && issue.value === "Q0072"), JSON.stringify(validation.issues));
  assert.ok(!validation.issues.some((issue) => issue.code === "malformed_fact_marker"));
  // The output grammar is unchanged: re-quoting the original marker syntax is still malformed.
  const requoted = validateAnnotatedReport(markerQuotingBody, `${output} \`\\[[fact:Q0072]]\``, catalog);
  assert.ok(requoted.validation.issues.some((issue) => issue.code === "malformed_fact_marker"));
});

test("fact source normalization neutralizes every marker-like opening bracket without moving any offset", () => {
  const raw = [
    "셸 `\\[[fact:Q0072]]`와 리터럴 [[source:C0001]]",
    "전각 ［［fact:T0001]] 공백 [ ​[ source :C0002]] 겹침 [[[fact:V0001]]",
    "이모지\u{1F600} 일반 [링크](x) [[note]] [fact:x] 5/8 PASS",
  ].join("\n");
  const normalized = normalizeFactSource(raw);
  assert.strictEqual(normalized, [
    "셸 `\\⟦[fact:Q0072]]`와 리터럴 ⟦[source:C0001]]",
    "전각 ⟦［fact:T0001]] 공백 ⟦ ​[ source :C0002]] 겹침 [⟦[fact:V0001]]",
    "이모지 일반 [링크](x) [[note]] [fact:x] 5/8 PASS",
  ].join("\n"));
  assert.strictEqual(normalized.length, stripAstralChars(raw).length);
  assert.strictEqual(normalized.split("\n").length, raw.split("\n").length);
  for (let index = 0; index < normalized.length; index += 1) {
    for (const name of ["fact", "source"]) {
      assert.strictEqual(hasMarkerLikePrefixAt(normalized, index, name), false, `${name} at ${index}`);
    }
  }
  assert.strictEqual("⟦".normalize("NFKC"), "⟦");
  assert.strictEqual(normalizeFactSource(normalized), normalized);
});

test("a measurement line quoting marker syntax is not team evidence, so copying the source still validates", () => {
  const raw = "#### <span style=\"color:blue\">조현우</span>\n- PIM\n  - Application\n    - [Notion] 접수 [[source:C0001]] 시작 시간 10→5.2초 단축\n";
  const catalog = buildFactCatalog(raw, [meetingDateFact], { teamReport: true, knownPaths: [["PIM"]] });
  // A display holding the neutralized "⟦[source:…]]" would close its expanded marker early, so no output could pass.
  assert.ok(!catalog.facts.some((fact) => /^M\d{4}$/.test(fact.id)
    && [fact.raw, fact.display].some((text) => String(text).includes("⟦"))), JSON.stringify(catalog.facts));
  const output = expandFactReferences(annotateFactReferences(raw, catalog), catalog);
  const { validation } = validateAnnotatedReport(raw, output, catalog);
  assert.deepStrictEqual(validation.issues, []);
  assert.strictEqual(validation.status, "PASS");
});


test("validated clean output restores source backslashes without changing genuine set-minus characters", () => {
  for (const raw of [
    String.raw`pgrep -c || echo 0 은 "0\n0" 을 만든다`,
    String.raw`\99건`, String.raw`C:\v1.2.3`,
    String.raw`\\99건`, String.raw`\\\99건`,
    String.raw`C:\v1.2.3; D:∖v1.2.3`,
  ]) {
    const catalog = buildFactCatalog(raw);
    const saved = JSON.stringify(catalog);
    const expanded = expandFactReferences(annotateFactReferences(raw, catalog), catalog);
    const result = validateAnnotatedReport(raw, expanded, catalog);
    assert.strictEqual(result.validation.status, "PASS", JSON.stringify(result.validation.issues));
    assert.strictEqual(result.cleanContent, normalizeFactSource(raw), raw);
    assert.strictEqual(JSON.stringify(catalog), saved);
    assert.ok(expanded.includes("∖[[fact:"));
    assert.deepStrictEqual(parseAnnotatedDraft(expanded).errors, []);
    const escaped = expanded.replace("∖[[fact:", "\\[[fact:");
    assert.strictEqual(validateAnnotatedReport(raw, escaped, catalog).validation.status, "FAIL");
  }
});

test("clean restoration requires the claimed source occurrence to have an ASCII backslash", () => {
  const raw = String.raw`C:∖v1.2.3`;
  const catalog = buildFactCatalog(raw);
  const expanded = expandFactReferences(annotateFactReferences(raw, catalog), catalog);
  const result = validateAnnotatedReport(raw, expanded, catalog);
  assert.strictEqual(result.validation.status, "PASS");
  assert.strictEqual(result.cleanContent, raw);

  const plain = buildFactCatalog("C:v1.2.3");
  const introduced = expandFactReferences("C:∖[[fact:V0001]]", plain);
  assert.strictEqual(validateAnnotatedReport("C:v1.2.3", introduced, plain).cleanContent, raw);
});


test("backslash restoration rejects moved or edited context and preserves the output symbol", () => {
  const { assertPublishable } = require("../../index");
  for (const [raw, factRaw, output] of [
    [String.raw`C:\v1.2.3`, "v1.2.3", "moved ∖{{fact}}"],
    [String.raw`\99건`, "99건", "moved ∖{{fact}}"],
    [String.raw`"0\n0"`, "n0", "moved ∖{{fact}}"],
    [String.raw`before C:\v1.2.3`, "v1.2.3", "after C:∖{{fact}}"],
    [String.raw`C:\v1.2.3`, "v1.2.3", "C:∖{{fact}} extra"],
    [String.raw`C:\v1.2.3`, "v1.2.3", "C:<u>∖{{fact}}</u>"],
    [String.raw`\\99건`, "99건", "∖{{fact}}"],
  ]) {
    const catalog = buildFactCatalog(raw);
    const before = JSON.stringify(catalog);
    const fact = catalog.facts.find(f => f.raw === factRaw);
    assert.ok(fact, raw);
    const annotated = output.replace("{{fact}}", `[[fact:${fact.id}|${fact.raw}]]`);
    const result = validateAnnotatedReport(raw, annotated, catalog);
    assert.strictEqual(result.cleanContent, output.replace("{{fact}}", fact.raw), raw);
    assert.strictEqual(result.validation.status, "FAIL", raw);
    assert.ok(result.validation.issues.some(issue => issue.code === "fact_evidence_mismatch"), raw);
    assert.throws(() => assertPublishable(result.validation, {env: {validationMode: "warn", validationOverride: true}}));
    assert.strictEqual(JSON.stringify(catalog), before);
    assert.deepStrictEqual(parseAnnotatedDraft(annotated).errors, []);
  }
});

test("source ASCII and genuine Unicode lines with the same projected body are ambiguous", () => {
  for (const raw of [
    String.raw`C:\v1.2.3` + "\n" + String.raw`C:∖v1.2.3`,
    String.raw`C:\v1.2.3 D:\v2.3.4` + "\n" + String.raw`C:∖v1.2.3 D:\v2.3.4`,
  ]) {
    const catalog = buildFactCatalog(raw);
    const firstLine = expandFactReferences(annotateFactReferences(raw, catalog), catalog).split("\n")[0];
    const result = validateAnnotatedReport(raw, firstLine, catalog);
    assert.strictEqual(result.validation.status, "FAIL");
    assert.ok(result.validation.issues.some(issue => issue.code === "fact_evidence_mismatch"));
    assert.strictEqual(result.cleanContent, parseAnnotatedDraft(firstLine).cleanContent);
  }
});

test("restoration provenance is local to each output line even when the fact ID repeats", () => {
  const raw = String.raw`C:\v1.2.3`;
  const catalog = buildFactCatalog(raw);
  const copied = expandFactReferences(annotateFactReferences(raw, catalog), catalog);
  const fact = catalog.facts.find(f => f.raw === "v1.2.3");
  const moved = `moved ∖[[fact:${fact.id}|${fact.raw}]]`;
  const result = validateAnnotatedReport(raw, `${copied}\n${moved}`, catalog);
  assert.strictEqual(result.cleanContent, `${raw}\nmoved ∖${fact.raw}`);
  assert.strictEqual(result.validation.status, "FAIL");
});
