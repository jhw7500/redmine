const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { aiSummarize, generate } = require("../publisher");

function makeFakeClaude(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-ai-cli-"));
  const cliPath = path.join(dir, "claude");
  fs.writeFileSync(cliPath, `#!/usr/bin/env node\n${source}\n`, "utf8");
  fs.chmodSync(cliPath, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return cliPath;
}

function createConfig(cliPath, overrides = {}) {
  return {
    env: {
      aiSummarize: true,
      claudeCli: cliPath,
      aiModel: "sonnet",
      aiEffort: "low",
      aiMaxInputChars: 100000,
      aiTimeoutMs: 300000,
      aiMaxBudgetUsd: null,
      reportDepth: 2,
      sectionHeader: '#### <span style="color:blue">조현우</span>',
      outputDir: os.tmpdir(),
      outputPath: "",
      ...overrides,
    },
    depthProfiles: {},
    reportFilter: {},
  };
}

test("AI summary runs once in an isolated low-cost Claude session", async (t) => {
  const cliPath = makeFakeClaude(
    t,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)))"
  );
  const config = createConfig(cliPath, { aiMaxBudgetUsd: 0.25 });

  const result = await aiSummarize("원본 보고서", config, new Date("2026-08-26T00:00:00"));
  const args = JSON.parse(result);

  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.deepStrictEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), [
    "--tools",
    "",
  ]);
  assert.deepStrictEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
    "--model",
    "sonnet",
  ]);
  assert.deepStrictEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), [
    "--effort",
    "low",
  ]);
  assert.deepStrictEqual(
    args.slice(args.indexOf("--max-budget-usd"), args.indexOf("--max-budget-usd") + 2),
    ["--max-budget-usd", "0.25"]
  );
  assert.strictEqual(args.filter((arg) => arg === "-p").length, 1);
});

test("AI input limit rejects before Claude is started", async (t) => {
  const markerPath = path.join(os.tmpdir(), `redmine-ai-marker-${process.pid}-${Date.now()}`);
  const cliPath = makeFakeClaude(
    t,
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`
  );
  t.after(() => fs.rmSync(markerPath, { force: true }));
  const config = createConfig(cliPath, { aiMaxInputChars: 10 });

  await assert.rejects(
    () => aiSummarize("이 입력은 열 글자를 넘는다", config, new Date("2026-08-26T00:00:00")),
    (err) => err && err.code === "AI_INPUT_LIMIT"
  );
  assert.strictEqual(fs.existsSync(markerPath), false);
});

test("quota failure is surfaced instead of falling back to raw output", async (t) => {
  const cliPath = makeFakeClaude(
    t,
    'process.stderr.write("You have hit your limit; resets Aug 28"); process.exit(1)'
  );
  const config = createConfig(cliPath);

  await assert.rejects(
    () => aiSummarize("원본 보고서", config, new Date("2026-08-26T00:00:00")),
    (err) => err && err.code === "AI_QUOTA"
  );
});

test("CLI dollar budget exhaustion has its own failure code", async (t) => {
  const cliPath = makeFakeClaude(
    t,
    'process.stderr.write("maximum budget reached (--max-budget-usd)"); process.exit(1)'
  );
  const config = createConfig(cliPath, { aiMaxBudgetUsd: 0.25 });

  await assert.rejects(
    () => aiSummarize("원본 보고서", config, new Date("2026-08-26T00:00:00")),
    (err) => err && err.code === "AI_BUDGET"
  );
});

test("AI timeout is surfaced with a distinct failure code", async (t) => {
  const cliPath = makeFakeClaude(t, "setTimeout(() => {}, 1000)");
  const config = createConfig(cliPath, { aiTimeoutMs: 20 });

  await assert.rejects(
    () => aiSummarize("원본 보고서", config, new Date("2026-08-26T00:00:00")),
    (err) => err && err.code === "AI_TIMEOUT"
  );
});

test("AI timeout escalates to SIGKILL when the process ignores SIGTERM", async (t) => {
  const pidPath = path.join(os.tmpdir(), `redmine-ai-pid-${process.pid}-${Date.now()}`);
  let childPid;
  t.after(() => {
    fs.rmSync(pidPath, { force: true });
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  });
  const cliPath = makeFakeClaude(
    t,
    `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);`
  );
  const config = createConfig(cliPath, { aiTimeoutMs: 20, aiKillGraceMs: 30 });

  await assert.rejects(
    () => aiSummarize("원본 보고서", config, new Date("2026-08-26T00:00:00")),
    (err) => err && err.code === "AI_TIMEOUT"
  );
  childPid = Number(fs.readFileSync(pidPath, "utf8"));
  assert.throws(
    () => process.kill(childPid, 0),
    (err) => err && err.code === "ESRCH"
  );
});

test("generate does not save a raw draft when an enabled AI call fails", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-ai-output-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const callsPath = path.join(dir, "calls");
  const cliPath = makeFakeClaude(
    t,
    `const fs = require("node:fs");
const callsPath = ${JSON.stringify(callsPath)};
const calls = fs.existsSync(callsPath) ? Number(fs.readFileSync(callsPath, "utf8")) : 0;
fs.writeFileSync(callsPath, String(calls + 1));
process.exit(7);`
  );
  const outputPath = path.join(dir, "report.md");
  const config = createConfig(cliPath, { outputDir: dir, outputPath });

  await assert.rejects(
    () => generate(config, new Date("2026-08-26T00:00:00"), "", [], { rawContent: "원본" }),
    (err) => err && err.code === "AI_EXIT"
  );
  assert.strictEqual(fs.existsSync(outputPath), false);
  assert.strictEqual(fs.readFileSync(callsPath, "utf8"), "1");
});
