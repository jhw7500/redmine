const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  collectAll,
  detectPathSignals,
  extractBodyHighlights,
  getChangelogEntries,
  getGitCommits,
  stripTypePrefix,
  translateLine,
} = require("../collector");
const { runCollect } = require("../../index");

// 2026-08-14 wlan-package 3f63094 재현: NXP 펌웨어 p149.115 갱신이 커밋 제목에
// 드러나지 않아(78파일 release 커밋) 2026-08-19 주간보고에서 통째로 누락됐다.
const FIRMWARE_SIGNALS = {
  pathSignals: [
    {
      pattern: /(^|\/)(lib\/)?firmware\/.+\.bin$/i,
      label: "무선모듈 펌웨어 바이너리 갱신",
      skipIf: /firmware|펌웨어|f\/w|\bfw\b/i,
    },
    {
      pattern: /(^|\/)(nxp-imx-firmware\/|firmware-source\.json$)/i,
      label: "펌웨어 출처·라이선스 문서 갱신",
      skipIf: /firmware|펌웨어|provenance|출처|license|라이선스/i,
    },
  ],
};

test("firmware binary buried in a release commit is surfaced by its path", () => {
  const files = [
    "dist/wlan/usr/lib/firmware/cts/sd9098_wlan_v1.bin",
    "dist/wlan/usr/share/doc/wlan-proc/nxp-imx-firmware/firmware-source.json",
    "scripts/validate_release.sh",
  ];
  const labels = detectPathSignals(
    files,
    "release: harden WLAN recovery and logger supervision",
    FIRMWARE_SIGNALS
  );

  assert.deepStrictEqual(labels, [
    "무선모듈 펌웨어 바이너리 갱신",
    "펌웨어 출처·라이선스 문서 갱신",
  ]);
});

test("a subject that already says it does not get the signal appended twice", () => {
  const labels = detectPathSignals(
    ["dist/wlan/usr/lib/firmware/cts/sd9098_wlan_v1.bin"],
    "chore(fw): NXP 9098 펌웨어 갱신",
    FIRMWARE_SIGNALS
  );

  assert.deepStrictEqual(labels, []);
});

test("unrelated files produce no signal", () => {
  const labels = detectPathSignals(
    ["lib/collector.js", "README.md"],
    "refactor: tidy collector",
    FIRMWARE_SIGNALS
  );

  assert.deepStrictEqual(labels, []);
});

test("scoped conventional commit prefixes are stripped without losing a repository prefix", () => {
  assert.strictEqual(
    stripTypePrefix("fix(cam): fail closed when policy loading fails"),
    "fail closed when policy loading fails"
  );
  assert.strictEqual(
    stripTypePrefix("camera: feat(runtime)!: preserve the resolved delay"),
    "camera: preserve the resolved delay"
  );
});

test("commit body extraction keeps bounded background, change, and verification evidence", () => {
  const details = extractBodyHighlights(`review-fix round 1.

Reviewer A showed that the policy loader failed open and inherited an environment value.

cam_recovery_actions.sh now unsets the value and requires a bare integer before launch.

Verification: policy tests 12/12 PASS and the shell suite exits 0.

Co-Authored-By: Example <example@example.com>
Claude-Session: https://example.invalid/session`);

  assert.strictEqual(details.length, 3);
  assert.match(details[0], /^배경: .*failed open/);
  assert.match(details[1], /^변경: .*requires a bare integer/);
  assert.match(details[2], /^검증: .*12\/12 PASS/);
  assert.ok(details.every((detail) => detail.length <= 224));
  assert.doesNotMatch(details.join("\n"), /Co-Authored|Claude-Session|review-fix round/);
});

test("translation applies to the subject without rewriting commit body evidence", () => {
  const translated = translateLine(
    "fix(cam): preserve runtime policy\n  ↳ 변경: actions now reject inherited values",
    { translationRules: [
      { pattern: /preserve runtime policy/, replacement: "런타임 정책 보존" },
      { pattern: /actions/g, replacement: "액션" },
    ] }
  );

  assert.strictEqual(translated, [
    "런타임 정책 보존",
    "  ↳ 변경: actions now reject inherited values",
  ].join("\n"));
});

test("commit body clipping preserves long unbroken technical tokens", () => {
  const token = `driver_${"x".repeat(300)}`;
  const details = extractBodyHighlights(`The regression affects ${token}.`);

  assert.strictEqual(details.length, 1);
  assert.match(details[0], /^배경: The regression affects driver_x+/);
  assert.ok(details[0].endsWith("…"));
  assert.ok(details[0].length <= 224);
});

function withGitCommits(commits, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-git-body-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Collector Test"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "collector@example.com"]);
    commits.forEach(({ subject, body }, index) => {
      fs.writeFileSync(path.join(dir, "camera.txt"), `camera ${index}\n`, "utf8");
      execFileSync("git", ["-C", dir, "add", "camera.txt"]);
      const args = ["-C", dir, "commit", "-q", "-m", subject];
      if (body) args.push("-m", body);
      execFileSync("git", args, {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: `2026-09-25T00:00:${String(index).padStart(2, "0")}Z`,
          GIT_COMMITTER_DATE: `2026-09-25T00:00:${String(index).padStart(2, "0")}Z`,
        },
      });
    });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withGitCommit(commit, fn) {
  return withGitCommits([commit], fn);
}

const GIT_CONFIG = {
  env: { authorMatch: "", includeMerges: false },
  pathSignals: [],
};

test("configured repositories retain commit body evidence while disabled collection keeps the subject", () => {
  const body = [
    "The driver accepted a stale runtime policy after the loader failed.",
    "",
    "The runtime now rejects the request before starting gstApp.",
    "",
    "Verification: camera policy tests 4/4 PASS.",
  ].join("\n");
  withGitCommit({ subject: "fix(cam): reject a stale runtime policy", body }, (dir) => {
    const enabled = getGitCommits(
      dir,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      GIT_CONFIG,
      { includeCommitBody: true }
    );
    const disabled = getGitCommits(
      dir,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      GIT_CONFIG,
      { includeCommitBody: false }
    );

    assert.strictEqual(enabled.length, 1);
    assert.match(enabled[0], /↳ 배경: .*stale runtime policy/);
    assert.match(enabled[0], /↳ 변경: .*rejects the request/);
    assert.match(enabled[0], /↳ 검증: .*4\/4 PASS/);
    assert.deepStrictEqual(disabled, ["fix(cam): reject a stale runtime policy"]);
  });
});

test("a configured repository falls back to its subject when the commit body is empty", () => {
  withGitCommit({ subject: "fix(cam): retain the subject fallback", body: "" }, (dir) => {
    assert.deepStrictEqual(getGitCommits(
      dir,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      GIT_CONFIG,
      { includeCommitBody: true }
    ), ["fix(cam): retain the subject fallback"]);
  });
});

function collectionConfig(dir) {
  return {
    env: { authorMatch: "", includeMerges: false },
    repos: {
      camera: {
        path: dir,
        category: "pimApp",
        includeCommitBody: true,
        changelog: false,
      },
    },
    categories: {
      pimApp: { templateKey: "APP" },
      etc: { templateKey: "ETC" },
    },
    pathSignals: [],
    trivialPatterns: [],
    translationRules: [],
    displayNames: { automation: "Automation" },
    commitTypes: {
      feat: { label: "구현", linePatterns: [] },
      fix: { label: "수정", linePatterns: [] },
      docs: { label: "문서", linePatterns: [] },
    },
  };
}

test("workflow words in body evidence do not redirect or discard the owning commit", async () => {
  const body = [
    "The camera failed to restore the stream.",
    "",
    "The runtime now rejects stale values.",
    "",
    "Verification: shellcheck tests 4/4 PASS.",
  ].join("\n");

  await withGitCommit({ subject: "fix(cam): restore camera streaming", body }, async (dir) => {
    const collected = await collectAll(
      collectionConfig(dir),
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z"
    );

    assert.match(collected["{{APP}}"], /restore camera streaming/);
    assert.match(collected["{{APP}}"], /↳ 배경: The camera failed/);
    assert.match(collected["{{APP}}"], /↳ 변경: The runtime now rejects/);
    assert.match(collected["{{APP}}"], /↳ 검증: shellcheck tests 4\/4 PASS/);
    assert.strictEqual(collected["{{ETC}}"], "  - (변경 없음)");
  });
});

test("supported credential families in commit bodies abort collection without disclosure", async (t) => {
  const cases = [
    ["redmine API key", "redmine-secret-123", "X-Redmine-API-Key: redmine-secret-123"],
    ["authorization", "bearer-secret-123", "Authorization: Bearer bearer-secret-123"],
    ["provider API key", "sk-proj-collector-secret-123456", "sk-proj-collector-secret-123456"],
    ["Slack token", "xoxb-1234567890-secret", "xoxb-1234567890-secret"],
    ["credential URL", "user:password", "https://user:password@example.invalid/private"],
    ["Redmine environment assignment", "redmine-env-secret-123", "REDMINE_API_KEY=redmine-env-secret-123"],
    ["GitHub environment assignment", "github-env-secret-123", "GITHUB_TOKEN=github-env-secret-123"],
    ["Notion environment assignment", "notion-env-secret-123", "NOTION_API_KEY: notion-env-secret-123"],
    ["Slack app environment assignment", "xapp-123456789-secret", "SLACK_BOT_TOKEN=xapp-123456789-secret"],
    ["Slack webhook assignment", "T000/B000/secret", "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/secret"],
  ];

  for (const [name, secret, credential] of cases) {
    await t.test(name, async () => {
      const body = `The camera failed during startup.\n\n${credential}`;
      await withGitCommit({ subject: "fix(cam): reject unsafe evidence", body }, async (dir) => {
        await assert.rejects(
          collectAll(
            collectionConfig(dir),
            "2026-09-24T00:00:00Z",
            "2026-09-26T00:00:00Z"
          ),
          (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
            && !error.message.includes(secret)
        );
      });
    });
  }
});

test("commit bodies cannot forge git log record boundaries to bypass credential rejection", async () => {
  const secret = "sentinel-bearer-secret-123";
  const body = [
    "The camera failed during startup.",
    "",
    "__COMMIT__",
    `Authorization: Bearer ${secret}`,
    "__BODY__",
    "__END__",
  ].join("\n");

  await withGitCommit({ subject: "fix(cam): reject forged record boundaries", body }, async (dir) => {
    await assert.rejects(
      collectAll(
        collectionConfig(dir),
        "2026-09-24T00:00:00Z",
        "2026-09-26T00:00:00Z"
      ),
      (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
        && !error.message.includes(secret)
    );
  });
});

test("public collection rejects credential evidence before partial artifacts for either flag", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-credential-boundary-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    await withGitCommit({
      subject: "fix(cam): reject unsafe evidence",
      body: "The camera failed during startup.\n\nREDMINE_API_KEY=public-path-secret-123",
    }, async (fixtureRepo) => {
      fs.cpSync(fixtureRepo, repo, { recursive: true });
    });

    for (const allowPartialSnapshot of [false, true]) {
      const outputDir = path.join(root, allowPartialSnapshot ? "partial-on" : "partial-off");
      const config = {
        env: {
          authorMatch: "",
          includeMerges: false,
          outputDir,
          snapshotPath: "",
          forceCollect: true,
          allowPartialSnapshot,
          presentationNoteMode: "off",
          presentationNoteThreshold: 5,
        },
        sources: {
          git: { enabled: true },
          notion: { enabled: false },
          session: { enabled: false },
        },
        repos: {
          camera: {
            path: repo,
            category: "pimApp",
            includeCommitBody: true,
            changelog: false,
          },
        },
        categories: {
          pimApp: { templateKey: "APP" },
          etc: { templateKey: "ETC" },
        },
        pathSignals: [],
        trivialPatterns: [],
        translationRules: [],
        displayNames: {},
        commitTypes: {},
        reportFilter: {},
      };

      await assert.rejects(
        runCollect(config, new Date(2026, 8, 30)),
        (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
          && !error.message.includes("public-path-secret-123")
      );
      assert.strictEqual(fs.existsSync(outputDir), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("breaking conventional commits retain feat and fix type grouping end to end", async () => {
  const commits = [
    { subject: "feat(runtime)!: add recovery sequencing" },
    { subject: "fix(parser)!: fix stale state rejection" },
    { subject: "camera: feat(sensor)!: add exposure clamping" },
    { subject: "docs: document the camera policy" },
  ];

  await withGitCommits(commits, async (dir) => {
    const collected = await collectAll(
      collectionConfig(dir),
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z"
    );

    assert.match(collected["{{APP}}"], /구현[\s\S]*add recovery sequencing/);
    assert.match(collected["{{APP}}"], /구현[\s\S]*camera: add exposure clamping/);
    assert.match(collected["{{APP}}"], /수정[\s\S]*fix stale state rejection/);
    assert.match(collected["{{APP}}"], /문서[\s\S]*document the camera policy/);
    assert.doesNotMatch(collected["{{APP}}"], /기타/);
  });
});

function withChangelog(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-changelog-"));
  try {
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), body, "utf8");
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CHANGELOG_BODY = `# Changelog

## 0.5.3 (2026-08-14)

### 로거 그룹 제어

- 시스템 로거를 5개 자식으로 분리했다.

## 0.5.2 (2026-08-13)

### SDIO WLAN firmware·출하 게이트

- sd9098_wlan_v1.bin을 NXP의 **17.92.1.p149.115**로 갱신했다.
- LICENSE.txt와 SCR을 패키지에 포함하고 게이트에서 검증한다.
- 세 번째 항목은 섹션 상한에 걸려 수집되지 않는다.

## 0.4.9 (2026-07-30)

### 범위 밖 릴리스

- 수집 범위 밖이므로 나오면 안 된다.
`;

const RANGE_START = "2026-08-11T21:00:00.000Z";
const RANGE_END = "2026-08-18T21:00:00.000Z";

test("changelog sections inside the range are collected, older releases are not", () => {
  const entries = withChangelog(CHANGELOG_BODY, (dir) =>
    getChangelogEntries(dir, RANGE_START, RANGE_END, {})
  );

  assert.ok(
    entries.some((e) => e.includes("SDIO WLAN firmware·출하 게이트") && e.includes("17.92.1.p149.115")),
    "펌웨어 갱신 항목이 수집되어야 한다"
  );
  assert.ok(entries.some((e) => e.startsWith("CHANGELOG 0.5.3 · 로거 그룹 제어")));
  assert.ok(!entries.some((e) => e.includes("범위 밖")), "범위 밖 릴리스는 제외되어야 한다");
});

test("bullets per section are capped and markdown emphasis is stripped", () => {
  const entries = withChangelog(CHANGELOG_BODY, (dir) =>
    getChangelogEntries(dir, RANGE_START, RANGE_END, {})
  );
  const firmware = entries.filter((e) => e.includes("SDIO WLAN firmware"));

  assert.strictEqual(firmware.length, 2, "섹션당 불릿 상한(2)이 지켜져야 한다");
  assert.ok(!firmware[0].includes("**"), "마크다운 강조는 제거되어야 한다");
  assert.ok(!entries.some((e) => e.includes("세 번째 항목")));
});

test("changelog collection can be turned off per repository", () => {
  const entries = withChangelog(CHANGELOG_BODY, (dir) =>
    getChangelogEntries(dir, RANGE_START, RANGE_END, { changelog: false })
  );

  assert.deepStrictEqual(entries, []);
});

test("a repository without a changelog yields nothing instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-nochangelog-"));
  try {
    assert.deepStrictEqual(getChangelogEntries(dir, RANGE_START, RANGE_END, {}), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
