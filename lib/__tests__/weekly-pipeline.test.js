const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildWeeklyPipelinePaths,
  createWeeklyAttempt,
  loadWeeklyStatus,
  patchWeeklyStatus,
  markWeeklyReady,
  markWeeklyPublishing,
  pinExpectedSectionHash,
  markWeeklyPublished,
  classifyWeeklyFailure,
  recordWeeklyFailure,
  formatWeeklyFailureLog,
  formatWeeklySkipLog,
} = require("../weekly-pipeline");

const MEETING_DATE = "2026-09-16";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const GENERATION_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const SECTION_HASH = "3333333333333333333333333333333333333333333333333333333333333333";

function makeOutputDir(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-weekly-pipeline-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  return outputDir;
}

function makeReadyEvidence(outputDir, overrides = {}) {
  const snapshotPath = path.join(outputDir, "snapshot.json");
  const generationStatePath = path.join(outputDir, "report.generation.json");
  const reportPath = path.join(outputDir, "report.md");
  fs.writeFileSync(snapshotPath, "{}\n", "utf8");
  fs.writeFileSync(generationStatePath, "{}\n", "utf8");
  fs.writeFileSync(reportPath, "report\n", "utf8");
  return {
    snapshotPath,
    snapshotHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generationAttemptId: GENERATION_ATTEMPT_ID,
    generationStatePath,
    reportPath,
    reportHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ...overrides,
  };
}

test("weekly state follows preparing to ready to publishing to published", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  const evidence = makeReadyEvidence(outputDir);

  const preparing = createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });

  assert.deepStrictEqual(paths, {
    meetingDir: path.join(outputDir, "pipeline", MEETING_DATE),
    statusPath: path.join(outputDir, "pipeline", MEETING_DATE, "status.json"),
    failuresDir: path.join(outputDir, "pipeline", MEETING_DATE, "failures"),
  });
  assert.deepStrictEqual(preparing, {
    schemaVersion: 1,
    meetingDate: MEETING_DATE,
    pipelineAttemptId: ATTEMPT_ID,
    reportDepth: 3,
    status: "preparing",
    stage: "collect",
    startedAt: "2026-09-16T06:05:00.000Z",
    updatedAt: "2026-09-16T06:05:00.000Z",
    snapshotPath: null,
    snapshotHash: null,
    generationAttemptId: null,
    generationStatePath: null,
    reportPath: null,
    reportHash: null,
    expectedSectionHash: null,
    failureArtifact: null,
    published: null,
  });

  const ready = markWeeklyReady(paths, ATTEMPT_ID, evidence);
  assert.strictEqual(ready.status, "ready");
  assert.strictEqual(ready.expectedSectionHash, null);
  assert.strictEqual(ready.published, null);

  const publishing = markWeeklyPublishing(paths, ATTEMPT_ID);
  assert.strictEqual(publishing.status, "publishing");
  assert.strictEqual(publishing.expectedSectionHash, null);

  const pinned = pinExpectedSectionHash(paths, ATTEMPT_ID, SECTION_HASH);
  assert.strictEqual(pinned.status, "publishing");
  assert.strictEqual(pinned.expectedSectionHash, SECTION_HASH);

  const publishedEvidence = {
    wikiTitle: "2026년 9월 3주차 주간보고",
    wikiVersion: 12,
    updatedOn: "2026-09-16T06:10:00.000Z",
    sectionHash: SECTION_HASH,
    verifiedAt: "2026-09-16T06:10:01.000Z",
  };
  const published = markWeeklyPublished(paths, ATTEMPT_ID, publishedEvidence);
  assert.strictEqual(published.status, "published");
  assert.deepStrictEqual(published.published, publishedEvidence);
});

test("weekly state rejects stale ownership, illegal transitions, and an unpinned publication", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });

  const staged = patchWeeklyStatus(paths, ATTEMPT_ID, { stage: "generate" });
  assert.strictEqual(staged.status, "preparing");
  assert.strictEqual(staged.stage, "generate");
  assert.strictEqual(staged.pipelineAttemptId, ATTEMPT_ID);
  assert.throws(
    () => patchWeeklyStatus(paths, OTHER_ATTEMPT_ID, { stage: "generate" }),
    /ownership/
  );
  assert.throws(
    () => markWeeklyPublished(paths, ATTEMPT_ID, { sectionHash: SECTION_HASH }),
    /invalid.*transition/
  );

  markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir));
  markWeeklyPublishing(paths, ATTEMPT_ID);
  assert.throws(
    () => markWeeklyPublished(paths, ATTEMPT_ID, { sectionHash: SECTION_HASH }),
    /pinned expected section hash/
  );
  assert.throws(
    () => pinExpectedSectionHash(paths, ATTEMPT_ID, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    /lowercase SHA-256/
  );
});

test("a new weekly attempt replaces only status.json and preserves the meeting directory", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE), null);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const meetingInode = fs.statSync(paths.meetingDir).ino;
  const retainedPath = path.join(paths.meetingDir, "retained-evidence.json");
  fs.writeFileSync(retainedPath, "retained\n", "utf8");

  const replacement = createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: OTHER_ATTEMPT_ID,
    now: () => "2026-09-16T07:05:00.000Z",
  });

  assert.strictEqual(replacement.pipelineAttemptId, OTHER_ATTEMPT_ID);
  assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).pipelineAttemptId, OTHER_ATTEMPT_ID);
  assert.strictEqual(fs.statSync(paths.meetingDir).ino, meetingInode);
  assert.strictEqual(fs.readFileSync(retainedPath, "utf8"), "retained\n");
});

test("weekly state rejects malformed meeting dates and non-UUID attempt ownership", (t) => {
  const outputDir = makeOutputDir(t);
  assert.throws(
    () => buildWeeklyPipelinePaths(outputDir, "2026-09-16/escape"),
    /YYYY-MM-DD/
  );
  assert.throws(() => createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: "not-a-uuid",
    now: () => "2026-09-16T06:05:00.000Z",
  }), /UUID/);
  assert.strictEqual(fs.existsSync(path.join(outputDir, "pipeline")), false);
});

test("weekly status replacement fsyncs complete bytes before rename and then fsyncs the directory", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  const events = [];
  let temporaryDescriptor;
  let directoryDescriptor;
  const original = {
    openSync: fs.openSync,
    writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync,
    renameSync: fs.renameSync,
  };

  fs.openSync = (entryPath, flags, mode) => {
    const descriptor = original.openSync(entryPath, flags, mode);
    if (String(entryPath).includes(".status.json.tmp-")) {
      temporaryDescriptor = descriptor;
      assert.strictEqual(flags, "wx");
      assert.strictEqual(mode, 0o600);
      events.push("open-temp");
    } else if (entryPath === paths.meetingDir) {
      directoryDescriptor = descriptor;
      events.push("open-directory");
    }
    return descriptor;
  };
  fs.writeFileSync = (target, data, encoding) => {
    if (target === temporaryDescriptor) {
      assert.strictEqual(JSON.parse(data).pipelineAttemptId, ATTEMPT_ID);
      events.push("write-temp");
    }
    return original.writeFileSync(target, data, encoding);
  };
  fs.fsyncSync = (descriptor) => {
    if (descriptor === directoryDescriptor) events.push("fsync-directory");
    else if (descriptor === temporaryDescriptor) events.push("fsync-temp");
    return original.fsyncSync(descriptor);
  };
  fs.closeSync = (descriptor) => {
    if (descriptor === directoryDescriptor) events.push("close-directory");
    else if (descriptor === temporaryDescriptor) events.push("close-temp");
    return original.closeSync(descriptor);
  };
  fs.renameSync = (source, destination) => {
    assert.strictEqual(destination, paths.statusPath);
    assert.strictEqual(JSON.parse(fs.readFileSync(source, "utf8")).pipelineAttemptId, ATTEMPT_ID);
    events.push("rename");
    return original.renameSync(source, destination);
  };
  try {
    createWeeklyAttempt({
      outputDir,
      meetingDate: MEETING_DATE,
      reportDepth: 3,
      attemptId: ATTEMPT_ID,
      now: () => "2026-09-16T06:05:00.000Z",
    });
  } finally {
    fs.openSync = original.openSync;
    fs.writeFileSync = original.writeFileSync;
    fs.fsyncSync = original.fsyncSync;
    fs.closeSync = original.closeSync;
    fs.renameSync = original.renameSync;
  }

  assert.deepStrictEqual(events, [
    "open-temp",
    "write-temp",
    "fsync-temp",
    "close-temp",
    "rename",
    "open-directory",
    "fsync-directory",
    "close-directory",
  ]);
  assert.strictEqual(fs.statSync(paths.statusPath).mode & 0o777, 0o600);
});

test("an interrupted weekly status rename preserves the previous readable owner", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === paths.statusPath) throw new Error("injected interrupted rename");
    return originalRenameSync(source, destination);
  };
  try {
    assert.throws(() => createWeeklyAttempt({
      outputDir,
      meetingDate: MEETING_DATE,
      reportDepth: 3,
      attemptId: OTHER_ATTEMPT_ID,
      now: () => "2026-09-16T07:05:00.000Z",
    }), /injected interrupted rename/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).pipelineAttemptId, ATTEMPT_ID);
  assert.deepStrictEqual(
    fs.readdirSync(paths.meetingDir).filter((name) => name.includes(".status.json.tmp-")),
    []
  );
});

test("dangling status and pipeline symlinks are rejected instead of treated as absent", async (t) => {
  await t.test("status.json", () => {
    const outputDir = makeOutputDir(t);
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    fs.mkdirSync(paths.meetingDir, { recursive: true });
    fs.symlinkSync(path.join(outputDir, "missing-status.json"), paths.statusPath);

    assert.throws(() => loadWeeklyStatus(outputDir, MEETING_DATE), /symlink/);
  });

  await t.test("pipeline directory", () => {
    const outputDir = makeOutputDir(t);
    fs.symlinkSync(path.join(outputDir, "missing-pipeline"), path.join(outputDir, "pipeline"));

    assert.throws(() => loadWeeklyStatus(outputDir, MEETING_DATE), /symlink/);
  });
});

test("READY rejects direct evidence escapes without changing the preparing status bytes", (t) => {
  const outputDir = makeOutputDir(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-weekly-outside-"));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const outsideEvidencePath = path.join(outsideDir, "evidence.json");
  fs.writeFileSync(outsideEvidencePath, "{}\n", "utf8");
  const previousBytes = fs.readFileSync(paths.statusPath, "utf8");

  for (const field of ["snapshotPath", "generationStatePath", "reportPath"]) {
    assert.throws(
      () => markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir, {
        [field]: outsideEvidencePath,
      })),
      /evidence.*outside|escape|ownership/
    );
    assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), previousBytes);
  }
});

test("READY rejects symlink evidence escapes without changing the preparing status bytes", (t) => {
  const outputDir = makeOutputDir(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-weekly-outside-"));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const outsideEvidencePath = path.join(outsideDir, "evidence.json");
  const evidenceLinkPath = path.join(outputDir, "evidence-link.json");
  fs.writeFileSync(outsideEvidencePath, "outside\n", "utf8");
  fs.symlinkSync(outsideEvidencePath, evidenceLinkPath);
  const previousBytes = fs.readFileSync(paths.statusPath, "utf8");

  for (const field of ["snapshotPath", "generationStatePath", "reportPath"]) {
    assert.throws(
      () => markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir, {
        [field]: evidenceLinkPath,
      })),
      /evidence.*symlink|escape|ownership/
    );
    assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), previousBytes);
  }
});

test("owned patches reject immutable identity mutations without changing status bytes", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const previousBytes = fs.readFileSync(paths.statusPath, "utf8");
  const mutations = [
    { schemaVersion: 2 },
    { meetingDate: "2026-09-17" },
    { pipelineAttemptId: OTHER_ATTEMPT_ID },
    { startedAt: "2026-09-16T00:00:00.000Z" },
    { reportDepth: 1 },
  ];

  for (const mutation of mutations) {
    assert.throws(
      () => patchWeeklyStatus(paths, ATTEMPT_ID, mutation),
      /immutable|ownership/
    );
    assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), previousBytes);
  }
});

test("owned patches reject malformed mutable schema fields without changing status bytes", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const previousBytes = fs.readFileSync(paths.statusPath, "utf8");

  assert.throws(
    () => patchWeeklyStatus(paths, ATTEMPT_ID, {
      reportPath: "relative-report.md",
      reportHash: "INVALID",
    }),
    /reportPath|report hash|schema/
  );
  assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), previousBytes);
});

test("generic patches reject helper-owned evidence fields without changing status bytes", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const evidence = makeReadyEvidence(outputDir);
  const previousBytes = fs.readFileSync(paths.statusPath, "utf8");

  assert.throws(
    () => patchWeeklyStatus(paths, ATTEMPT_ID, {
      reportPath: evidence.reportPath,
      reportHash: evidence.reportHash,
    }),
    /unsupported.*patch field/
  );
  assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), previousBytes);
  assert.throws(
    () => patchWeeklyStatus(paths, ATTEMPT_ID, {
      failureArtifact: evidence.reportPath,
    }),
    /unsupported.*patch field/
  );
  assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), previousBytes);
});

test("generic status patches cannot create READY without its complete evidence", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const previousBytes = fs.readFileSync(paths.statusPath, "utf8");

  assert.throws(
    () => patchWeeklyStatus(paths, ATTEMPT_ID, { status: "ready" }),
    /READY evidence/
  );
  assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), previousBytes);
});

test("READY rejects arbitrary identity keys without changing status bytes", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const previousBytes = fs.readFileSync(paths.statusPath, "utf8");

  assert.throws(
    () => markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir, {
      schemaVersion: 2,
    })),
    /evidence|immutable|schema/
  );
  assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), previousBytes);
});

test("weekly failures use stable categories while preserving actionable detail codes", () => {
  const validation = {
    publishable: false,
    issues: [
      { code: "z_other_error", severity: "error", message: "other" },
      {
        code: "unmarked_protected_fact",
        severity: "error",
        message: "version range changed",
      },
      {
        code: "unmarked_protected_fact",
        severity: "error",
        message: "ratio changed",
      },
    ],
  };
  const cases = [
    {
      name: "collect exception",
      input: { stage: "collect", error: Object.assign(new Error("socket closed"), {
        code: "ECONNRESET",
      }) },
      code: "collect_failed",
      primaryIssueCode: "ECONNRESET",
    },
    {
      name: "AI exception",
      input: { stage: "generate", error: Object.assign(new Error("timed out"), {
        code: "AI_TIMEOUT",
      }) },
      code: "ai_failed",
      primaryIssueCode: "AI_TIMEOUT",
    },
    {
      name: "source selection exception",
      input: { stage: "generate", error: Object.assign(new Error("invalid selection"), {
        code: "SOURCE_SELECTION_INVALID",
      }) },
      code: "source_selection_invalid",
      primaryIssueCode: "SOURCE_SELECTION_INVALID",
    },
    {
      name: "source records exception",
      input: { stage: "generate", error: Object.assign(new Error("invalid records"), {
        code: "SOURCE_RECORDS_AMBIGUOUS",
      }) },
      code: "source_selection_invalid",
      primaryIssueCode: "SOURCE_RECORDS_AMBIGUOUS",
    },
    {
      name: "non-publishable validation",
      input: { stage: "validate", validation },
      code: "validation_failed",
      primaryIssueCode: "unmarked_protected_fact",
    },
    {
      name: "validation stage takes precedence over an AI detail code",
      input: {
        stage: "validate",
        error: Object.assign(new Error("AI output failed validation"), {
          code: "AI_PART_VALIDATION",
        }),
        validation,
      },
      code: "validation_failed",
      primaryIssueCode: "unmarked_protected_fact",
    },
    {
      name: "missing or preparing status",
      input: { stage: "publish", error: Object.assign(new Error("prepare did not finish"), {
        code: "prepare_incomplete",
      }) },
      code: "prepare_incomplete",
      primaryIssueCode: "prepare_incomplete",
    },
    {
      name: "READY evidence mismatch",
      input: { stage: "publish", error: Object.assign(new Error("snapshot changed"), {
        code: "snapshot_hash_mismatch",
      }) },
      code: "ready_evidence_mismatch",
      primaryIssueCode: "snapshot_hash_mismatch",
    },
    {
      name: "Wiki HTTP exception",
      input: { stage: "publish", error: Object.assign(new Error("bad gateway"), {
        code: "HTTP_502",
      }) },
      code: "publish_http_failed",
      primaryIssueCode: "HTTP_502",
    },
    {
      name: "publish stage takes precedence over an AI-shaped HTTP detail code",
      input: { stage: "publish", error: Object.assign(new Error("unauthorized"), {
        code: "AI_AUTH",
      }) },
      code: "publish_http_failed",
      primaryIssueCode: "AI_AUTH",
    },
    {
      name: "stale publishing",
      input: { stage: "publish", error: Object.assign(new Error("previous PUT is uncertain"), {
        code: "publish_incomplete",
      }) },
      code: "publish_incomplete",
      primaryIssueCode: "publish_incomplete",
    },
    {
      name: "remote section mismatch",
      input: {
        stage: "publish_verify",
        error: Object.assign(new Error("section changed"), { code: "section_hash_mismatch" }),
      },
      code: "publish_verify_mismatch",
      primaryIssueCode: "publish_verify_mismatch",
    },
  ];

  for (const entry of cases) {
    const failure = classifyWeeklyFailure(entry.input);
    assert.strictEqual(failure.code, entry.code, entry.name);
    assert.strictEqual(failure.primaryIssueCode, entry.primaryIssueCode, entry.name);
  }

  const classifiedValidation = classifyWeeklyFailure({ stage: "validate", validation });
  assert.deepStrictEqual(classifiedValidation.issueCounts, {
    unmarked_protected_fact: 2,
    z_other_error: 1,
  });
  assert.deepStrictEqual(
    classifiedValidation.representativeIssues.map((issue) => issue.message),
    ["ratio changed", "version range changed", "other"]
  );
  assert.ok(classifiedValidation.representativeIssues.length <= 3);

  const log = formatWeeklyFailureLog(classifiedValidation, "/tmp/failure.md");
  assert.match(log, /^\[weekly\]\[FAIL\] stage=validate code=unmarked_protected_fact /);
  assert.match(log, /artifact=.*\.md$/);
  assert.strictEqual(log.includes("\n"), false);
});

test("weekly failure summaries redact secrets and cap untrusted text", () => {
  const secretMessage = [
    "X-Redmine-API-Key: redmine-key-123",
    "Authorization: Bearer bearer-token-456",
    '"Authorization": "Bearer json-bearer-token-789"',
    '"X-Redmine-API-Key": "json-redmine-key-789"',
    "Authorization: token token-scheme-secret-789",
    "sk-proj-provider-secret-789",
    "sk-ant-api03-provider-secret-987",
    "xoxb-1234567890-secret",
    "https://secret@host/private",
    "Z".repeat(3000),
  ].join("\n");
  const error = Object.assign(new Error(secretMessage), { code: "AI_PROVIDER" });
  error.stack = `Error: ${secretMessage}\n${"stack-frame ".repeat(500)}`;
  const failure = classifyWeeklyFailure({
    stage: "generate",
    error,
    validation: {
      publishable: false,
      issues: [{
        code: "long_issue",
        severity: "error",
        message: `${secretMessage}${"I".repeat(3000)}`,
      }],
    },
  });
  const log = formatWeeklyFailureLog({ ...failure, stage: "generate" }, "/tmp/failure.md");
  const serialized = JSON.stringify(failure);

  assert.match(serialized, /\[REDACTED\]/);
  for (const secret of [
    "redmine-key-123",
    "bearer-token-456",
    "json-bearer-token-789",
    "json-redmine-key-789",
    "token-scheme-secret-789",
    "sk-proj-provider-secret-789",
    "sk-ant-api03-provider-secret-987",
    "xoxb-1234567890-secret",
    "secret@host",
  ]) {
    assert.strictEqual(serialized.includes(secret), false);
    assert.strictEqual(log.includes(secret), false);
  }
  assert.ok(failure.cause.length <= 500);
  assert.ok(failure.representativeIssues[0].message.length <= 500);
  assert.strictEqual(log.includes("\n"), false);
});

test("weekly skip logs expose terminal state without retrying work", () => {
  assert.strictEqual(
    formatWeeklySkipLog({ status: "failed", failureArtifact: "/tmp/failure.md" }),
    "[weekly][SKIP] status=failed artifact=/tmp/failure.md"
  );
  assert.strictEqual(
    formatWeeklySkipLog({ status: "published" }),
    "[weekly][SKIP] already-published"
  );
});

test("weekly failure records immutable JSON and ordered Markdown with owned artifact hashes", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  const state = createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const artifactPath = path.join(outputDir, "runs", MEETING_DATE, ATTEMPT_ID, "artifact.txt");
  const missingPath = path.join(outputDir, "runs", MEETING_DATE, ATTEMPT_ID, "missing.txt");
  const directoryPath = path.dirname(artifactPath);
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(artifactPath, "artifact-one\n", "utf8");
  const error = Object.assign(new Error(
    [
      '"Authorization": "Bearer json-bearer-token-789"',
      '"X-Redmine-API-Key": "json-redmine-key-789"',
      "Authorization: token token-scheme-secret-789",
      "sk-proj-provider-secret-789",
      "sk-ant-api03-provider-secret-987",
      "https://secret@host/private",
    ].join(" ")
  ), { code: "VALIDATION_REJECTED", responseBody: "never serialize this response body" });
  error.stack = `Error: X-Redmine-API-Key: redmine-key-123\n${"stack-frame ".repeat(500)}`;

  const result = recordWeeklyFailure({
    paths,
    state,
    stage: "validate",
    error,
    validation: {
      publishable: false,
      issues: [
        { code: "z_other_error", severity: "error", message: "other" },
        {
          code: "unmarked_protected_fact",
          severity: "error",
          message: "xoxb-1234567890-secret " + "I".repeat(1000),
        },
        {
          code: "unmarked_protected_fact",
          severity: "error",
          message: "ratio changed",
        },
      ],
    },
    artifacts: [artifactPath, missingPath, directoryPath],
    redmineWriteAttempted: false,
    serverState: "unchanged",
    retryCommand: "node index.js --mode weekly-prepare --date 2026-09-16",
    now: () => "2026-09-16T06:15:00.123Z",
  });

  const expectedBase = `20260916T061500123Z-validate-${ATTEMPT_ID}`;
  assert.strictEqual(result.jsonPath, path.join(paths.failuresDir, `${expectedBase}.json`));
  assert.strictEqual(result.markdownPath, path.join(paths.failuresDir, `${expectedBase}.md`));
  assert.strictEqual(result.state.status, "failed");
  assert.strictEqual(result.state.failureArtifact, result.markdownPath);
  assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).failureArtifact, result.markdownPath);

  const jsonBytes = fs.readFileSync(result.jsonPath, "utf8");
  const recorded = JSON.parse(jsonBytes);
  assert.deepStrictEqual({
    schemaVersion: recorded.schemaVersion,
    meetingDate: recorded.meetingDate,
    pipelineAttemptId: recorded.pipelineAttemptId,
    occurredAt: recorded.occurredAt,
    stage: recorded.stage,
    code: recorded.code,
    primaryIssueCode: recorded.primaryIssueCode,
    issueCounts: recorded.issueCounts,
    redmineWriteAttempted: recorded.redmineWriteAttempted,
    serverState: recorded.serverState,
    retryCommand: recorded.retryCommand,
  }, {
    schemaVersion: 1,
    meetingDate: MEETING_DATE,
    pipelineAttemptId: ATTEMPT_ID,
    occurredAt: "2026-09-16T06:15:00.123Z",
    stage: "validate",
    code: "validation_failed",
    primaryIssueCode: "unmarked_protected_fact",
    issueCounts: { unmarked_protected_fact: 2, z_other_error: 1 },
    redmineWriteAttempted: false,
    serverState: "unchanged",
    retryCommand: "node index.js --mode weekly-prepare --date 2026-09-16",
  });
  assert.deepStrictEqual(recorded.artifacts, [{
    path: artifactPath,
    sha256: "8a4e7c30c9d88e86c25918409b96c905e9966494ad6d48b9c17037fafe944120",
  }]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(recorded, "responseBody"), false);
  assert.strictEqual(jsonBytes.includes("artifact-one"), false);
  assert.ok(recorded.message.length <= 500);
  assert.ok(recorded.stack.length <= 2000);
  assert.ok(recorded.representativeIssues[0].message.length <= 500);

  const markdown = fs.readFileSync(result.markdownPath, "utf8");
  const log = formatWeeklyFailureLog(result.failure, result.markdownPath);
  for (const secret of [
    "redmine-key-123",
    "json-bearer-token-789",
    "json-redmine-key-789",
    "token-scheme-secret-789",
    "sk-proj-provider-secret-789",
    "sk-ant-api03-provider-secret-987",
    "xoxb-1234567890-secret",
    "secret@host",
    "never serialize this response body",
  ]) {
    assert.strictEqual(jsonBytes.includes(secret), false);
    assert.strictEqual(markdown.includes(secret), false);
    assert.strictEqual(log.includes(secret), false);
  }
  assert.match(jsonBytes, /\[REDACTED\]/);
  assert.match(markdown, /\[REDACTED\]/);
  assert.match(log, /\[REDACTED\]/);
  const stageIndex = markdown.indexOf("Stage: validate");
  const causeIndex = markdown.indexOf("Cause:");
  const countsIndex = markdown.indexOf("## Issue counts");
  const examplesIndex = markdown.indexOf("## Representative issues");
  const serverIndex = markdown.indexOf("## Server state");
  const artifactsIndex = markdown.indexOf("## Artifacts");
  const retryIndex = markdown.indexOf("## Retry");
  assert.ok(stageIndex < causeIndex);
  assert.ok(causeIndex < countsIndex);
  assert.ok(countsIndex < examplesIndex);
  assert.ok(examplesIndex < serverIndex);
  assert.ok(serverIndex < artifactsIndex);
  assert.ok(artifactsIndex < retryIndex);
  assert.match(markdown, /node index\.js --mode weekly-prepare --date 2026-09-16/);
});

test("weekly failure destinations are immutable and a later attempt preserves prior evidence", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  const firstState = createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const input = {
    paths,
    state: firstState,
    stage: "collect",
    error: new Error("collect stopped"),
    validation: null,
    artifacts: [],
    redmineWriteAttempted: false,
    serverState: "unchanged",
    retryCommand: "node index.js --mode weekly-prepare --date 2026-09-16",
    now: () => "2026-09-16T06:10:00.000Z",
  };
  const first = recordWeeklyFailure(input);
  const firstJson = fs.readFileSync(first.jsonPath, "utf8");
  const firstMarkdown = fs.readFileSync(first.markdownPath, "utf8");

  assert.throws(() => recordWeeklyFailure(input), /immutable artifact already exists/);
  assert.strictEqual(fs.readFileSync(first.jsonPath, "utf8"), firstJson);
  assert.strictEqual(fs.readFileSync(first.markdownPath, "utf8"), firstMarkdown);

  const secondState = createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: OTHER_ATTEMPT_ID,
    now: () => "2026-09-16T07:05:00.000Z",
  });
  const second = recordWeeklyFailure({
    ...input,
    state: secondState,
    error: new Error("second collect stopped"),
    now: () => "2026-09-16T07:10:00.000Z",
  });

  assert.notStrictEqual(second.jsonPath, first.jsonPath);
  assert.notStrictEqual(second.markdownPath, first.markdownPath);
  assert.strictEqual(fs.readFileSync(first.jsonPath, "utf8"), firstJson);
  assert.strictEqual(fs.readFileSync(first.markdownPath, "utf8"), firstMarkdown);
  assert.strictEqual(fs.existsSync(second.jsonPath), true);
  assert.strictEqual(fs.existsSync(second.markdownPath), true);
});

test("weekly failure artifact candidates cannot escape through direct or symlink paths", async (t) => {
  await t.test("direct escape", () => {
    const outputDir = makeOutputDir(t);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-weekly-outside-"));
    t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
    const outsidePath = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    const state = createWeeklyAttempt({
      outputDir,
      meetingDate: MEETING_DATE,
      reportDepth: 3,
      attemptId: ATTEMPT_ID,
      now: () => "2026-09-16T06:05:00.000Z",
    });

    assert.throws(() => recordWeeklyFailure({
      paths,
      state,
      stage: "collect",
      error: new Error("collect stopped"),
      artifacts: [outsidePath],
      redmineWriteAttempted: false,
      serverState: "unchanged",
      retryCommand: "retry",
      now: () => "2026-09-16T06:10:00.000Z",
    }), /artifact.*escapes configured output directory/);
    assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).status, "preparing");
  });

  await t.test("symlink escape", () => {
    const outputDir = makeOutputDir(t);
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    const state = createWeeklyAttempt({
      outputDir,
      meetingDate: MEETING_DATE,
      reportDepth: 3,
      attemptId: ATTEMPT_ID,
      now: () => "2026-09-16T06:05:00.000Z",
    });
    const targetPath = path.join(outputDir, "target.txt");
    const linkPath = path.join(outputDir, "artifact-link.txt");
    fs.writeFileSync(targetPath, "target\n", "utf8");
    fs.symlinkSync(targetPath, linkPath);

    assert.throws(() => recordWeeklyFailure({
      paths,
      state,
      stage: "collect",
      error: new Error("collect stopped"),
      artifacts: [linkPath],
      redmineWriteAttempted: false,
      serverState: "unchanged",
      retryCommand: "retry",
      now: () => "2026-09-16T06:10:00.000Z",
    }), /artifact.*symlink/);
    assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).status, "preparing");
  });

  await t.test("symlink failure directory", () => {
    const outputDir = makeOutputDir(t);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-weekly-outside-"));
    t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    const state = createWeeklyAttempt({
      outputDir,
      meetingDate: MEETING_DATE,
      reportDepth: 3,
      attemptId: ATTEMPT_ID,
      now: () => "2026-09-16T06:05:00.000Z",
    });
    fs.symlinkSync(outsideDir, paths.failuresDir);

    assert.throws(() => recordWeeklyFailure({
      paths,
      state,
      stage: "collect",
      error: new Error("collect stopped"),
      artifacts: [],
      redmineWriteAttempted: false,
      serverState: "unchanged",
      retryCommand: "retry",
      now: () => "2026-09-16T06:10:00.000Z",
    }), /failures directory.*symlink/);
    assert.deepStrictEqual(fs.readdirSync(outsideDir), []);
    assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).status, "preparing");
  });

  await t.test("symlink final JSON path", () => {
    const outputDir = makeOutputDir(t);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-weekly-outside-"));
    t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    const state = createWeeklyAttempt({
      outputDir,
      meetingDate: MEETING_DATE,
      reportDepth: 3,
      attemptId: ATTEMPT_ID,
      now: () => "2026-09-16T06:05:00.000Z",
    });
    fs.mkdirSync(paths.failuresDir);
    const outsidePath = path.join(outsideDir, "outside.json");
    fs.writeFileSync(outsidePath, "unchanged\n", "utf8");
    const finalJsonPath = path.join(
      paths.failuresDir,
      `20260916T061000000Z-collect-${ATTEMPT_ID}.json`
    );
    fs.symlinkSync(outsidePath, finalJsonPath);

    assert.throws(() => recordWeeklyFailure({
      paths,
      state,
      stage: "collect",
      error: new Error("collect stopped"),
      artifacts: [],
      redmineWriteAttempted: false,
      serverState: "unchanged",
      retryCommand: "retry",
      now: () => "2026-09-16T06:10:00.000Z",
    }), /failure JSON file.*symlink/);
    assert.strictEqual(fs.readFileSync(outsidePath, "utf8"), "unchanged\n");
    assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).status, "preparing");
  });
});

test("weekly state changes only after both failure files exist and preserves immutable fields", async (t) => {
  for (const initialStatus of ["preparing", "ready", "publishing"]) {
    await t.test(initialStatus, () => {
      const outputDir = makeOutputDir(t);
      const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
      let state = createWeeklyAttempt({
        outputDir,
        meetingDate: MEETING_DATE,
        reportDepth: 3,
        attemptId: ATTEMPT_ID,
        now: () => "2026-09-16T06:05:00.000Z",
      });
      if (initialStatus !== "preparing") {
        state = markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir));
      }
      if (initialStatus === "publishing") state = markWeeklyPublishing(paths, ATTEMPT_ID);
      const originalRenameSync = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (destination === paths.statusPath) {
          const base = `20260916T061500000Z-${state.stage}-${ATTEMPT_ID}`;
          assert.strictEqual(fs.existsSync(path.join(paths.failuresDir, `${base}.json`)), true);
          assert.strictEqual(fs.existsSync(path.join(paths.failuresDir, `${base}.md`)), true);
        }
        return originalRenameSync(source, destination);
      };
      let result;
      try {
        result = recordWeeklyFailure({
          paths,
          state,
          stage: state.stage,
          error: new Error("stopped"),
          artifacts: [],
          redmineWriteAttempted: initialStatus === "publishing",
          serverState: initialStatus === "publishing" ? "written_unverified" : "unchanged",
          retryCommand: "retry exact",
          now: () => "2026-09-16T06:15:00.000Z",
        });
      } finally {
        fs.renameSync = originalRenameSync;
      }
      assert.strictEqual(result.state.status, "failed");
      assert.strictEqual(result.state.pipelineAttemptId, state.pipelineAttemptId);
      assert.strictEqual(result.state.startedAt, state.startedAt);
      assert.strictEqual(result.state.reportDepth, state.reportDepth);
    });
  }
});

test("weekly failure files survive status persistence failure with recovery paths attached", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  const state = createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === paths.statusPath) throw new Error("injected status persistence failure");
    return originalRenameSync(source, destination);
  };
  let caught;
  try {
    recordWeeklyFailure({
      paths,
      state,
      stage: "collect",
      error: new Error("collect stopped"),
      artifacts: [],
      redmineWriteAttempted: false,
      serverState: "unchanged",
      retryCommand: "retry exact",
      now: () => "2026-09-16T06:15:00.000Z",
    });
  } catch (error) {
    caught = error;
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.match(caught && caught.message, /injected status persistence failure/);
  assert.strictEqual(fs.existsSync(caught.jsonPath), true);
  assert.strictEqual(fs.existsSync(caught.markdownPath), true);
  assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).status, "preparing");
});

test("damaged READY evidence can record its mismatch without weakening state ownership", (t) => {
  const outputDir = makeOutputDir(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-weekly-outside-"));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  createWeeklyAttempt({
    outputDir,
    meetingDate: MEETING_DATE,
    reportDepth: 3,
    attemptId: ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
  });
  const ready = markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir));
  const readyBytes = fs.readFileSync(paths.statusPath, "utf8");

  assert.throws(() => recordWeeklyFailure({
    paths,
    state: { ...ready, reportPath: "relative-report.md" },
    stage: "publish",
    error: Object.assign(new Error("report disappeared"), { code: "report_hash_mismatch" }),
    artifacts: [],
    redmineWriteAttempted: false,
    serverState: "unchanged",
    retryCommand: "node index.js --mode weekly-prepare --date 2026-09-16",
    now: () => "2026-09-16T06:20:00.000Z",
  }), /reportPath.*absolute evidence path/);
  assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), readyBytes);
  assert.strictEqual(fs.existsSync(paths.failuresDir), false);

  fs.unlinkSync(ready.reportPath);
  const result = recordWeeklyFailure({
    paths,
    state: ready,
    stage: "publish",
    error: Object.assign(new Error("report disappeared"), { code: "report_hash_mismatch" }),
    artifacts: [ready.reportPath],
    redmineWriteAttempted: false,
    serverState: "unchanged",
    retryCommand: "node index.js --mode weekly-prepare --date 2026-09-16",
    now: () => "2026-09-16T06:20:00.000Z",
  });

  assert.strictEqual(result.failure.code, "ready_evidence_mismatch");
  assert.strictEqual(fs.existsSync(result.jsonPath), true);
  assert.strictEqual(fs.existsSync(result.markdownPath), true);
  assert.strictEqual(result.state.status, "failed");
  assert.strictEqual(result.state.failureArtifact, result.markdownPath);
  assert.deepStrictEqual(result.failure.artifacts, []);

  const failedBytes = fs.readFileSync(paths.statusPath, "utf8");
  const outsidePath = path.join(outsideDir, "outside.md");
  fs.writeFileSync(outsidePath, "outside\n", "utf8");
  fs.unlinkSync(result.markdownPath);
  fs.symlinkSync(outsidePath, result.markdownPath);
  assert.throws(
    () => patchWeeklyStatus(paths, ATTEMPT_ID, { stage: "publish_verify" }),
    /failure artifact.*symlink/
  );
  assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), failedBytes);
  assert.strictEqual(fs.readFileSync(outsidePath, "utf8"), "outside\n");
});
