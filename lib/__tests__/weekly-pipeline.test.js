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

test("weekly state follows preparing to ready to publishing to published", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  const snapshotPath = path.join(outputDir, "snapshot.json");
  const generationStatePath = path.join(outputDir, "report.generation.json");
  const reportPath = path.join(outputDir, "report.md");

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

  const ready = markWeeklyReady(paths, ATTEMPT_ID, {
    snapshotPath,
    snapshotHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generationAttemptId: GENERATION_ATTEMPT_ID,
    generationStatePath,
    reportPath,
    reportHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
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

  markWeeklyReady(paths, ATTEMPT_ID, {
    snapshotPath: path.join(outputDir, "snapshot.json"),
    snapshotHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generationAttemptId: GENERATION_ATTEMPT_ID,
    generationStatePath: path.join(outputDir, "report.generation.json"),
    reportPath: path.join(outputDir, "report.md"),
    reportHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
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
