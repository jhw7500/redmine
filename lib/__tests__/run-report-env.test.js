const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../..");
const runtimeFixtureEntries = [
  "index.js",
  "repo-config.json",
  "translation-rules.json",
  "lib",
  "scripts",
  "templates",
  "run-report-env.sh",
  "run-weekly-prepare-env.sh",
  "run-weekly-publish-env.sh",
];

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function writeNodeExecutable(filePath, content) {
  writeExecutable(filePath, `#!${process.execPath}\n${content}`);
}

function writeFixtureEnv(root, content) {
  const envPath = path.join(root, ".env");
  fs.writeFileSync(envPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const stats = fs.lstatSync(envPath);
  assert.strictEqual(stats.isFile(), true);
  assert.strictEqual(stats.isSymbolicLink(), false);
  return envPath;
}

function copyRuntimeFixture(t, sourceRoot = projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-weekly-wrapper-"));
  const root = path.join(dir, "checkout");
  fs.mkdirSync(root);
  for (const entry of runtimeFixtureEntries) {
    const source = path.join(sourceRoot, entry);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(root, entry), {
      recursive: true,
      filter(candidate) {
        const stats = fs.lstatSync(candidate);
        return stats.isDirectory() || stats.isFile();
      },
    });
  }
  const binDir = path.join(dir, "bin");
  const homeDir = path.join(dir, "home");
  fs.mkdirSync(binDir);
  fs.mkdirSync(homeDir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, root, binDir, homeDir };
}

test("runtime fixture excludes source env files and symlinks before creating its own .env", (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-unsafe-source-"));
  const externalSecret = path.join(sourceRoot, "..", `${path.basename(sourceRoot)}-secret`);
  fs.writeFileSync(externalSecret, "SOURCE_SECRET=do-not-copy\n");
  fs.writeFileSync(path.join(sourceRoot, "repo-config.json"), "fixture-runtime-file\n");
  fs.writeFileSync(path.join(sourceRoot, ".env.local"), "LOCAL_SECRET=do-not-copy\n");
  fs.symlinkSync(externalSecret, path.join(sourceRoot, ".env"));
  fs.symlinkSync(externalSecret, path.join(sourceRoot, "index.js"));
  fs.mkdirSync(path.join(sourceRoot, "lib"));
  fs.symlinkSync(externalSecret, path.join(sourceRoot, "lib", "linked-secret.js"));
  t.after(() => {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(externalSecret, { force: true });
  });

  const fixture = copyRuntimeFixture(t, sourceRoot);
  assert.strictEqual(fs.readFileSync(path.join(fixture.root, "repo-config.json"), "utf8"),
    "fixture-runtime-file\n");
  assert.strictEqual(fs.existsSync(path.join(fixture.root, ".env")), false);
  assert.strictEqual(fs.existsSync(path.join(fixture.root, ".env.local")), false);
  assert.strictEqual(fs.existsSync(path.join(fixture.root, "index.js")), false);
  assert.strictEqual(fs.existsSync(path.join(fixture.root, "lib", "linked-secret.js")), false);

  const fixtureEnv = writeFixtureEnv(fixture.root, "FIXTURE_ONLY=1\n");
  assert.strictEqual(fs.lstatSync(fixtureEnv).isFile(), true);
  assert.strictEqual(fs.lstatSync(fixtureEnv).isSymbolicLink(), false);
  assert.strictEqual(fs.readFileSync(externalSecret, "utf8"), "SOURCE_SECRET=do-not-copy\n");
});

function isolatedEnv(fixture, overrides = {}) {
  return {
    ...process.env,
    HOME: fixture.homeDir,
    BASH_ENV: "",
    ENV: "",
    PATH: `${fixture.binDir}:/usr/bin:/bin`,
    NOTION_API_KEY: "",
    REDMINE_API_KEY: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    SLACK_BOT_TOKEN: "",
    SLACK_CHANNEL_ID: "",
    ...overrides,
  };
}

test("environment wrappers execute the index from their own checkout", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-env-wrapper-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const fakeBash = path.join(binDir, "bash");
  fs.writeFileSync(fakeBash, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  mode: process.env.MODE,
}));
`, "utf8");
  fs.chmodSync(fakeBash, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const reportArgs = [
    path.join(projectRoot, "scripts/run-with-lock.sh"),
    path.join(projectRoot, "out/report-run.lock"),
    "node",
    path.join(projectRoot, "index.js"),
  ];
  const cases = [
    {
      wrapper: "run-report-env.sh",
      inputMode: "prune",
      expectedMode: "prune",
      expectedArgs: reportArgs,
    },
    {
      wrapper: "run-generate-env.sh",
      inputMode: null,
      expectedMode: "generate",
      expectedArgs: [path.join(projectRoot, "run-report-env.sh")],
    },
    {
      wrapper: "run-update-env.sh",
      inputMode: "generate",
      expectedMode: "update",
      expectedArgs: [path.join(projectRoot, "run-report-env.sh")],
    },
  ];

  for (const { wrapper, inputMode, expectedMode, expectedArgs } of cases) {
    const capturePath = path.join(dir, `${wrapper}.json`);
    const env = {
      ...process.env,
      CAPTURE_PATH: capturePath,
      NOTION_API_KEY: "test-key",
      PATH: `${binDir}:${process.env.PATH}`,
    };
    if (inputMode === null) delete env.MODE;
    else env.MODE = inputMode;

    const result = spawnSync("/usr/bin/bash", [path.join(projectRoot, wrapper)], {
      encoding: "utf8",
      env,
    });

    assert.strictEqual(result.status, 0, `${wrapper}: ${result.stderr}`);
    const captured = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    assert.deepStrictEqual(captured, {
      args: expectedArgs,
      mode: expectedMode,
    });
  }
});

test("weekly wrappers apply fixed profiles after .env and preserve caller recovery values", (t) => {
  const fixture = copyRuntimeFixture(t);
  const capturePath = path.join(fixture.dir, "capture.json");
  const entryCapturePath = path.join(fixture.dir, "entry.txt");
  writeNodeExecutable(path.join(fixture.binDir, "bash"), `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.length === 1 && path.basename(args[0]) === "run-report-env.sh") {
  fs.writeFileSync(process.env.ENTRY_CAPTURE_PATH, args[0]);
  const result = spawnSync("/usr/bin/bash", args, { env: process.env, stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}
fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args,
  mode: process.env.MODE,
  aiSummarize: process.env.AI_SUMMARIZE,
  aiProvider: process.env.AI_PROVIDER,
  aiModel: process.env.AI_MODEL,
  aiEffort: process.env.AI_EFFORT,
  aiGenerationMethod: process.env.AI_GENERATION_METHOD,
  aiGenerationScope: process.env.AI_GENERATION_SCOPE,
  sourceSelectionFallback: process.env.SOURCE_SELECTION_FALLBACK,
  autoApprove: process.env.AUTO_APPROVE,
  reportDepth: process.env.REPORT_DEPTH,
  validationMode: process.env.VALIDATION_MODE,
  validationOverride: process.env.VALIDATION_OVERRIDE,
  presentationNoteMode: process.env.PRESENTATION_NOTE_MODE,
  meetingDate: process.env.MEETING_DATE,
  outputDir: process.env.OUTPUT_DIR,
  snapshotPath: process.env.SNAPSHOT_PATH,
}));
`);
  writeFixtureEnv(fixture.root, [
    "MODE=from-dotenv",
    "REDMINE_WEEKLY_PROFILE=unknown-from-dotenv",
    "AI_SUMMARIZE=0",
    "AI_PROVIDER=claude",
    "AI_MODEL=hostile-model",
    "AI_EFFORT=max",
    "AI_GENERATION_METHOD=freeform",
    "AI_GENERATION_SCOPE=project",
    "SOURCE_SELECTION_FALLBACK=0",
    "AUTO_APPROVE=0",
    "REPORT_DEPTH=1",
    "VALIDATION_MODE=warn",
    "VALIDATION_OVERRIDE=1",
    "PRESENTATION_NOTE_MODE=off",
    "MEETING_DATE=1999-01-01",
    "OUTPUT_DIR=/dotenv/output",
    "SNAPSHOT_PATH=/dotenv/snapshot.json",
  ].join("\n"));

  const recovery = {
    MEETING_DATE: "2026-09-16",
    OUTPUT_DIR: path.join(fixture.dir, "recovery-output"),
    SNAPSHOT_PATH: path.join(fixture.dir, "recovery-snapshot.json"),
  };
  const common = {
    reportDepth: "3",
    validationMode: "block",
    validationOverride: "0",
    presentationNoteMode: "suggest",
    meetingDate: recovery.MEETING_DATE,
    outputDir: recovery.OUTPUT_DIR,
    snapshotPath: recovery.SNAPSHOT_PATH,
  };
  const cases = [
    {
      wrapper: "run-weekly-prepare-env.sh",
      expected: {
        mode: "weekly-prepare",
        aiSummarize: "1",
        aiProvider: "codex",
        aiModel: "gpt-5.6-sol",
        aiEffort: "low",
        aiGenerationMethod: "source_selection",
        aiGenerationScope: "whole",
        sourceSelectionFallback: "1",
        autoApprove: "0",
        ...common,
      },
    },
    {
      wrapper: "run-weekly-publish-env.sh",
      expected: {
        mode: "weekly-publish",
        aiSummarize: "0",
        aiProvider: "claude",
        aiModel: "hostile-model",
        aiEffort: "max",
        aiGenerationMethod: "freeform",
        aiGenerationScope: "project",
        sourceSelectionFallback: "0",
        autoApprove: "1",
        ...common,
      },
    },
  ];

  for (const { wrapper, expected } of cases) {
    fs.rmSync(capturePath, { force: true });
    fs.rmSync(entryCapturePath, { force: true });
    const result = spawnSync("/usr/bin/bash", [path.join(fixture.root, wrapper)], {
      encoding: "utf8",
      env: isolatedEnv(fixture, {
        ...recovery,
        CAPTURE_PATH: capturePath,
        ENTRY_CAPTURE_PATH: entryCapturePath,
        MODE: "hostile-inherited-mode",
        REDMINE_WEEKLY_PROFILE: "hostile-inherited-profile",
        AI_SUMMARIZE: "0",
        AI_PROVIDER: "claude",
        AI_MODEL: "hostile-inherited-model",
        AI_EFFORT: "max",
        AI_GENERATION_METHOD: "freeform",
        AI_GENERATION_SCOPE: "project",
        SOURCE_SELECTION_FALLBACK: "0",
        AUTO_APPROVE: "0",
        REPORT_DEPTH: "1",
        VALIDATION_MODE: "warn",
        VALIDATION_OVERRIDE: "1",
        PRESENTATION_NOTE_MODE: "off",
      }),
    });

    assert.strictEqual(result.status, 0, `${wrapper}: ${result.stderr}`);
    assert.strictEqual(fs.readFileSync(entryCapturePath, "utf8"),
      path.join(fixture.root, "run-report-env.sh"));
    const captured = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    assert.deepStrictEqual(captured, {
      args: [
        path.join(fixture.root, "scripts/run-with-lock.sh"),
        path.join(fixture.root, "out/report-run.lock"),
        "node",
        path.join(fixture.root, "index.js"),
      ],
      ...expected,
    });
  }
});

test("weekly recovery settings distinguish explicit empty, .env defaults, and unset", async (t) => {
  const cases = [
    {
      name: "explicit empty survives dotenv",
      dotenv: "MEETING_DATE=2026-01-01\nOUTPUT_DIR=/dotenv/out\nSNAPSHOT_PATH=/dotenv/snapshot.json\n",
      recovery: { MEETING_DATE: "", OUTPUT_DIR: "", SNAPSHOT_PATH: "" },
      expected: {
        MEETING_DATE: { isSet: true, value: "" },
        OUTPUT_DIR: { isSet: true, value: "" },
        SNAPSHOT_PATH: { isSet: true, value: "" },
      },
    },
    {
      name: "caller unset uses dotenv defaults",
      dotenv: "MEETING_DATE=2026-01-01\nOUTPUT_DIR=/dotenv/out\nSNAPSHOT_PATH=/dotenv/snapshot.json\n",
      recovery: {},
      expected: {
        MEETING_DATE: { isSet: true, value: "2026-01-01" },
        OUTPUT_DIR: { isSet: true, value: "/dotenv/out" },
        SNAPSHOT_PATH: { isSet: true, value: "/dotenv/snapshot.json" },
      },
    },
    {
      name: "caller and dotenv unset stay unset",
      dotenv: "AI_SUMMARIZE=0\n",
      recovery: {},
      expected: {
        MEETING_DATE: { isSet: false, value: null },
        OUTPUT_DIR: { isSet: false, value: null },
        SNAPSHOT_PATH: { isSet: false, value: null },
      },
    },
  ];

  for (const settings of cases) await t.test(settings.name, (t) => {
    const fixture = copyRuntimeFixture(t);
    const capturePath = path.join(fixture.dir, "recovery.json");
    writeFixtureEnv(fixture.root, settings.dotenv);
    writeNodeExecutable(path.join(fixture.binDir, "bash"), `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.length === 1 && path.basename(args[0]) === "run-report-env.sh") {
  const result = spawnSync("/usr/bin/bash", args, { env: process.env, stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}
const recovery = {};
for (const key of ["MEETING_DATE", "OUTPUT_DIR", "SNAPSHOT_PATH"]) {
  recovery[key] = {
    isSet: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key] ?? null,
  };
}
fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(recovery));
`);
    const env = isolatedEnv(fixture, { CAPTURE_PATH: capturePath, ...settings.recovery });
    for (const key of ["MEETING_DATE", "OUTPUT_DIR", "SNAPSHOT_PATH"]) {
      if (!Object.prototype.hasOwnProperty.call(settings.recovery, key)) delete env[key];
    }
    const result = spawnSync("/usr/bin/bash", [
      path.join(fixture.root, "run-weekly-prepare-env.sh"),
    ], { encoding: "utf8", env });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")), settings.expected);
  });
});

test("run-report-env rejects an unknown private weekly profile before report execution", (t) => {
  const fixture = copyRuntimeFixture(t);
  const executionPath = path.join(fixture.dir, "report-executed");
  writeNodeExecutable(path.join(fixture.binDir, "bash"), `
require("node:fs").writeFileSync(process.env.REPORT_EXECUTION_PATH, "executed");
`);
  const result = spawnSync("/usr/bin/bash", [path.join(fixture.root, "run-report-env.sh")], {
    encoding: "utf8",
    env: isolatedEnv(fixture, {
      NOTION_API_KEY: "fixture-key",
      REDMINE_WEEKLY_PROFILE: "mystery",
      REPORT_EXECUTION_PATH: executionPath,
    }),
  });
  assert.strictEqual(result.status, 64, result.stderr);
  assert.match(result.stderr, /unknown weekly profile/i);
  assert.strictEqual(fs.existsSync(executionPath), false);
});

test("weekly wrapper failures alert once and terminal publish skips without another alert", (t) => {
  const fixture = copyRuntimeFixture(t);
  const lockCapturePath = path.join(fixture.dir, "locks.jsonl");
  const notifyCapturePath = path.join(fixture.dir, "notify.log");
  const curlCapturePath = path.join(fixture.dir, "curl.log");
  writeNodeExecutable(path.join(fixture.binDir, "bash"), `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.length === 1 && path.basename(args[0]) === "run-report-env.sh") {
  const result = spawnSync("/usr/bin/bash", args, { env: process.env, stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}
fs.appendFileSync(process.env.LOCK_CAPTURE_PATH, JSON.stringify(args) + "\\n");
const command = process.env.MODE === "weekly-prepare" && process.env.FAIL_PREPARE === "1"
  ? [args[0], args[1], "/usr/bin/false"]
  : args;
const result = spawnSync("/usr/bin/bash", command, { env: process.env, stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`);
  writeExecutable(path.join(fixture.binDir, "notify-send"), `#!/bin/sh
printf '%s\n' "$*" >> "$NOTIFY_CAPTURE_PATH"
`);
  writeExecutable(path.join(fixture.binDir, "curl"), `#!/bin/sh
printf '%s\n' "$*" >> "$CURL_CAPTURE_PATH"
exit 99
`);

  const outputDir = path.join(fixture.dir, "pipeline-output");
  const baseEnv = isolatedEnv(fixture, {
    MEETING_DATE: "2026-09-16",
    OUTPUT_DIR: outputDir,
    LOCK_CAPTURE_PATH: lockCapturePath,
    NOTIFY_CAPTURE_PATH: notifyCapturePath,
    CURL_CAPTURE_PATH: curlCapturePath,
  });
  const run = (wrapper, env = baseEnv) => spawnSync(
    "/usr/bin/bash", [path.join(fixture.root, wrapper)], { encoding: "utf8", env }
  );
  const alertPath = path.join(fixture.root, "out/ALERT.log");
  const alertLines = () => fs.existsSync(alertPath)
    ? fs.readFileSync(alertPath, "utf8").trim().split("\n").filter(Boolean)
    : [];

  const prepare = run("run-weekly-prepare-env.sh", { ...baseEnv, FAIL_PREPARE: "1" });
  assert.strictEqual(prepare.status, 1, prepare.stderr);
  assert.strictEqual(alertLines().length, 1);

  const meetingDir = path.join(outputDir, "pipeline", "2026-09-16");
  fs.mkdirSync(meetingDir, { recursive: true });
  fs.writeFileSync(path.join(meetingDir, "status.json"), JSON.stringify({
    status: "failed",
    failureArtifact: path.join(meetingDir, "failures", "prepare.md"),
  }));
  const failedPublish = run("run-weekly-publish-env.sh");
  assert.strictEqual(failedPublish.status, 0, failedPublish.stderr);
  assert.strictEqual(alertLines().length, 1);

  const missingPublish = run("run-weekly-publish-env.sh", {
    ...baseEnv,
    MEETING_DATE: "2026-09-23",
  });
  assert.notStrictEqual(missingPublish.status, 0, missingPublish.stderr);
  assert.strictEqual(alertLines().length, 2);

  const lockCalls = fs.readFileSync(lockCapturePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.strictEqual(lockCalls.length, 3);
  for (const args of lockCalls) {
    assert.deepStrictEqual(args.slice(0, 4), [
      path.join(fixture.root, "scripts/run-with-lock.sh"),
      path.join(fixture.root, "out/report-run.lock"),
      "node",
      path.join(fixture.root, "index.js"),
    ]);
  }
  assert.strictEqual(fs.readFileSync(notifyCapturePath, "utf8").trim().split("\n").length, 2);
  assert.strictEqual(fs.existsSync(curlCapturePath), false);
});
