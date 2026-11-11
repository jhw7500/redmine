const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { isPublishable, runGenerate, runGenerateV2 } = require("../../index");
const { sha256 } = require("../report-artifact");
const {
  makeFakeClaude,
  makeProjectFakeClaude,
  makeSpawnMarker,
  setupSnapshot,
} = require("./helpers/report-run-fixture");
const sourceCoverageIncident = require("./fixtures/report-source-coverage-incident.json");

const HEADER = '#### <span style="color:blue">조현우</span>';

function projectFixture(t, options = {}) {
  const pimWork = options.pimWork || "PIM 작업";
  return setupSnapshot(t, {
    rawContent: [
      HEADER,
      "",
      "- PIM",
      "  - Application",
      `    - [Notion] ${pimWork}`,
      "",
      "- Wireless Lan",
      "  - Application",
      "    - [Notion] WLAN 작업",
      "",
      "- ETC",
      "  - [Notion] ETC 작업",
      "",
    ].join("\n"),
    autoContent: {
      "{{PIM_APPLICATION_KO}}": `    - [Notion] ${pimWork}`,
      "{{WLAN_APPLICATION_KO}}": "    - [Notion] WLAN 작업",
      "{{ETC_KO}}": "  - [Notion] ETC 작업",
    },
    categories: {
      pimApp: { label: "Application", parent: "PIM", templateKey: "PIM_APPLICATION_KO" },
      wlanApp: {
        label: "Application",
        parent: "Wireless Lan",
        templateKey: "WLAN_APPLICATION_KO",
      },
      etc: { label: null, parent: "ETC", templateKey: "ETC_KO" },
    },
  });
}

function validProjectOutputs() {
  return {
    PIM: [
      HEADER,
      "- PIM",
      "  - Application [[source:C0001]]",
      "    - PIM 결과 [[source:N0001]]",
      "",
    ].join("\n"),
    "Wireless Lan": [
      HEADER,
      "- Wireless Lan",
      "  - Application [[source:C0002]]",
      "    - WLAN 결과 [[source:N0002]]",
      "",
    ].join("\n"),
    ETC: [
      HEADER,
      "- ETC [[source:C0003]]",
      "  - ETC 결과 [[source:N0003]]",
      "",
    ].join("\n"),
  };
}

test("project schema v2 generation records three prompts and validates the merged draft", async (t) => {
  const fixture = projectFixture(t);
  fixture.config.env.aiSummarize = true;
  fixture.config.env.aiGenerationScope = "project";
  fixture.config.env.claudeCli = makeProjectFakeClaude(fixture, validProjectOutputs());

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "3");
  assert.strictEqual(result.validation.publishable, true);
  assert.strictEqual(fs.readFileSync(result.runPaths.aiDraftPath, "utf8"), [
    HEADER,
    "",
    "- PIM",
    "  - Application [[source:C0001]]",
    "    - PIM 결과 [[source:N0001]]",
    "",
    "- Wireless Lan",
    "  - Application [[source:C0002]]",
    "    - WLAN 결과 [[source:N0002]]",
    "",
    "- ETC [[source:C0003]]",
    "  - ETC 결과 [[source:N0003]]",
    "",
  ].join("\n"));
  const promptInput = JSON.parse(fs.readFileSync(result.runPaths.promptInputPath, "utf8"));
  assert.strictEqual(promptInput.provider, "claude");
  assert.strictEqual(promptInput.generationScope, "project");
  assert.strictEqual(promptInput.callCount, 3);
  assert.deepStrictEqual(promptInput.calls.map((call) => call.id), ["PIM", "Wireless Lan", "ETC"]);
});

test("project generation stops before the next AI call when a newer attempt supersedes it", async (t) => {
  const fixture = projectFixture(t);
  fixture.config.env.aiSummarize = true;
  fixture.config.env.aiGenerationScope = "project";
  fixture.config.env.claudeCli = makeProjectFakeClaude(fixture, validProjectOutputs(), {
    supersedeGenerationStatePath: fixture.generationStatePath,
  });

  await assert.rejects(
    () => runGenerate(fixture.config, fixture.meetingDate),
    (error) => error && error.code === "GENERATION_SUPERSEDED"
  );
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.existsSync(fixture.reportPath), false);
});

test("project validation applies the same fact expansion and section normalization as the final draft", async (t) => {
  const fixture = projectFixture(t, { pimWork: "PIM 작업 5/8 PASS" });
  const outputs = validProjectOutputs();
  outputs.PIM = [
    HEADER,
    "- PIM",
    "  - Application",
    "    - PIM 작업 [[fact:T0001]] [[source:N0001]]",
    "",
  ].join("\n");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.aiGenerationScope = "project";
  fixture.config.env.claudeCli = makeProjectFakeClaude(fixture, outputs);

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(result.validation.publishable, true);
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "3");
  assert.match(fs.readFileSync(result.runPaths.workingDraftPath, "utf8"), /5\/8 PASS/);
  assert.match(fs.readFileSync(fixture.reportPath, "utf8"), /PIM 작업 5\/8 PASS/);
});

test("project schema v2 stops after the first part invents a protected fact", async (t) => {
  const fixture = projectFixture(t);
  const outputs = validProjectOutputs();
  outputs.PIM = [
    HEADER,
    "- PIM",
    "  - Application [[source:C0001]]",
    "    - 4채널 PIM 결과 [[source:N0001]]",
    "",
  ].join("\n");
  fixture.config.env.aiSummarize = true;
  fixture.config.env.aiGenerationScope = "project";
  fixture.config.env.claudeCli = makeProjectFakeClaude(fixture, outputs);

  await assert.rejects(
    () => runGenerate(fixture.config, fixture.meetingDate),
    (error) => error && error.code === "AI_PART_VALIDATION"
  );
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.existsSync(fixture.reportPath), false);
  const runDateDir = path.join(fixture.dir, "runs", "2026-08-26");
  const [attemptId] = fs.readdirSync(runDateDir);
  const runDir = path.join(runDateDir, attemptId);
  const partArtifact = path.join(runDir, "draft.ai.part.001.annotated.md");
  const runState = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  assert.strictEqual(fs.readFileSync(partArtifact, "utf8"), outputs.PIM);
  assert.strictEqual(runState.partFailure.partId, "PIM");
  assert.ok(runState.partFailure.issues.some((issue) => issue.severity === "error"));
});

test("a retained team summary completes every project and preserves the failed merged report", async (t) => {
  const fixture = projectFixture(t);
  const outputs = {
    PIM: `${HEADER}\n- PIM [[source:C0001]]\n  - 영상 검증\n    - 4채널 PIM 결과 [[source:N0001]]\n`,
    "Wireless Lan": `${HEADER}\n- Wireless Lan [[source:C0002]]\n  - WLAN 결과 [[source:N0002]]\n`,
    ETC: `${HEADER}\n- ETC [[source:C0003]]\n  - ETC 결과 [[source:N0003]]\n`,
  };
  Object.assign(fixture.config.env, {
    aiSummarize: true,
    aiGenerationScope: "project",
    reportAudience: "team",
    retainRejectedSummary: true,
    claudeCli: makeProjectFakeClaude(fixture, outputs),
  });

  const result = await runGenerate(fixture.config, fixture.meetingDate);

  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "3");
  assert.strictEqual(result.validation.publishable, false);
  assert.ok(result.validation.issues.some((issue) => issue.code === "unmarked_protected_fact"));
  assert.strictEqual(fs.existsSync(fixture.reportPath), false);
  const rejected = fs.readFileSync(result.rejectedReportPath, "utf8");
  assert.match(rejected, /4채널 PIM 결과/);
  assert.match(rejected, /- Wireless Lan\n  - WLAN 결과/);
  assert.match(rejected, /- ETC\n  - ETC 결과/);
  assert.ok(!rejected.includes("[[fact:") && !rejected.includes("[[source:"));
  const state = JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8"));
  assert.strictEqual(state.status, "validation_failed");
  assert.deepStrictEqual(state.aiParts.map((part) => part.id), ["PIM", "Wireless Lan", "ETC"]);
  assert.strictEqual(state.latestRejectedReportHash, sha256(rejected));
});

test("retained team summaries still stop on invalid project scope or empty AI output", async (t) => {
  for (const [name, content, code] of [
    ["wrong project", `${HEADER}\n- Wireless Lan\n  - 다른 프로젝트 결과\n`, "AI_PART_VALIDATION"],
    ["empty response", "", "AI_EMPTY_OUTPUT"],
  ]) await t.test(name, async (t) => {
    const fixture = projectFixture(t);
    Object.assign(fixture.config.env, {
      aiSummarize: true,
      aiGenerationScope: "project",
      reportAudience: "team",
      retainRejectedSummary: true,
      claudeCli: makeProjectFakeClaude(fixture, { ...validProjectOutputs(), PIM: content }),
    });

    await assert.rejects(() => runGenerate(fixture.config, fixture.meetingDate),
      (error) => error && error.code === code);
    assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
    assert.strictEqual(fs.existsSync(fixture.reportPath), false);
    const generation = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
    const state = JSON.parse(fs.readFileSync(path.join(generation.runDir, "state.json"), "utf8"));
    assert.strictEqual(state.status, "ai_failed");
    assert.strictEqual(state.latestRejectedReportPath, undefined);
  });
});

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
    provider: "claude",
    model: "sonnet",
    effort: "low",
    generationScope: "whole",
    callCount: 1,
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
  assert.strictEqual(globalState.latestRejectedReportPath, "report.rejected.001.md");
  assert.match(globalState.latestRejectedReportHash, /^[0-9a-f]{64}$/);
  const rejectedPath = path.join(result.runPaths.runDir, globalState.latestRejectedReportPath);
  assert.strictEqual(
    fs.readFileSync(rejectedPath, "utf8"),
    `${HEADER}\n- 보드 실행 10/11 PASS\n`
  );
  assert.strictEqual(fs.readFileSync(rejectedPath, "utf8").includes("[[fact:"), false);
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

test("a protected value right after a single backslash in the source never stops generation before Claude", async (t) => {
  const { buildFactCatalog } = require("../fact-catalog");
  const { annotateFactReferences } = require("../fact-references");
  // 2026-09-23 source line 41: keep the raw `\n0`, but give Claude an NFKC-stable safe copy whose
  // immediately preceding backslash cannot turn the inserted marker into a Markdown escape.
  const rawContent = `${HEADER}\n- 보드 실행 5/8 PASS\n  ↳ 출처 요약: pgrep -c || echo 0 은 "0\\n0" 을 만든다\n`;
  assert.match(annotateFactReferences(rawContent, buildFactCatalog(rawContent)), /"\[\[fact:Q\d{4}\]\]∖\[\[fact:V\d{4}\]\]"/);
  const fixture = setupSnapshot(t, { rawContent });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeSpawnMarker(fixture);
  const snapshotBefore = fs.readFileSync(fixture.snapshotPath, "utf8");
  let catalogBeforeAnnotation;

  const result = await runGenerateV2(fixture.config, fixture.meetingDate, {
    annotateFactReferences(source, catalog) {
      catalogBeforeAnnotation = structuredClone(catalog);
      const annotated = annotateFactReferences(source, catalog);
      assert.deepStrictEqual(catalog, catalogBeforeAnnotation);
      return annotated;
    },
  });
  assert.strictEqual(fs.existsSync(fixture.spawnMarkerPath), true);
  assert.strictEqual(fs.readFileSync(fixture.snapshotPath, "utf8"), snapshotBefore);
  assert.strictEqual(JSON.parse(snapshotBefore).rawContent, rawContent);
  const runState = JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8"));
  assert.strictEqual(runState.snapshotHash, fixture.snapshot.contentHash);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(result.runPaths.catalogPath, "utf8")),
    catalogBeforeAnnotation
  );
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


test("source backslashes survive generation and revalidation with separate annotated and clean hashes", async (t) => {
  const { buildFactCatalog } = require("../fact-catalog");
  const { annotateFactReferences } = require("../fact-references");
  const { runRevalidate, assertV2PublishEvidence } = require("../../index");
  const raw = `${HEADER}\n- ${String.raw`C:\v1.2.3\2026-11-04-weekly.md`}\n- ${String.raw`"0\n0" 및 \99건`}\n- genuine ∖v2.3.4\n`;
  const fixture = setupSnapshot(t, { rawContent: raw });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, `${annotateFactReferences(raw, buildFactCatalog(raw))}- added 30ms\n`);
  fs.writeFileSync(fixture.reportPath, "prior canonical\n");
  const originalSnapshot = fs.readFileSync(fixture.snapshotPath);
  const result = await runGenerateV2(fixture.config, fixture.meetingDate);
  assert.strictEqual(result.validation.status, "FAIL");
  assert.deepStrictEqual(result.validation.issues.map(issue => issue.value), ["30ms"]);
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), "prior canonical\n");
  assert.strictEqual(fs.readFileSync(result.rejectedReportPath, "utf8"), `${raw}- added 30ms\n`);
  // Repair only the invented value in the editable failed draft; never change a complete run's state.
  const working = fs.readFileSync(result.runPaths.workingDraftPath, "utf8").replace(/- added 30ms\n$/, "");
  fs.writeFileSync(result.runPaths.workingDraftPath, working);
  assert.ok(working.includes("∖[[fact:"));
  fixture.config.env.runId = path.basename(result.runPaths.runDir);
  const second = await runRevalidate(fixture.config, fixture.meetingDate);
  assert.strictEqual(second.validation.status, "PASS");
  assert.strictEqual(second.validation.revision, 2);
  assert.strictEqual(second.validation.cleanReportHash, sha256(raw));
  assert.strictEqual(fs.readFileSync(result.runPaths.workingDraftPath, "utf8"), working);
  const canonical = fs.readFileSync(fixture.reportPath, "utf8");
  assert.strictEqual(canonical, raw);
  assert.strictEqual(fs.readFileSync(result.runPaths.cleanReportPath, "utf8"), raw);
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.deepStrictEqual(fs.readFileSync(fixture.snapshotPath), originalSnapshot);
  const state = JSON.parse(fs.readFileSync(fixture.generationStatePath));
  assert.strictEqual(assertV2PublishEvidence({state, reportContent: canonical, snapshot: fixture.snapshot,
    meetingDate: fixture.meetingDate, config: fixture.config}).validation.publishable, true);
});

test("source selection publishes restored bytes to a mock wiki and keeps annotation evidence immutable", async (t) => {
  const { setupCompleteV2Run } = require("./helpers/report-run-fixture");
  const { runRevalidate, runUpdate, assertV2PublishEvidence } = require("../../index");
  const token = String.raw`C:\v1.2.3\2026-11-04-weekly.md`;
  const command = String.raw`pgrep -c || echo 0 은 "0\n0" 을 만든다; \99건; genuine ∖v2.3.4`;
  const raw = `${HEADER}\n- PIM\n  - Application\n    - ${token}\n      - ${command}\n`;
  const fixture = await setupCompleteV2Run(t, {
    rawContent: raw, aiGenerationMethod: "source_selection", sourceSelectionFallback: false,
    autoContent: {"{{APP}}": "- updated"}, categories: {app: {parent: "PIM", label: "Application", templateKey: "APP"}},
    aiOutput: JSON.stringify({sections: [{id: "C0001", groups: [{theme: "stability", items: [{id: "R0001", highlight: false}]}]}]}),
  });
  const working = fs.readFileSync(fixture.runPaths.workingDraftPath, "utf8");
  const clean = fs.readFileSync(fixture.reportPath, "utf8");
  assert.ok(working.includes("∖[[fact:"));
  assert.ok(clean.includes(token), clean);
  assert.ok(clean.includes(command), clean);
  assert.strictEqual(fixture.validation.cleanReportHash, sha256(clean));
  fixture.config.env.runId = fixture.attemptId;
  await assert.rejects(runRevalidate(fixture.config, fixture.meetingDate), /requires validation_failed state, got complete/);
  assert.strictEqual(fs.readFileSync(fixture.callsPath, "utf8"), "1");
  assert.strictEqual(fs.readFileSync(fixture.runPaths.workingDraftPath, "utf8"), working);
  assert.strictEqual(fs.readFileSync(fixture.reportPath, "utf8"), clean);
  const args = {state: JSON.parse(fs.readFileSync(fixture.generationStatePath)), reportContent: clean,
    snapshot: fixture.snapshot, meetingDate: fixture.meetingDate, config: fixture.config};
  assert.strictEqual(assertV2PublishEvidence(args).validation.publishable, true);
  assert.throws(() => assertV2PublishEvidence({...args, reportContent: clean.replace(token, token.replace("\\", "∖"))}));
  await runUpdate(fixture.config, fixture.meetingDate);
  const puts = fixture.redmineRequests.filter(request => request.method === "PUT");
  assert.strictEqual(puts.length, 1);
  const posted = JSON.parse(puts[0].body).wiki_page.text;
  assert.ok(posted.includes(token));
  assert.ok(posted.includes(command));
});


test("moved genuine Unicode is rejected before canonical promotion or a publication transport", async (t) => {
  const { assertPublishable, runUpdate } = require("../../index");
  const raw = `${HEADER}\n- ${String.raw`C:\v1.2.3`}\n`;
  const fixture = setupSnapshot(t, {rawContent: raw});
  const output = `${HEADER}\n- moved ∖[[fact:V0001|v1.2.3]]\n`;
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(fixture, output);
  let transportCalls = 0;
  const savedFetch = global.fetch;
  global.fetch = () => {transportCalls += 1; throw new Error("FIXTURE_TRANSPORT_FORBIDDEN");};
  t.after(() => {global.fetch = savedFetch;});
  const before = fs.readFileSync(fixture.snapshotPath);
  const result = await runGenerateV2(fixture.config, fixture.meetingDate);
  assert.strictEqual(result.validation.status, "FAIL");
  assert.strictEqual(fs.existsSync(fixture.reportPath), false);
  const rejected = `${HEADER}\n- moved ∖v1.2.3\n`;
  assert.strictEqual(fs.readFileSync(result.rejectedReportPath, "utf8"), rejected);
  const state = JSON.parse(fs.readFileSync(result.runPaths.statePath));
  assert.strictEqual(state.latestRejectedReportHash, sha256(rejected));
  assert.strictEqual(result.validation.cleanReportHash, undefined);
  assert.throws(() => assertPublishable(result.validation, {env: {validationMode: "warn", validationOverride: true}}));
  await assert.rejects(runUpdate(fixture.config, fixture.meetingDate), /선행 생성 실패.*FAIL/);
  assert.strictEqual(transportCalls, 0);
  assert.deepStrictEqual(fs.readFileSync(fixture.snapshotPath), before);
});

test("highlighted source selection restores exact source-line context and keeps its annotated evidence", async (t) => {
  const { assertV2PublishEvidence } = require("../../index");
  const token = String.raw`C:\v1.2.3\2026-11-04-weekly.md`;
  const detail = String.raw`↳ 변경: "0\n0"; \99건; genuine ∖v2.3.4`;
  const raw = `${HEADER}\n- PIM\n  - Application\n    - ${token}\n      ${detail}\n`;
  const fixture = setupSnapshot(t, {rawContent: raw, autoContent: {"{{APP}}": "- updated"},
    categories: {app: {parent: "PIM", label: "Application", templateKey: "APP"}}});
  Object.assign(fixture.config.env, {aiSummarize: true, aiGenerationMethod: "source_selection", sourceSelectionFallback: false});
  fixture.config.reportFilter.leaderHighlight = {enabled: true, maxLines: 10};
  fixture.config.env.claudeCli = makeFakeClaude(fixture, JSON.stringify({sections: [{id: "C0001", groups: [{theme: "stability", items: [{id: "R0001", highlight: true}]}]}]}));
  const result = await runGenerateV2(fixture.config, fixture.meetingDate);
  assert.notStrictEqual(result.validation.status, "FAIL", JSON.stringify(result.validation.issues));
  const clean = fs.readFileSync(fixture.reportPath, "utf8");
  assert.ok(clean.includes(`<u>${token}</u>`), clean);
  assert.ok(clean.includes(detail), clean);
  const working = fs.readFileSync(result.runPaths.workingDraftPath, "utf8");
  assert.ok(working.includes("∖[[fact:"));
  assert.strictEqual(result.validation.annotatedDraftHash, sha256(working));
  assert.strictEqual(result.validation.cleanReportHash, sha256(clean));
  assert.strictEqual(assertV2PublishEvidence({state: JSON.parse(fs.readFileSync(fixture.generationStatePath)),
    reportContent: clean, snapshot: fixture.snapshot, meetingDate: fixture.meetingDate, config: fixture.config}).validation.publishable, true);
});

test("fixture pair preparation does not invoke fetch or http transports", async (t) => {
  const { prepareWeeklyPair } = require("../weekly-report-pair");
  const { annotateFactReferences } = require("../fact-references");
  const { buildFactCatalog } = require("../fact-catalog");
  const http = require("node:http"), https = require("node:https");
  const token = String.raw`C:\v1.2.3\2026-11-04-weekly.md`;
  const raw = `${HEADER}\n- PIM\n  - Application\n    - ${token}\n`;
  const fixture = setupSnapshot(t, {rawContent: raw, autoContent: {"{{APP}}": "- updated"},
    categories: {app: {parent: "PIM", label: "Application", templateKey: "APP"}}});
  const fakeAi = makeFakeClaude(fixture, annotateFactReferences(raw, buildFactCatalog(raw)));
  Object.assign(fixture.config.env, {aiSummarize: true, aiProvider: "codex", codexCli: fakeAi,
    aiModel: "gpt-5.6-sol", aiEffort: "low", aiGenerationMethod: "source_selection", aiGenerationScope: "whole",
    sourceSelectionFallback: true, validationMode: "block", validationOverride: false, presentationNoteMode: "suggest"});
  const saved = {fetch: global.fetch, http: http.request, https: https.request};
  let requests = 0;
  const deny = () => {requests += 1; throw new Error("FIXTURE_TRANSPORT_FORBIDDEN");};
  global.fetch = deny; http.request = deny; https.request = deny;
  t.after(() => {global.fetch = saved.fetch; http.request = saved.http; https.request = saved.https;});
  const result = await prepareWeeklyPair(fixture.config, fixture.meetingDate, {collect: async child => {
    fs.copyFileSync(fixture.snapshotPath, child.env.snapshotPath, fs.constants.COPYFILE_EXCL);
    return {snapshot: fixture.snapshot, snapshotPath: child.env.snapshotPath};
  }});
  assert.strictEqual(result.manifest.variants[2].status, "ready");
  assert.strictEqual(result.manifest.variants[3].status, "ready");
  assert.strictEqual(requests, 0);
  assert.strictEqual(fs.existsSync(path.join(result.root, "publication.completed.json")), false);
  assert.strictEqual(fs.existsSync(path.join(result.root, "slack-delivery")), false);
});
