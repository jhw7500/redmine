// 동일 sealed snapshot으로 provider/model/scope 조합을 비교한다. Redmine update는 수행하지 않는다.
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../lib/config");
const { writeJsonAtomic } = require("../lib/report-artifact");
const { runGenerate } = require("../index");

const DEFAULT_MATRIX = Object.freeze([
  { id: "claude-sonnet-whole", provider: "claude", model: "sonnet", scope: "whole" },
  { id: "claude-sonnet-project", provider: "claude", model: "sonnet", scope: "project" },
  { id: "claude-opus-whole", provider: "claude", model: "opus", scope: "whole" },
  { id: "claude-opus-project", provider: "claude", model: "opus", scope: "project" },
  { id: "codex-gpt-5.6-sol-whole", provider: "codex", model: "gpt-5.6-sol", scope: "whole" },
  { id: "codex-gpt-5.6-sol-project", provider: "codex", model: "gpt-5.6-sol", scope: "project" },
]);

function buildComparisonMatrix() {
  return DEFAULT_MATRIX.map((entry) => ({ ...entry }));
}

function selectComparisonMatrix(selection) {
  if (!selection) return buildComparisonMatrix();
  const entries = new Map(buildComparisonMatrix().map((entry) => [entry.id, entry]));
  return String(selection).split(",").map((value) => value.trim()).filter(Boolean).map((id) => {
    const entry = entries.get(id);
    if (!entry) throw new Error(`Unknown comparison id: ${id}`);
    return entry;
  });
}

function normalizeBullet(line) {
  const match = String(line).match(/^\s*[-*+]\s+(.+?)\s*$/);
  if (!match) return null;
  return match[1].replace(/\s+/g, " ").trim();
}

function bulletIndent(line) {
  const match = String(line).match(/^(\s*)[-*+]\s+/);
  return match ? match[1].replace(/\t/g, "  ").length : null;
}

function analyzeReport(content) {
  const trimmed = String(content || "").trim();
  const lines = trimmed ? trimmed.split("\n") : [];
  const entries = [];
  lines.forEach((line, index) => {
    const text = normalizeBullet(line);
    if (!text) return;
    entries.push({ text, indent: bulletIndent(line), line: index + 1 });
  });
  const bullets = new Map();
  entries.forEach((entry, index) => {
    const next = entries[index + 1];
    if (next && next.indent > entry.indent) return;
    const { text } = entry;
    const key = text.toLocaleLowerCase("ko-KR");
    const current = bullets.get(key) || { text, count: 0, lines: [] };
    current.count += 1;
    current.lines.push(entry.line);
    bullets.set(key, current);
  });

  return {
    lineCount: lines.length,
    bulletCount: entries.length,
    duplicateGroups: [...bullets.values()].filter((item) => item.count > 1),
  };
}

function summarizeIssues(issues = []) {
  const bySeverity = {};
  const byCode = {};
  for (const issue of issues) {
    const severity = issue.severity || "unknown";
    const code = issue.code || "unknown";
    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
    byCode[code] = (byCode[code] || 0) + 1;
  }
  return { total: issues.length, bySeverity, byCode };
}

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listRunDirectories(outputDir, meetingDateText) {
  const root = path.join(outputDir, "runs", meetingDateText);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

function selectEvidenceRun(outputDir, meetingDateText, result, previousRuns) {
  const returnedRunDir = result && result.runPaths && result.runPaths.runDir;
  if (returnedRunDir && fs.existsSync(returnedRunDir)) return returnedRunDir;
  const candidates = listRunDirectories(outputDir, meetingDateText)
    .filter((runDir) => !previousRuns.has(runDir));
  return candidates.sort((left, right) => {
    const leftState = readJsonIfPresent(path.join(left, "state.json"));
    const rightState = readJsonIfPresent(path.join(right, "state.json"));
    return String(rightState?.startedAt || "").localeCompare(String(leftState?.startedAt || ""));
  })[0] || null;
}

function readModelCallEvidence(outputDir, meetingDateText, entry, result, previousRuns) {
  const runDir = selectEvidenceRun(outputDir, meetingDateText, result, previousRuns);
  if (!runDir) return { plannedCalls: null, actualCalls: 0, callEvidenceRunDir: null };
  const promptInput = readJsonIfPresent(path.join(runDir, "prompt-input.json"));
  const state = readJsonIfPresent(path.join(runDir, "state.json"));
  const plannedCalls = Number.isInteger(promptInput?.callCount) ? promptInput.callCount : null;
  let actualCalls = 0;
  if (entry.scope === "project") {
    const stateCalls = Array.isArray(state?.aiParts) ? state.aiParts.length : 0;
    const artifactCalls = fs.readdirSync(runDir)
      .filter((name) => /^draft\.ai\.part\.\d+\.annotated\.md$/.test(name)).length;
    actualCalls = Math.max(stateCalls, artifactCalls);
  } else if (state?.rawAiDraftHash || fs.existsSync(path.join(runDir, "draft.ai.annotated.md"))) {
    actualCalls = 1;
  }
  return { plannedCalls, actualCalls, callEvidenceRunDir: runDir };
}

function findAnalyzableReport(result) {
  const candidates = [
    result && result.reportPath,
    result && result.runPaths && result.runPaths.workingDraftPath,
    result && result.runPaths && result.runPaths.aiDraftPath,
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function buildRunConfig(baseConfig, entry, options) {
  const outputDir = path.join(options.outputRoot, entry.id);
  const outputPath = path.join(
    outputDir,
    `jo-hyunwoo-${options.meetingDateText}.depth${options.depth}.md`
  );
  return {
    ...baseConfig,
    env: {
      ...baseConfig.env,
      mode: "generate",
      meetingDate: options.meetingDateText,
      outputDir,
      outputPath,
      snapshotPath: options.snapshotPath,
      reportDepth: options.depth,
      aiSummarize: true,
      aiProvider: entry.provider,
      aiModel: entry.model,
      aiEffort: options.effort,
      aiGenerationScope: entry.scope,
      aiTimeoutMs: options.timeoutMs,
      validationMode: "block",
      validationOverride: false,
      presentationNoteMode: "off",
    },
  };
}

async function runComparison(options) {
  const {
    baseConfig,
    meetingDate,
    meetingDateText,
    outputRoot,
    snapshotPath,
    runGenerateFn = runGenerate,
    matrix = buildComparisonMatrix(),
    depth = 3,
    effort = "medium",
    timeoutMs = 900000,
    logger = console.log,
    now = Date.now,
  } = options;
  fs.mkdirSync(outputRoot, { recursive: true });
  const results = [];

  for (const entry of matrix) {
    const config = buildRunConfig(baseConfig, entry, {
      depth,
      effort,
      meetingDateText,
      outputRoot,
      snapshotPath,
      timeoutMs,
    });
    const startedAt = now();
    const previousRuns = new Set(listRunDirectories(config.env.outputDir, meetingDateText));
    logger(`[spike] start ${entry.id}`);
    try {
      const generated = await runGenerateFn(config, meetingDate);
      const callEvidence = readModelCallEvidence(
        config.env.outputDir,
        meetingDateText,
        entry,
        generated,
        previousRuns
      );
      const reportPath = findAnalyzableReport(generated);
      const analysis = reportPath
        ? analyzeReport(fs.readFileSync(reportPath, "utf8"))
        : analyzeReport("");
      const validation = generated.validation || {};
      results.push({
        ...entry,
        status: validation.status || "UNKNOWN",
        publishable: validation.publishable === true,
        elapsedMs: now() - startedAt,
        ...callEvidence,
        reportPath,
        validationIssues: summarizeIssues(validation.issues),
        sourceCoverage: validation.sourceCoverage || null,
        ...analysis,
      });
    } catch (error) {
      const callEvidence = readModelCallEvidence(
        config.env.outputDir,
        meetingDateText,
        entry,
        null,
        previousRuns
      );
      results.push({
        ...entry,
        status: "ERROR",
        publishable: false,
        elapsedMs: now() - startedAt,
        ...callEvidence,
        reportPath: null,
        sourceCoverage: null,
        ...analyzeReport(""),
        errorCode: error && error.code ? error.code : "GENERATE_FAILED",
        errorMessage: error && error.message ? error.message : String(error),
        partId: error && error.partId ? error.partId : null,
        validationIssues: summarizeIssues(error && Array.isArray(error.issues) ? error.issues : []),
      });
    }
    logger(`[spike] done ${entry.id}: ${results.at(-1).status}`);
  }

  const summary = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    meetingDate: meetingDateText,
    snapshotPath,
    depth,
    effort,
    retryPolicy: "none",
    redmineUpdate: false,
    maximumModelCalls: matrix.reduce(
      (total, entry) => total + (entry.scope === "project" ? 3 : 1),
      0
    ),
    results,
  };
  writeJsonAtomic(path.join(outputRoot, "comparison.json"), summary);
  return summary;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.snapshot || !args["meeting-date"]) {
    throw new Error("Usage: node scripts/ai-provider-scope-spike.js --snapshot <path> --meeting-date YYYY-MM-DD [--output-dir <path>] [--only <id,id>] [--depth 3] [--effort medium] [--timeout-ms 900000]");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args["meeting-date"])) {
    throw new Error("--meeting-date must be YYYY-MM-DD");
  }
  const snapshotPath = path.resolve(args.snapshot);
  if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot not found: ${snapshotPath}`);
  const meetingDateText = args["meeting-date"];
  const meetingDate = new Date(`${meetingDateText}T12:00:00`);
  const outputRoot = path.resolve(
    args["output-dir"] || path.join("out", "spikes", `ai-provider-scope-${Date.now()}`)
  );
  const summary = await runComparison({
    baseConfig: loadConfig(),
    meetingDate,
    meetingDateText,
    outputRoot,
    snapshotPath,
    matrix: selectComparisonMatrix(args.only),
    depth: Number(args.depth || 3),
    effort: args.effort || "medium",
    timeoutMs: Number(args["timeout-ms"] || 900000),
  });
  console.log(`[spike] summary: ${path.join(outputRoot, "comparison.json")}`);
  if (summary.results.some((result) => !result.publishable)) process.exitCode = 2;
  return summary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  analyzeReport,
  buildComparisonMatrix,
  buildRunConfig,
  main,
  parseArgs,
  runComparison,
  selectComparisonMatrix,
};
