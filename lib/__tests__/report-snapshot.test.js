const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectSnapshot, loadSnapshot } = require("../report-snapshot");
const { mergeItemsIntoAutoContent } = require("../merger");
const { blocksToMd } = require("../notion-blocks-to-md");

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
    config.env.allowPartialSnapshot = true;
    assert.strictEqual(loadSnapshot(config, meetingDate).snapshot.status, "partial");
    config.env.allowPartialSnapshot = false;

    const recovered = await collectSnapshot(config, meetingDate, { deps: fakeDeps(counter) });
    assert.strictEqual(recovered.snapshot.status, "sealed");
    assert.strictEqual(recovered.reused, false);
    assert.strictEqual(counter.git, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit Notion API key reaches the collector and day precision is warned", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-notion-key-"));
  try {
    const config = configFor(dir);
    config.sources.notion.enabled = true;
    config.sources.session.enabled = false;
    let receivedKey;
    const deps = fakeDeps({ git: 0, session: 0 });
    deps.collectNotionItems = async (_config, _start, _end, apiKey) => {
      receivedKey = apiKey;
      return [{ sourceDb: "decisionLog", timePrecision: "day", date: "2026-07-15" }];
    };
    const result = await collectSnapshot(config, new Date(2026, 6, 15), {
      deps,
      notionApiKey: "test-notion-key",
    });

    assert.strictEqual(receivedKey, "test-notion-key");
    assert.ok(result.snapshot.warnings.some((warning) => warning.includes("Notion date 속성")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("depth 3 snapshots preserve source-grounded cause, fix, and verification details", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-notion-briefing-"));
  try {
    const config = configFor(dir);
    config.env.reportDepth = 3;
    config.sources.git.enabled = false;
    config.sources.notion.enabled = true;
    config.sources.session.enabled = false;
    config.categories = { pimDriverCam: { templateKey: "CAMERA" } };
    config.reportFilter = {};
    const deps = fakeDeps({ git: 0, session: 0 });
    deps.collectNotionItems = async () => [{
      source: "notion",
      sourceDb: "knowledgeBase",
      sourceId: "notion:camera-page",
      pageId: "camera-page",
      category: "pimDriverCam",
      report: "pim-driver-cam",
      title: "360p@120 듀얼와이드 실패",
      summary: "듀얼와이드 쌍은 하나의 CSI/GMSL 링크를 공유해 같은 exp_time 으로 돌아야 한다. 갈리면 fps>30 에서 합성이 깨진다 — 두 ISP 는 119fps 정상인데 CSI2 만 8~14%. ae_on 비대칭은 그 갈림을 만드는 경로.",
      timestamp: "2026-07-10T00:00:00.000Z",
      date: "2026-07-10",
      tags: ["max9296"],
    }];
    deps.classifyPresentationNotes = items => items.map(item => ({
      pageId: item.pageId,
      title: item.title,
      summary: item.summary,
      candidate: true,
    }));
    deps.fetchPageMarkdown = async () => [
      "> 이전 분석은 폐기한다.",
      "**두 AP1302의 노출값**이 갈리면서 와이드 프레임 합성이 실패했다.",
      "",
      "## 수정 (max9296 PR #66)",
      "노출 시드를 쌍 단위로 결정한다.",
      "- **게이트**: 두 채널이 모두 자동 노출일 때만 시드를 건너뛴다.",
      "- 주소: dual에서는 0x3c broadcast를 사용한다.",
      "```nft",
      "set allowed4 { type ipv4_addr; flags interval; }",
      "```",
      "## 실기 검증:",
      blocksToMd([{
        type: "code",
        code: {
          language: "markdown",
          rich_text: [{
            plain_text: "```js\nconst example = 1;\n```\n## 검증\n- 실행하지 않은 예시 결과",
            annotations: {},
          }],
        },
      }]),
      "| 갈래 | 수정 전 | 수정 후 |",
      "| --- | --- | --- |",
      "| ae_on 비대칭 | 10.1 / 11.3 | 112.3 / 112.6 (4/4) |",
    ].join("\n");
    deps.mergeItemsIntoAutoContent = mergeItemsIntoAutoContent;
    deps.buildContent = (_date, autoContent) => [
      "#### 조현우",
      "- PIM",
      "  - Camera Driver",
      autoContent["{{CAMERA}}"],
      "",
    ].join("\n");

    const result = await collectSnapshot(config, new Date(2026, 6, 15), {
      deps,
      notionApiKey: "test-notion-key",
    });

    assert.deepStrictEqual(result.snapshot.sources.notion.data[0].briefing, {
      cause: "듀얼와이드 쌍은 하나의 CSI/GMSL 링크를 공유해 같은 exp_time 으로 돌아야 한다. ae_on 비대칭은 그 갈림을 만드는 경로. 갈리면 fps>30 에서 합성이 깨진다 — 두 ISP 는 119fps 정상인데 CSI2 만 8~14%.",
      fix: "노출 시드를 쌍 단위로 결정한다. 게이트: 두 채널이 모두 자동 노출일 때만 시드를 건너뛴다. 주소: dual에서는 0x3c broadcast를 사용한다.",
      verification: "ae_on 비대칭: 수정 전 10.1 / 11.3 → 수정 후 112.3 / 112.6 (4/4)",
    });
    assert.match(result.snapshot.rawContent, /↳ 원인: 듀얼와이드 쌍은 .* 같은 exp_time .* ae_on 비대칭/);
    assert.match(result.snapshot.rawContent, /↳ 수정: 노출 시드를 쌍 단위로 결정한다/);
    assert.match(result.snapshot.rawContent, /↳ 검증: ae_on 비대칭: 수정 전 10\.1/);
    assert.ok(Object.values(result.snapshot.sources.notion.data[0].briefing)
      .every(detail => detail.length <= 220));
    assert.doesNotMatch(result.snapshot.rawContent, /\*\*/);
    assert.doesNotMatch(result.snapshot.rawContent, /set allowed4/);
    assert.doesNotMatch(result.snapshot.rawContent, /실행하지 않은 예시 결과|const example/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
