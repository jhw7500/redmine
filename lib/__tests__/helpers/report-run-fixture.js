const fs = require("node:fs");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  buildGenerationStatePath,
  sealSnapshot,
  writeJsonAtomic,
} = require("../../report-artifact");
const { runGenerate } = require("../../../index");

function setupSnapshot(t, { rawContent, reportDepth = 3 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-report-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meetingDate = new Date("2026-08-26T00:00:00");
  const snapshotPath = path.join(dir, "snapshot.json");
  const reportPath = path.join(dir, "report.md");
  const callsPath = path.join(dir, "claude-calls.txt");
  const spawnMarkerPath = path.join(dir, "claude-spawned.txt");
  const snapshot = sealSnapshot({
    collectedAt: "2026-08-26T06:05:00+09:00",
    meetingDate: "2026-08-26",
    status: "sealed",
    failures: [],
    warnings: [],
    sources: {},
    autoContent: {},
    rawContent,
    presentationCandidates: [],
  });
  writeJsonAtomic(snapshotPath, snapshot);
  fs.writeFileSync(callsPath, "0", "utf8");

  const config = {
    env: {
      snapshotPath,
      outputPath: reportPath,
      outputDir: dir,
      reportDepth,
      sectionHeader: '#### <span style="color:blue">조현우</span>',
      presentationNoteMode: "off",
      allowPartialSnapshot: false,
      validationMode: "block",
      validationOverride: false,
      aiSummarize: false,
      claudeCli: "claude",
      aiModel: "sonnet",
      aiEffort: "low",
      aiMaxInputChars: 100000,
      aiTimeoutMs: 300000,
      aiMaxBudgetUsd: null,
    },
    repos: {},
    depthProfiles: {},
    reportFilter: {},
  };

  return {
    dir,
    meetingDate,
    config,
    snapshot,
    snapshotPath,
    reportPath,
    generationStatePath: buildGenerationStatePath(reportPath),
    callsPath,
    spawnMarkerPath,
  };
}

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function makeFakeClaude(fixture, output) {
  const executablePath = path.join(fixture.dir, "fake-claude.js");
  return writeExecutable(executablePath, [
    'const fs = require("node:fs");',
    `const callsPath = ${JSON.stringify(fixture.callsPath)};`,
    'const calls = Number(fs.readFileSync(callsPath, "utf8"));',
    'fs.writeFileSync(callsPath, String(calls + 1), "utf8");',
    `process.stdout.write(${JSON.stringify(output)});`,
    "",
  ].join("\n"));
}

function makeSpawnMarker(fixture) {
  const executablePath = path.join(fixture.dir, "spawn-marker-claude.js");
  return writeExecutable(executablePath, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(fixture.spawnMarkerPath)}, "spawned", "utf8");`,
    'process.stdout.write("unexpected spawn\\n");',
    "",
  ].join("\n"));
}

async function setupFailedV2Run(t) {
  const fixture = setupSnapshot(t, {
    rawContent: '#### <span style="color:blue">조현우</span>\n- 보드 실행 5/8 PASS\n',
  });
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    '#### <span style="color:blue">조현우</span>\n- 보드 실행 [[fact:T0001|10/11 PASS]]\n'
  );
  const result = await runGenerate(fixture.config, fixture.meetingDate);
  assert.strictEqual(result.validation.schemaVersion, 2);
  assert.strictEqual(result.validation.status, "FAIL");
  const state = JSON.parse(fs.readFileSync(result.runPaths.statePath, "utf8"));
  assert.strictEqual(state.status, "validation_failed");
  return {
    ...fixture,
    attemptId: state.attemptId,
    validation: result.validation,
    runPaths: result.runPaths,
  };
}

async function attachWikiServer(t, fixture, options = {}) {
  const redmineRequests = [];
  const pageText = [
    '#### <span style="color:blue">조현우</span>',
    "- 기존 내용",
    '#### <span style="color:blue">다음 사람</span>',
    "- 보존 내용",
    "",
  ].join("\n");
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const record = {
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      redmineRequests.push(record);
      if (options.onRedmineRequest) options.onRedmineRequest(record, fixture);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        wiki_page: {
          text: pageText,
          version: request.method === "PUT" ? 2 : 1,
        },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  Object.assign(fixture.config.env, {
    apiKey: "test-key",
    autoApprove: true,
    baseUrl,
    pageSuffix: "weekly",
    projectId: "p",
    wikiUrl: `${baseUrl}/projects/p/wiki/2026-08-26_weekly`,
  });

  return { ...fixture, redmineRequests };
}

async function setupCompleteV1Run(t, options = {}) {
  const rawContent = options.rawContent
    || '#### <span style="color:blue">조현우</span>\n- 완료 항목\n';
  const fixture = setupSnapshot(t, { rawContent, reportDepth: 2 });
  fixture.config.repos = options.repos || {};
  fixture.config.env.aiSummarize = false;
  await runGenerate(fixture.config, fixture.meetingDate);
  const state = JSON.parse(fs.readFileSync(fixture.generationStatePath, "utf8"));
  assert.strictEqual(state.schemaVersion, 1);
  return { ...await attachWikiServer(t, fixture, options), attemptId: state.attemptId };
}

async function setupCompleteV2Run(t, options = {}) {
  const rawContent = options.rawContent
    || '#### <span style="color:blue">조현우</span>\n- 완료 항목\n';
  const fixture = setupSnapshot(t, { rawContent, reportDepth: 2 });
  fixture.config.repos = options.repos || {};
  fixture.config.openIssueVerifierOptions = options.openIssueVerifierOptions;
  fixture.config.env.aiSummarize = true;
  fixture.config.env.claudeCli = makeFakeClaude(
    fixture,
    options.aiOutput || rawContent
  );

  const result = await runGenerate(fixture.config, fixture.meetingDate);
  assert.strictEqual(result.validation.schemaVersion, 2);
  assert.notStrictEqual(result.validation.status, "FAIL");
  const attached = await attachWikiServer(t, fixture, options);
  return {
    ...attached,
    attemptId: result.runPaths.runDir.split(path.sep).at(-1),
    runPaths: result.runPaths,
    validation: result.validation,
  };
}

module.exports = {
  makeFakeClaude,
  makeSpawnMarker,
  setupCompleteV1Run,
  setupCompleteV2Run,
  setupFailedV2Run,
  setupSnapshot,
};
