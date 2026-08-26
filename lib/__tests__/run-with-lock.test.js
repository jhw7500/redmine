const { test } = require("node:test");
const assert = require("node:assert");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("run-with-lock refuses a concurrent report command with exit 75", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-run-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "report.lock");
  const markerPath = path.join(dir, "ran");
  const holder = spawn(
    "bash",
    ["-c", 'exec 9>"$1"; flock 9; echo locked; read -r _', "bash", lockPath],
    { stdio: ["pipe", "pipe", "inherit"] }
  );
  t.after(() => holder.stdin.end("release\n"));
  await once(holder.stdout, "data");

  const helper = path.resolve(__dirname, "../../scripts/run-with-lock.sh");
  const result = spawnSync(
    "bash",
    [
      helper,
      lockPath,
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`,
    ],
    { encoding: "utf8" }
  );

  assert.strictEqual(result.status, 75);
  assert.strictEqual(fs.existsSync(markerPath), false);
});
