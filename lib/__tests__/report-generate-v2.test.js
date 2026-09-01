const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { isPublishable, runGenerate, runGenerateV2 } = require("../../index");
const { sha256 } = require("../report-artifact");
const {
  makeFakeClaude,
  makeSpawnMarker,
  setupSnapshot,
} = require("./helpers/report-run-fixture");
const sourceCoverageIncident = require("./fixtures/report-source-coverage-incident.json");

const HEADER = '#### <span style="color:blue">조현우</span>';

test("generate keeps the canonical report when Claude omits source coverage and moves the BSP", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: sourceCoverageIncident.rawContent,
    autoContent: sourceCoverageIncident.autoContent,
    categories: sourceCoverageIncident.categories,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, [
    HEADER,
    "- PIM",
    "  - iMX93 BSP",
    "    - [Notion] wlan-package 다보드 부팅 SSoT",
    "",
  ].join("\n"));

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.publishable, false);
  assert.ok(result.validation.issues.some((issue) => issue.code === "missing_source_id"));
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.existsSync(fixture.reportPath), false);
  assert.strictEqual(fs.existsSync(result.runPaths.coverageCatalogPath), true);
});

test("generate preserves complete source coverage and pins one coverage hash", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: sourceCoverageIncident.rawContent,
    autoContent: sourceCoverageIncident.autoContent,
    categories: sourceCoverageIncident.categories,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, [
    HEADER,
    "- PIM",
    "  - [[fact:V0001]] BSP [[source:C0001]]",
    "    - IMU 브링업 [[source:N0001]]",
    "    - 규제 DB 복구 [[source:N0002]]",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "    - 다보드 부팅 SSoT [[source:N0003]]",
    "",
  ].join("\n"));

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.publishable, true);
  const working = fs.readFileSync(result.runPaths.workingDraftPath, "utf8");
  const clean = fs.readFileSync(result.runPaths.cleanReportPath, "utf8");
  const canonical = fs.readFileSync(fixture.reportPath, "utf8");
  assert.match(working, /\[\[source:/);
  assert.strictEqual(clean.includes("[[source:"), false);
  assert.strictEqual(clean.includes("[[fact:"), false);
  assert.strictEqual(canonical.includes("[[source:"), false);
  assert.strictEqual(canonical.includes("[[fact:"), false);

  const coverageCatalog = JSON.parse(
    fs.readFileSync(result.runPaths.coverageCatalogPath, "utf8")
  );
  const runState = JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8"));
  const globalState = JSON.parse(fs.readFileSync(result.generationStatePath, "utf8"));
  const promptInput = JSON.parse(fs.readFileSync(result.runPaths.promptInputPath, "utf8"));
  assert.strictEqual(runState.sourceCoverageMode, "required_sections_notion_advisory_v2");
  assert.strictEqual(globalState.sourceCoverageMode, runState.sourceCoverageMode);
  assert.strictEqual(promptInput.sourceCoverageMode, runState.sourceCoverageMode);
  assert.strictEqual(runState.coverageCatalogHash, coverageCatalog.coverageCatalogHash);
  assert.strictEqual(globalState.coverageCatalogHash, runState.coverageCatalogHash);
  assert.strictEqual(promptInput.coverageCatalogHash, runState.coverageCatalogHash);
  assert.strictEqual(result.validation.coverageCatalogHash, runState.coverageCatalogHash);
});

test("generate restores only a missing canonical section marker without another Claude call", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: sourceCoverageIncident.rawContent,
    autoContent: sourceCoverageIncident.autoContent,
    categories: sourceCoverageIncident.categories,
  });
  const aiOutput = [
    HEADER,
    "- PIM",
    "  - iMX8MP BSP",
    "    - IMU bring-up [[source:N0001]]",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "    - multi-board boot [[source:N0003]]",
    "",
  ].join("\n");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, aiOutput);

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "WARNING");
  assert.strictEqual(result.validation.publishable, true);
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(result.runPaths.aiDraftPath, "utf8"), aiOutput);
  const working = fs.readFileSync(result.runPaths.workingDraftPath, "utf8");
  assert.match(working, /iMX8MP\]\] BSP \[\[source:C0001\]\]/);
  assert.strictEqual(working.includes("[Notion]"), false);
  assert.strictEqual(working.split("\n").length, aiOutput.split("\n").length);
  const runState = JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8"));
  assert.deepStrictEqual(runState.sourceCoverageNormalization, {
    canonicalizedSectionIds: [],
    addedSectionMarkerIds: ["C0001"],
  });
  assert.strictEqual(Object.hasOwn(runState, "sourceCoverageReconciliation"), false);
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8").includes("[[source:"), false);
});

test("generate restores a marked canonical heading without appending omitted Notion items", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: sourceCoverageIncident.rawContent,
    autoContent: sourceCoverageIncident.autoContent,
    categories: sourceCoverageIncident.categories,
  });
  const aiOutput = [
    HEADER,
    "- PIM",
    "  - iMX93 BSP [[source:C0001]]",
    "    - IMU bring-up [[source:N0001]] [[source:N0001]]",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "    - multi-board boot [[source:N0003]]",
    "",
  ].join("\n");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, aiOutput);

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(result.validation.status, "WARNING");
  assert.strictEqual(result.validation.publishable, true);
  assert.strictEqual(result.validation.sourceCoverage.complete, false);
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "missing_source_id"
      && issue.id === "N0002"
      && issue.severity === "warning"
  ));
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "duplicate_source_id"
      && issue.id === "N0001"
      && issue.severity === "warning"
  ));
  assert.strictEqual(result.validation.issues.some(
    (issue) => issue.code === "source_section_heading_mismatch"
  ), false);

  const working = fs.readFileSync(result.runPaths.workingDraftPath, "utf8");
  assert.match(working, /\[\[fact:V0001\|iMX8MP\]\] BSP \[\[source:C0001\]\]/);
  assert.strictEqual(working.includes("[Notion] Sterling60"), false);
  assert.strictEqual(working.split("\n").length, aiOutput.split("\n").length);
  const runState = JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8"));
  assert.deepStrictEqual(runState.sourceCoverageNormalization, {
    canonicalizedSectionIds: ["C0001"],
    addedSectionMarkerIds: [],
  });
  assert.strictEqual(fs.existsSync(fixture.reportPath), true);
  assert.match(fs.readFileSync(fixture.reportPath, "utf8"), /iMX8MP BSP/);
});

test("generate sends summary-friendly source-marker guidance to the actual Claude process", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: sourceCoverageIncident.rawContent,
    autoContent: sourceCoverageIncident.autoContent,
    categories: sourceCoverageIncident.categories,
  });
  const promptPath = path.join(fixture.dir, "claude-prompt.txt");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, [
    HEADER,
    "- PIM",
    "  - [[fact:V0001]] BSP [[source:C0001]]",
    "    - IMU 브링업 [[source:N0001]]",
    "    - 규제 DB 복구 [[source:N0002]]",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "    - 다보드 부팅 SSoT [[source:N0003]]",
    "",
  ].join("\n"), { promptPath });

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.publishable, true);
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  const prompt = fs.readFileSync(promptPath, "utf8");
  assert.match(prompt, /\[\[source:C0001\]\]/);
  assert.match(prompt, /canonical C marker.*반드시.*보존/s);
  assert.match(prompt, /요약에 유지한.*Notion.*N marker.*보존/s);
  assert.match(prompt, /요약에서 제외한 Notion.*N marker.*생략.*허용/s);
  const promptInput = JSON.parse(fs.readFileSync(result.runPaths.promptInputPath, "utf8"));
  assert.strictEqual(promptInput.promptHash, sha256(prompt));
});

test("depth 1 generate gives canonical coverage headings priority in the production prompt", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: sourceCoverageIncident.rawContent,
    autoContent: sourceCoverageIncident.autoContent,
    categories: sourceCoverageIncident.categories,
    reportDepth: 1,
  });
  fixture.config.depthProfiles = {
    "1": {
      label: "요약",
      promptGuidance: [
        "들여쓰기 최대 2단만 사용한다.",
        "서브카테고리 헤더는 출력하지 않는다.",
      ].join("\n"),
    },
  };
  const promptPath = path.join(fixture.dir, "depth-1-claude-prompt.txt");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, [
    HEADER,
    "- PIM",
    "  - [[fact:V0001]] BSP [[source:C0001]]",
    "    - IMU and regulatory work [[source:N0001]] [[source:N0002]]",
    "- Wireless Lan",
    "  - iMX93 BSP [[source:C0002]]",
    "    - wlan boot SSoT [[source:N0003]]",
    "",
  ].join("\n"), { promptPath });

  const result = await runGenerate(fixture.config, fixture.meetingDate);
  const prompt = fs.readFileSync(promptPath, "utf8");

  assert.strictEqual(result.validation.publishable, true);
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.match(prompt, /서브카테고리 헤더는 출력하지 않는다/);
  assert.match(prompt, /source coverage.*상세도 규칙보다 우선/s);
  assert.match(prompt, /depth=1.*canonical C heading.*보존/s);
  assert.match(prompt, /요약에 남긴 Notion.*N marker.*보존/s);
  assert.doesNotMatch(prompt, /모든 N marker.*보존/s);
});

test("schema v2 generate prunes an expired terminal run before creating a new run", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  const oldAttemptId = "11111111-1111-4111-8111-111111111111";
  const oldRunDir = path.join(fixture.dir, "runs", "2026-05-01", oldAttemptId);
  fs.mkdirSync(oldRunDir, { recursive: true });
  fs.writeFileSync(path.join(oldRunDir, "state.json"), JSON.stringify({
    schemaVersion: 2,
    attemptId: oldAttemptId,
    meetingDate: "2026-05-01",
    startedAt: "2026-05-01T00:00:00.000Z",
    status: "complete",
  }, null, 2) + "\n");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.runArtifactRetentionDays = 90;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 보드 실행 [[fact:T0001]]\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "PASS");
  assert.strictEqual(fs.existsSync(oldRunDir), false);
  assert.strictEqual(fs.existsSync(result.runPaths.runDir), true);
});

test("schema v2 generate warns and continues when automatic pruning throws", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.runArtifactRetentionDays = 90;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 보드 실행 [[fact:T0001]]\n`
  );
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));

  let result;
  try {
    result = await runGenerateV2(fixture.config, fixture.meetingDate, {
      pruneRunArtifacts() {
        throw new Error("simulated prune failure");
      },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(result.validation.status, "PASS");
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.ok(warnings.some(
    (message) => message.includes("prune") && message.includes("simulated prune failure")
  ));
});

test("AI-enabled generate stores schema v2 artifacts and promotes only clean Markdown", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  const aiOutput = `설명 머리말\n${HEADER}\n- 보드 실행 [[fact:T0001]]\n`;
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, aiOutput);

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8").includes("[[fact:"), false);
  assert.strictEqual(result.validation.schemaVersion, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(result.generationStatePath, "utf8")).status, "complete");
  assert.strictEqual(fs.readFileSync(result.runPaths.aiDraftPath, "utf8"), aiOutput);
  const working = fs.readFileSync(result.runPaths.workingDraftPath, "utf8");
  assert.strictEqual(working, `${HEADER}\n- 보드 실행 [[fact:T0001|5/8 PASS]]\n`);
  const runState = JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8"));
  assert.strictEqual(runState.sanitizer.inputHash, sha256(aiOutput));
  assert.strictEqual(runState.sanitizer.outputHash, sha256(working));
  const globalState = JSON.parse(fs.readFileSync(result.generationStatePath, "utf8"));
  assert.strictEqual(globalState.runDir, result.runPaths.runDir);
  assert.strictEqual(globalState.catalogHash, runState.catalogHash);
  assert.strictEqual(globalState.latestValidationPath, "validation.001.json");
  assert.strictEqual(globalState.validationRevision, 1);
  assert.strictEqual(globalState.latestValidationHash, runState.latestValidationHash);
  const validationText = fs.readFileSync(
    path.join(result.runPaths.runDir, "validation.001.json"),
    "utf8"
  );
  assert.strictEqual(JSON.parse(validationText).revision, 1);
  assert.strictEqual(globalState.latestValidationHash, sha256(validationText));
  assert.strictEqual(globalState.cleanReportHash, sha256(fs.readFileSync(fixture.reportPath, "utf8")));
  const promptInput = JSON.parse(fs.readFileSync(result.runPaths.promptInputPath, "utf8"));
  assert.deepStrictEqual(promptInput, {
    snapshotPath: fixture.snapshotPath,
    snapshotHash: fixture.snapshot.contentHash,
    catalogHash: runState.catalogHash,
    factInputMode: "inline_refs",
    sourceCoverageMode: "required_sections_notion_advisory_v2",
    coverageCatalogHash: runState.coverageCatalogHash,
    promptHash: promptInput.promptHash,
    model: "sonnet",
    effort: "low",
    promptLength: promptInput.promptLength,
    timeoutMs: 300000,
  });
  assert.match(promptInput.promptHash, /^[0-9a-f]{64}$/);
  assert.ok(promptInput.promptLength > 0);
  assert.strictEqual(
    runState.promptInputHash,
    sha256(fs.readFileSync(result.runPaths.promptInputPath, "utf8"))
  );
  assert.strictEqual(
    runState.rawAiDraftHash,
    sha256(fs.readFileSync(result.runPaths.aiDraftPath, "utf8"))
  );
  assert.strictEqual(globalState.promptInputHash, runState.promptInputHash);
  assert.strictEqual(globalState.rawAiDraftHash, runState.rawAiDraftHash);
});

test("schema v2 restores exact pilot identifiers when Claude omits inline references", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: [
      HEADER,
      "- docker build verifies aarch64",
      "- prepare max9296 ABI validation",
      "- align max9296 driver handling",
      "- max9296 quiescence",
      "",
    ].join("\n"),
  });
  const aiOutput = [
    HEADER,
    "- docker build artifact verified on aarch64",
    "- idle handling moved to max9296 driver",
    "",
  ].join("\n");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, aiOutput);

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "PASS");
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(result.runPaths.aiDraftPath, "utf8"), aiOutput);
  assert.strictEqual(
    fs.readFileSync(result.runPaths.workingDraftPath, "utf8"),
    [
      HEADER,
      "- docker build artifact verified on [[fact:V0001|aarch64]]",
      "- idle handling moved to [[fact:V0003|max9296]] driver",
      "",
    ].join("\n")
  );
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), aiOutput);
});

test("schema v2 still blocks an exact numeric fact when Claude omits its reference", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 보드 실행 5/8 PASS\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "FAIL");
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "unmarked_protected_fact" && issue.value === "5/8 PASS"
  ));
});

test("schema v2 still blocks prerelease versions when Claude omits their references", async (t) => {
  const versions = "v2-rc1 v2-dev v2-preview1 v2_canary";
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- release ${versions} validation\n`,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- release ${versions} validation\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "FAIL");
  assert.deepStrictEqual(
    result.validation.issues
      .filter((issue) => issue.code === "unmarked_protected_fact")
      .map((issue) => issue.value),
    ["v2-rc1", "v2-dev", "v2-preview1", "v2_canary"]
  );
});

test("v2 validation failure preserves the previous report and never retries Claude", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n` });
  fs.writeFileSync(fixture.reportPath, "previous valid report\n", "utf8");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 보드 실행 [[fact:T0001|10/11 PASS]]\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "FAIL");
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), "previous valid report\n");
  assert.strictEqual(JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8")).status, "validation_failed");
  const globalState = JSON.parse(fs.readFileSync(result.generationStatePath, "utf8"));
  assert.strictEqual(globalState.status, "failed");
  assert.strictEqual(globalState.latestValidationPath, "validation.001.json");
  assert.strictEqual(globalState.validationRevision, 1);
  assert.match(globalState.latestValidationHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(Object.hasOwn(globalState, "cleanReportHash"), false);
});

test("v2 leaves an unknown bare reference visible and blocks it as malformed", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 보드 실행 [[fact:T9999]]\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "FAIL");
  assert.strictEqual(
    fs.readFileSync(result.runPaths.workingDraftPath, "utf8"),
    `${HEADER}\n- 보드 실행 [[fact:T9999]]\n`
  );
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "malformed_fact_marker"
  ));
});

test("v2 blocks a counter appended outside an expanded bare-number reference", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- retire 4 repos\n`,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- retire [[fact:Q0001]]개 repos\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.status, "FAIL");
  assert.match(
    fs.readFileSync(result.runPaths.workingDraftPath, "utf8"),
    /\[\[fact:Q0001\|4\]\]개/
  );
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "unmarked_protected_fact" && issue.value === "4개"
  ));
});

test("fact-reference preflight failure leaves no running run and never starts Claude", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n`,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  const preflightError = new Error("catalog/source mismatch");
  preflightError.code = "FACT_SOURCE_MISMATCH";

  await assert.rejects(
    () => runGenerateV2(fixture.config, fixture.meetingDate, {
      annotateFactReferences() {
        throw preflightError;
      },
    }),
    (error) => error === preflightError
  );

  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  assert.strictEqual(globalState.status, "failed");
  assert.strictEqual(globalState.errorCode, "FACT_SOURCE_MISMATCH");
  assert.strictEqual(fs.existsSync(globalState.runDir), false);
});

test("source-coverage preflight failure leaves no running run and never starts Claude", async (t) => {
  const fixture = setupSnapshot(t, {
    rawContent: sourceCoverageIncident.rawContent,
    autoContent: sourceCoverageIncident.autoContent,
    categories: sourceCoverageIncident.categories,
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  const preflightError = new Error("coverage/source mismatch");
  preflightError.code = "SOURCE_COVERAGE_LOCATION_MISSING";

  await assert.rejects(
    () => runGenerateV2(fixture.config, fixture.meetingDate, {
      annotateSourceCoverageReferences() {
        throw preflightError;
      },
    }),
    (error) => error === preflightError
  );

  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), false);
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  assert.strictEqual(globalState.status, "failed");
  assert.strictEqual(globalState.errorCode, "SOURCE_COVERAGE_LOCATION_MISSING");
  assert.strictEqual(fs.existsSync(globalState.runDir), false);
});

test("v2 AI failure records both failed states and preserves the existing error code without retry", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 보드 실행 5/8 PASS\n` });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, "");

  await assert.rejects(
    () => runGenerate(fixture.config, fixture.meetingDate),
    (error) => error.code === "AI_EMPTY_OUTPUT"
  );

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  assert.strictEqual(globalState.status, "failed");
  assert.strictEqual(globalState.errorCode, "AI_EMPTY_OUTPUT");
  const runState = JSON.parse(fs.readFileSync(`${globalState.runDir}/state.json`, "utf8"));
  assert.strictEqual(runState.status, "ai_failed");
  assert.strictEqual(runState.errorCode, "AI_EMPTY_OUTPUT");
});

test("v2 does not promote an open-status claim without pickaxe evidence", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 연결 안정화 작업\n` });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 연결 안정화 작업 ([[fact:S0001|2026-08-26]] 기준 미완료)\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(result.validation.status, "WARNING");
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "open_status_pickaxe_unavailable"
  ));
  assert.strictEqual(isPublishable(result.validation), false);
  assert.strictEqual(fs.existsSync(fixture.reportPath), false);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8")).status,
    "validation_failed"
  );
  assert.strictEqual(
    JSON.parse(fs.readFileSync(result.generationStatePath, "utf8")).status,
    "failed"
  );
});

test("v2 normalizes a misplaced 미수정 note without another Claude call", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 연결 안정화 작업\n` });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 연결 안정화 작업 (미수정, [[fact:S0001|2026-08-26]] 기준 미완료)\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(
    fs.readFileSync(result.runPaths.workingDraftPath, "utf8"),
    `${HEADER}\n- 연결 안정화 작업 미수정 ([[fact:S0001|2026-08-26]] 기준 미완료)\n`
  );
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "open_status_pickaxe_unavailable"
  ));
  assert.strictEqual(result.validation.issues.some(
    (issue) => issue.code === "open_status_without_as_of"
  ), false);
});

test("v2 adds the system meeting date when Claude omits an open-status as-of", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 관련 PR 정규 릴리스 편승\n` });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    `${HEADER}\n- 관련 PR 즉시 배포는 보류하고 정규 릴리스에 편승 확정\n`
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(
    fs.readFileSync(result.runPaths.workingDraftPath, "utf8"),
    `${HEADER}\n- 관련 PR 즉시 배포는 ([[fact:S0001|2026-08-26]] 기준 보류)하고 정규 릴리스에 편승 확정\n`
  );
  assert.ok(result.validation.issues.some(
    (issue) => issue.code === "open_status_pickaxe_unavailable"
  ));
  assert.strictEqual(result.validation.issues.some(
    (issue) => issue.code === "open_status_without_as_of"
  ), false);
});

test("sanitizer interruption preserves raw stdout before working or canonical output", async (t) => {
  const fixture = setupSnapshot(t, { rawContent: `${HEADER}\n- 완료 항목\n` });
  const aiOutput = `설명 머리말\n${HEADER}\n- 완료 항목\n`;
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, aiOutput);
  const interruption = new Error("sanitizer interrupted");
  interruption.code = "SANITIZER_INTERRUPTED";
  Object.defineProperty(fixture.config.env, "sectionHeader", {
    configurable: true,
    get() {
      if (fs.existsSync(fixture.generationStatePath)) {
        const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
        if (state.runDir && fs.existsSync(path.join(state.runDir, "draft.ai.annotated.md"))) {
          throw interruption;
        }
      }
      return HEADER;
    },
  });

  await assert.rejects(
    () => runGenerate(fixture.config, fixture.meetingDate),
    (error) => error.code === "SANITIZER_INTERRUPTED"
  );

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  const rawPath = path.join(globalState.runDir, "draft.ai.annotated.md");
  const workingPath = path.join(globalState.runDir, "draft.working.annotated.md");
  assert.strictEqual(fs.readFileSync(rawPath, "utf8"), aiOutput);
  assert.strictEqual(fs.existsSync(workingPath), false);
  assert.strictEqual(fs.existsSync(fixture.reportPath), false);
  assert.strictEqual(globalState.status, "failed");
  assert.strictEqual(globalState.errorCode, "SANITIZER_INTERRUPTED");
  const runState = JSON.parse(fs.readFileSync(path.join(globalState.runDir, "state.json"), "utf8"));
  assert.strictEqual(runState.status, "ai_failed");
  assert.strictEqual(runState.errorCode, "SANITIZER_INTERRUPTED");
});
