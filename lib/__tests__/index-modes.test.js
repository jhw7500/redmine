const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertPublishable,
  resolveOpenIssueVerifierOptions,
  isPublishable,
  resolveRunMeetingDate,
  runGenerate,
  runUpdate,
  writeGenerationStateIfOwned,
} = require("../../index");
const {
  buildGenerationStatePath,
  sealSnapshot,
  writeJsonAtomic,
} = require("../report-artifact");
const { holdFileLock } = require("./helpers/report-run-fixture");

test("resolveRunMeetingDate uses the explicit meeting date", () => {
  const date = resolveRunMeetingDate({
    env: { meetingDate: "2026-07-15", wikiUrl: "", pageSuffix: "weekly", baseUrl: "http://r", projectId: "p" },
  });
  assert.strictEqual(date.getFullYear(), 2026);
  assert.strictEqual(date.getMonth(), 6);
  assert.strictEqual(date.getDate(), 15);
});

test("publish gate blocks FAIL unless explicitly overridden", () => {
  assert.throws(
    () => assertPublishable({ status: "FAIL" }, { env: { validationMode: "block", validationOverride: false } }),
    /Redmine 반영을 중단/
  );
  assert.doesNotThrow(() => assertPublishable(
    { status: "FAIL" },
    { env: { validationMode: "block", validationOverride: true } }
  ));
});

test("schema v2 cannot override an unavailable open-status repository", () => {
  assert.throws(
    () => assertPublishable(
      {
        schemaVersion: 2,
        status: "FAIL",
        issues: [{ severity: "error", code: "open_status_repo_unavailable" }],
      },
      { env: { validationMode: "block", validationOverride: true } }
    ),
    /open_status_repo_unavailable/
  );
});

test("open-status DI cannot replace configured unavailable repositories", () => {
  const runGit = () => ({ ok: true, stdout: "", error: null });
  const unavailableRepos = {
    gstApp: { path: "/missing/gstApp", reason: ".git entry not found" },
  };
  const resolved = resolveOpenIssueVerifierOptions({
    unavailableRepos,
    openIssueVerifierOptions: { runGit },
  });

  assert.strictEqual(resolved.runGit, runGit);
  assert.strictEqual(resolved.unavailableRepos, unavailableRepos);
});

test("generation completion accepts matching schema v2 state", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-generation-v2-complete-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reportPath = path.join(dir, "report.md");
  const snapshot = { contentHash: "snapshot-hash" };
  writeJsonAtomic(buildGenerationStatePath(reportPath), {
    schemaVersion: 2,
    status: "complete",
    meetingDate: "2026-08-26",
    reportDepth: 2,
    snapshotHash: "snapshot-hash",
    attemptId: "11111111-1111-4111-8111-111111111111",
  });

  const { assertGenerationComplete } = require("../../index");
  const result = assertGenerationComplete(
    reportPath,
    snapshot,
    new Date("2026-08-26T00:00:00"),
    { env: { reportDepth: 2 } }
  );
  assert.strictEqual(result.state.schemaVersion, 2);
});

test("publish gate blocks an open-status claim without pickaxe evidence", () => {
  assert.throws(
    () => assertPublishable(
      { status: "WARNING", issues: [{ severity: "warning", code: "open_status_pickaxe_unavailable" }] },
      { env: { validationMode: "block", validationOverride: false } }
    ),
    /Redmine 반영을 중단/
  );
});

test("generate and update share one publishable standard", () => {
  const blockingWarning = {
    status: "WARNING",
    issues: [{ severity: "warning", code: "open_status_pickaxe_unavailable" }],
  };
  assert.strictEqual(isPublishable(blockingWarning), false);
  assert.throws(
    () => assertPublishable(
      blockingWarning,
      { env: { validationMode: "block", validationOverride: false } }
    ),
    /Redmine 반영을 중단/
  );

  assert.strictEqual(isPublishable({ status: "PASS", issues: [] }), true);
  assert.strictEqual(isPublishable({ status: "FAIL", issues: [] }), false);
  assert.strictEqual(
    isPublishable({
      status: "WARNING",
      issues: [{ severity: "warning", code: "open_status_resolution_evidence" }],
    }),
    false
  );
});

test("publish gate blocks every warning code by default", () => {
  // 새 warning code도 기본 차단이어야 한다. 검토 없이 자동 게시되면 안 된다.
  assert.throws(
    () => assertPublishable(
      { status: "WARNING", issues: [{ severity: "warning", code: "some_future_warning_code" }] },
      { env: { validationMode: "block", validationOverride: false } }
    ),
    /Redmine 반영을 중단/
  );
});

test("publish gate still blocks warnings that demand human review", () => {
  // 기준일 이후 해결 흔적이 발견됐다는 신호(AGENTS.md의 stale 미해결 방지 규율)나
  // git 확인 자체가 실패한 경우는 사람이 봐야 한다. 통과시키면 안 된다.
  for (const code of [
    "open_status_resolution_evidence",
    "open_status_git_check_failed",
    "open_status_git_pickaxe_failed",
  ]) {
    assert.throws(
      () => assertPublishable(
        { status: "WARNING", issues: [{ severity: "warning", code }] },
        { env: { validationMode: "block", validationOverride: false } }
      ),
      /Redmine 반영을 중단/,
      `${code}는 게시를 차단해야 한다`
    );
  }
});

test("update refuses a draft without a matching completed generation attempt", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-generation-gate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meetingDate = new Date("2026-08-26T00:00:00");
  const snapshotPath = path.join(dir, "snapshot.json");
  const reportPath = path.join(dir, "report.md");
  const header = '#### <span style="color:blue">조현우</span>';
  const content = `${header}\n- 완료 항목\n`;
  const snapshot = sealSnapshot({
    collectedAt: "2026-08-26T06:05:00+09:00",
    meetingDate: "2026-08-26",
    status: "sealed",
    failures: [],
    warnings: [],
    sources: {},
    autoContent: {},
    rawContent: content,
    presentationCandidates: [],
  });
  writeJsonAtomic(snapshotPath, snapshot);
  fs.writeFileSync(reportPath, content, "utf8");
  const config = {
    env: {
      snapshotPath,
      allowPartialSnapshot: false,
      outputPath: reportPath,
      outputDir: dir,
      reportDepth: 3,
      sectionHeader: header,
      presentationNoteMode: "off",
      validationMode: "block",
      validationOverride: false,
      baseUrl: "http://127.0.0.1:9",
      projectId: "p",
      wikiUrl: "http://127.0.0.1:9/projects/p/wiki/2026-08-26_weekly",
      pageSuffix: "weekly",
    },
  };

  await assert.rejects(
    () => runUpdate(config, meetingDate),
    /generation state.*complete/
  );

  writeJsonAtomic(buildGenerationStatePath(reportPath), {
    schemaVersion: 1,
    status: "complete",
    meetingDate: "2026-08-26",
    reportDepth: 3,
    snapshotHash: "stale-snapshot",
  });
  await assert.rejects(
    () => runUpdate(config, meetingDate),
    /generation state.*snapshot\/date\/depth/
  );
});

test("generate records a completed attempt for the matching snapshot", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-generation-complete-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meetingDate = new Date("2026-08-26T00:00:00");
  const snapshotPath = path.join(dir, "snapshot.json");
  const reportPath = path.join(dir, "report.md");
  const header = '#### <span style="color:blue">조현우</span>';
  const content = `${header}\n- 완료 항목\n`;
  const snapshot = sealSnapshot({
    collectedAt: "2026-08-26T06:05:00+09:00",
    meetingDate: "2026-08-26",
    status: "sealed",
    failures: [],
    warnings: [],
    sources: {},
    autoContent: {},
    rawContent: content,
    presentationCandidates: [],
  });
  writeJsonAtomic(snapshotPath, snapshot);
  const config = {
    env: {
      snapshotPath,
      allowPartialSnapshot: false,
      outputPath: reportPath,
      outputDir: dir,
      reportDepth: 3,
      sectionHeader: header,
      aiSummarize: false,
    },
  };

  await runGenerate(config, meetingDate);

  const state = JSON.parse(fs.readFileSync(buildGenerationStatePath(reportPath), "utf8"));
  assert.strictEqual(state.schemaVersion, 1);
  assert.strictEqual(state.status, "complete");
  assert.strictEqual(state.snapshotHash, snapshot.contentHash);
  assert.strictEqual(state.reportDepth, 3);
  assert.match(
    state.attemptId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.strictEqual(fs.existsSync(path.join(dir, "runs", "2026-08-26")), false);
});

test("a failed preliminary artifact write invalidates an older completed generation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-generation-preflight-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meetingDate = new Date("2026-08-26T00:00:00");
  const snapshotPath = path.join(dir, "snapshot.json");
  const reportPath = path.join(dir, "report.md");
  const blockedOutputDir = path.join(dir, "not-a-directory");
  fs.writeFileSync(blockedOutputDir, "block mkdir", "utf8");
  const snapshot = sealSnapshot({
    collectedAt: "2026-08-26T06:05:00+09:00",
    meetingDate: "2026-08-26",
    status: "sealed",
    failures: [],
    warnings: [],
    sources: {},
    autoContent: {},
    rawContent: "#### 조현우\n- 완료\n",
    presentationCandidates: [],
  });
  writeJsonAtomic(snapshotPath, snapshot);
  const statePath = buildGenerationStatePath(reportPath);
  writeJsonAtomic(statePath, {
    schemaVersion: 1,
    status: "complete",
    meetingDate: "2026-08-26",
    reportDepth: 3,
    snapshotHash: snapshot.contentHash,
    attemptId: "older-attempt",
  });
  const config = {
    env: {
      snapshotPath,
      allowPartialSnapshot: false,
      outputPath: reportPath,
      outputDir: blockedOutputDir,
      reportDepth: 3,
      aiSummarize: false,
    },
  };

  await assert.rejects(() => runGenerate(config, meetingDate));

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.strictEqual(state.status, "failed");
  assert.notStrictEqual(state.attemptId, "older-attempt");
});

test("an older generate attempt cannot overwrite a newer attempt state", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-generation-owner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "report.generation.json");
  const newer = { schemaVersion: 1, status: "running", attemptId: "newer" };
  writeJsonAtomic(statePath, newer);

  assert.strictEqual(
    writeGenerationStateIfOwned(statePath, "older", { status: "complete" }),
    false
  );
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), newer);
});

test("a held generation-state lock prevents an owned state update", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-generation-owner-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "report.generation.json");
  const current = { schemaVersion: 1, status: "running", attemptId: "owner" };
  writeJsonAtomic(statePath, current);
  const held = holdFileLock(t, `${statePath}.lock`);

  assert.strictEqual(writeGenerationStateIfOwned(statePath, "owner", { status: "complete" }), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), current);
  await held.release();
});

test("a held generation-state lock prevents generate from replacing the current attempt", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-generation-start-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meetingDate = new Date("2026-08-26T00:00:00");
  const snapshotPath = path.join(dir, "snapshot.json");
  const reportPath = path.join(dir, "report.md");
  const snapshot = sealSnapshot({
    collectedAt: "2026-08-26T06:05:00+09:00",
    meetingDate: "2026-08-26",
    status: "sealed",
    failures: [],
    warnings: [],
    sources: {},
    autoContent: {},
    rawContent: "#### 조현우\n- 완료\n",
    presentationCandidates: [],
  });
  writeJsonAtomic(snapshotPath, snapshot);
  const statePath = buildGenerationStatePath(reportPath);
  const current = { schemaVersion: 1, status: "running", attemptId: "current-owner" };
  writeJsonAtomic(statePath, current);
  const held = holdFileLock(t, `${statePath}.lock`);
  const config = {
    env: {
      snapshotPath,
      allowPartialSnapshot: false,
      outputPath: reportPath,
      outputDir: dir,
      reportDepth: 3,
      aiSummarize: false,
    },
  };

  await assert.rejects(() => runGenerate(config, meetingDate), /locked/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), current);
  assert.strictEqual(fs.existsSync(reportPath), false);
  await held.release();
});
