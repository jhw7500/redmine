const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { sha256 } = require("../report-artifact");
const { buildFactCatalog } = require("../fact-catalog");
const { annotateFactReferences } = require("../fact-references");
const {
  aiSummarize,
  buildAiPrompt,
  generate,
  generateContent,
} = require("../publisher");

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

async function waitForFile(filePath, timeoutMs = 800) {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for child readiness: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("AI summary runs once in an isolated low-cost Claude session", async (t) => {
  const cliPath = makeFakeClaude(
    t,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)))"
  );
  const config = createConfig(cliPath, { aiMaxBudgetUsd: 0.25 });

  const meetingDate = new Date("2026-08-26T00:00:00");
  const catalog = buildFactCatalog("보드 실행 5/8 PASS\n플릿 16건 저장소 전면 배포");
  const result = await aiSummarize("원본 보고서", config, meetingDate, { factCatalog: catalog });
  const args = JSON.parse(result);
  const prompt = args[args.indexOf("-p") + 1];

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
  assert.match(prompt, /\[\[fact:T0001\|5\/8 PASS\]\]/);
  assert.match(prompt, /숫자.*표기 순서.*단위.*조수사.*바꾸지/);
  assert.match(prompt, /합산.*차감.*집계/);
  assert.match(prompt, /환산.*평균.*반올림/);
  assert.doesNotMatch(prompt, /출력은 `N건 PASS, 실패 M건`/);
});

test("inline fact prompt keeps opaque source references without duplicating catalog surfaces", () => {
  const config = createConfig("claude");
  const meetingDate = new Date("2026-08-26T00:00:00");
  const raw = "보드 실행 5/8 PASS";
  const catalog = buildFactCatalog(raw, [
    { type: "meeting_date", raw: "2026-08-26", subject: "meeting date" },
  ]);
  const source = annotateFactReferences(raw, catalog);

  const prompt = buildAiPrompt(source, config, meetingDate, {
    factCatalog: catalog,
    factInputMode: "inline_refs",
  });

  assert.match(prompt, /보드 실행 \[\[fact:T0001\]\]/);
  assert.match(prompt, /meeting date: \[\[fact:S0001\]\]/);
  assert.doesNotMatch(prompt, /\[\[fact:T0001\|5\/8 PASS\]\]/);
  assert.doesNotMatch(prompt, /— 보드 실행 5\/8 PASS/);
  assert.doesNotMatch(prompt, /원본에 기준일이 없으면[^\n]*2026-08-26/);
});

test("coverage prompt makes source markers mandatory while fact references stay optional", () => {
  const config = createConfig("claude");
  const meetingDate = new Date("2026-08-26T00:00:00");
  const annotatedSource = [
    '#### <span style="color:blue">조현우</span>',
    "- PIM",
    "  - Platform [[source:C0001]]",
    "",
  ].join("\n");
  const factCatalog = buildFactCatalog(annotatedSource);
  const coverageCatalog = {
    schemaVersion: 1,
    coverageCatalogHash: "coverage-catalog-hash",
    sections: [{ id: "C0001", requiredPath: ["PIM", "Platform"] }],
    items: [],
    knownPaths: [["PIM", "Platform"]],
  };

  const prompt = buildAiPrompt(annotatedSource, config, meetingDate, {
    factCatalog,
    factInputMode: "inline_refs",
    coverageCatalog,
    sourceCoverageMode: "required_sections_and_notion_v1",
  });

  assert.match(prompt, /\[\[source:C0001\]\]/);
  assert.match(prompt, /모든.*source.*marker.*보존/s);
  assert.match(prompt, /source coverage marker.*생략.*금지/s);
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

test("catalog-expanded prompt rejects before Claude is started", async (t) => {
  const promptCli = makeFakeClaude(
    t,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)))"
  );
  const baselineConfig = createConfig(promptCli);
  const meetingDate = new Date("2026-08-26T00:00:00");
  const baselineArgs = JSON.parse(await aiSummarize("원본", baselineConfig, meetingDate));
  const baselinePrompt = baselineArgs[baselineArgs.indexOf("-p") + 1];

  const markerPath = path.join(os.tmpdir(), `redmine-ai-catalog-marker-${process.pid}-${Date.now()}`);
  const markerCli = makeFakeClaude(
    t,
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`
  );
  t.after(() => fs.rmSync(markerPath, { force: true }));
  const config = createConfig(markerCli, { aiMaxInputChars: baselinePrompt.length });
  const catalog = buildFactCatalog("보드 실행 5/8 PASS\n플릿 16건 저장소 전면 배포");

  await assert.rejects(
    () => aiSummarize("원본", config, meetingDate, { factCatalog: catalog }),
    (err) => err && err.code === "AI_INPUT_LIMIT"
  );
  assert.strictEqual(fs.existsSync(markerPath), false);
});

test("generateContent returns the raw section and prompt hash when AI is disabled", async (t) => {
  const cliPath = makeFakeClaude(t, "process.exit(1)");
  const config = createConfig(cliPath, { aiSummarize: false });
  const rawContent = "#### 조현우\n- 원본\n";
  const prompt = "test prompt";

  const result = await generateContent(config, new Date("2026-08-26T00:00:00"), rawContent, { prompt });

  assert.deepStrictEqual(result, {
    usedAi: false,
    rawAiOutput: null,
    content: rawContent,
    prompt,
    promptHash: sha256(prompt),
  });
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
  // This case tests the post-timeout escalation, so first allow the real child
  // process to finish startup and advertise that its SIGTERM handler is ready.
  const config = createConfig(cliPath, { aiTimeoutMs: 1000, aiKillGraceMs: 30 });

  const rejection = assert.rejects(
    aiSummarize("원본 보고서", config, new Date("2026-08-26T00:00:00")),
    (err) => err && err.code === "AI_TIMEOUT"
  );
  await waitForFile(pidPath);
  childPid = Number(fs.readFileSync(pidPath, "utf8"));
  await rejection;
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
