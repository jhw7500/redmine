const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { detectPathSignals, getChangelogEntries } = require("../collector");

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
