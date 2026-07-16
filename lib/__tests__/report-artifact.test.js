const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildPublishedPath,
  buildValidationPath,
  computeSnapshotHash,
  readSnapshot,
  sealSnapshot,
  stableStringify,
  writeJsonAtomic,
} = require("../report-artifact");

test("stableStringify sorts object keys without changing array order", () => {
  assert.strictEqual(
    stableStringify({ z: 1, a: { y: 2, b: 3 }, list: [2, 1] }),
    '{"a":{"b":3,"y":2},"list":[2,1],"z":1}'
  );
});

test("snapshot hash ignores collection time but detects content changes", () => {
  const first = sealSnapshot({
    collectedAt: "2026-07-15T06:10:00+09:00",
    meetingDate: "2026-07-15",
    rawContent: "one",
  });
  const second = sealSnapshot({
    collectedAt: "2026-07-15T06:20:00+09:00",
    meetingDate: "2026-07-15",
    rawContent: "one",
  });
  const changed = sealSnapshot({
    collectedAt: "2026-07-15T06:20:00+09:00",
    meetingDate: "2026-07-15",
    rawContent: "two",
  });

  assert.strictEqual(first.contentHash, second.contentHash);
  assert.notStrictEqual(first.contentHash, changed.contentHash);
  assert.strictEqual(computeSnapshotHash(first), first.contentHash);
});

test("readSnapshot rejects tampered content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-snapshot-"));
  const file = path.join(dir, "snapshot.json");
  try {
    const snapshot = sealSnapshot({ meetingDate: "2026-07-15", rawContent: "original" });
    writeJsonAtomic(file, snapshot);
    assert.strictEqual(readSnapshot(file).contentHash, snapshot.contentHash);

    const tampered = { ...snapshot, rawContent: "changed" };
    fs.writeFileSync(file, JSON.stringify(tampered), "utf8");
    assert.throws(() => readSnapshot(file), /Snapshot hash mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact paths never overwrite an extensionless report", () => {
  assert.strictEqual(
    buildValidationPath("/tmp/custom-report"),
    "/tmp/custom-report.validation.json"
  );
  assert.strictEqual(
    buildPublishedPath("/tmp/custom-report"),
    "/tmp/custom-report.published.md"
  );
  assert.strictEqual(
    buildValidationPath("/tmp/custom-report.md"),
    "/tmp/custom-report.validation.json"
  );
});
