const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("environment wrappers execute the index from their own checkout", (t) => {
  const projectRoot = path.resolve(__dirname, "../..");
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
