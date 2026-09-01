const fs = require("fs");
const os = require("os");
const path = require("path");

function noCleanup() {}

function buildClaudeInvocation(prompt, config) {
  const args = [
    "--safe-mode",
    "--tools",
    "",
    "--no-session-persistence",
    "--model",
    config.env.aiModel,
    "--effort",
    config.env.aiEffort,
  ];
  if (config.env.aiMaxBudgetUsd !== null) {
    args.push("--max-budget-usd", String(config.env.aiMaxBudgetUsd));
  }
  args.push("-p", prompt, "--output-format", "text");
  return {
    provider: "claude",
    providerLabel: "Claude CLI",
    command: config.env.claudeCli,
    args,
    stdin: null,
    cwd: undefined,
    cleanup: noCleanup,
    cleanOutput(output) {
      return String(output).replace(/\n*─{3,}[\s\S]*$/m, "").trimEnd();
    },
  };
}

function buildCodexInvocation(prompt, config) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-codex-"));
  let cleaned = false;
  return {
    provider: "codex",
    providerLabel: "Codex CLI",
    command: config.env.codexCli,
    args: [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--model",
      config.env.aiModel,
      "-c",
      `model_reasoning_effort=${JSON.stringify(config.env.aiEffort)}`,
      "--skip-git-repo-check",
      "-",
    ],
    stdin: prompt,
    cwd,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(cwd, { recursive: true, force: true });
    },
    cleanOutput(output) {
      return String(output).trimEnd();
    },
  };
}

function buildAiInvocation(prompt, config) {
  const provider = config.env.aiProvider || "claude";
  if (provider === "claude") return buildClaudeInvocation(prompt, config);
  if (provider === "codex") return buildCodexInvocation(prompt, config);
  const error = new Error(`지원하지 않는 AI provider입니다: ${provider}`);
  error.code = "AI_PROVIDER";
  throw error;
}

module.exports = { buildAiInvocation };
