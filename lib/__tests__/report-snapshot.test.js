const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectSnapshot, loadSnapshot } = require("../report-snapshot");

function configFor(outputDir) {
  return {
    env: {
      outputDir,
      forceCollect: false,
      allowPartialSnapshot: false,
      presentationNoteThreshold: 5,
      snapshotPath: "",
    },
    sources: {
      git: { enabled: true },
      notion: { enabled: false },
      session: { enabled: true },
    },
  };
}

function fakeDeps(counter) {
  const start = new Date(2026, 6, 8, 6, 0, 0, 0);
  const end = new Date(2026, 6, 15, 5, 59, 59, 999);
  return {
    dateRange: () => ({
      start,
      end,
      startDate: "2026-07-08T06:00:00",
      endDate: "2026-07-15T05:59:59",
      startInclusive: start.toISOString(),
      endExclusive: new Date(end.getTime() + 1).toISOString(),
    }),
    collectAll: async () => {
      counter.git += 1;
      return { "{{ETC_KO}}": "  - collected" };
    },
    collectSessionItems: () => {
      counter.session += 1;
      return [];
    },
    collectNotionItems: async () => [],
    mergeItemsIntoAutoContent: (git) => git,
    buildContent: (_date, autoContent) => `HEADER\n${autoContent["{{ETC_KO}}"]}\n`,
    classifyPresentationNotes: () => [],
  };
}

test("sealed snapshot is reused without recollecting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-collect-"));
  const counter = { git: 0, session: 0 };
  try {
    const config = configFor(dir);
    const meetingDate = new Date(2026, 6, 15);
    const first = await collectSnapshot(config, meetingDate, { deps: fakeDeps(counter) });
    const second = await collectSnapshot(config, meetingDate, { deps: fakeDeps(counter) });

    assert.strictEqual(first.snapshot.status, "sealed");
    assert.strictEqual(second.reused, true);
    assert.strictEqual(first.snapshot.contentHash, second.snapshot.contentHash);
    assert.deepStrictEqual(counter, { git: 1, session: 1 });
    assert.strictEqual(loadSnapshot(config, meetingDate).snapshot.contentHash, first.snapshot.contentHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("force collection archives a changed sealed snapshot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-recollect-"));
  try {
    const config = configFor(dir);
    const meetingDate = new Date(2026, 6, 15);
    await collectSnapshot(config, meetingDate, { deps: fakeDeps({ git: 0, session: 0 }) });

    const changedDeps = fakeDeps({ git: 0, session: 0 });
    changedDeps.collectAll = async () => ({ "{{ETC_KO}}": "  - changed" });
    const changed = await collectSnapshot(config, meetingDate, {
      forceCollect: true,
      deps: changedDeps,
    });

    assert.strictEqual(changed.reused, false);
    assert.ok(fs.readdirSync(dir).some((name) => /\.[0-9a-f]{12}\.snapshot\.json$/.test(name)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("partial snapshot is recollected automatically instead of being reused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-partial-"));
  const counter = { git: 0, session: 0 };
  try {
    const config = configFor(dir);
    const meetingDate = new Date(2026, 6, 15);
    const failedDeps = fakeDeps(counter);
    failedDeps.collectAll = async () => {
      counter.git += 1;
      throw new Error("temporary git failure");
    };
    await collectSnapshot(config, meetingDate, { deps: failedDeps });

    const recovered = await collectSnapshot(config, meetingDate, { deps: fakeDeps(counter) });
    assert.strictEqual(recovered.snapshot.status, "sealed");
    assert.strictEqual(recovered.reused, false);
    assert.strictEqual(counter.git, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
