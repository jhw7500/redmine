const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  detectPathSignals,
  extractBodyHighlights,
  getChangelogEntries,
  getGitCommits,
  stripTypePrefix,
  translateLine,
} = require("../collector");

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

function withGitCommit({ subject, body }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-git-body-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Collector Test"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "collector@example.com"]);
    fs.writeFileSync(path.join(dir, "camera.txt"), "camera\n", "utf8");
    execFileSync("git", ["-C", dir, "add", "camera.txt"]);
    const args = ["-C", dir, "commit", "-q", "-m", subject];
    if (body) args.push("-m", body);
    execFileSync("git", args, {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-09-25T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-09-25T00:00:00Z",
      },
    });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
