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
  getGitCommitRecords,
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
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Collector Test"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "collector@example.com"]);
    commits.forEach(({ subject, body, file = "camera.txt" }, index) => {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `camera ${index}\n`, "utf8");
      execFileSync("git", ["-C", dir, "add", file]);
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
    const result = fn(dir);
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
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

test("Markdown and HTML commit bodies keep only the subject", () => {
  const bodies = [
    "Background: [GitHub docs] describe [token rotation] without credential values.",
    "Background: [GitHub's docs] describe [token's rotation] without credential values.",
    "Background: <strong>document token rotation</strong>.",
  ];
  for (const body of bodies) {
    withGitCommit({ subject: "docs: explain token rotation", body }, (dir) => {
      assert.deepStrictEqual(getGitCommits(
        dir,
        "2026-09-24T00:00:00Z",
        "2026-09-26T00:00:00Z",
        GIT_CONFIG,
        { includeCommitBody: true }
      ), ["docs: explain token rotation"]);
    });
  }
});

test("Unicode identifiers retain commit body evidence", () => {
  const body = "변경: 카메라_복구_경로를 수정했다.";
  withGitCommit({ subject: "fix(cam): preserve identifier details", body }, (dir) => {
    const commits = getGitCommits(
      dir,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      GIT_CONFIG,
      { includeCommitBody: true }
    );
    assert.strictEqual(commits.length, 1);
    assert.match(commits[0], /카메라_복구_경로/);
  });
});

test("escaped underscore delimiter candidates keep only the subject", () => {
  const body = "변경: \\_literal\\_ 경로 설명을 수정했다.";
  withGitCommit({ subject: "docs: explain literal underscores", body }, (dir) => {
    assert.deepStrictEqual(getGitCommits(
      dir,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      GIT_CONFIG,
      { includeCommitBody: true }
    ), ["docs: explain literal underscores"]);
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

test("merged PR evidence replaces its covered commit and keeps purpose, change, and validation", async () => {
  const commitBody = `### Contract version
v1

### Why
재시작 후 오래된 스트림 값이 남았다.

### Changes
- 오래된 값을 거부한다.

### Validation
- node --test: 8/8 PASS

### References
#42`;
  const prBody = `### Contract version
v1

### Summary
카메라 스트림 복구 경로를 안정화했다.

### Changes
- 오래된 런타임 값을 거부하고 기본 상태를 다시 계산한다.

### Validation
- node --test: 12/12 PASS

### Impact and risks
기존 설정 파일 형식은 유지한다.

### Related issue
Closes #42`;
  const issueBody = `### Contract version
v1

### Context and problem
카메라 재시작 후 이전 스트림 값이 남아 복구가 실패했다.

### Goal
재시작 후 유효한 스트림 상태만 복원한다.

### Non-goals
Not applicable: 장치 펌웨어는 변경하지 않는다.

### Acceptance criteria
- [x] 오래된 상태가 거부된다.

### Constraints and impact
기존 설정 파일과 호환되어야 한다.`;

  await withGitCommit({ subject: "fix(camera): restore a valid stream state", body: commitBody },
    async (dir) => {
      const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const config = collectionConfig(dir);
      config.env.githubToken = "test-token";
      config.env.githubOwner = "acme";
      const context = {};
      const fetch = async (url) => {
        if (url.includes("/pulls?")) return mockGithubResponse([{
          number: 7,
          title: "fix(camera): restore a valid stream state",
          body: prBody,
          html_url: "https://github.com/acme/camera/pull/7",
          merged_at: "2026-09-25T03:00:00Z",
          merge_commit_sha: sha,
        }]);
        if (url.includes("/pulls/7/commits")) return mockGithubResponse([{ sha }]);
        if (url.endsWith("/issues/42")) return mockGithubResponse({
          number: 42,
          title: "재시작 상태 복구",
          body: issueBody,
          html_url: "https://github.com/acme/camera/issues/42",
        });
        throw new Error(`unexpected request: ${url}`);
      };

      const collected = await collectAll(
        config,
        "2026-09-24T00:00:00Z",
        "2026-09-26T00:00:00Z",
        { fetch, collectionContext: context }
      );

      assert.match(collected["{{APP}}"], /restore a valid stream state/);
      assert.match(collected["{{APP}}"], /↳ 목적: 카메라 스트림 복구 경로를 안정화했다/);
      assert.doesNotMatch(collected["{{APP}}"], /↳ 목적: 재시작 후 유효한 스트림 상태만 복원한다/);
      assert.match(collected["{{APP}}"], /↳ 변경: 오래된 런타임 값을 거부/);
      assert.match(collected["{{APP}}"], /↳ 검증: node --test: 12\/12 PASS/);
      assert.doesNotMatch(collected["{{APP}}"], /8\/8 PASS/);
      assert.strictEqual(context.changeEvidence.status, "success");
      assert.strictEqual(context.changeEvidence.records.length, 1);
      assert.deepStrictEqual(context.changeEvidence.records[0].usedEvidence,
        ["pull_request"]);
      assert.strictEqual(context.changeEvidence.records[0].pullRequest.rawBody, prBody);
    });
});

test("GitHub degradation deterministically falls back to structured commit evidence", async () => {
  const body = `### Contract version
v1

### Why
카메라 초기화가 오래된 상태를 복원했다.

### Changes
- 유효하지 않은 상태를 거부한다.

### Validation
- node --test: 8/8 PASS

### References
#42`;
  await withGitCommit({ subject: "fix(camera): reject stale recovery state", body }, async (dir) => {
    const config = collectionConfig(dir);
    config.repos.camera.includeCommitBody = false;
    config.env.githubToken = "test-token";
    config.env.githubOwner = "acme";
    const context = {};
    const collected = await collectAll(
      config,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      {
        fetch: async () => mockGithubResponse({ message: "rate limited" }, 403),
        collectionContext: context,
      }
    );

    assert.match(collected["{{APP}}"], /reject stale recovery state/);
    assert.match(collected["{{APP}}"], /↳ 목적: 카메라 초기화가 오래된 상태를 복원했다/);
    assert.match(collected["{{APP}}"], /↳ 변경: 유효하지 않은 상태를 거부한다/);
    assert.match(collected["{{APP}}"], /↳ 검증: node --test: 8\/8 PASS/);
    assert.strictEqual(context.changeEvidence.status, "degraded");
    assert.deepStrictEqual(context.changeEvidence.records[0].usedEvidence, ["structured_commit"]);
  });
});

test("AUTHOR_MATCH keeps only PRs connected to author-filtered local commits", async () => {
  await withGitCommit({ subject: "fix(camera): preserve filtered evidence" }, async (dir) => {
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const fetch = async (url) => {
      if (url.includes("/pulls?")) return mockGithubResponse([{
        number: 17,
        title: "fix(camera): replace the filtered commit with its PR",
        body: "Legacy PR prose.",
        merged_at: "2026-09-25T03:00:00Z",
        merge_commit_sha: sha,
      }]);
      if (url.includes("/pulls/17/commits")) return mockGithubResponse([{ sha }]);
      throw new Error(`unexpected request: ${url}`);
    };

    const matchedConfig = collectionConfig(dir);
    matchedConfig.env.authorMatch = "Collector Test";
    matchedConfig.env.githubToken = "test-token";
    matchedConfig.env.githubOwner = "acme";
    const matchedContext = {};
    const matched = await collectAll(
      matchedConfig,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      { fetch, collectionContext: matchedContext }
    );
    assert.match(matched["{{APP}}"], /replace the filtered commit with its PR/);
    assert.strictEqual(matchedContext.changeEvidence.records.length, 1);

    const unmatchedConfig = collectionConfig(dir);
    unmatchedConfig.env.authorMatch = "definitely-no-such-author";
    unmatchedConfig.env.githubToken = "test-token";
    unmatchedConfig.env.githubOwner = "acme";
    const unmatchedContext = {};
    const unmatched = await collectAll(
      unmatchedConfig,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      { fetch, collectionContext: unmatchedContext }
    );
    assert.strictEqual(unmatched["{{APP}}"], "    - (변경 없음)");
    assert.deepStrictEqual(unmatchedContext.changeEvidence.records, []);
  });
});

test("AUTHOR_MATCH retains structured PR evidence for trivial covered commits", async () => {
  const prBody = `### Contract version
v1

### Summary
릴리스 PR이 카메라 복구 동작의 목적을 설명한다.

### Changes
- 오래된 복구 상태를 거부한다.

### Validation
- node --test: 4/4 PASS

### Impact and risks
기존 설정 형식은 유지한다.

### Related issue
Closes #42`;
  const issueBody = `### Contract version
v1

### Context and problem
오래된 복구 상태가 남았다.

### Goal
유효한 복구 상태만 사용한다.

### Non-goals
Not applicable: 장치 펌웨어는 변경하지 않는다.

### Acceptance criteria
- [x] 오래된 상태가 거부된다.

### Constraints and impact
기존 설정과 호환되어야 한다.`;

  await withGitCommit({ subject: "chore: release" }, async (dir) => {
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const config = collectionConfig(dir);
    config.env.authorMatch = "Collector Test";
    config.env.githubToken = "test-token";
    config.env.githubOwner = "acme";
    config.trivialPatterns = [/^chore:/i];
    const context = {};
    const fetch = async (url) => {
      if (url.includes("/pulls?")) return mockGithubResponse([{
        number: 18,
        title: "feat(camera): publish structured recovery evidence",
        body: prBody,
        merged_at: "2026-09-25T03:00:00Z",
        merge_commit_sha: sha,
      }]);
      if (url.includes("/pulls/18/commits")) return mockGithubResponse([{ sha }]);
      if (url.endsWith("/issues/42")) return mockGithubResponse({
        number: 42,
        title: "복구 상태 검증",
        body: issueBody,
      });
      throw new Error(`unexpected request: ${url}`);
    };

    const collected = await collectAll(
      config,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      { fetch, collectionContext: context }
    );

    assert.match(collected["{{APP}}"], /publish structured recovery evidence/);
    assert.match(collected["{{APP}}"], /오래된 복구 상태를 거부한다/);
    assert.doesNotMatch(collected["{{APP}}"], /chore: release/);
    assert.strictEqual(context.changeEvidence.records.length, 1);
    assert.deepStrictEqual(context.changeEvidence.records[0].usedEvidence, ["pull_request"]);
  });
});

test("legacy PR deduplication retains covered commit subjects as explicit fallback evidence", async () => {
  await withGitCommit({ subject: "fix(camera): reject stale recovery state" }, async (dir) => {
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const config = collectionConfig(dir);
    config.env.githubToken = "test-token";
    config.env.githubOwner = "acme";
    const context = {};
    const collected = await collectAll(
      config,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      {
        collectionContext: context,
        fetch: async (url) => {
          if (url.includes("/pulls?")) return mockGithubResponse([{
            number: 8,
            title: "fix(camera): stabilize restart handling",
            body: "Legacy PR prose. Closes #42.",
            html_url: "https://github.com/acme/camera/pull/8",
            merged_at: "2026-09-25T03:00:00Z",
            merge_commit_sha: sha,
          }]);
          if (url.includes("/pulls/8/commits")) return mockGithubResponse([{ sha }]);
          if (url.endsWith("/issues/42")) return mockGithubResponse({
            number: 42,
            title: "legacy issue",
            body: "Legacy Issue prose.",
            html_url: "https://github.com/acme/camera/issues/42",
          });
          throw new Error(`unexpected request: ${url}`);
        },
      }
    );

    assert.match(collected["{{APP}}"], /stabilize restart handling/);
    assert.match(collected["{{APP}}"], /↳ 변경: reject stale recovery state/);
    assert.deepStrictEqual(context.changeEvidence.records[0].usedEvidence,
      ["pull_request_title", "commit_subject"]);
    assert.strictEqual(
      Object.hasOwn(context.changeEvidence.records[0].pullRequest, "rawBody"),
      false
    );
    assert.strictEqual(
      Object.hasOwn(context.changeEvidence.records[0].issues[0], "rawBody"),
      false
    );
    assert.strictEqual(
      Object.hasOwn(context.changeEvidence.records[0].pullRequest.contract, "fields"),
      false
    );
    assert.strictEqual(
      Object.hasOwn(context.changeEvidence.records[0].issues[0].contract, "fields"),
      false
    );
  });
});

test("PR deduplication retains each covered commit path signal exactly once", async () => {
  await withGitCommit({
    subject: "chore: prepare release",
    file: "firmware/fw.bin",
  }, async (dir) => {
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const config = collectionConfig(dir);
    config.pathSignals = [{
      pattern: /(^|\/)firmware\/.+\.bin$/i,
      label: "PATH-SIGNAL",
      skipIf: /never-match/,
    }];
    config.env.githubToken = "test-token";
    config.env.githubOwner = "acme";
    const collected = await collectAll(
      config,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      {
        fetch: async (url) => {
          if (url.includes("/pulls?")) return mockGithubResponse([{
            number: 9,
            title: "chore: publish release",
            body: "Legacy PR prose.",
            html_url: "https://github.com/acme/camera/pull/9",
            merged_at: "2026-09-25T03:00:00Z",
            merge_commit_sha: sha,
          }]);
          if (url.includes("/pulls/9/commits")) return mockGithubResponse([{ sha }]);
          throw new Error(`unexpected request: ${url}`);
        },
      }
    );

    assert.strictEqual((collected["{{APP}}"].match(/PATH-SIGNAL/g) || []).length, 1);
  });
});

function mockGithubResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test("credential bodies abort before markup fallback or provenance", async (t) => {
  const fallbackOnlyCases = new Set([
    "Markdown multiline credential label",
  ]);
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
    ["underscore-emphasized provider API key", "sk-proj-emphasized-secret-123456", "_sk-proj-emphasized-secret-123456_"],
    ["internally emphasized provider API key", "sk-proj-internal-secret-123456", "_sk_-proj-internal-secret-123456"],
    ["double-backslash emphasized provider API key", "sk-proj-double-escape-secret-123456", "\\\\_sk_-proj-double-escape-secret-123456"],
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
    ["underscore-emphasized credential URL", "user:emphasized-password", "_https://user:emphasized-password@example.invalid/private_"],
    ["internally emphasized credential URL", "user:internal-password", "_https_://user:internal-password@example.invalid/private"],
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
    ["balanced HTML comment value", "html-comment-value-secret-123", "GITHUB_<!--TOKEN=html-comment-value-secret-123-->"],
    ["balanced HTML tag value", "html-tag-value-secret-123", "GITHUB_<TOKEN=html-tag-value-secret-123>"],
    ["Markdown destination value", "markdown-destination-secret-123", "[GITHUB_](TOKEN=markdown-destination-secret-123)"],
    ["Markdown reference value", "markdown-reference-value-secret-123", "[GITHUB_][TOKEN=markdown-reference-value-secret-123]"],
    ["entity-encoded HTML comment inside key", "encoded-comment-secret-123", "GITHUB_&lt;!--hidden--&gt;TOKEN=encoded-comment-secret-123"],
    ["entity-encoded HTML tag inside key", "encoded-tag-secret-123", "GITHUB_&lt;span&gt;TOKEN&lt;/span&gt;=encoded-tag-secret-123"],
    ["HTML numeric entity inside key", "html-entity-secret-123", "GITHUB&#95;TOKEN=html-entity-secret-123"],
    ["HTML hex entity inside key", "html-hex-entity-secret-123", "GITHUB&#x5f;TOKEN=html-hex-entity-secret-123"],
    ["semicolon-less HTML entity inside key", "html-entity-no-semicolon-secret-123", "GITHUB&#95TOKEN=html-entity-no-semicolon-secret-123"],
    ["HTML UnderBar entity inside key", "html-underbar-secret-123", "GITHUB&UnderBar;TOKEN=html-underbar-secret-123"],
    ["long decimal HTML entity assignment", "html-long-decimal-secret-123", "GITHUB_TOKEN&#0000000061;html-long-decimal-secret-123"],
    ["long hex HTML entity assignment", "html-long-hex-secret-123", "GITHUB_TOKEN&#x000000003d;html-long-hex-secret-123"],
    ["Markdown inline link key", "markdown-link-secret-123", "[GITHUB_TOKEN](https://example.invalid)=markdown-link-secret-123"],
    ["Markdown nested link key", "markdown-nested-link-secret-123", "[GITHUB_TOKEN](https://example.invalid/a_(b))=markdown-nested-link-secret-123"],
    ["Markdown deeply nested destination split key", "markdown-deep-destination-secret-123", "[GITHUB_](https://example.invalid/a_(b_(c)))TOKEN=markdown-deep-destination-secret-123"],
    ["Markdown quoted-title split key", "markdown-title-secret-123", "[GITHUB](https://example.invalid/docs \"note ) still title\")_TOKEN=markdown-title-secret-123"],
    ["Markdown parenthesized-title split key", "markdown-parenthesized-title-secret-123", "[GITHUB](https://example.invalid/docs (release note))_TOKEN=markdown-parenthesized-title-secret-123"],
    ["Markdown angle-destination split key", "markdown-angle-secret-123", "[GITHUB](<./path)still-angle>)_TOKEN=markdown-angle-secret-123"],
    ["Markdown reference link key", "markdown-reference-secret-123", "[GITHUB_TOKEN][credential-doc]=markdown-reference-secret-123"],
    ["Markdown shortcut reference key", "markdown-shortcut-secret-123", "[GITHUB_TOKEN] = markdown-shortcut-secret-123\n\n[GITHUB_TOKEN]: https://example.invalid/docs"],
    ["Markdown colon shortcut reference key", "markdown-shortcut-colon-secret-123", "[GITHUB_TOKEN] : markdown-shortcut-colon-secret-123\n\n[GITHUB_TOKEN]: https://example.invalid/docs"],
    ["Markdown decorated shortcut reference key", "markdown-shortcut-decorated-secret-123", "[*GITHUB_TOKEN*] : markdown-shortcut-decorated-secret-123\n\n[*GITHUB_TOKEN*]: https://example.invalid/docs"],
    ["Markdown escaped shortcut reference key", "markdown-shortcut-escaped-secret-123", "[GITHUB\\_TOKEN] : markdown-shortcut-escaped-secret-123\n\n[GITHUB\\_TOKEN]: https://example.invalid/docs"],
    ["Markdown entity shortcut reference key", "markdown-shortcut-entity-secret-123", "[GITHUB&#95;TOKEN] : markdown-shortcut-entity-secret-123\n\n[GITHUB&#95;TOKEN]: https://example.invalid/docs"],
    ["Markdown credential-valued reference definition", "markdown-definition-secret-123", "[GITHUB_TOKEN]: markdown-definition-secret-123"],
    ["Markdown HTML attribute label", "markdown-html-attribute-secret-123", "[GITHUB_<span title=\">\">TOKEN</span>] : markdown-html-attribute-secret-123\n\n[GITHUB_<span title=\">\">TOKEN</span>]: https://example.invalid/docs"],
    ["Markdown multiline credential label", "markdown-multiline-label-secret-123", "[GITHUB_\nTOKEN]: markdown-multiline-label-secret-123"],
    ["HTML tag-split credential key", "html-tag-split-secret-123", "GITHUB_<span title=\">\">TOKEN</span>=html-tag-split-secret-123"],
    ["multiline HTML tag-split credential key", "html-multiline-secret-123", "GITHUB_<span\n title=\">\">TOKEN</span>=html-multiline-secret-123"],
    ["nested Markdown image credential label", "markdown-image-secret-123", "[GITHUB_![](https://example.invalid/pixel.png)TOKEN](https://example.invalid)=markdown-image-secret-123"],
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
      const collecting = collectAll(
          collectionConfig(dir),
          "2026-09-24T00:00:00Z",
          "2026-09-26T00:00:00Z"
        );
        if (fallbackOnlyCases.has(name)) {
          const collected = await collecting;
          assert.strictEqual(JSON.stringify(collected).includes(secret), false);
          assert.match(collected["{{APP}}"], /reject unsafe evidence/);
        } else {
          await assert.rejects(
            collecting,
            (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
              && !error.message.includes(secret)
          );
        }
      });
    });
  }
});

test("forged git log record boundaries reject credential disclosure", async () => {
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

test("invalid-v1 bodies are scanned or reduced to content-free provenance", async () => {
  const secret = `ghp_${"S".repeat(36)}`;
  const invalidBody = value => `### Contract version
v1

### Why
${value}

### Changes
- preserve safe evidence

### Validation
- node --test: PASS

### References
TBD`;

  await withGitCommit({
    subject: "fix(camera): reject unsafe invalid evidence",
    body: invalidBody(secret),
  }, async (dir) => {
    const config = collectionConfig(dir);
    config.repos.camera.includeCommitBody = false;
    await assert.rejects(
      collectAll(config, "2026-09-24T00:00:00Z", "2026-09-26T00:00:00Z"),
      (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
        && !error.message.includes(secret)
    );
  });

  const marker = "review-sensitive-marker";
  await withGitCommit({
    subject: "fix(camera): omit invalid evidence fields",
    body: invalidBody(`<span>${marker}</span>`),
  }, async (dir) => {
    const config = collectionConfig(dir);
    config.repos.camera.includeCommitBody = false;
    const context = {};
    await collectAll(config, "2026-09-24T00:00:00Z", "2026-09-26T00:00:00Z", {
      collectionContext: context,
    });
    const contract = context.changeEvidence.records[0].commit.contract;
    assert.strictEqual(contract.classification, "v1-invalid");
    assert.strictEqual(Object.hasOwn(contract, "fields"), false);
    assert.strictEqual(Object.hasOwn(contract, "lists"), false);
    assert.strictEqual(JSON.stringify(context).includes(marker), false);
  });
});

test("an unclosed HTML comment cannot render or persist structured commit evidence", async () => {
  const body = `<!--
### Contract version
v1

### Why
hidden purpose must not be rendered

### Changes
- hidden change must not be rendered

### Validation
- hidden validation must not be rendered

### References
#42`;

  await withGitCommit({
    subject: "fix(camera): fall back from hidden commit evidence",
    body,
  }, async (dir) => {
    const config = collectionConfig(dir);
    config.repos.camera.includeCommitBody = false;
    const context = {};
    const collected = await collectAll(
      config,
      "2026-09-24T00:00:00Z",
      "2026-09-26T00:00:00Z",
      { collectionContext: context }
    );

    assert.match(collected["{{APP}}"], /fall back from hidden commit evidence/);
    assert.doesNotMatch(collected["{{APP}}"], /hidden purpose|hidden change|hidden validation/);
    assert.deepStrictEqual(context.changeEvidence.records[0].usedEvidence, ["commit_subject"]);
    assert.strictEqual(context.changeEvidence.records[0].commit.contract.classification,
      "v1-invalid");
    assert.strictEqual(Object.hasOwn(context.changeEvidence.records[0].commit, "rawBody"), false);
  });
});

test("public collection rejects invalid-v1 credentials with body rendering disabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-invalid-contract-boundary-"));
  const outputDir = path.join(root, "out");
  const templatePath = path.join(root, "template.md");
  const secret = "unicode-body-secret-123";
  fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");
  const body = `### Contract version
v1

### Why
GITHUB_\u200bTOKEN=${secret}

### Changes
- preserve safe evidence

### Validation
- node --test: PASS

### References
TBD`;
  try {
    await withGitCommit({ subject: "fix(camera): reject invalid evidence", body }, async (dir) => {
      const config = collectionConfig(dir);
      config.repos.camera.includeCommitBody = false;
      Object.assign(config.env, {
        outputDir,
        snapshotPath: "",
        templatePath,
        forceCollect: true,
        allowPartialSnapshot: true,
        presentationNoteMode: "off",
        presentationNoteThreshold: 5,
      });
      config.sources = {
        git: { enabled: true },
        notion: { enabled: false },
        session: { enabled: false },
      };
      config.reportFilter = {};

      await assert.rejects(
        runCollect(config, new Date(2026, 8, 30)),
        (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
          && !error.message.includes(secret)
      );
      assert.strictEqual(fs.existsSync(outputDir), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public collection rejects underscore-split credentials in valid-v1 bodies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-v1-underscore-boundary-"));
  const outputDir = path.join(root, "out");
  const templatePath = path.join(root, "template.md");
  const secret = "sk-proj-structured-secret-123456";
  const credential = secret.replace(/^sk/, "_sk_");
  fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");
  const body = `### Contract version
v1

### Why
카메라 초기화 실패를 분석했다.

### Changes
- ${credential} 값을 사용하도록 변경했다.

### Validation
- node --test: PASS

### References
TBD`;

  try {
    await withGitCommit({ subject: "fix(camera): reject unsafe structured evidence", body },
      async (dir) => {
        const config = collectionConfig(dir);
        config.repos.camera.includeCommitBody = false;
        Object.assign(config.env, {
          outputDir,
          snapshotPath: "",
          templatePath,
          forceCollect: true,
          allowPartialSnapshot: true,
          presentationNoteMode: "off",
          presentationNoteThreshold: 5,
        });
        config.sources = {
          git: { enabled: true },
          notion: { enabled: false },
          session: { enabled: false },
        };
        config.reportFilter = {};

        await assert.rejects(
          runCollect(config, new Date(2026, 8, 30)),
          (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
            && !error.message.includes(secret)
        );
        assert.strictEqual(fs.existsSync(outputDir), false);
      });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public collection rejects credentials in direct and PR-coverable commit subjects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-subject-credential-boundary-"));
  const templatePath = path.join(root, "template.md");
  const previousFetch = globalThis.fetch;
  fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");
  try {
    for (const includeCommitBody of [false, true]) {
      for (const source of ["direct", "pr-covered", "underscore-emphasis"]) {
        const secret = `subject-${source}-${includeCommitBody ? "body-on" : "body-off"}-secret`;
        const credential = source === "pr-covered"
          ? `GITHUB_&lt;span&gt;TOKEN&lt;/span&gt;=${secret}`
          : source === "underscore-emphasis"
            ? `_sk_-proj-${secret}-123456`
            : `GITHUB_\u200bTOKEN=${secret}`;
        const outputDir = path.join(
          root,
          `${source}-${includeCommitBody ? "body-on" : "body-off"}`
        );
        let fetchCalls = 0;
        globalThis.fetch = previousFetch;

        await withGitCommit({
          subject: `fix(camera): ${credential}`,
          body: "The camera startup path now rejects stale state.",
        }, async (dir) => {
          const config = collectionConfig(dir);
          config.repos.camera.includeCommitBody = includeCommitBody;
          Object.assign(config.env, {
            outputDir,
            snapshotPath: "",
            templatePath,
            forceCollect: true,
            allowPartialSnapshot: true,
            presentationNoteMode: "off",
            presentationNoteThreshold: 5,
          });
          config.sources = {
            git: { enabled: true },
            notion: { enabled: false },
            session: { enabled: false },
          };
          config.reportFilter = {};

          if (source === "pr-covered") {
            Object.assign(config.env, {
              githubToken: "test-token",
              githubOwner: "acme",
            });
            config.repos.camera.githubRepo = "camera";
            globalThis.fetch = async () => {
              fetchCalls += 1;
              throw new Error("commit subject should be rejected before GitHub collection");
            };
          }

          await assert.rejects(
            runCollect(config, new Date(2026, 8, 30)),
            (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
              && !error.message.includes(secret)
          );
          assert.strictEqual(fs.existsSync(outputDir), false);
          assert.strictEqual(fetchCalls, 0);
        });
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public collection rejects credentials split by balanced or unterminated markup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-subject-markup-boundary-"));
  const templatePath = path.join(root, "template.md");
  const previousFetch = globalThis.fetch;
  fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");
  const cases = [
    ["html-comment", secret => `GITHUB_<!--hidden TOKEN=${secret}`],
    ["html-tag", secret => `GITHUB_<span class=x TOKEN=${secret}`],
    ["markdown-bracket", secret => `GITHUB_[hidden TOKEN=${secret}`],
    ["zero-width-prefix", secret => `GITHUB_\u200b<!--hidden TOKEN=${secret}`],
    ["zero-width-suffix", secret => `GITHUB_<!--hidden TO\u200bKEN=${secret}`],
    ["authorization-comment", secret => `Authoriz<!--hidden ation: Bearer ${secret}`],
    ["authorization-tag", secret => `Author<span class=x ization: Bearer ${secret}`],
    ["authorization-bracket", secret => `Author[hidden ization: Bearer ${secret}`],
    ["closing-bracket", secret => `GITHUB_]TOKEN=${secret}`],
    ["hyphen-boundary", secret => `check-GITHUB_<!--hidden TOKEN=${secret}`],
    ["balanced-comment", secret => `GITHUB_<!--TOKEN=${secret}-->`],
    ["balanced-tag", secret => `GITHUB_<TOKEN=${secret}>`],
    ["markdown-destination", secret => `[GITHUB_](TOKEN=${secret})`],
    ["markdown-deep-destination", secret => `[GITHUB_](https://example.invalid/a_(b_(c)))TOKEN=${secret}`],
    ["markdown-quoted-title", secret => `[GITHUB](https://example.invalid/docs "note ) still title")_TOKEN=${secret}`],
    ["markdown-parenthesized-title", secret => `[GITHUB](https://example.invalid/docs (release note))_TOKEN=${secret}`],
    ["markdown-angle-destination", secret => `[GITHUB](<./path)still-angle>)_TOKEN=${secret}`],
    ["markdown-reference", secret => `[GITHUB_][TOKEN=${secret}]`],
  ];

  try {
    for (const [markup, credentialFor] of cases) {
      for (const source of ["direct", "pr-covered"]) {
        const secret = `${markup}-${source}-secret-123`;
        const outputDir = path.join(root, `${markup}-${source}`);
        let fetchCalls = 0;
        globalThis.fetch = previousFetch;

        await withGitCommit({
          subject: `fix(camera): ${credentialFor(secret)}`,
          body: "The camera startup path now rejects stale state.",
        }, async (dir) => {
          const config = collectionConfig(dir);
          config.repos.camera.includeCommitBody = false;
          Object.assign(config.env, {
            outputDir,
            snapshotPath: "",
            templatePath,
            forceCollect: true,
            allowPartialSnapshot: true,
            presentationNoteMode: "off",
            presentationNoteThreshold: 5,
          });
          config.sources = {
            git: { enabled: true },
            notion: { enabled: false },
            session: { enabled: false },
          };
          config.reportFilter = {};

          if (source === "pr-covered") {
            Object.assign(config.env, {
              githubToken: "test-token",
              githubOwner: "acme",
            });
            config.repos.camera.githubRepo = "camera";
            globalThis.fetch = async () => {
              fetchCalls += 1;
              throw new Error("commit subject should be rejected before GitHub collection");
            };
          }

          await assert.rejects(
            runCollect(config, new Date(2026, 8, 30)),
            (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
              && !error.message.includes(secret)
          );
          assert.strictEqual(fs.existsSync(outputDir), false);
          assert.strictEqual(fetchCalls, 0);
        });
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public git collection bounds 280KB repeated incomplete-markup scanning", () => {
  const targetBytes = 280_000;
  const repeated = "GITHUB_<!--x";
  const payload = repeated.repeat(Math.ceil(targetBytes / repeated.length)).slice(0, targetBytes);
  const collectSubject = (subject) => getGitCommitRecords(
    "/unused",
    "2026-09-24T00:00:00Z",
    "2026-09-26T00:00:00Z",
    GIT_CONFIG,
    { includeCommitBody: false },
    { spawnSync: () => ({
      status: 0,
      signal: null,
      error: null,
      stdout: `${"a".repeat(40)}\0${subject}\0\0\ncamera.txt\0\0`,
    }) },
  );

  const safeStartedAt = performance.now();
  const safeRecords = collectSubject(`fix(camera): ${payload}`);
  const safeElapsedMs = performance.now() - safeStartedAt;
  assert.strictEqual(safeRecords.length, 1);
  assert.ok(safeElapsedMs < 1_500,
    `280KB delimiter-only scan took ${safeElapsedMs.toFixed(3)}ms`);

  const markdownPayload = "[x](".repeat(Math.ceil(targetBytes / 4)).slice(0, targetBytes);
  const markdownStartedAt = performance.now();
  const markdownRecords = collectSubject(`fix(camera): ${markdownPayload}`);
  const markdownElapsedMs = performance.now() - markdownStartedAt;
  assert.strictEqual(markdownRecords.length, 1);
  assert.ok(markdownElapsedMs < 1_500,
    `280KB incomplete Markdown destination scan took ${markdownElapsedMs.toFixed(3)}ms`);

  const suffix = "TOKEN=bounded-scan-secret-123";
  const unsafeStartedAt = performance.now();
  assert.throws(
    () => collectSubject(`fix(camera): ${payload.slice(0, -suffix.length)}${suffix}`),
    (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
      && !error.message.includes("bounded-scan-secret-123")
  );
  const unsafeElapsedMs = performance.now() - unsafeStartedAt;
  assert.ok(unsafeElapsedMs < 1_500,
    `280KB credential scan took ${unsafeElapsedMs.toFixed(3)}ms`);
});

test("public git collection parses complete Markdown links and fails closed on ambiguity", () => {
  const collectSubject = (subject) => getGitCommitRecords(
    "/unused",
    "2026-09-24T00:00:00Z",
    "2026-09-26T00:00:00Z",
    GIT_CONFIG,
    { includeCommitBody: false },
    { spawnSync: () => ({
      status: 0,
      signal: null,
      error: null,
      stdout: `${"a".repeat(40)}\0${subject}\0\0\ncamera.txt\0\0`,
    }) },
  );
  const supportedDestination = `${"(".repeat(31)}bounded${")".repeat(31)}`;
  assert.strictEqual(
    collectSubject(`fix(camera): [docs](${supportedDestination})`).length,
    1
  );
  for (const safeLink of [
    `[docs](https://example.invalid/docs "note ) still title")`,
    `[docs](https://example.invalid/docs 'note ) still title')`,
    `[docs](https://example.invalid/docs (release note))`,
    `[docs](<./path)still-angle>)`,
  ]) {
    assert.strictEqual(collectSubject(`docs(camera): ${safeLink}`).length, 1);
  }

  const excessiveDestination = `${"(".repeat(32)}bounded${")".repeat(32)}`;
  assert.throws(
    () => collectSubject(`fix(camera): [docs](${excessiveDestination})`),
    (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
      && /normalization_limit/.test(error.message)
  );
  for (const ambiguousLink of [
    `[docs](<unterminated)`,
    `[docs](https://example.invalid/docs "unterminated)`,
  ]) {
    assert.throws(
      () => collectSubject(`docs(camera): ${ambiguousLink}`),
      (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
        && /normalization_limit/.test(error.message)
    );
  }
});

test("public collection preserves credential comparison operators", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-subject-comparison-boundary-"));
  const templatePath = path.join(root, "template.md");
  fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");

  try {
    for (const [name, subject] of [
      ["not-equal", "fix(camera): correct GITHUB_TOKEN!=null guard"],
      ["strict-not-equal", "fix(camera): correct GITHUB_TOKEN !== undefined guard"],
    ]) {
      const outputDir = path.join(root, name);
      await withGitCommit({
        subject,
        body: "The camera startup path now rejects stale state.",
      }, async (dir) => {
        const config = collectionConfig(dir);
        config.repos.camera.includeCommitBody = false;
        Object.assign(config.env, {
          outputDir,
          snapshotPath: "",
          templatePath,
          forceCollect: true,
          allowPartialSnapshot: true,
          presentationNoteMode: "off",
          presentationNoteThreshold: 5,
        });
        config.sources = {
          git: { enabled: true },
          notion: { enabled: false },
          session: { enabled: false },
        };
        config.reportFilter = {};

        await assert.doesNotReject(runCollect(config, new Date(2026, 8, 30)));
        assert.strictEqual(fs.existsSync(outputDir), true);
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public collection rejects credentials in PR and Issue titles before artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-title-credential-boundary-"));
  const templatePath = path.join(root, "template.md");
  const previousFetch = globalThis.fetch;
  fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");
  try {
    await withGitCommit({ subject: "fix(camera): reject unsafe remote titles" }, async (dir) => {
      const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      for (const source of ["pull-request", "issue"]) {
        const secret = `${source}-title-secret-123`;
        const unsafeTitle = `GITHUB_TOKEN=${secret}`;
        const outputDir = path.join(root, source);
        const config = collectionConfig(dir);
        Object.assign(config.env, {
          outputDir,
          snapshotPath: "",
          templatePath,
          forceCollect: true,
          allowPartialSnapshot: true,
          presentationNoteMode: "off",
          presentationNoteThreshold: 5,
          githubToken: "test-token",
          githubOwner: "acme",
        });
        config.sources = {
          git: { enabled: true },
          notion: { enabled: false },
          session: { enabled: false },
        };
        config.reportFilter = {};
        const requests = [];
        globalThis.fetch = async (url) => {
          requests.push(url);
          if (url.includes("/pulls?")) return mockGithubResponse([{
            number: 7,
            title: source === "pull-request" ? unsafeTitle : "fix: safe PR title",
            body: source === "issue" ? "Legacy PR prose. Closes #42." : "Legacy PR prose.",
            merged_at: "2026-09-25T03:00:00Z",
            merge_commit_sha: sha,
          }]);
          if (url.includes("/pulls/7/commits")) return mockGithubResponse([{ sha }]);
          if (url.endsWith("/issues/42")) return mockGithubResponse({
            number: 42,
            title: unsafeTitle,
            body: "Legacy Issue prose.",
          });
          throw new Error(`unexpected request: ${url}`);
        };

        let result;
        let collectionError;
        try {
          result = await runCollect(config, new Date(2026, 8, 30));
        } catch (error) {
          collectionError = error;
        }
        assert.ok(
          collectionError,
          `${source} collection unexpectedly succeeded: ${JSON.stringify({
            requests,
            failures: result?.snapshot?.failures,
          })}`
        );
        assert.strictEqual(collectionError.code, "COMMIT_BODY_CREDENTIAL_DETECTED");
        assert.strictEqual(collectionError.message.includes(secret), false);
        assert.strictEqual(fs.existsSync(outputDir), false);
      }
    });
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public collection rejects markup- and Unicode-hidden credentials in remote evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-remote-markup-boundary-"));
  const templatePath = path.join(root, "template.md");
  const previousFetch = globalThis.fetch;
  fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");
  try {
    await withGitCommit({ subject: "fix(camera): reject decorated remote evidence" },
      async (dir) => {
        const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        const cases = [
          ["pull-title", "markdown", "pull-request", "title"],
          ["pull-body", "markdown", "pull-request", "body"],
          ["issue-title", "html", "issue", "title"],
          ["issue-body", "html", "issue", "body"],
          ["pull-title-entity-tag", "entity-tag", "pull-request", "title"],
          ["pull-title-entity-comment", "entity-comment", "pull-request", "title"],
          ["pull-body-entity-tag", "entity-tag", "pull-request", "body"],
          ["pull-body-entity-comment", "entity-comment", "pull-request", "body"],
          ["issue-title-entity-tag", "entity-tag", "issue", "title"],
          ["issue-title-entity-comment", "entity-comment", "issue", "title"],
          ["issue-body-entity-tag", "entity-tag", "issue", "body"],
          ["issue-body-entity-comment", "entity-comment", "issue", "body"],
          ["pull-title-zero-width", "zero-width", "pull-request", "title"],
          ["pull-body-bidi", "bidi", "pull-request", "body"],
          ["issue-title-zero-width", "zero-width", "issue", "title"],
          ["issue-body-bidi", "bidi", "issue", "body"],
          ["pull-title-unclosed-comment", "unclosed-comment", "pull-request", "title"],
          ["pull-title-unclosed-tag", "unclosed-tag", "pull-request", "title"],
          ["pull-title-unclosed-bracket", "unclosed-bracket", "pull-request", "title"],
          ["pull-title-unclosed-zero-width-prefix", "unclosed-zero-width-prefix", "pull-request", "title"],
          ["pull-title-unclosed-zero-width-suffix", "unclosed-zero-width-suffix", "pull-request", "title"],
          ["pull-title-unclosed-authorization", "unclosed-authorization", "pull-request", "title"],
          ["pull-title-closing-bracket", "closing-bracket", "pull-request", "title"],
          ["pull-title-hyphen-boundary", "hyphen-boundary", "pull-request", "title"],
          ["pull-title-balanced-comment", "balanced-comment", "pull-request", "title"],
          ["pull-body-balanced-tag", "balanced-tag", "pull-request", "body"],
          ["issue-title-markdown-destination", "markdown-destination", "issue", "title"],
          ["issue-body-markdown-reference", "markdown-reference", "issue", "body"],
          ["pull-title-markdown-deep-destination", "markdown-deep-destination", "pull-request", "title"],
          ["pull-body-markdown-deep-destination", "markdown-deep-destination", "pull-request", "body"],
          ["issue-title-markdown-deep-destination", "markdown-deep-destination", "issue", "title"],
          ["issue-body-markdown-deep-destination", "markdown-deep-destination", "issue", "body"],
          ["pull-title-markdown-quoted-title", "markdown-quoted-title", "pull-request", "title"],
          ["pull-body-markdown-quoted-title", "markdown-quoted-title", "pull-request", "body"],
          ["issue-title-markdown-quoted-title", "markdown-quoted-title", "issue", "title"],
          ["issue-body-markdown-quoted-title", "markdown-quoted-title", "issue", "body"],
          ["pull-title-markdown-parenthesized-title", "markdown-parenthesized-title", "pull-request", "title"],
          ["pull-body-markdown-parenthesized-title", "markdown-parenthesized-title", "pull-request", "body"],
          ["issue-title-markdown-parenthesized-title", "markdown-parenthesized-title", "issue", "title"],
          ["issue-body-markdown-parenthesized-title", "markdown-parenthesized-title", "issue", "body"],
          ["pull-title-markdown-angle-destination", "markdown-angle-destination", "pull-request", "title"],
          ["pull-body-markdown-angle-destination", "markdown-angle-destination", "pull-request", "body"],
          ["issue-title-markdown-angle-destination", "markdown-angle-destination", "issue", "title"],
          ["issue-body-markdown-angle-destination", "markdown-angle-destination", "issue", "body"],
          ["pull-title-underscore-emphasis", "underscore-emphasis", "pull-request", "title"],
          ["pull-body-underscore-emphasis", "underscore-emphasis", "pull-request", "body"],
          ["issue-title-underscore-emphasis", "underscore-emphasis", "issue", "title"],
          ["issue-body-underscore-emphasis", "underscore-emphasis", "issue", "body"],
        ];
        for (const [name, decoration, source, field] of cases) {
          const secret = `${name}-secret-123`;
          const credential = {
            markdown: `[GITHUB_TOKEN](https://example.invalid/docs)=${secret}`,
            html: `GITHUB_<span>TOKEN</span>=${secret}`,
            "entity-tag": `GITHUB_&lt;span&gt;TOKEN&lt;/span&gt;=${secret}`,
            "entity-comment": `GITHUB_&lt;!--hidden--&gt;TOKEN=${secret}`,
            "zero-width": `GITHUB_\u200bTOKEN=${secret}`,
            bidi: `GITHUB_\u202eTOKEN=${secret}`,
            "unclosed-comment": `GITHUB_<!--hidden TOKEN=${secret}`,
            "unclosed-tag": `GITHUB_<span class=x TOKEN=${secret}`,
            "unclosed-bracket": `GITHUB_[hidden TOKEN=${secret}`,
            "unclosed-zero-width-prefix": `GITHUB_\u200b<!--hidden TOKEN=${secret}`,
            "unclosed-zero-width-suffix": `GITHUB_<!--hidden TO\u200bKEN=${secret}`,
            "unclosed-authorization": `Authoriz<!--hidden ation: Bearer ${secret}`,
            "closing-bracket": `GITHUB_]TOKEN=${secret}`,
            "hyphen-boundary": `check-GITHUB_<!--hidden TOKEN=${secret}`,
            "balanced-comment": `GITHUB_<!--TOKEN=${secret}-->`,
            "balanced-tag": `GITHUB_<TOKEN=${secret}>`,
            "markdown-destination": `[GITHUB_](TOKEN=${secret})`,
            "markdown-deep-destination": `[GITHUB_](https://example.invalid/a_(b_(c)))TOKEN=${secret}`,
            "markdown-quoted-title": `[GITHUB](https://example.invalid/docs "note ) still title")_TOKEN=${secret}`,
            "markdown-parenthesized-title": `[GITHUB](https://example.invalid/docs (release note))_TOKEN=${secret}`,
            "markdown-angle-destination": `[GITHUB](<./path)still-angle>)_TOKEN=${secret}`,
            "markdown-reference": `[GITHUB_][TOKEN=${secret}]`,
            "underscore-emphasis": `_sk_-proj-${secret}-123456`,
          }[decoration];
          const outputDir = path.join(root, name);
          const config = collectionConfig(dir);
          Object.assign(config.env, {
            outputDir,
            snapshotPath: "",
            templatePath,
            forceCollect: true,
            allowPartialSnapshot: true,
            presentationNoteMode: "off",
            presentationNoteThreshold: 5,
            githubToken: "test-token",
            githubOwner: "acme",
          });
          config.sources = {
            git: { enabled: true },
            notion: { enabled: false },
            session: { enabled: false },
          };
          config.reportFilter = {};
          globalThis.fetch = async (url) => {
            if (url.includes("/pulls?")) return mockGithubResponse([{
              number: 7,
              title: source === "pull-request" && field === "title"
                ? credential
                : "fix: safe PR title",
              body: source === "pull-request" && field === "body"
                ? credential
                : (source === "issue" ? "Legacy PR prose. Closes #42." : "Legacy PR prose."),
              merged_at: "2026-09-25T03:00:00Z",
              merge_commit_sha: sha,
            }]);
            if (url.includes("/pulls/7/commits")) return mockGithubResponse([{ sha }]);
            if (url.endsWith("/issues/42")) return mockGithubResponse({
              number: 42,
              title: field === "title" ? credential : "safe Issue title",
              body: field === "body" ? credential : "Legacy Issue prose.",
            });
            throw new Error(`unexpected request: ${url}`);
          };

          await assert.rejects(
            runCollect(config, new Date(2026, 8, 30)),
            (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
              && !error.message.includes(secret)
          );
          assert.strictEqual(fs.existsSync(outputDir), false);
        }
      });
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public collection rejects credential bodies before writing artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-credential-boundary-"));
  const fallbackOnlyCases = new Set([
    "markdown-multiline-credential-label",
  ]);
  try {
    const templatePath = path.join(root, "template.md");
    fs.writeFileSync(templatePath, "#### Probe\n{{APP}}\n{{ETC}}\n", "utf8");
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
      ["balanced-html-comment-value", "public-html-comment-value-secret-123", "GITHUB_<!--TOKEN=public-html-comment-value-secret-123-->"],
      ["balanced-html-tag-value", "public-html-tag-value-secret-123", "GITHUB_<TOKEN=public-html-tag-value-secret-123>"],
      ["markdown-destination-value", "public-markdown-destination-secret-123", "[GITHUB_](TOKEN=public-markdown-destination-secret-123)"],
      ["markdown-reference-value", "public-markdown-reference-value-secret-123", "[GITHUB_][TOKEN=public-markdown-reference-value-secret-123]"],
      ["html-entity-inside-key", "public-html-entity-secret-123", "GITHUB&#95;TOKEN=public-html-entity-secret-123"],
      ["html-hex-entity-inside-key", "public-html-hex-entity-secret-123", "GITHUB&#x5f;TOKEN=public-html-hex-entity-secret-123"],
      ["html-entity-no-semicolon-inside-key", "public-html-entity-no-semicolon-secret-123", "GITHUB&#95TOKEN=public-html-entity-no-semicolon-secret-123"],
      ["html-underbar-inside-key", "public-html-underbar-secret-123", "GITHUB&UnderBar;TOKEN=public-html-underbar-secret-123"],
      ["html-long-decimal-assignment", "public-html-long-decimal-secret-123", "GITHUB_TOKEN&#0000000061;public-html-long-decimal-secret-123"],
      ["html-long-hex-assignment", "public-html-long-hex-secret-123", "GITHUB_TOKEN&#x000000003d;public-html-long-hex-secret-123"],
      ["markdown-inline-link-key", "public-markdown-link-secret-123", "[GITHUB_TOKEN](https://example.invalid)=public-markdown-link-secret-123"],
      ["markdown-nested-link-key", "public-markdown-nested-link-secret-123", "[GITHUB_TOKEN](https://example.invalid/a_(b))=public-markdown-nested-link-secret-123"],
      ["markdown-deep-destination-split-key", "public-markdown-deep-destination-secret-123", "[GITHUB_](https://example.invalid/a_(b_(c)))TOKEN=public-markdown-deep-destination-secret-123"],
      ["markdown-quoted-title-split-key", "public-markdown-title-secret-123", "[GITHUB](https://example.invalid/docs \"note ) still title\")_TOKEN=public-markdown-title-secret-123"],
      ["markdown-parenthesized-title-split-key", "public-markdown-parenthesized-title-secret-123", "[GITHUB](https://example.invalid/docs (release note))_TOKEN=public-markdown-parenthesized-title-secret-123"],
      ["markdown-angle-destination-split-key", "public-markdown-angle-secret-123", "[GITHUB](<./path)still-angle>)_TOKEN=public-markdown-angle-secret-123"],
      ["markdown-reference-link-key", "public-markdown-reference-secret-123", "[GITHUB_TOKEN][credential-doc]=public-markdown-reference-secret-123"],
      ["markdown-shortcut-reference-key", "public-markdown-shortcut-secret-123", "[GITHUB_TOKEN] = public-markdown-shortcut-secret-123\n\n[GITHUB_TOKEN]: https://example.invalid/docs"],
      ["markdown-colon-shortcut-reference-key", "public-markdown-shortcut-colon-secret-123", "[GITHUB_TOKEN] : public-markdown-shortcut-colon-secret-123\n\n[GITHUB_TOKEN]: https://example.invalid/docs"],
      ["markdown-decorated-shortcut-reference-key", "public-markdown-shortcut-decorated-secret-123", "[*GITHUB_TOKEN*] : public-markdown-shortcut-decorated-secret-123\n\n[*GITHUB_TOKEN*]: https://example.invalid/docs"],
      ["markdown-escaped-shortcut-reference-key", "public-markdown-shortcut-escaped-secret-123", "[GITHUB\\_TOKEN] : public-markdown-shortcut-escaped-secret-123\n\n[GITHUB\\_TOKEN]: https://example.invalid/docs"],
      ["markdown-entity-shortcut-reference-key", "public-markdown-shortcut-entity-secret-123", "[GITHUB&#95;TOKEN] : public-markdown-shortcut-entity-secret-123\n\n[GITHUB&#95;TOKEN]: https://example.invalid/docs"],
      ["markdown-credential-valued-reference-definition", "public-markdown-definition-secret-123", "[GITHUB_TOKEN]: public-markdown-definition-secret-123"],
      ["markdown-html-attribute-label", "public-markdown-html-attribute-secret-123", "[GITHUB_<span title=\">\">TOKEN</span>] : public-markdown-html-attribute-secret-123\n\n[GITHUB_<span title=\">\">TOKEN</span>]: https://example.invalid/docs"],
      ["markdown-multiline-credential-label", "public-markdown-multiline-label-secret-123", "[GITHUB_\nTOKEN]: public-markdown-multiline-label-secret-123"],
      ["html-tag-split-credential-key", "public-html-tag-split-secret-123", "GITHUB_<span title=\">\">TOKEN</span>=public-html-tag-split-secret-123"],
      ["multiline-html-tag-split-credential-key", "public-html-multiline-secret-123", "GITHUB_<span\n title=\">\">TOKEN</span>=public-html-multiline-secret-123"],
      ["nested-markdown-image-credential-label", "public-markdown-image-secret-123", "[GITHUB_![](https://example.invalid/pixel.png)TOKEN](https://example.invalid)=public-markdown-image-secret-123"],
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
      ["underscore-emphasized-provider-api-key", "sk-proj-public-emphasized-secret-123456", "_sk-proj-public-emphasized-secret-123456_"],
      ["underscore-emphasized-credential-url", "user:public-emphasized-password", "_https://user:public-emphasized-password@example.invalid/private_"],
      ["internally-emphasized-provider-api-key", "sk-proj-public-internal-secret-123456", "_sk_-proj-public-internal-secret-123456"],
      ["double-backslash-emphasized-provider-api-key", "sk-proj-public-double-escape-secret-123456", "\\\\_sk_-proj-public-double-escape-secret-123456"],
      ["internally-emphasized-credential-url", "user:public-internal-password", "_https_://user:public-internal-password@example.invalid/private"],
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
            templatePath,
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

        const collecting = runCollect(config, new Date(2026, 8, 30));
        if (fallbackOnlyCases.has(name)) {
          const result = await collecting;
          const snapshotPath = path.join(outputDir, "report-2026-09-30.snapshot.json");
          assert.strictEqual(JSON.stringify(result).includes(secret), false);
          assert.strictEqual(fs.readFileSync(snapshotPath, "utf8").includes(secret), false);
        } else {
          await assert.rejects(
            collecting,
            (error) => error.code === "COMMIT_BODY_CREDENTIAL_DETECTED"
              && !error.message.includes(secret)
          );
          assert.strictEqual(fs.existsSync(outputDir), false);
        }
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
      assert.strictEqual(result.snapshot.securityContracts.commitBodyCredentialScan, 30);
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

test("timezone-less changelog bounds use KST even when the host timezone is UTC", () => {
  const body = `# Changelog

## 1.0.0 (2026-08-12)

### 첫 보고일 변경

- 첫 보고일 항목을 포함한다.
`;
  const previousTimeZone = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const entries = withChangelog(body, (dir) => getChangelogEntries(
      dir,
      "2026-08-12T06:00:00",
      "2026-08-19T05:59:59",
      {}
    ));
    assert.ok(entries.some((entry) => entry.includes("첫 보고일 항목")));
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
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
