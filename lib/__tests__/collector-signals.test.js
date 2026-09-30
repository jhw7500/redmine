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
const { buildCandidatesPath, sealSnapshot, writeJsonAtomic } = require("../report-artifact");

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

test("standalone commit body section labels retain neutral evidence without blank details", () => {
  const details = extractBodyHighlights(`Background:

Latency doubled in production.

Changes:

Raised the ring capacity.

Verification:

Observed stable output after restart.`);

  assert.deepStrictEqual(details, [
    "배경: Latency doubled in production.",
    "변경: Raised the ring capacity.",
    "검증: Observed stable output after restart.",
  ]);
  assert.ok(details.every((detail) => !detail.endsWith(": ")));
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
  const githubTokens = {
    classic: `ghp_${"A".repeat(36)}`,
    fineGrained: `github_pat_${"B".repeat(64)}`,
    oauth: `gho_${"C".repeat(36)}`,
    appUser: `ghu_${"D".repeat(36)}`,
    appInstallation: `ghs_APPID_JWT.${"E-F_".repeat(9)}`,
    appRefresh: `ghr_${"F".repeat(36)}`,
  };
  const nestedCredential = (secret, layers) => {
    let serialized = JSON.stringify({ GITHUB_TOKEN: secret });
    for (let index = 0; index < layers; index += 1) serialized = JSON.stringify(serialized);
    return serialized;
  };
  const slackTokens = {
    workflow: `xwfp-${"W".repeat(40)}`,
    rotatingBotAccess: `xoxe.xoxb-${"R".repeat(40)}`,
    rotatingUserAccess: `xoxe.xoxp-${"U".repeat(40)}`,
    refresh: `xoxe-1-${"E".repeat(40)}`,
    session: `xoxc-${"C".repeat(40)}`,
    defensiveCookie: `xoxd-${"D".repeat(40)}`,
  };
  const cases = [
    ["redmine API key", "redmine-secret-123", "X-Redmine-API-Key: redmine-secret-123"],
    ["italic Redmine API header", "redmine-italic-secret-123", "_X-Redmine-API-Key_: redmine-italic-secret-123"],
    ["bold Redmine API header", "redmine-bold-secret-123", "__X-Redmine-API-Key__: redmine-bold-secret-123"],
    ["authorization", "bearer-secret-123", "Authorization: Bearer bearer-secret-123"],
    ["authorization assignment", "assigned-bearer-secret-123", "Authorization=Bearer assigned-bearer-secret-123"],
    ["Markdown authorization assignment", "markdown-bearer-secret-123", "**Authorization**=Bearer markdown-bearer-secret-123"],
    ["Markdown authorization value", "emphasis-bearer-secret-123", "Authorization: _Bearer emphasis-bearer-secret-123_"],
    ["provider API key", "sk-proj-collector-secret-123456", "sk-proj-collector-secret-123456"],
    ["Slack token", "xoxb-1234567890-secret", "xoxb-1234567890-secret"],
    ["Slack workflow token", slackTokens.workflow, slackTokens.workflow],
    ["Slack rotating bot access token", slackTokens.rotatingBotAccess, slackTokens.rotatingBotAccess],
    ["Slack rotating user access token", slackTokens.rotatingUserAccess, slackTokens.rotatingUserAccess],
    ["Slack refresh token", slackTokens.refresh, slackTokens.refresh],
    ["Slack session token", slackTokens.session, slackTokens.session],
    ["Slack defensive xoxd token", slackTokens.defensiveCookie, slackTokens.defensiveCookie],
    ["serialized Slack refresh token", slackTokens.refresh, JSON.stringify({ refresh_token: slackTokens.refresh })],
    ["Markdown-escaped Slack refresh token", slackTokens.refresh, slackTokens.refresh.replace("-", "\\-")],
    ["Markdown-escaped Slack rotating access token", slackTokens.rotatingBotAccess, slackTokens.rotatingBotAccess.replace(".", "\\.")],
    ["Markdown-escaped GitHub token", githubTokens.classic, githubTokens.classic.replace("_", "\\_")],
    ["underscore-emphasized GitHub token", githubTokens.classic, `_${githubTokens.classic}_`],
    ["underscore-emphasized Slack token", "xoxb-1234567890-secret", "_xoxb-1234567890-secret_"],
    ["GitHub classic PAT", githubTokens.classic, githubTokens.classic],
    ["GitHub fine-grained PAT", githubTokens.fineGrained, githubTokens.fineGrained],
    ["GitHub OAuth token", githubTokens.oauth, githubTokens.oauth],
    ["GitHub App user token", githubTokens.appUser, githubTokens.appUser],
    ["GitHub App installation token", githubTokens.appInstallation, githubTokens.appInstallation],
    ["GitHub App refresh token", githubTokens.appRefresh, githubTokens.appRefresh],
    ["credential URL", "user:password", "https://user:password@example.invalid/private"],
    ["escaped Slack webhook", "T100/B100/escaped-secret", String.raw`https:\/\/hooks.slack.com\/services\/T100\/B100\/escaped-secret`],
    ["nested escaped Slack webhook", "T200/B200/nested-secret", JSON.stringify(String.raw`https:\/\/hooks.slack.com\/services\/T200\/B200\/nested-secret`)],
    ["escaped credential URL", "user:escaped-password", String.raw`https:\/\/user:escaped-password@example.invalid\/private`],
    ["nested escaped credential URL", "user:nested-password", JSON.stringify(String.raw`https:\/\/user:nested-password@example.invalid\/private`)],
    ["Redmine environment assignment", "redmine-env-secret-123", "REDMINE_API_KEY=redmine-env-secret-123"],
    ["GitHub environment assignment", "github-env-secret-123", "GITHUB_TOKEN=github-env-secret-123"],
    ["GitHub append assignment", "github-append-secret-123", "GITHUB_TOKEN+=github-append-secret-123"],
    ["Notion environment assignment", "notion-env-secret-123", "NOTION_API_KEY: notion-env-secret-123"],
    ["Slack app environment assignment", "xapp-123456789-secret", "SLACK_BOT_TOKEN=xapp-123456789-secret"],
    ["Slack webhook assignment", "T000/B000/secret", "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/secret"],
    ["JSON quoted key", "json-secret-123", '{"REDMINE_API_KEY":"json-secret-123"}'],
    ["YAML quoted key", "yaml-secret-123", '"GITHUB_TOKEN": yaml-secret-123'],
    ["Markdown bold key", "bold-secret-123", "**GITHUB_TOKEN**=bold-secret-123"],
    ["Markdown italic key", "italic-secret-123", "*NOTION_API_KEY*=italic-secret-123"],
    ["Markdown inline-code key", "code-secret-123", "`REDMINE_API_KEY`=code-secret-123"],
    ["Markdown inside key", "inside-secret-123", "GITHUB_**TOKEN**=inside-secret-123"],
    ["HTML comment inside key", "html-comment-secret-123", "GITHUB_<!--hidden-->TOKEN=html-comment-secret-123"],
    ["HTML tag inside key", "html-tag-secret-123", "GITHUB_<span>TOKEN</span>=html-tag-secret-123"],
    ["HTML numeric entity inside key", "html-entity-secret-123", "GITHUB&#95;TOKEN=html-entity-secret-123"],
    ["HTML hex entity inside key", "html-hex-entity-secret-123", "GITHUB&#x5f;TOKEN=html-hex-entity-secret-123"],
    ["semicolon-less HTML entity inside key", "html-entity-no-semicolon-secret-123", "GITHUB&#95TOKEN=html-entity-no-semicolon-secret-123"],
    ["HTML UnderBar entity inside key", "html-underbar-secret-123", "GITHUB&UnderBar;TOKEN=html-underbar-secret-123"],
    ["long decimal HTML entity assignment", "html-long-decimal-secret-123", "GITHUB_TOKEN&#0000000061;html-long-decimal-secret-123"],
    ["long hex HTML entity assignment", "html-long-hex-secret-123", "GITHUB_TOKEN&#x000000003d;html-long-hex-secret-123"],
    ["JSON Unicode-escaped key", "unicode-secret-123", '{"GITHUB\\u005fTOKEN":"unicode-secret-123"}'],
    ["backslash-escaped JSON", "backslash-secret-123", '{\\"GITHUB_TOKEN\\":\\"backslash-secret-123\\"}'],
    ["serialized JSON whitespace", "whitespace-secret-123", '{\\"GITHUB_TOKEN\\"\\n:\\n\\"whitespace-secret-123\\"}'],
    ["triply serialized JSON", "nested-secret-123", nestedCredential("nested-secret-123", 3)],
    ["normalization limit", "bounded-secret-123", nestedCredential("bounded-secret-123", 10)],
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
    const githubTokens = {
      classic: `ghp_${"G".repeat(36)}`,
      fineGrained: `github_pat_${"H".repeat(64)}`,
      oauth: `gho_${"I".repeat(36)}`,
      appUser: `ghu_${"J".repeat(36)}`,
      appInstallation: `ghs_APPID_JWT.${"K-L_".repeat(9)}`,
      appRefresh: `ghr_${"M".repeat(36)}`,
    };
    const slackTokens = {
      rotatingBotAccess: `xoxe.xoxb-${"N".repeat(40)}`,
      refresh: `xoxe-1-${"O".repeat(40)}`,
      session: `xoxc-${"P".repeat(40)}`,
      defensiveCookie: `xoxd-${"Q".repeat(40)}`,
    };
    let nestedCredential = JSON.stringify({ GITHUB_TOKEN: "public-nested-secret-123" });
    for (let index = 0; index < 3; index += 1) {
      nestedCredential = JSON.stringify(nestedCredential);
    }
    const cases = [
      ["json", "public-json-secret-123", '{"REDMINE_API_KEY":"public-json-secret-123"}'],
      ["italic-redmine-header", "public-redmine-italic-secret-123", "_X-Redmine-API-Key_: public-redmine-italic-secret-123"],
      ["bold-redmine-header", "public-redmine-bold-secret-123", "__X-Redmine-API-Key__: public-redmine-bold-secret-123"],
      ["yaml", "public-yaml-secret-123", '"GITHUB_TOKEN": public-yaml-secret-123'],
      ["bold", "public-bold-secret-123", "**GITHUB_TOKEN**=public-bold-secret-123"],
      ["italic", "public-italic-secret-123", "*NOTION_API_KEY*=public-italic-secret-123"],
      ["inline-code", "public-code-secret-123", "`REDMINE_API_KEY`=public-code-secret-123"],
      ["inside-key", "public-inside-secret-123", "GITHUB_**TOKEN**=public-inside-secret-123"],
      ["html-comment-inside-key", "public-html-comment-secret-123", "GITHUB_<!--hidden-->TOKEN=public-html-comment-secret-123"],
      ["html-tag-inside-key", "public-html-tag-secret-123", "GITHUB_<span>TOKEN</span>=public-html-tag-secret-123"],
      ["html-entity-inside-key", "public-html-entity-secret-123", "GITHUB&#95;TOKEN=public-html-entity-secret-123"],
      ["html-hex-entity-inside-key", "public-html-hex-entity-secret-123", "GITHUB&#x5f;TOKEN=public-html-hex-entity-secret-123"],
      ["html-entity-no-semicolon-inside-key", "public-html-entity-no-semicolon-secret-123", "GITHUB&#95TOKEN=public-html-entity-no-semicolon-secret-123"],
      ["html-underbar-inside-key", "public-html-underbar-secret-123", "GITHUB&UnderBar;TOKEN=public-html-underbar-secret-123"],
      ["html-long-decimal-assignment", "public-html-long-decimal-secret-123", "GITHUB_TOKEN&#0000000061;public-html-long-decimal-secret-123"],
      ["html-long-hex-assignment", "public-html-long-hex-secret-123", "GITHUB_TOKEN&#x000000003d;public-html-long-hex-secret-123"],
      ["authorization-assignment", "public-auth-secret-123", "**Authorization**=Bearer public-auth-secret-123"],
      ["authorization-value-emphasis", "public-emphasis-secret-123", "Authorization: _Bearer public-emphasis-secret-123_"],
      ["json-unicode", "public-unicode-secret-123", '{"GITHUB\\u005fTOKEN":"public-unicode-secret-123"}'],
      ["json-backslash", "public-backslash-secret-123", '{\\"GITHUB_TOKEN\\":\\"public-backslash-secret-123\\"}'],
      ["append-assignment", "public-append-secret-123", "GITHUB_TOKEN+=public-append-secret-123"],
      ["json-whitespace", "public-whitespace-secret-123", '{\\"GITHUB_TOKEN\\"\\n:\\n\\"public-whitespace-secret-123\\"}'],
      ["json-nested", "public-nested-secret-123", nestedCredential],
      ["github-classic-pat", githubTokens.classic, githubTokens.classic],
      ["github-fine-grained-pat", githubTokens.fineGrained, githubTokens.fineGrained],
      ["github-oauth-token", githubTokens.oauth, githubTokens.oauth],
      ["github-app-user-token", githubTokens.appUser, githubTokens.appUser],
      ["github-app-installation-token", githubTokens.appInstallation, githubTokens.appInstallation],
      ["github-app-refresh-token", githubTokens.appRefresh, githubTokens.appRefresh],
      ["slack-rotating-access-token", slackTokens.rotatingBotAccess, slackTokens.rotatingBotAccess],
      ["slack-refresh-token", slackTokens.refresh, slackTokens.refresh],
      ["slack-session-token", slackTokens.session, slackTokens.session],
      ["slack-defensive-xoxd-token", slackTokens.defensiveCookie, slackTokens.defensiveCookie],
      ["serialized-slack-refresh-token", slackTokens.refresh, JSON.stringify({ refresh_token: slackTokens.refresh })],
      ["markdown-escaped-slack-refresh-token", slackTokens.refresh, slackTokens.refresh.replace("-", "\\-")],
      ["markdown-escaped-slack-rotating-token", slackTokens.rotatingBotAccess, slackTokens.rotatingBotAccess.replace(".", "\\.")],
      ["markdown-escaped-github-token", githubTokens.classic, githubTokens.classic.replace("_", "\\_")],
      ["underscore-emphasized-github-token", githubTokens.classic, `_${githubTokens.classic}_`],
      ["underscore-emphasized-slack-token", "xoxb-1234567890-public-secret", "_xoxb-1234567890-public-secret_"],
      ["escaped-webhook", "T300/B300/public-secret", String.raw`https:\/\/hooks.slack.com\/services\/T300\/B300\/public-secret`],
      ["nested-escaped-webhook", "T400/B400/public-nested-secret", JSON.stringify(String.raw`https:\/\/hooks.slack.com\/services\/T400\/B400\/public-nested-secret`)],
      ["escaped-credential-url", "user:public-password", String.raw`https:\/\/user:public-password@example.invalid\/private`],
      ["nested-escaped-credential-url", "user:public-nested-password", JSON.stringify(String.raw`https:\/\/user:public-nested-password@example.invalid\/private`)],
    ];

    for (const [name, secret, credential] of cases) {
      const repo = path.join(root, `repo-${name}`);
      fs.mkdirSync(repo);
      await withGitCommit({
        subject: "fix(cam): reject unsafe evidence",
        body: `The camera failed during startup.\n\n변경: ${credential} 값을 사용하도록 수정`,
      }, async (fixtureRepo) => {
        fs.cpSync(fixtureRepo, repo, { recursive: true });
      });

      for (const allowPartialSnapshot of [false, true]) {
        const outputDir = path.join(
          root,
          `${name}-${allowPartialSnapshot ? "partial-on" : "partial-off"}`
        );
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
            && !error.message.includes(secret)
        );
        assert.strictEqual(fs.existsSync(outputDir), false);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public collection replaces an unbound legacy Git snapshot without copying credential evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-legacy-public-boundary-"));
  const secret = "legacy-public-secret-123";
  try {
    const outputDir = path.join(root, "out");
    const templatePath = path.join(root, "template.md");
    const snapshotPath = path.join(outputDir, "report-2026-09-30.snapshot.json");
    fs.mkdirSync(outputDir);
    fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");
    writeJsonAtomic(snapshotPath, sealSnapshot({
      collectedAt: "2026-09-30T06:00:00.000Z",
      meetingDate: "2026-09-30",
      status: "sealed",
      failures: [],
      warnings: [],
      sources: {
        git: {
          status: "success",
          count: 1,
          data: { "{{APP}}": `    - 변경: GITHUB_TOKEN=${secret}` },
        },
      },
      autoContent: { "{{APP}}": `    - 변경: GITHUB_TOKEN=${secret}` },
      rawContent: `#### Probe\n    - 변경: GITHUB_TOKEN=${secret}\n`,
      presentationCandidates: [],
    }));

    await withGitCommit({
      subject: "fix(cam): preserve safe frames",
      body: "The camera failed during startup.\n\n변경: validate frame ownership",
    }, async (repo) => {
      const config = {
        env: {
          authorMatch: "",
          includeMerges: false,
          outputDir,
          snapshotPath,
          templatePath,
          forceCollect: false,
          allowPartialSnapshot: false,
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

      const result = await runCollect(config, new Date(2026, 8, 30));
      const candidatesPath = buildCandidatesPath(new Date(2026, 8, 30), config);
      assert.strictEqual(result.reused, false);
      assert.strictEqual(result.snapshot.securityContracts.commitBodyCredentialScan, 11);
      assert.strictEqual(fs.readFileSync(snapshotPath, "utf8").includes(secret), false);
      assert.strictEqual(fs.readFileSync(candidatesPath, "utf8").includes(secret), false);
      assert.deepStrictEqual(
        fs.readdirSync(outputDir).filter(name => /\.[0-9a-f]{12}\.snapshot\.json$/.test(name)),
        []
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("git log failures are propagated with sanitized diagnostics", () => {
  const config = { env: { authorMatch: "", includeMerges: false }, pathSignals: [] };
  const missing = path.join(os.tmpdir(), "definitely-missing-redmine-repository");
  assert.throws(
    () => getGitCommits(missing, "2026-09-01", "2026-10-01", config, {}),
    error => error.code === "GIT_LOG_FAILED" && !error.message.includes(missing)
  );

  const diagnosticSecret = "spawn-diagnostic-secret-123";
  assert.throws(
    () => getGitCommits(".", "2026-09-01", "2026-10-01", config, {}, {
      spawnSync: () => ({
        status: null,
        signal: "SIGTERM",
        error: Object.assign(new Error(diagnosticSecret), { code: "ENOBUFS" }),
        stderr: diagnosticSecret,
      }),
    }),
    error => error.code === "GIT_LOG_FAILED"
      && /spawn ENOBUFS/.test(error.message)
      && !error.message.includes(diagnosticSecret)
  );
  assert.throws(
    () => getGitCommits(".", "2026-09-01", "2026-10-01", config, {}, {
      spawnSync: () => { throw new Error(diagnosticSecret); },
    }),
    error => error.code === "GIT_LOG_FAILED"
      && /spawn exception/.test(error.message)
      && !error.message.includes(diagnosticSecret)
  );
});

test("public collection records a Git command failure as partial instead of sealed success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-git-command-failure-"));
  try {
    const outputDir = path.join(root, "out");
    const templatePath = path.join(root, "template.md");
    fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");
    const missingRepo = path.join(root, "missing-repository");
    const result = await runCollect({
      env: {
        authorMatch: "",
        includeMerges: false,
        outputDir,
        snapshotPath: "",
        templatePath,
        forceCollect: true,
        allowPartialSnapshot: true,
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
          path: missingRepo,
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
    }, new Date(2026, 8, 30));

    assert.strictEqual(result.snapshot.status, "partial");
    assert.strictEqual(result.snapshot.sources.git.status, "failed");
    assert.match(result.snapshot.sources.git.error, /Git log collection failed \(exit 128\)/);
    assert.strictEqual(result.snapshot.sources.git.error.includes(missingRepo), false);
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
