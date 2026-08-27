const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  assertPublishable,
  assertV2PublishEvidence,
  buildPublishTimeValidation,
  hasNonOverridableV2Issue,
  runUpdate,
} = require("../../index");
const { update } = require("../publisher");
const { sha256, writeJsonAtomic } = require("../report-artifact");
const {
  setupCompleteV1Run,
  setupCompleteV2Run,
} = require("./helpers/report-run-fixture");

const HEADER = '#### <span style="color:blue">조현우</span>';

test("schema v2 update blocks a changed clean report before Redmine even with override", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  fs.writeFileSync(fixture.reportPath, `${HEADER}\n- changed 77건\n`, "utf8");
  fixture.config.env.validationOverride = true;

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    (error) => error.code === "clean_report_hash_mismatch"
      && /clean report hash mismatch/.test(error.message)
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 fact errors are never validation-override eligible", () => {
  const validation = {
    schemaVersion: 2,
    status: "FAIL",
    issues: [{ severity: "error", code: "fact_value_mismatch" }],
  };
  assert.strictEqual(hasNonOverridableV2Issue(validation), true);
  assert.throws(
    () => assertPublishable(validation, {
      env: { validationMode: "block", validationOverride: true },
    }),
    /cannot be overridden/
  );
});

test("schema v2 update rechecks mutable open-issue evidence before Redmine", async (t) => {
  const openLine = "- `arg.cam[i].bps` 설정 오류 (2026-05-08 기준 미해결)";
  const fixture = await setupCompleteV2Run(t, {
    rawContent: `${HEADER}\n${openLine}\n`,
    aiOutput: `${HEADER}\n- \`arg.cam[i].bps\` 설정 오류 ([[fact:V0001|2026-05-08]] 기준 미해결)\n`,
    repos: { gstApp: { path: "/fixture/gstApp" } },
    openIssueVerifierOptions: {
      runGit: () => ({ ok: true, stdout: "", error: null }),
    },
  });
  fixture.config.openIssueVerifierOptions = {
    runGit: (_repoPath, args) => args.includes("-S")
      ? { ok: true, stdout: "dc06098\tchore: 빌드 디렉토리 정리\n", error: null }
      : { ok: true, stdout: "", error: null },
  };

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    /보고서 검증 WARNING/
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 refreshes mutable git evidence after approval before Wiki mutation", async (t) => {
  const openLine = "- `arg.cam[i].bps` 설정 오류 (2026-05-08 기준 미해결)";
  let titleChecks = 0;
  const runGit = (_repoPath, args) => {
    if (!args.includes("-S")) titleChecks += 1;
    return titleChecks >= 4
      ? { ok: true, stdout: "dc06098\tfix: arg.cam[i].bps 설정 오류 수정\n", error: null }
      : { ok: true, stdout: "", error: null };
  };
  const fixture = await setupCompleteV2Run(t, {
    rawContent: `${HEADER}\n${openLine}\n`,
    aiOutput: `${HEADER}\n- \`arg.cam[i].bps\` 설정 오류 ([[fact:V0001|2026-05-08]] 기준 미해결)\n`,
    repos: { gstApp: { path: "/fixture/gstApp" } },
    openIssueVerifierOptions: { runGit },
  });

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    /보고서 검증 WARNING/
  );
  assert.ok(titleChecks >= 4);
  assert.strictEqual(fixture.redmineRequests.filter((request) => request.method === "GET").length, 1);
  assert.strictEqual(fixture.redmineRequests.filter((request) => request.method === "PUT").length, 0);
});

test("schema v2 publish evidence rejects unsafe validation paths before Redmine", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  writeJsonAtomic(fixture.generationStatePath, {
    ...state,
    latestValidationPath: path.join("..", "validation.001.json"),
  });

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    (error) => error.code === "validation_path_mismatch"
      && /validation path/.test(error.message)
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 publish evidence requires the latest owned validation revision", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  const runState = JSON.parse(fs.readFileSync(fixture.runPaths.statePath, "utf8"));
  fs.copyFileSync(
    path.join(fixture.runPaths.runDir, "validation.001.json"),
    path.join(fixture.runPaths.runDir, "validation.002.json")
  );
  writeJsonAtomic(fixture.generationStatePath, {
    ...globalState,
    latestValidationPath: "validation.002.json",
    validationRevision: 2,
  });
  writeJsonAtomic(fixture.runPaths.statePath, {
    ...runState,
    latestValidationPath: "validation.002.json",
    validationRevision: 2,
  });
  fixture.config.env.validationOverride = true;

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    (error) => error.code === "validation_path_mismatch"
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 publish evidence verifies the pinned validation artifact hash", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  const validationPath = path.join(fixture.runPaths.runDir, "validation.001.json");
  const validation = JSON.parse(fs.readFileSync(validationPath, "utf8"));
  fs.writeFileSync(validationPath, JSON.stringify({
    ...validation,
    checkedAt: "2099-01-01T00:00:00.000Z",
  }), "utf8");
  fixture.config.env.validationOverride = true;

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    /validation artifact hash mismatch/
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 publish evidence binds run and validation attempt ownership", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  const validationPath = path.join(
    fixture.runPaths.runDir,
    "validation.001.json"
  );
  const validation = JSON.parse(fs.readFileSync(validationPath, "utf8"));
  const changedValidation = JSON.stringify({
    ...validation,
    attemptId: "22222222-2222-4222-8222-222222222222",
  }, null, 2) + "\n";
  const changedHash = sha256(changedValidation);
  fs.writeFileSync(validationPath, changedValidation, "utf8");
  const runState = JSON.parse(fs.readFileSync(fixture.runPaths.statePath, "utf8"));
  const globalState = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  writeJsonAtomic(fixture.runPaths.statePath, {
    ...runState,
    latestValidationHash: changedHash,
  });
  writeJsonAtomic(fixture.generationStatePath, {
    ...globalState,
    latestValidationHash: changedHash,
  });

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    (error) => error.code === "attempt_ownership_mismatch"
      && /attempt ownership mismatch/.test(error.message)
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 publish evidence binds annotated, run-clean, and canonical hashes", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  const reportContent = fs.readFileSync(fixture.reportPath, "utf8");
  const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  fs.writeFileSync(fixture.runPaths.workingDraftPath, `${HEADER}\n- changed working\n`, "utf8");

  assert.throws(
    () => assertV2PublishEvidence({
      state,
      reportContent,
      snapshot: fixture.snapshot,
      meetingDate: fixture.meetingDate,
      config: fixture.config,
    }),
    (error) => error.code === "annotated_draft_hash_mismatch"
  );

  fs.writeFileSync(
    fixture.runPaths.workingDraftPath,
    `${HEADER}\n- 완료 항목\n`,
    "utf8"
  );
  fs.writeFileSync(fixture.runPaths.cleanReportPath, `${HEADER}\n- changed run clean\n`, "utf8");
  assert.throws(
    () => assertV2PublishEvidence({
      state,
      reportContent,
      snapshot: fixture.snapshot,
      meetingDate: fixture.meetingDate,
      config: fixture.config,
    }),
    (error) => error.code === "clean_report_hash_mismatch"
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 snapshot and catalog hash failures ignore override before Redmine", async (t) => {
  await t.test("snapshot", async (t) => {
    const fixture = await setupCompleteV2Run(t);
    const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
    writeJsonAtomic(fixture.generationStatePath, {
      ...state,
      snapshotHash: "tampered-snapshot",
    });
    fixture.config.env.validationOverride = true;

    await assert.rejects(
      () => runUpdate(fixture.config, fixture.meetingDate),
      (error) => error.code === "snapshot_hash_mismatch"
    );
    assert.strictEqual(fixture.redmineRequests.length, 0);
  });

  await t.test("catalog", async (t) => {
    const fixture = await setupCompleteV2Run(t);
    const catalog = JSON.parse(fs.readFileSync(fixture.runPaths.catalogPath, "utf8"));
    fs.writeFileSync(fixture.runPaths.catalogPath, JSON.stringify({
      ...catalog,
      facts: [...catalog.facts, { id: "Q9999", raw: "9999" }],
    }), "utf8");
    fixture.config.env.validationOverride = true;

    await assert.rejects(
      () => runUpdate(fixture.config, fixture.meetingDate),
      (error) => error.code === "catalog_hash_mismatch"
    );
    assert.strictEqual(fixture.redmineRequests.length, 0);
  });
});

test("schema v2 annotated hash failure ignores override before Redmine", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  fs.writeFileSync(fixture.runPaths.workingDraftPath, `${HEADER}\n- changed working\n`, "utf8");
  fixture.config.env.validationOverride = true;

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    (error) => error.code === "annotated_draft_hash_mismatch"
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 prompt-input hash failure is non-overridable before Redmine", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  fs.appendFileSync(fixture.runPaths.promptInputPath, "tampered\n", "utf8");
  fixture.config.env.validationOverride = true;

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    (error) => error.code === "prompt_input_hash_mismatch"
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 raw AI draft hash failure is non-overridable before Redmine", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  fs.appendFileSync(fixture.runPaths.aiDraftPath, "tampered\n", "utf8");
  fixture.config.env.validationOverride = true;

  await assert.rejects(
    () => runUpdate(fixture.config, fixture.meetingDate),
    (error) => error.code === "raw_ai_draft_hash_mismatch"
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 update publishes the same hash-pinned report string", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  const reportContent = fs.readFileSync(fixture.reportPath, "utf8");

  await runUpdate(fixture.config, fixture.meetingDate);

  const puts = fixture.redmineRequests.filter((request) => request.method === "PUT");
  assert.strictEqual(puts.length, 1);
  assert.ok(JSON.parse(puts[0].body).wiki_page.text.includes(reportContent.trimEnd()));
});

test("schema v2 assertReady blocks every Wiki request after canonical mutation", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  const reportContent = fs.readFileSync(fixture.reportPath, "utf8");
  fs.writeFileSync(fixture.reportPath, `${HEADER}\n- raced canonical edit\n`, "utf8");

  await assert.rejects(
    () => update(fixture.config, fixture.meetingDate, {
      draftContent: reportContent,
      assertReady: () => assertV2PublishEvidence({
        state,
        reportContent,
        snapshot: fixture.snapshot,
        meetingDate: fixture.meetingDate,
        config: fixture.config,
      }),
    }),
    (error) => error.code === "clean_report_hash_mismatch"
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v2 assertReady blocks every Wiki request after snapshot mutation", async (t) => {
  const fixture = await setupCompleteV2Run(t);
  const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  const reportContent = fs.readFileSync(fixture.reportPath, "utf8");
  writeJsonAtomic(fixture.generationStatePath, {
    ...state,
    snapshotHash: "raced-snapshot",
  });

  await assert.rejects(
    () => update(fixture.config, fixture.meetingDate, {
      draftContent: reportContent,
      assertReady: () => assertV2PublishEvidence({
        state,
        reportContent,
        snapshot: fixture.snapshot,
        meetingDate: fixture.meetingDate,
        config: fixture.config,
      }),
    }),
    (error) => error.code === "snapshot_hash_mismatch"
  );
  assert.strictEqual(fixture.redmineRequests.length, 0);
});

test("schema v1 update remains compatible with direct report edits", async (t) => {
  const fixture = await setupCompleteV1Run(t);
  const edited = `${HEADER}\n- 사람이 직접 편집한 완료 항목\n`;
  fs.writeFileSync(fixture.reportPath, edited, "utf8");

  await runUpdate(fixture.config, fixture.meetingDate);

  const puts = fixture.redmineRequests.filter((request) => request.method === "PUT");
  assert.strictEqual(puts.length, 1);
  assert.ok(JSON.parse(puts[0].body).wiki_page.text.includes(edited.trimEnd()));
});

test("schema v2 generation state cannot be downgraded to schema v1", async (t) => {
  await t.test("v2 ownership fields remain", async (t) => {
    const fixture = await setupCompleteV2Run(t);
    const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
    writeJsonAtomic(fixture.generationStatePath, { ...state, schemaVersion: 1 });
    fixture.config.env.validationOverride = true;

    await assert.rejects(
      () => runUpdate(fixture.config, fixture.meetingDate),
      /schema v2 downgrade/
    );
    assert.strictEqual(fixture.redmineRequests.length, 0);
  });

  await t.test("v2 ownership fields are deleted", async (t) => {
    const fixture = await setupCompleteV2Run(t);
    const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
    writeJsonAtomic(fixture.generationStatePath, {
      schemaVersion: 1,
      status: state.status,
      meetingDate: state.meetingDate,
      reportDepth: state.reportDepth,
      snapshotHash: state.snapshotHash,
      attemptId: state.attemptId,
    });
    fixture.config.env.validationOverride = true;

    await assert.rejects(
      () => runUpdate(fixture.config, fixture.meetingDate),
      /schema v2 downgrade/
    );
    assert.strictEqual(fixture.redmineRequests.length, 0);
  });
});

test("publish-time validation preserves immutable evidence and replaces mutable issues", () => {
  const evidence = {
    schemaVersion: 2,
    status: "PASS",
    attemptId: "11111111-1111-4111-8111-111111111111",
    snapshotHash: "snapshot-hash",
    catalogHash: "catalog-hash",
    annotatedDraftHash: "annotated-hash",
    cleanReportHash: "clean-hash",
    checkedAt: "2026-08-26T00:00:00.000Z",
    facts: { openIssueChecks: [{ kind: "old" }] },
    issues: [{ severity: "error", code: "fact_value_mismatch" }],
  };
  const publishTime = {
    issues: [{ severity: "warning", code: "open_status_resolution_evidence" }],
    openIssueChecks: [{ kind: "fresh" }],
  };

  const actual = buildPublishTimeValidation(evidence, publishTime);

  assert.strictEqual(actual.schemaVersion, 2);
  assert.strictEqual(actual.status, "WARNING");
  assert.strictEqual(actual.attemptId, "11111111-1111-4111-8111-111111111111");
  assert.strictEqual(actual.snapshotHash, "snapshot-hash");
  assert.strictEqual(actual.catalogHash, "catalog-hash");
  assert.strictEqual(actual.annotatedDraftHash, "annotated-hash");
  assert.strictEqual(actual.cleanReportHash, "clean-hash");
  assert.deepStrictEqual(actual.issues, publishTime.issues);
  assert.deepStrictEqual(actual.facts.openIssueChecks, publishTime.openIssueChecks);
  assert.notStrictEqual(actual.checkedAt, "2026-08-26T00:00:00.000Z");
});
