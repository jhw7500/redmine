const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
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
const { runWeeklyPrepare, runWeeklyPublish, runGenerateV2, runUpdate, assertWeeklyProfile } = require("../../index");
const { setupSnapshot, makeFakeClaude } = require("./helpers/report-run-fixture");
const { sha256, buildPublishedPath } = require("../report-artifact");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const MEETING_DATE = "2026-09-16";
const EXPECTED_RETRY_COMMAND = "rtk env MEETING_DATE=2026-09-16 ./run-weekly-prepare-env.sh";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const GENERATION_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const SECTION_HASH = "3333333333333333333333333333333333333333333333333333333333333333";

function makeOutputDir(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-weekly-pipeline-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  return outputDir;
}

function publishConfig(outputDir) {
  return { env: { outputDir, autoApprove: true, reportDepth: 3,
    validationMode: "block", validationOverride: false, presentationNoteMode: "suggest" } };
}

function failureFor(outputDir, date = MEETING_DATE) {
  const state = loadWeeklyStatus(outputDir, date);
  return JSON.parse(fs.readFileSync(state.failureArtifact.replace(/\.md$/, ".json"), "utf8"));
}

function assertPrepareRetryGuidance(outputDir, failure) {
  const state = loadWeeklyStatus(outputDir, MEETING_DATE);
  const markdown = fs.readFileSync(state.failureArtifact, "utf8");
  assert.strictEqual(failure.retryCommand, EXPECTED_RETRY_COMMAND);
  assert.strictEqual(
    markdown.includes(`## Retry\n\n\`\`\`sh\n${EXPECTED_RETRY_COMMAND}\n\`\`\``),
    true
  );
  assert.doesNotMatch(`${failure.retryCommand}\n${markdown}`, /--mode|--date|node index\.js/);
}

function makeTerminalState(outputDir, status) {
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  const state = createWeeklyAttempt({ outputDir, meetingDate: MEETING_DATE, reportDepth: 3,
    attemptId: ATTEMPT_ID, now: () => "2026-09-16T06:05:00.000Z" });
  if (status === "failed") {
    recordWeeklyFailure({ paths, state, stage: "collect", error: new Error("fixture collection failed"),
      artifacts: [], redmineWriteAttempted: false, serverState: "unchanged",
      retryCommand: EXPECTED_RETRY_COMMAND, now: () => "2026-09-16T06:06:00.000Z" });
  } else {
    markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir));
    markWeeklyPublishing(paths, ATTEMPT_ID);
    pinExpectedSectionHash(paths, ATTEMPT_ID, SECTION_HASH);
    markWeeklyPublished(paths, ATTEMPT_ID, { wikiTitle: "weekly", version: 2,
      updatedOn: "2026-09-16T06:45:00Z", sectionHash: SECTION_HASH,
      verifiedAt: "2026-09-16T06:45:01.000Z" });
  }
  return loadWeeklyStatus(outputDir, MEETING_DATE);
}

test("weekly publish skips terminal states once without calls or artifacts", async (t) => {
  for (const status of ["failed", "published"]) await t.test(status, async () => {
    const outputDir = makeOutputDir(t);
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    const prior = makeTerminalState(outputDir, status);
    const before = fs.readFileSync(paths.statusPath, "utf8");
    const filesBefore = fs.readdirSync(paths.meetingDir, { recursive: true });
    const logs = [];
    const originalLog = console.log;
    let calls = 0;
    console.log = (line) => logs.push(line);
    try {
      const result = await runWeeklyPublish(publishConfig(outputDir), new Date(MEETING_DATE), {
        runUpdate: async () => { calls += 1; },
      });
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.reason, status === "published" ? "already-published" : prior.failureArtifact);
    } finally { console.log = originalLog; }
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(logs, [status === "published"
      ? "[weekly][SKIP] already-published" : `[weekly][SKIP] status=failed artifact=${prior.failureArtifact}`]);
    assert.strictEqual(fs.readFileSync(paths.statusPath, "utf8"), before);
    assert.deepStrictEqual(fs.readdirSync(paths.meetingDir, { recursive: true }), filesBefore);
  });
});

test("weekly publish rejects invalid terminal state without erasing evidence or calling update", async (t) => {
  for (const status of ["failed", "published"]) {
    for (const mutation of ["status-only", "meeting-date", "attempt", "depth", "missing-evidence", "missing-file", "symlink"]) {
      await t.test(`${status}/${mutation}`, async (t) => {
        const outputDir = makeOutputDir(t);
        const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
        let state = makeTerminalState(outputDir, status);
        const evidencePath = status === "failed" ? state.failureArtifact : state.reportPath;
        if (mutation === "status-only") state = { status };
        if (mutation === "meeting-date") state.meetingDate = "2026-09-23";
        if (mutation === "attempt") delete state.pipelineAttemptId;
        if (mutation === "depth") state.reportDepth = 2;
        if (mutation === "missing-evidence") {
          if (status === "failed") state.failureArtifact = null;
          else state.published = null;
        }
        if (mutation === "missing-file" || mutation === "symlink") {
          fs.renameSync(evidencePath, `${evidencePath}.retained`);
          if (mutation === "symlink") fs.symlinkSync(`${evidencePath}.retained`, evidencePath);
        }
        fs.writeFileSync(paths.statusPath, JSON.stringify(state));
        const before = fs.readFileSync(paths.statusPath);
        const filesBefore = fs.readdirSync(outputDir, { recursive: true });
        const logs = [];
        t.mock.method(console, "error", (line) => logs.push(line));
        await assert.rejects(() => runWeeklyPublish(publishConfig(outputDir), new Date(MEETING_DATE), {
          runUpdate: async () => assert.fail("invalid terminal state must not invoke update"),
        }), { code: "terminal_state_invalid" });
        assert.match(logs.join("\n"), /\[weekly\]\[FAIL\].*code=terminal_state_invalid/);
        assert.ok(logs.some((line) => line.includes(paths.statusPath)));
        assert.deepStrictEqual(fs.readFileSync(paths.statusPath), before);
        assert.deepStrictEqual(fs.readdirSync(outputDir, { recursive: true }), filesBefore);
      });
    }
  }
});

test("weekly publish records incomplete attempts and never retries external work", async (t) => {
  for (const status of [null, "preparing", "publishing"]) await t.test(String(status), async () => {
    const outputDir = makeOutputDir(t);
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    if (status) createWeeklyAttempt({ outputDir, meetingDate: MEETING_DATE, reportDepth: 3,
      attemptId: ATTEMPT_ID, now: () => "2026-09-16T06:05:00.000Z" });
    if (status === "publishing") {
      markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir));
      markWeeklyPublishing(paths, ATTEMPT_ID);
    }
    let calls = 0;
    const expectedCode = status === "publishing" ? "publish_incomplete" : "prepare_incomplete";
    await assert.rejects(() => runWeeklyPublish(publishConfig(outputDir), new Date(MEETING_DATE), {
      randomUUID: () => OTHER_ATTEMPT_ID,
      runUpdate: async () => { calls += 1; },
    }), { code: expectedCode });
    const failure = failureFor(outputDir);
    assert.strictEqual(failure.code, expectedCode);
    assert.strictEqual(failure.redmineWriteAttempted, status === "publishing");
    assert.strictEqual(failure.serverState, status === "publishing" ? "written_unverified" : "unchanged");
    assert.strictEqual(failure.pipelineAttemptId, status ? ATTEMPT_ID : OTHER_ATTEMPT_ID);
    assert.strictEqual(calls, 0);
  });
});

test("weekly failure artifacts route prepare and uncertain publish recovery through the wrapper", async (t) => {
  await t.test("prepare failure", async (t) => {
    const result = await capturePrepareFailure(t, {
      runCollect: async () => {
        throw Object.assign(new Error("collector unavailable"), { code: "ECONNRESET" });
      },
    });
    assertPrepareRetryGuidance(result.outputDir, result.failure);
  });

  await t.test("uncertain publish failure", async (t) => {
    const outputDir = makeOutputDir(t);
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    createWeeklyAttempt({ outputDir, meetingDate: MEETING_DATE, reportDepth: 3,
      attemptId: ATTEMPT_ID, now: () => "2026-09-16T06:05:00.000Z" });
    markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir));
    markWeeklyPublishing(paths, ATTEMPT_ID);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        () => runWeeklyPublish(publishConfig(outputDir), new Date(MEETING_DATE)),
        { code: "publish_incomplete" }
      );
    } finally {
      console.error = originalConsoleError;
    }
    assertPrepareRetryGuidance(outputDir, failureFor(outputDir));
  });
});

async function setupWeeklyReady(t, presentationCandidates = []) {
  const fixture = setupSnapshot(t, {
    presentationCandidates,
    rawContent: '#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - FPS 상한 30에서 60으로 변경\n',
    autoContent: { "{{APP}}": "- updated" },
    categories: { app: { parent: "PIM", label: "Application", templateKey: "APP" } },
  });
  Object.assign(fixture.config.env, { aiSummarize: true, aiGenerationMethod: "source_selection",
    sourceSelectionFallback: true, autoApprove: true, presentationNoteMode: "suggest" });
  fixture.config.env.claudeCli = makeFakeClaude(fixture, JSON.stringify({ sections: [{ id: "C0001",
    groups: [{ theme: "stability", items: [{ id: "R0001", highlight: false }] }] }] }));
  const generated = await runGenerateV2(fixture.config, fixture.meetingDate);
  assert.strictEqual(generated.validation.publishable, true);
  const date = "2026-08-26";
  const paths = buildWeeklyPipelinePaths(fixture.dir, date);
  createWeeklyAttempt({ outputDir: fixture.dir, meetingDate: date, reportDepth: 3,
    attemptId: ATTEMPT_ID, now: () => "2026-08-26T06:05:00.000Z" });
  const generationState = JSON.parse(fs.readFileSync(fixture.generationStatePath));
  const state = markWeeklyReady(paths, ATTEMPT_ID, {
    snapshotPath: fixture.snapshotPath, snapshotHash: fixture.snapshot.contentHash,
    generationStatePath: fixture.generationStatePath, generationAttemptId: generationState.attemptId,
    reportPath: fixture.reportPath, reportHash: sha256(fs.readFileSync(fixture.reportPath)),
  });
  return { ...fixture, generated, generationState, state, paths, date };
}

function runWeeklyCli(fixture, extraPreload = "") {
  const preloadPath = path.join(fixture.dir, "cli-fixture.cjs");
  // Only replace configuration and the external boundary; execute the real CLI/catches.
  fs.writeFileSync(preloadPath, [
    `require(${JSON.stringify(require.resolve("../config"))}).loadConfig = () => (${JSON.stringify({
      ...fixture.config, env: { ...fixture.config.env, mode: "weekly-publish", meetingDate: fixture.date },
    })});`,
    extraPreload,
  ].join("\n"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--require", preloadPath, path.resolve(__dirname, "../../index.js")], {
      cwd: path.resolve(__dirname, "../.."), env: { ...process.env, NOTION_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

test("weekly CLI stderr never reprints credentials from the original exception", async (t) => {
  const f = await setupWeeklyReady(t);
  Object.assign(f.config.env, { baseUrl: "http://127.0.0.1:1", apiKey: "fixture-key",
    wikiUrl: "http://127.0.0.1:1/projects/p/wiki/weekly" });
  const result = await runWeeklyCli(f, `
    global.fetch = async () => {
      const error = new Error("Authorization: Bearer CLI_MESSAGE_SENTINEL", {
        cause: new Error("CLI_CAUSE_SENTINEL")
      });
      error.stack = "Error: X-Redmine-API-Key: CLI_STACK_SENTINEL";
      error.headers = { authorization: "CLI_PROPERTY_SENTINEL" };
      throw error;
    };
  `);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /\[weekly\]\[FAIL\].*artifact=.*\.md/);
  for (const secret of ["CLI_MESSAGE_SENTINEL", "CLI_CAUSE_SENTINEL", "CLI_STACK_SENTINEL", "CLI_PROPERTY_SENTINEL"]) {
    assert.ok(!result.stderr.includes(secret), `complete stderr exposed ${secret}`);
  }
  const failureLines = result.stderr.trim().split("\n").filter((line) => line.includes("[weekly][FAIL]"));
  assert.strictEqual(failureLines.length, 1);
  assert.ok(result.stderr.trim().endsWith(failureLines[0]));
  assert.strictEqual(loadWeeklyStatus(f.dir, f.date).status, "failed");
});

test("non-weekly CLI failures retain a bounded useful diagnostic without inspecting exceptions", async (t) => {
  const f = { dir: makeOutputDir(t), config: {} };
  const result = await runWeeklyCli(f, `
    require(${JSON.stringify(require.resolve("../config"))}).loadConfig = () => {
      const error = new Error("fixture configuration rejected: " + "x".repeat(5000));
      error.privateDetails = "CLI_ATTACHED_SENTINEL";
      throw error;
    };
  `);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /fixture configuration rejected/);
  assert.ok(result.stderr.length < 600);
  assert.doesNotMatch(result.stderr, /CLI_ATTACHED_SENTINEL/);
});

test("weekly publish rejects changed READY evidence before calling update", async (t) => {
  const mutations = {
    meeting: (f) => { f.state.meetingDate = "2026-08-19"; },
    depth: (f) => { f.state.reportDepth = 2; },
    path: (f) => { f.state.reportPath = "/outside/report.md"; },
    reportHash: (f) => { fs.appendFileSync(f.reportPath, "changed\n"); },
    snapshotHash: (f) => { f.state.snapshotHash = "a".repeat(64); },
    snapshotBytes: (f) => { const s = JSON.parse(fs.readFileSync(f.snapshotPath)); s.rawContent += "changed";
      fs.writeFileSync(f.snapshotPath, JSON.stringify(s)); },
    attempt: (f) => { f.state.generationAttemptId = OTHER_ATTEMPT_ID; },
    generationPath: (f) => { f.state.generationStatePath = f.snapshotPath; },
    schema: (f) => { f.generationState.schemaVersion = 1; },
    method: (f) => { f.generationState.generationMethod = "freeform"; },
    generationDepth: (f) => { f.generationState.reportDepth = 2; },
    validation: (f) => { fs.appendFileSync(path.join(f.generated.runPaths.runDir,
      f.generationState.latestValidationPath), "changed"); },
    selectionSymlink: (f) => {
      const file = path.join(f.generated.runPaths.runDir, "source-selection.json");
      fs.renameSync(file, `${file}.target`);
      fs.symlinkSync(`${file}.target`, file);
    },
    symlink: (f) => { fs.renameSync(f.reportPath, `${f.reportPath}.target`);
      fs.symlinkSync(`${f.reportPath}.target`, f.reportPath); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const f = await setupWeeklyReady(t);
    mutate(f);
    fs.writeFileSync(f.paths.statusPath, JSON.stringify(f.state));
    fs.writeFileSync(f.generationStatePath, JSON.stringify(f.generationState));
    let calls = 0;
    await assert.rejects(() => runWeeklyPublish(f.config, f.meetingDate, {
      runUpdate: async () => { calls += 1; },
    }), { code: "ready_evidence_mismatch" });
    assert.strictEqual(calls, 0);
    const failure = failureFor(f.dir, f.date);
    assert.strictEqual(failure.code, "ready_evidence_mismatch");
    assert.strictEqual(failure.serverState, "unchanged");
    assert.strictEqual(failure.redmineWriteAttempted, false);
  });
});

test("weekly publish pins READY paths and exact final section before verifying", async (t) => {
  const f = await setupWeeklyReady(t);
  f.config.env.snapshotPath = "/wrong/snapshot.json";
  f.config.env.outputPath = "/wrong/report.md";
  const section = "final section\n \n";
  const result = await runWeeklyPublish(f.config, f.meetingDate, {
    runUpdate: async (config, date, options) => {
      assert.strictEqual(config.env.snapshotPath, f.snapshotPath);
      assert.strictEqual(config.env.outputPath, f.reportPath);
      assert.strictEqual(config.categories, f.config.categories);
      assert.strictEqual(date, f.meetingDate);
      await options.onBeforeExternalWrite({});
      assert.strictEqual(loadWeeklyStatus(f.dir, f.date).status, "publishing");
      assert.strictEqual(loadWeeklyStatus(f.dir, f.date).expectedSectionHash, null);
      await options.onFinalSection({ finalSection: section });
      assert.strictEqual(loadWeeklyStatus(f.dir, f.date).expectedSectionHash, sha256("final section\n"));
      return { publication: { finalSection: section, wikiTitle: "weekly", changed: false,
        remote: { section: "final section", version: 8, updatedOn: "2026-08-26T06:10:00Z" } } };
    },
  });
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.state.status, "published");
  assert.strictEqual(result.state.published.version, 8);
  assert.strictEqual(result.state.published.sectionHash, sha256("final section\n"));
  assert.strictEqual(f.config.env.outputPath, "/wrong/report.md");
});

test("weekly publish failure evidence distinguishes Wiki state from note write attempts", async (t) => {
  for (const phase of ["before", "note", "afterWiki", "mismatch", "wrongPinnedSection"]) {
    await t.test(phase, async () => {
      const f = await setupWeeklyReady(t);
      await assert.rejects(() => runWeeklyPublish(f.config, f.meetingDate, {
        runUpdate: async (_config, _date, options) => {
          if (phase === "before") throw new Error("GET failed");
          await options.onBeforeExternalWrite({});
          if (phase === "note") throw new Error("note failed");
          await options.onFinalSection({ finalSection: "expected" });
          if (phase === "afterWiki") throw Object.assign(new Error("verify GET failed"), {
            serverState: "written_unverified", redmineWriteAttempted: true,
          });
          return { publication: { finalSection: phase === "wrongPinnedSection" ? "replaced" : "expected",
            remote: { section: "replaced" } } };
        },
      }));
      const failure = failureFor(f.dir, f.date);
      assert.strictEqual(failure.code, ["mismatch", "wrongPinnedSection"].includes(phase)
        ? "publish_verify_mismatch" : "publish_http_failed");
      assert.strictEqual(failure.redmineWriteAttempted, phase !== "before");
      assert.strictEqual(failure.serverState, ["before", "note"].includes(phase)
        ? "unchanged" : "written_unverified");
    });
  }
});

test("weekly publish profile enforces unattended publishing without changing generic modes", () => {
  const config = publishConfig("/tmp/unused");
  for (const [field, value] of Object.entries({ autoApprove: false, reportDepth: 2,
    validationMode: "warn", validationOverride: true, presentationNoteMode: "off" })) {
    assert.throws(() => assertWeeklyProfile({ env: { ...config.env, [field]: value } }, "weekly-publish"),
      new RegExp(field));
  }
  assert.doesNotThrow(() => assertWeeklyProfile(config, "weekly-publish"));
  assert.doesNotThrow(() => assertWeeklyProfile({}, "update"));
});

test("weekly publish CLI resolves terminal skips without credentials or new artifacts", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  makeTerminalState(outputDir, "published");
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../index.js")], {
    cwd: path.resolve(__dirname, "../.."), encoding: "utf8",
    env: { ...process.env, MODE: "weekly-publish", MEETING_DATE, OUTPUT_DIR: outputDir,
      REDMINE_API_KEY: "", NOTION_API_KEY: "", AUTO_APPROVE: "1", REPORT_DEPTH: "3",
      VALIDATION_MODE: "block", VALIDATION_OVERRIDE: "0", PRESENTATION_NOTE_MODE: "suggest" },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout.split("\n").filter((line) => line.includes("[weekly][SKIP]")).length, 1);
  assert.deepStrictEqual(fs.readdirSync(paths.meetingDir), ["status.json"]);
});

test("weekly publish CLI records owned nonterminal failures without network", async (t) => {
  for (const status of [null, "preparing", "publishing"]) await t.test(String(status), (t) => {
    const outputDir = makeOutputDir(t);
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    if (status) createWeeklyAttempt({ outputDir, meetingDate: MEETING_DATE, reportDepth: 3,
      attemptId: ATTEMPT_ID, now: () => "2026-09-16T06:05:00.000Z" });
    if (status === "publishing") {
      markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir));
      markWeeklyPublishing(paths, ATTEMPT_ID);
    }
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../index.js")], {
      cwd: path.resolve(__dirname, "../.."), encoding: "utf8",
      env: { ...process.env, MODE: "weekly-publish", MEETING_DATE, OUTPUT_DIR: outputDir,
        REDMINE_API_KEY: "", NOTION_API_KEY: "", AUTO_APPROVE: "1", REPORT_DEPTH: "3",
        VALIDATION_MODE: "block", VALIDATION_OVERRIDE: "0", PRESENTATION_NOTE_MODE: "suggest" },
    });
    assert.strictEqual(result.status, 1);
    assert.doesNotMatch(result.stderr, /is not a function|circular dependency/);
    const failure = failureFor(outputDir);
    assert.strictEqual(failure.code, status === "publishing" ? "publish_incomplete" : "prepare_incomplete");
    if (status) assert.strictEqual(failure.pipelineAttemptId, ATTEMPT_ID);
    assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).status, "failed");
  });
});

async function attachWeeklyWiki(t, f, behavior = "success") {
  const otherSection = '#### <span style="color:blue">다음 사람</span>\n- 보존 내용\n';
  const wiki = { text: `${f.config.env.sectionHeader}\n- 기존 내용\n${otherSection}`,
    version: 1, requests: [], otherSection };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    wiki.requests.push(request.method);
    if (request.method === "PUT") {
      wiki.stateBeforePut = loadWeeklyStatus(f.dir, f.date);
      wiki.text = JSON.parse(Buffer.concat(chunks).toString()).wiki_page.text;
      wiki.version += 1;
      if (behavior === "mismatch") wiki.text = wiki.text.replace("FPS 상한", "changed FPS 상한");
      if (behavior === "putTransport") { response.destroy(); return; }
    }
    if (request.method === "GET") {
      const getNumber = wiki.requests.filter((method) => method === "GET").length;
      const malformedAt = { initial: 1, fresh: 2, verify: 3 }[behavior.split(":")[0]];
      if (getNumber === malformedAt) {
        const kind = behavior.split(":")[1];
        if (kind === "httpBody") {
          response.writeHead(503);
          response.end("PRIVATE_WEEKLY_HTTP_BODY_SENTINEL");
        } else if (kind === "json") response.end("PRIVATE_INVALID_JSON_SENTINEL");
        else response.end(JSON.stringify({ wiki_page: {
          text: kind === "section" ? wiki.otherSection : kind === "type" ? {} : undefined,
          version: wiki.version, updated_on: "2026-08-26T06:10:00Z",
        } }));
        return;
      }
    }
    if (request.method === "GET" && wiki.requests.length === 2) {
      if (behavior === "snapshotRace") fs.appendFileSync(f.snapshotPath, "changed");
      if (behavior === "prePut500") {
        response.writeHead(500); response.end("unavailable"); return;
      }
    }
    if (request.method === "GET" && wiki.version === 2 && behavior === "verify500") {
      response.writeHead(500); response.end("verification unavailable"); return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ wiki_page: { text: wiki.text, version: wiki.version,
      updated_on: "2026-08-26T06:10:00Z" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  Object.assign(f.config.env, { baseUrl, apiKey: "fixture-key", projectId: "p",
    wikiUrl: `${baseUrl}/projects/p/wiki/2026-08-26_weekly` });
  const oldNotionKey = process.env.NOTION_API_KEY;
  delete process.env.NOTION_API_KEY;
  t.after(() => {
    if (oldNotionKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = oldNotionKey;
  });
  return wiki;
}

test("weekly CLI records malformed Wiki failures before and after external writes without retry", async (t) => {
  for (const phase of ["initial", "fresh", "verify"]) {
    for (const kind of ["missing", "type", "section", "json"]) await t.test(`${phase}:${kind}`, async (t) => {
      const f = await setupWeeklyReady(t);
      const wiki = await attachWeeklyWiki(t, f, `${phase}:${kind}`);
      const result = await runWeeklyCli(f);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /\[weekly\]\[FAIL\].*artifact=.*\.md/);
      const state = loadWeeklyStatus(f.dir, f.date);
      assert.strictEqual(state.status, "failed");
      const failure = failureFor(f.dir, f.date);
      assert.strictEqual(failure.redmineWriteAttempted, phase !== "initial");
      assert.strictEqual(failure.serverState, phase === "verify" ? "written_unverified" : "unchanged");
      assert.strictEqual(failure.primaryIssueCode, kind === "section" ? "PUBLISH_SECTION_MISSING"
        : kind === "json" ? "PUBLISH_JSON_INVALID" : "PUBLISH_RESPONSE_INVALID");
      const jsonPath = state.failureArtifact.replace(/\.md$/, ".json");
      for (const file of [state.failureArtifact, jsonPath]) {
        const stats = fs.lstatSync(file);
        assert.ok(stats.isFile() && !stats.isSymbolicLink());
        assert.strictEqual(stats.uid, process.getuid());
        assert.strictEqual(stats.mode & 0o777, 0o600);
        assert.doesNotMatch(fs.readFileSync(file, "utf8"), /PRIVATE_INVALID_JSON_SENTINEL/);
      }
      const requests = phase === "initial" ? ["GET"] : phase === "fresh"
        ? ["GET", "GET"] : ["GET", "GET", "PUT", "GET"];
      assert.deepStrictEqual(wiki.requests, requests);
      const before = fs.readFileSync(jsonPath);
      const retry = await runWeeklyCli(f);
      assert.strictEqual(retry.status, 0, retry.stderr);
      assert.deepStrictEqual(wiki.requests, requests);
      assert.deepStrictEqual(fs.readFileSync(jsonPath), before);
      assert.strictEqual(fs.readdirSync(f.paths.failuresDir).length, 2);
    });
  }
});

test("weekly immutable summaries never retain a publisher HTTP response body", async (t) => {
  for (const phase of ["initial", "verify"]) await t.test(phase, async (t) => {
    const f = await setupWeeklyReady(t);
    await attachWeeklyWiki(t, f, `${phase}:httpBody`);
    const result = await runWeeklyCli(f);
    assert.strictEqual(result.status, 1);
    const state = loadWeeklyStatus(f.dir, f.date);
    for (const file of [state.failureArtifact, state.failureArtifact.replace(/\.md$/, ".json")]) {
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /PRIVATE_WEEKLY_HTTP_BODY_SENTINEL/);
    }
    assert.doesNotMatch(result.stderr, /PRIVATE_WEEKLY_HTTP_BODY_SENTINEL/);
    assert.strictEqual(failureFor(f.dir, f.date).primaryIssueCode, "PUBLISH_HTTP_FAILED");
  });
});

test("weekly presentation-note metadata failures keep complete stderr and immutable artifacts body-free", async (t) => {
  for (const responseKind of ["HTTP failure", "malformed JSON"]) await t.test(responseKind, async (t) => {
    const f = await setupWeeklyReady(t, [{ pageId: "fixture-note", title: "검증 발표",
      notionUrl: "https://notion.invalid/fixture-note", report: "pim-app", tagged: true, candidate: true }]);
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      response.setHeader("Content-Type", "application/json");
      if (request.url.includes("/wiki/")) {
        response.end(JSON.stringify({ wiki_page: { text: `${f.config.env.sectionHeader}\n- existing\n`,
          version: 1, updated_on: "2026-08-26T06:05:00Z" } }));
      } else if (request.url.startsWith("/projects/p.json")) {
        response.writeHead(responseKind === "HTTP failure" ? 500 : 200);
        response.end("PRIVATE_NOTE_BODY_SENTINEL");
      } else if (request.url === "/issue_statuses.json") {
        response.end(JSON.stringify({ issue_statuses: [{ id: 9, name: "검토" }] }));
      } else if (request.url === "/users/current.json") {
        response.end(JSON.stringify({ user: { id: 10 } }));
      } else {
        response.writeHead(404);
        response.end("unexpected fixture request");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    Object.assign(f.config.env, { baseUrl, apiKey: "fixture-key", projectId: "p",
      wikiUrl: `${baseUrl}/projects/p/wiki/weekly` });
    const result = await runWeeklyCli(f, `
      process.env.NOTION_API_KEY = "fixture-notion-key";
      const localFetch = global.fetch;
      global.fetch = (url, ...args) => {
        if (!String(url).startsWith(${JSON.stringify(baseUrl + "/")})) {
          throw new Error("live network disabled in presentation fixture");
        }
        return localFetch(url, ...args);
      };
    `);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /\[weekly\]\[FAIL\].*artifact=.*\.md/);
    const state = loadWeeklyStatus(f.dir, f.date);
    assert.strictEqual(state.status, "failed");
    const failure = failureFor(f.dir, f.date);
    const jsonPath = state.failureArtifact.replace(/\.md$/, ".json");
    const json = fs.readFileSync(jsonPath, "utf8");
    const markdown = fs.readFileSync(state.failureArtifact, "utf8");
    assert.doesNotMatch(result.stderr + json + markdown, /PRIVATE_/);
    assert.strictEqual(failure.primaryIssueCode, responseKind === "HTTP failure"
      ? "PRESENTATION_HTTP_FAILED" : "PRESENTATION_JSON_INVALID");
    assert.strictEqual(failure.redmineWriteAttempted, true);
    assert.strictEqual(failure.serverState, "unchanged");
    assert.strictEqual(requests.filter((request) => request.method !== "GET").length, 0);
    assert.ok(requests.some((request) => request.url.startsWith("/projects/p.json")));
    for (const file of [jsonPath, state.failureArtifact]) {
      const stats = fs.lstatSync(file);
      assert.ok(stats.isFile() && !stats.isSymbolicLink());
      assert.strictEqual(stats.uid, process.getuid());
      assert.strictEqual(stats.mode & 0o777, 0o600);
    }
    const requestCount = requests.length;
    const retry = await runWeeklyCli(f);
    assert.strictEqual(retry.status, 0);
    assert.strictEqual(requests.length, requestCount);
    assert.strictEqual(fs.readFileSync(jsonPath, "utf8"), json);
  });
});

test("weekly selected-note publication requires complete references and retains uncertain issue writes", async (t) => {
  for (const failureAt of ["lookup", "notion", "post-http", "post-lost", "post-id", "reuse-id", "second-lookup",
    "post-notes-wiki", "reused-notes-wiki", "post-notes-readiness", "none"]) {
    await t.test(failureAt, async (t) => {
      const notes = ["one", "two"].map((name) => ({ pageId: `fixture-${name}`, title: `발표 ${name}`,
        notionUrl: `https://notion.invalid/${name}`, report: "pim-app", tagged: true, candidate: true }));
      const f = await setupWeeklyReady(t, notes);
      const priorPublished = Buffer.from("previous verified report\n");
      fs.writeFileSync(buildPublishedPath(f.reportPath), priorPublished);
      const requests = [];
      let issuePosts = 0;
      let wikiReads = 0;
      let wikiText = `${f.config.env.sectionHeader}\n- existing\n`;
      const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push(`${request.method} ${request.url}`);
        response.setHeader("Content-Type", "application/json");
        if (request.url.includes("/wiki/")) {
          if (request.method === "GET") wikiReads += 1;
          if (failureAt.endsWith("notes-wiki") && wikiReads === 2) {
            response.writeHead(503); response.end("PRIVATE_POST_NOTES_WIKI_BODY"); return;
          }
          if (request.method === "PUT") wikiText = JSON.parse(Buffer.concat(chunks)).wiki_page.text;
          response.end(JSON.stringify({ wiki_page: { text: wikiText, version: 2, updated_on: "2026-08-26T06:10:00Z" } }));
        } else if (request.url.startsWith("/projects/p.json")) {
          response.end(JSON.stringify({ project: { id: 7, trackers: [{ id: 8, name: "새기능" }] } }));
        } else if (request.url === "/issue_statuses.json") {
          response.end(JSON.stringify({ issue_statuses: [{ id: 9, name: "검토" }] }));
        } else if (request.url === "/users/current.json") {
          response.end(JSON.stringify({ user: { id: 10 } }));
        } else if (request.url.startsWith("/projects/p/issues.json")) {
          if (failureAt === "lookup" || (failureAt === "second-lookup" && issuePosts === 1)) {
            response.writeHead(503); response.end("PRIVATE_NOTE_LOOKUP_BODY");
          } else {
            const issues = failureAt === "reuse-id" ? [{ id: "invalid", status: { id: 9 },
              description: `Notion-Page-Id: fixture-one` }]
              : failureAt === "reused-notes-wiki" ? notes.map((note, index) => ({
                id: 101 + index, status: { id: 9 }, description: `Notion-Page-Id: ${note.pageId}`,
              })) : [];
            response.end(JSON.stringify({ issues, total_count: issues.length }));
          }
        } else if (request.url === "/issues.json" && request.method === "POST") {
          issuePosts += 1;
          if (failureAt === "post-lost") { response.destroy(); return; }
          if (failureAt === "post-http") { response.writeHead(503); response.end("PRIVATE_NOTE_POST_BODY"); return; }
          if (failureAt === "post-notes-readiness" && issuePosts === 2) {
            fs.appendFileSync(f.reportPath, "\nchanged after note creation\n");
          }
          response.writeHead(201);
          response.end(JSON.stringify({ issue: { id: failureAt === "post-id" ? "invalid" : 100 + issuePosts,
            status: { id: 9 }, assigned_to: { id: 10 } } }));
        } else { response.writeHead(404); response.end("unexpected fixture request"); }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      Object.assign(f.config.env, { baseUrl, apiKey: "fixture-key", projectId: "p",
        wikiUrl: `${baseUrl}/projects/p/wiki/weekly` });
      const originalFetch = global.fetch;
      const previousNotionKey = process.env.NOTION_API_KEY;
      process.env.NOTION_API_KEY = "fixture-only-key";
      t.after(() => {
        if (previousNotionKey === undefined) delete process.env.NOTION_API_KEY;
        else process.env.NOTION_API_KEY = previousNotionKey;
      });
      t.mock.method(global, "fetch", (url, ...args) => {
        if (String(url).startsWith(baseUrl + "/")) return originalFetch(url, ...args);
        if (String(url).startsWith("https://api.notion.com/v1/blocks/fixture-")) {
          return Promise.resolve(failureAt === "notion"
            ? new Response("PRIVATE_NOTION_BODY", { status: 503 })
            : new Response(JSON.stringify({ results: [], has_more: false })));
        }
        throw new Error("live network disabled in selected-note fixture");
      });
      let closureCalls = 0;
      const publish = () => runWeeklyPublish(f.config, f.meetingDate, {
        runUpdate: (config, date, options) => runUpdate(config, date, { ...options,
          queryCompletedNotes: async () => { closureCalls += 1; return []; },
          closePresentedNotes: async () => [],
        }),
      });
      if (failureAt === "none") {
        const published = await publish();
        assert.strictEqual(published.state.status, "published");
        const report = fs.readFileSync(buildPublishedPath(f.reportPath), "utf8");
        assert.match(report, /발표 one — #101/);
        assert.match(report, /발표 two — #102/);
        assert.strictEqual(issuePosts, 2);
        assert.strictEqual(requests.filter((request) => request.startsWith("PUT ")).length, 1);
        assert.strictEqual(closureCalls, 1);
        const beforeRetry = requests.slice();
        assert.strictEqual((await runWeeklyPublish(f.config, f.meetingDate)).skipped, true);
        assert.deepStrictEqual(requests, beforeRetry);
        return;
      }
      await assert.rejects(publish);
      const state = loadWeeklyStatus(f.dir, f.date);
      assert.strictEqual(state.status, "failed");
      const failure = failureFor(f.dir, f.date);
      assert.strictEqual(failure.redmineWriteAttempted, true);
      assert.strictEqual(failure.serverState, issuePosts > 0 ? "written_unverified" : "unchanged");
      if (failureAt.endsWith("id")) assert.strictEqual(failure.primaryIssueCode, "PRESENTATION_RESPONSE_INVALID");
      else if (failureAt.endsWith("notes-wiki")) assert.strictEqual(failure.primaryIssueCode, "PUBLISH_HTTP_FAILED");
      else if (failureAt === "post-notes-readiness") assert.strictEqual(failure.code, "ready_evidence_mismatch");
      else if (failureAt !== "post-lost") assert.strictEqual(failure.primaryIssueCode, "PRESENTATION_HTTP_FAILED");
      assert.strictEqual(closureCalls, 0);
      assert.strictEqual(requests.filter((request) => request.startsWith("PUT ")).length, 0);
      assert.deepStrictEqual(fs.readFileSync(buildPublishedPath(f.reportPath)), priorPublished);
      const failureJsonPath = state.failureArtifact.replace(/\.md$/, ".json");
      const failureBytes = fs.readFileSync(failureJsonPath);
      assert.doesNotMatch(failureBytes.toString() + fs.readFileSync(state.failureArtifact, "utf8"), /PRIVATE_/);
      const beforeRetry = requests.slice();
      assert.strictEqual((await runWeeklyPublish(f.config, f.meetingDate)).skipped, true);
      assert.deepStrictEqual(requests, beforeRetry);
      assert.deepStrictEqual(fs.readFileSync(failureJsonPath), failureBytes);
    });
  }
});

test("weekly publish verifies a stateful Wiki and preserves written failures without retry", async (t) => {
  for (const behavior of ["success", "mismatch", "verify500", "putTransport", "prePut500", "snapshotRace"]) {
    await t.test(behavior, async (t) => {
      const f = await setupWeeklyReady(t);
      const wiki = await attachWeeklyWiki(t, f, behavior);
      if (behavior === "success") {
        const result = await runWeeklyPublish(f.config, f.meetingDate);
        assert.strictEqual(result.state.status, "published");
        assert.strictEqual(result.state.published.wikiTitle, "2026-08-26_weekly");
        assert.strictEqual(result.state.published.version, 2);
        const local = fs.readFileSync(buildPublishedPath(f.reportPath), "utf8");
        assert.strictEqual(local, result.updateResult.publication.remote.section);
        assert.strictEqual(result.state.published.sectionHash, sha256(local));
      } else {
        await assert.rejects(() => runWeeklyPublish(f.config, f.meetingDate));
        const failure = failureFor(f.dir, f.date);
        assert.strictEqual(failure.code, behavior === "mismatch" ? "publish_verify_mismatch"
          : behavior === "snapshotRace" ? "ready_evidence_mismatch" : "publish_http_failed");
        assert.strictEqual(failure.redmineWriteAttempted, true);
        assert.strictEqual(failure.serverState, ["prePut500", "snapshotRace"].includes(behavior)
          ? "unchanged" : "written_unverified");
      }
      assert.ok(wiki.text.endsWith(wiki.otherSection));
      if (["success", "mismatch", "verify500", "putTransport"].includes(behavior)) {
        assert.deepStrictEqual(wiki.requests, behavior === "putTransport"
          ? ["GET", "GET", "PUT"] : ["GET", "GET", "PUT", "GET"]);
        assert.strictEqual(wiki.stateBeforePut.status, "publishing");
        assert.ok(wiki.stateBeforePut.expectedSectionHash);
        assert.ok(wiki.text.includes("FPS 상한 30에서 60으로 변경"));
      } else {
        assert.deepStrictEqual(wiki.requests, ["GET", "GET"]);
        assert.strictEqual(wiki.version, 1);
      }
    });
  }
});

test("weekly remote equality gates prior published bytes and completed-note closure", async (t) => {
  for (const behavior of ["mismatch", "success"]) await t.test(behavior, async (t) => {
    const f = await setupWeeklyReady(t);
    const wiki = await attachWeeklyWiki(t, f, behavior);
    const publishedPath = buildPublishedPath(f.reportPath);
    const prior = Buffer.from("previous verified section\r\n\0exact bytes\n");
    fs.writeFileSync(publishedPath, prior);
    process.env.NOTION_API_KEY = "fixture-only-key";
    const originalFetch = global.fetch;
    let unexpectedExternalCalls = 0;
    global.fetch = (url, ...args) => {
      if (!String(url).startsWith(f.config.env.baseUrl + "/")) {
        unexpectedExternalCalls += 1;
        throw new Error("live network disabled in weekly fixture");
      }
      return originalFetch(url, ...args);
    };
    t.after(() => { global.fetch = originalFetch; });
    const done = [{ pageId: "fixture-completed-note" }];
    let closureCalls = 0;
    let queryCalls = 0;
    const publish = () => runWeeklyPublish(f.config, f.meetingDate, {
      runUpdate: (config, date, options) => runUpdate(config, date, { ...options,
        queryCompletedNotes: async () => { queryCalls += 1; return done; },
        closePresentedNotes: async (_env, notes) => {
          closureCalls += 1;
          assert.strictEqual(notes, done);
          assert.strictEqual(wiki.version, 2);
          return notes;
        },
      }),
    });
    if (behavior === "mismatch") {
      await assert.rejects(publish, (error) => error.redmineWriteAttempted === true
        && error.serverState === "written_unverified" && error.stage === "publish_verify");
      assert.deepStrictEqual(fs.readFileSync(publishedPath), prior);
      assert.strictEqual(queryCalls, 0);
      assert.strictEqual(closureCalls, 0);
      const failure = failureFor(f.dir, f.date);
      assert.strictEqual(failure.code, "publish_verify_mismatch");
      assert.strictEqual(failure.serverState, "written_unverified");
    } else {
      const result = await publish();
      assert.strictEqual(result.state.status, "published");
      assert.strictEqual(queryCalls, 1);
      assert.strictEqual(closureCalls, 1);
      assert.strictEqual(fs.readFileSync(publishedPath, "utf8"), result.updateResult.publication.remote.section);
    }
    assert.strictEqual(unexpectedExternalCalls, 0);
    assert.deepStrictEqual(wiki.requests, ["GET", "GET", "PUT", "GET"]);
  });
});

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

function makeWeeklyPrepareConfig(outputDir) {
  return {
    env: {
      mode: "weekly-prepare",
      outputDir,
      aiSummarize: true,
      aiProvider: "codex",
      aiModel: "gpt-5.6-sol",
      aiEffort: "low",
      aiGenerationMethod: "source_selection",
      aiGenerationScope: "whole",
      sourceSelectionFallback: true,
      reportDepth: 3,
      validationMode: "block",
      validationOverride: false,
      presentationNoteMode: "suggest",
    },
  };
}

test("weekly prepare retains owned diagnostics when real generation throws AI_INPUT_LIMIT", async (t) => {
  const f = setupSnapshot(t, {
    rawContent: '#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - FPS 상한 30에서 60으로 변경\n',
    autoContent: { "{{APP}}": "- updated" },
    categories: { app: { parent: "PIM", label: "Application", templateKey: "APP" } },
  });
  Object.assign(f.config.env, makeWeeklyPrepareConfig(f.dir).env, {
    aiMaxInputChars: 1, codexCli: path.join(f.dir, "must-never-spawn"),
  });
  await assert.rejects(() => runWeeklyPrepare(f.config, f.meetingDate, {
    runCollect: async () => ({ snapshot: f.snapshot, snapshotPath: f.snapshotPath }),
  }), { code: "AI_INPUT_LIMIT" });
  const state = JSON.parse(fs.readFileSync(f.generationStatePath));
  assert.strictEqual(state.status, "failed");
  assert.strictEqual(state.errorCode, "AI_INPUT_LIMIT");
  const failure = failureFor(f.dir, "2026-08-26");
  const expected = [f.snapshotPath, f.generationStatePath, ...[
    "state.json", "fact-catalog.json", "source-coverage.json", "source-records.json", "prompt-input.json",
  ].map((name) => path.join(state.runDir, name))].sort();
  assert.deepStrictEqual(failure.artifacts.map((artifact) => artifact.path).sort(), expected);
  for (const artifact of failure.artifacts) {
    assert.strictEqual(artifact.sha256, sha256(fs.readFileSync(artifact.path)));
  }
  assert.strictEqual(failure.primaryIssueCode, "AI_INPUT_LIMIT");
  assert.strictEqual(failure.serverState, "unchanged");
});

test("weekly validation summaries prioritize blocking fact errors over advisory volume", () => {
  const result = classifyWeeklyFailure({ stage: "validate", validation: { publishable: false, issues: [
    ...Array.from({ length: 168 }, () => ({ code: "missing_source_id", severity: "warning", message: "optional source" })),
    { code: "fact_subject_mismatch", severity: "error", message: "fact belongs to another subject" },
  ] } });
  assert.strictEqual(result.primaryIssueCode, "fact_subject_mismatch");
  assert.strictEqual(result.representativeIssues[0].code, "fact_subject_mismatch");
  assert.strictEqual(result.issueCounts.missing_source_id, 168);
  assert.strictEqual(result.issueCounts.fact_subject_mismatch, 1);
  assert.match(formatWeeklyFailureLog(result, "/tmp/failure.md"), /code=fact_subject_mismatch/);
});

test("weekly prepare retains provider and validation diagnostics when generation cannot return", async (t) => {
  for (const phase of ["promotion", "rejection"]) await t.test(phase, async (t) => {
    const f = setupSnapshot(t, {
      rawContent: '#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - '
        + (phase === "promotion" ? "FPS 상한 30에서 60으로 변경" : "설치 보류") + "\n",
      autoContent: { "{{APP}}": "- updated" },
      categories: { app: { parent: "PIM", label: "Application", templateKey: "APP" } },
    });
    Object.assign(f.config.env, makeWeeklyPrepareConfig(f.dir).env);
    f.config.env.codexCli = makeFakeClaude(f, JSON.stringify({ sections: [{ id: "C0001", groups: [
      { theme: "stability", items: [{ id: "R0001", highlight: false }] },
    ] }] }));
    const originalRename = fs.renameSync;
    let interrupted = false;
    fs.renameSync = (from, to) => {
      const target = phase === "promotion" ? to === f.reportPath
        : to === f.generationStatePath && JSON.parse(fs.readFileSync(from)).latestRejectedReportPath;
      if (target && !interrupted) {
        interrupted = true;
        throw Object.assign(new Error("fixture promotion failure"), { code: "EIO" });
      }
      return originalRename(from, to);
    };
    try {
      await assert.rejects(() => runWeeklyPrepare(f.config, f.meetingDate, {
        runCollect: async () => ({ snapshot: f.snapshot, snapshotPath: f.snapshotPath }),
      }), { code: "EIO" });
    } finally { fs.renameSync = originalRename; }
    assert.strictEqual(interrupted, true);
    const state = JSON.parse(fs.readFileSync(f.generationStatePath));
    const failure = failureFor(f.dir, "2026-08-26");
    const expected = [f.snapshotPath, f.generationStatePath, ...[
      "state.json", "fact-catalog.json", "source-coverage.json", "source-records.json", "prompt-input.json",
      "draft.ai.annotated.md", "draft.working.annotated.md", "source-selection.json", "validation.001.json",
      ...(phase === "rejection" ? ["report.rejected.001.md"] : []),
    ].map((name) => path.join(state.runDir, name))].sort();
    assert.deepStrictEqual(failure.artifacts.map((artifact) => artifact.path).sort(), expected);
    assert.strictEqual(fs.existsSync(f.reportPath), false);
  });
});

test("weekly failure files and directory are durable and private before FAILED is committed", (t) => {
  const outputDir = makeOutputDir(t);
  const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
  const state = createWeeklyAttempt({ outputDir, meetingDate: MEETING_DATE, reportDepth: 3,
    attemptId: ATTEMPT_ID, now: () => "2026-09-16T06:05:00.000Z" });
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
  const descriptors = new Map();
  const events = [];
  fs.openSync = (file, ...args) => {
    const fd = original.openSync(file, ...args);
    descriptors.set(fd, String(file));
    return fd;
  };
  fs.closeSync = (fd) => { descriptors.delete(fd); return original.closeSync(fd); };
  fs.fsyncSync = (fd) => {
    const file = descriptors.get(fd);
    if (file === paths.failuresDir) events.push("sync-failures-directory");
    else if (file && path.dirname(file) === paths.failuresDir) {
      const stats = fs.fstatSync(fd);
      assert.ok(stats.isFile());
      assert.strictEqual(stats.uid, process.getuid());
      assert.strictEqual(stats.mode & 0o777, 0o600);
      events.push(file.includes(".json") ? "sync-json" : "sync-markdown");
    }
    return original.fsyncSync(fd);
  };
  fs.renameSync = (from, to) => {
    if (to === paths.statusPath) {
      assert.strictEqual(JSON.parse(fs.readFileSync(from)).status, "failed");
      assert.deepStrictEqual(events, ["sync-json", "sync-markdown", "sync-failures-directory"]);
    }
    return original.renameSync(from, to);
  };
  const oldUmask = process.umask(0);
  let recorded;
  try {
    recorded = recordWeeklyFailure({ paths, state, stage: "generate", error: new Error("fixture failure"),
      artifacts: [], redmineWriteAttempted: false, serverState: "unchanged",
      retryCommand: EXPECTED_RETRY_COMMAND, now: () => "2026-09-16T06:15:00.000Z" });
  } finally {
    process.umask(oldUmask);
    Object.assign(fs, original);
  }
  assert.strictEqual(recorded.state.status, "failed");
  for (const file of [recorded.jsonPath, recorded.markdownPath]) {
    const stats = fs.lstatSync(file);
    assert.ok(stats.isFile() && !stats.isSymbolicLink());
    assert.strictEqual(stats.uid, process.getuid());
    assert.strictEqual(stats.mode & 0o777, 0o600);
  }
});

test("weekly failure synchronization errors preserve the prior durable status", async (t) => {
  for (const phase of ["json", "markdown", "directory"]) await t.test(phase, (t) => {
    const outputDir = makeOutputDir(t);
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    const state = createWeeklyAttempt({ outputDir, meetingDate: MEETING_DATE, reportDepth: 3,
      attemptId: ATTEMPT_ID, now: () => "2026-09-16T06:05:00.000Z" });
    const before = fs.readFileSync(paths.statusPath);
    const descriptors = new Map();
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    const originalSync = fs.fsyncSync;
    t.mock.method(fs, "openSync", (file, ...args) => {
      const fd = originalOpen(file, ...args);
      descriptors.set(fd, String(file));
      return fd;
    });
    t.mock.method(fs, "closeSync", (fd) => { descriptors.delete(fd); return originalClose(fd); });
    t.mock.method(fs, "fsyncSync", (fd) => {
      const file = descriptors.get(fd);
      const current = file === paths.failuresDir ? "directory"
        : file && path.dirname(file) === paths.failuresDir ? (file.includes(".json") ? "json" : "markdown")
          : null;
      if (current === phase) throw Object.assign(new Error("fixture fsync failure"), { code: "EIO" });
      return originalSync(fd);
    });
    assert.throws(() => recordWeeklyFailure({ paths, state, stage: "generate", error: new Error("fixture failure"),
      artifacts: [], redmineWriteAttempted: false, serverState: "unchanged",
      retryCommand: EXPECTED_RETRY_COMMAND, now: () => "2026-09-16T06:15:00.000Z" }), { code: "EIO" });
    assert.deepStrictEqual(fs.readFileSync(paths.statusPath), before);
    if (phase === "directory") {
      const files = fs.readdirSync(paths.failuresDir);
      assert.strictEqual(files.length, 2);
      for (const file of files) assert.ok(fs.statSync(path.join(paths.failuresDir, file)).size > 0);
    }
  });
});

test("weekly thrown generation diagnostics reject stale owners and symlinked runs", async (t) => {
  for (const mutation of ["owner", "symlink"]) await t.test(mutation, async (t) => {
    const f = setupSnapshot(t, {
      rawContent: '#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - FPS 상한 30에서 60으로 변경\n',
      autoContent: { "{{APP}}": "- updated" },
      categories: { app: { parent: "PIM", label: "Application", templateKey: "APP" } },
    });
    Object.assign(f.config.env, makeWeeklyPrepareConfig(f.dir).env, { aiMaxInputChars: 1 });
    await assert.rejects(() => runWeeklyPrepare(f.config, f.meetingDate, {
      runCollect: async () => ({ snapshot: f.snapshot, snapshotPath: f.snapshotPath }),
      runGenerate: async (config, date) => {
        try { return await runGenerateV2(config, date); } catch (error) {
          const state = JSON.parse(fs.readFileSync(f.generationStatePath));
          if (mutation === "owner") {
            fs.writeFileSync(f.generationStatePath, JSON.stringify({ ...state, attemptId: OTHER_ATTEMPT_ID }));
          } else {
            fs.renameSync(state.runDir, `${state.runDir}.target`);
            fs.symlinkSync(`${state.runDir}.target`, state.runDir);
          }
          throw error;
        }
      },
    }), { code: "AI_INPUT_LIMIT" });
    const failure = failureFor(f.dir, "2026-08-26");
    assert.deepStrictEqual(failure.artifacts.map((artifact) => artifact.path), [f.snapshotPath]);
  });
});

test("weekly prepare validates sealed source-selection evidence before binding READY to file bytes", async (t) => {
  const outputDir = makeOutputDir(t);
  const config = makeWeeklyPrepareConfig(outputDir);
  const meetingDate = new Date("2026-09-16T00:00:00.000Z");
  const snapshotPath = path.join(outputDir, "snapshot.json");
  const generationStatePath = path.join(outputDir, "report.generation.json");
  const reportPath = path.join(outputDir, "report.md");
  const snapshotHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const snapshotText = `${JSON.stringify({ status: "sealed", contentHash: snapshotHash })}\n`;
  const reportText = "validated weekly report\n";
  const generationState = {
    schemaVersion: 2,
    status: "complete",
    generationMethod: "source_selection",
    reportDepth: 3,
    attemptId: GENERATION_ATTEMPT_ID,
  };
  const events = [];
  const collectResult = {
    snapshot: { status: "sealed", contentHash: snapshotHash },
    snapshotPath,
  };
  const generationResult = {
    snapshot: collectResult.snapshot,
    snapshotPath,
    generationStatePath,
    reportPath,
    validation: { schemaVersion: 2, status: "PASS", publishable: true, issues: [] },
  };

  const result = await runWeeklyPrepare(config, meetingDate, {
    randomUUID: () => ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
    runCollect: async (receivedConfig, receivedDate) => {
      assert.strictEqual(receivedConfig, config);
      assert.strictEqual(receivedDate, meetingDate);
      assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).stage, "collect");
      events.push("collect");
      fs.writeFileSync(snapshotPath, snapshotText, "utf8");
      return collectResult;
    },
    runGenerate: async (receivedConfig, receivedDate) => {
      assert.strictEqual(receivedConfig, config);
      assert.strictEqual(receivedDate, meetingDate);
      assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).stage, "generate");
      events.push("generate");
      fs.writeFileSync(generationStatePath, `${JSON.stringify(generationState)}\n`, "utf8");
      fs.writeFileSync(reportPath, reportText, "utf8");
      return generationResult;
    },
    assertV2PublishEvidence: (args) => {
      assert.strictEqual(loadWeeklyStatus(outputDir, MEETING_DATE).stage, "validate");
      assert.strictEqual(args.config, config);
      assert.strictEqual(args.meetingDate, meetingDate);
      assert.deepStrictEqual(args.snapshot, collectResult.snapshot);
      assert.deepStrictEqual(args.state, generationState);
      assert.strictEqual(args.reportContent, reportText);
      events.push("validate");
      return { validation: generationResult.validation };
    },
  });

  assert.deepStrictEqual(events, ["collect", "generate", "validate"]);
  assert.strictEqual(result.collectResult, collectResult);
  assert.strictEqual(result.generationResult, generationResult);
  assert.strictEqual(result.state.status, "ready");
  assert.strictEqual(result.state.snapshotHash, collectResult.snapshot.contentHash);
  assert.strictEqual(result.state.generationAttemptId, generationState.attemptId);
  assert.strictEqual(
    result.state.reportHash,
    crypto.createHash("sha256").update(fs.readFileSync(reportPath, "utf8")).digest("hex")
  );
  assert.strictEqual(result.state.expectedSectionHash, null);
});

function writePrepareGeneration(outputDir, snapshot, overrides = {}) {
  const generationStatePath = path.join(outputDir, "report.generation.json");
  const reportPath = overrides.reportPath || path.join(outputDir, "report.md");
  const generationState = {
    schemaVersion: 2,
    status: "complete",
    generationMethod: "source_selection",
    reportDepth: 3,
    attemptId: GENERATION_ATTEMPT_ID,
    ...overrides.generationState,
  };
  fs.writeFileSync(generationStatePath, `${JSON.stringify(generationState)}\n`, "utf8");
  fs.writeFileSync(reportPath, overrides.reportText || "validated weekly report\n", "utf8");
  return {
    snapshot,
    snapshotPath: path.join(outputDir, "snapshot.json"),
    generationStatePath,
    reportPath,
    validation: overrides.validation || {
      schemaVersion: 2,
      status: "PASS",
      publishable: true,
      issues: [],
    },
    ...overrides.result,
  };
}

function makePrepareCollection(outputDir, status = "sealed") {
  const snapshotPath = path.join(outputDir, "snapshot.json");
  const snapshot = {
    status,
    contentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  return { snapshot, snapshotPath };
}

async function capturePrepareFailure(t, options) {
  const outputDir = makeOutputDir(t);
  const config = makeWeeklyPrepareConfig(outputDir);
  const canonicalPath = path.join(outputDir, "canonical.md");
  const canonicalBytes = "previous canonical report\n";
  fs.writeFileSync(canonicalPath, canonicalBytes, "utf8");
  config.env.outputPath = canonicalPath;
  const logs = [];
  let redmineRequests = 0;
  const originalConsoleError = console.error;
  console.error = (line) => logs.push(String(line));
  let thrown;
  try {
    await runWeeklyPrepare(config, new Date("2026-09-16T00:00:00.000Z"), {
      randomUUID: () => ATTEMPT_ID,
      now: () => "2026-09-16T06:05:00.000Z",
      redmineRequest: () => { redmineRequests += 1; },
      assertV2PublishEvidence: options.assertV2PublishEvidence || (({ state }) => {
        if (options.afterValidation) options.afterValidation(outputDir, state);
        return { validation: { schemaVersion: 2, status: "PASS", publishable: true, issues: [] } };
      }),
      runCollect: options.runCollect
        ? (...args) => options.runCollect(outputDir, ...args)
        : async () => makePrepareCollection(outputDir),
      runGenerate: options.runGenerate
        ? (...args) => options.runGenerate(outputDir, ...args)
        : async () => {
        const collected = JSON.parse(fs.readFileSync(path.join(outputDir, "snapshot.json"), "utf8"));
        return writePrepareGeneration(outputDir, collected);
      },
    });
  } catch (error) {
    thrown = error;
  } finally {
    console.error = originalConsoleError;
  }
  assert.ok(thrown, "weekly prepare must throw after recording failure");
  assert.strictEqual(redmineRequests, 0);
  assert.strictEqual(fs.readFileSync(canonicalPath, "utf8"), canonicalBytes);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /^\[weekly\]\[FAIL\] /);
  assert.strictEqual(logs[0].includes("\n"), false);
  const failuresDir = buildWeeklyPipelinePaths(outputDir, MEETING_DATE).failuresDir;
  const names = fs.readdirSync(failuresDir).sort();
  assert.strictEqual(names.filter((name) => name.endsWith(".json")).length, 1);
  assert.strictEqual(names.filter((name) => name.endsWith(".md")).length, 1);
  const failure = JSON.parse(fs.readFileSync(
    path.join(failuresDir, names.find((name) => name.endsWith(".json"))),
    "utf8"
  ));
  assert.strictEqual(failure.redmineWriteAttempted, false);
  assert.strictEqual(failure.serverState, "unchanged");
  return { outputDir, failure, thrown };
}

test("weekly prepare records collection exceptions and partial snapshots as collect_failed", async (t) => {
  await t.test("exception", async (t) => {
    const result = await capturePrepareFailure(t, {
      runCollect: async () => { throw Object.assign(new Error("collector unavailable"), { code: "ECONNRESET" }); },
    });
    assert.strictEqual(result.failure.stage, "collect");
    assert.strictEqual(result.failure.code, "collect_failed");
  });
  await t.test("partial snapshot", async (t) => {
    const result = await capturePrepareFailure(t, {
      runCollect: async (outputDir) => makePrepareCollection(outputDir, "partial"),
    });
    assert.strictEqual(result.failure.code, "collect_failed");
  });
});

test("weekly prepare records escaped provider failures as ai_failed", async (t) => {
  for (const code of ["AI_TIMEOUT", "AI_EXIT", "AI_EMPTY_OUTPUT", "AI_SPAWN"]) {
    await t.test(code, async (t) => {
      const result = await capturePrepareFailure(t, {
        runGenerate: async () => { throw Object.assign(new Error(`${code} escaped`), { code }); },
      });
      assert.strictEqual(result.failure.stage, "generate");
      assert.strictEqual(result.failure.code, "ai_failed");
      assert.strictEqual(result.failure.primaryIssueCode, code);
    });
  }
});

test("weekly prepare records escaped source-selection failures separately", async (t) => {
  for (const code of ["SOURCE_SELECTION_INVALID", "SOURCE_RECORDS_INVALID"]) {
    await t.test(code, async (t) => {
      const result = await capturePrepareFailure(t, {
        runGenerate: async () => { throw Object.assign(new Error(`${code} escaped`), { code }); },
      });
      assert.strictEqual(result.failure.stage, "generate");
      assert.strictEqual(result.failure.code, "source_selection_invalid");
      assert.strictEqual(result.failure.primaryIssueCode, code);
    });
  }
});

test("weekly prepare reaches READY when an AI provider error is recovered by valid fallback", async (t) => {
  const outputDir = makeOutputDir(t);
  const config = makeWeeklyPrepareConfig(outputDir);
  const meetingDate = new Date("2026-09-16T00:00:00.000Z");
  const collectResult = makePrepareCollection(outputDir);
  const generationResult = writePrepareGeneration(outputDir, collectResult.snapshot, {
    generationState: { fallbackOrigin: "deterministic_fallback", fallbackErrorCode: "AI_TIMEOUT" },
  });

  const result = await runWeeklyPrepare(config, meetingDate, {
    randomUUID: () => ATTEMPT_ID,
    now: () => "2026-09-16T06:05:00.000Z",
    runCollect: async () => collectResult,
    runGenerate: async () => generationResult,
    assertV2PublishEvidence: () => ({
      validation: generationResult.validation,
    }),
  });

  assert.strictEqual(result.state.status, "ready");
  assert.strictEqual(result.state.generationAttemptId, GENERATION_ATTEMPT_ID);
  assert.strictEqual(fs.existsSync(buildWeeklyPipelinePaths(outputDir, MEETING_DATE).failuresDir), false);
});

test("weekly prepare records rejected validation with its validation and rejected report artifacts", async (t) => {
  const issue = { code: "unmarked_protected_fact", severity: "error", message: "fact changed" };
  const result = await capturePrepareFailure(t, {
    runGenerate: async (outputDir) => {
      const snapshot = JSON.parse(fs.readFileSync(path.join(outputDir, "snapshot.json"), "utf8"));
      const runDir = path.join(outputDir, "runs", MEETING_DATE, GENERATION_ATTEMPT_ID);
      fs.mkdirSync(runDir, { recursive: true });
      const validationPath = path.join(runDir, "validation.001.json");
      const rejectedReportPath = path.join(runDir, "report.rejected.001.md");
      fs.writeFileSync(validationPath, `${JSON.stringify({ status: "FAIL", issues: [issue] })}\n`);
      fs.writeFileSync(rejectedReportPath, "rejected candidate\n");
      return writePrepareGeneration(outputDir, snapshot, {
        generationState: {
          latestValidationPath: "validation.001.json",
          latestRejectedReportPath: "report.rejected.001.md",
        },
        validation: { schemaVersion: 2, status: "FAIL", publishable: false, issues: [issue] },
        result: {
          runPaths: { runDir },
          rejectedReportPath,
        },
      });
    },
  });

  assert.strictEqual(result.failure.stage, "validate");
  assert.strictEqual(result.failure.code, "validation_failed");
  assert.strictEqual(result.failure.primaryIssueCode, issue.code);
  assert.deepStrictEqual(
    result.failure.artifacts.map((artifact) => path.basename(artifact.path)).sort(),
    ["report.generation.json", "report.md", "report.rejected.001.md", "snapshot.json", "validation.001.json"]
  );
});

test("weekly prepare restores the exact previous canonical after post-generation evidence mismatch", async (t) => {
  const result = await capturePrepareFailure(t, {
    runGenerate: async (outputDir, config) => {
      const snapshot = JSON.parse(fs.readFileSync(path.join(outputDir, "snapshot.json"), "utf8"));
      return writePrepareGeneration(outputDir, snapshot, {
        reportPath: config.env.outputPath,
        reportText: "newly promoted canonical report\n",
      });
    },
    afterValidation: (outputDir) => {
      fs.appendFileSync(path.join(outputDir, "report.generation.json"), " \n");
    },
  });

  assert.strictEqual(result.failure.code, "ready_evidence_mismatch");
  assert.match(
    fs.readFileSync(path.join(result.outputDir, "report.generation.json"), "utf8"),
    / \n$/
  );
});

test("weekly first prepare restores canonical absence while retaining generated artifacts", async (t) => {
  const f = setupSnapshot(t, {
    rawContent: '#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - FPS 상한 30에서 60으로 변경\n',
    autoContent: { "{{APP}}": "- updated" },
    categories: { app: { parent: "PIM", label: "Application", templateKey: "APP" } },
  });
  Object.assign(f.config.env, makeWeeklyPrepareConfig(f.dir).env);
  f.config.env.codexCli = makeFakeClaude(f, JSON.stringify({ sections: [{ id: "C0001", groups: [
    { theme: "stability", items: [{ id: "R0001", highlight: false }] },
  ] }] }));
  assert.strictEqual(fs.existsSync(f.reportPath), false);
  let generatedBytes;
  await assert.rejects(() => runWeeklyPrepare(f.config, f.meetingDate, {
    runCollect: async () => ({ snapshot: f.snapshot, snapshotPath: f.snapshotPath }),
    assertV2PublishEvidence: (input) => {
      const result = require("../../index").assertV2PublishEvidence(input);
      generatedBytes = fs.readFileSync(f.reportPath);
      fs.appendFileSync(f.generationStatePath, " \n");
      return result;
    },
  }), { code: "ready_evidence_mismatch" });
  const failure = failureFor(f.dir, "2026-08-26");
  assert.strictEqual(failure.code, "ready_evidence_mismatch");
  assert.strictEqual(fs.existsSync(f.reportPath), false, "failed first prepare must not leave publishable canonical output");
  const generation = JSON.parse(fs.readFileSync(f.generationStatePath));
  const cleanPath = path.join(generation.runDir, "report.clean.md");
  assert.deepStrictEqual(fs.readFileSync(cleanPath), generatedBytes);
  assert.ok(failure.artifacts.some((artifact) => artifact.path === cleanPath
    && artifact.sha256 === sha256(generatedBytes)));
  for (const name of ["draft.ai.annotated.md", "draft.working.annotated.md", "validation.001.json"]) {
    assert.ok(fs.existsSync(path.join(generation.runDir, name)), `must retain ${name}`);
  }
  t.mock.method(global, "fetch", () => { assert.fail("failed first prepare must not permit ordinary update I/O"); });
  await assert.rejects(() => runUpdate(f.config, f.meetingDate), /초안 파일이 없습니다/);
});

test("weekly prepare records missing or post-validation changed evidence as ready_evidence_mismatch", async (t) => {
  await t.test("missing generation state", async (t) => {
    const result = await capturePrepareFailure(t, {
      runGenerate: async (outputDir) => {
        const snapshot = JSON.parse(fs.readFileSync(path.join(outputDir, "snapshot.json"), "utf8"));
        const generation = writePrepareGeneration(outputDir, snapshot);
        fs.unlinkSync(generation.generationStatePath);
        return generation;
      },
    });
    assert.strictEqual(result.failure.stage, "publish");
    assert.strictEqual(result.failure.code, "ready_evidence_mismatch");
  });

  await t.test("missing generation state path", async (t) => {
    const result = await capturePrepareFailure(t, {
      runGenerate: async (outputDir) => {
        const snapshot = JSON.parse(fs.readFileSync(path.join(outputDir, "snapshot.json"), "utf8"));
        const generation = writePrepareGeneration(outputDir, snapshot);
        delete generation.generationStatePath;
        return generation;
      },
    });
    assert.strictEqual(result.failure.stage, "publish");
    assert.strictEqual(result.failure.code, "ready_evidence_mismatch");
  });

  await t.test("report changes after validation", async (t) => {
    const result = await capturePrepareFailure(t, {
      afterValidation: (outputDir) => {
        fs.appendFileSync(path.join(outputDir, "report.md"), "changed\n");
      },
    });
    assert.strictEqual(result.failure.stage, "publish");
    assert.strictEqual(result.failure.code, "ready_evidence_mismatch");
  });
});

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
    version: 12,
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

test("weekly terminal states reject every explicit transition without changing evidence", async (t) => {
  for (const terminal of ["failed", "published"]) await t.test(terminal, (t) => {
    const outputDir = makeOutputDir(t);
    const paths = buildWeeklyPipelinePaths(outputDir, MEETING_DATE);
    let state = createWeeklyAttempt({ outputDir, meetingDate: MEETING_DATE, reportDepth: 3,
      attemptId: ATTEMPT_ID, now: () => "2026-09-16T06:05:00.000Z" });
    if (terminal === "failed") {
      recordWeeklyFailure({ paths, state, stage: "generate", error: new Error("fixture failure"),
        artifacts: [], redmineWriteAttempted: false, serverState: "unchanged",
        retryCommand: EXPECTED_RETRY_COMMAND, now: () => "2026-09-16T06:15:00.000Z" });
    } else {
      markWeeklyReady(paths, ATTEMPT_ID, makeReadyEvidence(outputDir));
      markWeeklyPublishing(paths, ATTEMPT_ID);
      pinExpectedSectionHash(paths, ATTEMPT_ID, SECTION_HASH);
      markWeeklyPublished(paths, ATTEMPT_ID, { wikiTitle: "weekly", version: 12,
        updatedOn: "2026-09-16T06:45:00.000Z", sectionHash: SECTION_HASH,
        verifiedAt: "2026-09-16T06:45:01.000Z" });
    }
    const bytes = fs.readFileSync(paths.statusPath);
    for (const next of ["preparing", "ready", "publishing", "published", "failed"]) {
      assert.throws(() => patchWeeklyStatus(paths, ATTEMPT_ID, { status: next }), /invalid.*transition/);
      assert.deepStrictEqual(fs.readFileSync(paths.statusPath), bytes);
    }
  });
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
    retryCommand: EXPECTED_RETRY_COMMAND,
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
    retryCommand: EXPECTED_RETRY_COMMAND,
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
  assert.ok(markdown.includes(EXPECTED_RETRY_COMMAND));
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
    retryCommand: EXPECTED_RETRY_COMMAND,
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
    retryCommand: EXPECTED_RETRY_COMMAND,
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
    retryCommand: EXPECTED_RETRY_COMMAND,
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
