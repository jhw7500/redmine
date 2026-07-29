const { test } = require("node:test");
const assert = require("node:assert");
const { assertPublishable, isPublishable, resolveRunMeetingDate } = require("../../index");

test("resolveRunMeetingDate uses the explicit meeting date", () => {
  const date = resolveRunMeetingDate({
    env: { meetingDate: "2026-07-15", wikiUrl: "", pageSuffix: "weekly", baseUrl: "http://r", projectId: "p" },
  });
  assert.strictEqual(date.getFullYear(), 2026);
  assert.strictEqual(date.getMonth(), 6);
  assert.strictEqual(date.getDate(), 15);
});

test("publish gate blocks FAIL unless explicitly overridden", () => {
  assert.throws(
    () => assertPublishable({ status: "FAIL" }, { env: { validationMode: "block", validationOverride: false } }),
    /Redmine 반영을 중단/
  );
  assert.doesNotThrow(() => assertPublishable(
    { status: "FAIL" },
    { env: { validationMode: "block", validationOverride: true } }
  ));
});

test("publish gate allows WARNING because warnings are review hints, not errors", () => {
  assert.doesNotThrow(() => assertPublishable(
    { status: "WARNING", issues: [{ severity: "warning", code: "open_status_pickaxe_unavailable" }] },
    { env: { validationMode: "block", validationOverride: false } }
  ));
});

test("generate and update share one publishable standard", () => {
  // generate가 자체 기준을 쓰면 게시 가능한 WARNING이 실패 종료코드가 되어
  // cron 래퍼가 매주 헛알림을 낸다. index.js의 generate 분기는 이 함수를 쓴다.
  const publishableWarning = {
    status: "WARNING",
    issues: [{ severity: "warning", code: "open_status_pickaxe_unavailable" }],
  };
  assert.strictEqual(isPublishable(publishableWarning), true);
  assert.doesNotThrow(() => assertPublishable(
    publishableWarning,
    { env: { validationMode: "block", validationOverride: false } }
  ));

  assert.strictEqual(isPublishable({ status: "PASS", issues: [] }), true);
  assert.strictEqual(isPublishable({ status: "FAIL", issues: [] }), false);
  assert.strictEqual(
    isPublishable({
      status: "WARNING",
      issues: [{ severity: "warning", code: "open_status_resolution_evidence" }],
    }),
    false
  );
});

test("publishable warning log names the codes that need manual review", () => {
  const original = console.warn;
  const lines = [];
  console.warn = (message) => lines.push(String(message));
  try {
    assertPublishable(
      { status: "WARNING", issues: [{ severity: "warning", code: "open_status_pickaxe_unavailable" }] },
      { env: { validationMode: "block", validationOverride: false } }
    );
  } finally {
    console.warn = original;
  }

  assert.ok(lines.some((line) => line.includes("open_status_pickaxe_unavailable")));
});

test("publish gate blocks any warning code not in the allowlist by default", () => {
  // 허용목록에 없는 코드는 기본 차단이어야 한다. 이 테스트가 없으면
  // blockingWarnings를 "목록에 없으면 통과"로 뒤집어도 아무도 알아채지 못한다.
  assert.throws(
    () => assertPublishable(
      { status: "WARNING", issues: [{ severity: "warning", code: "some_future_warning_code" }] },
      { env: { validationMode: "block", validationOverride: false } }
    ),
    /Redmine 반영을 중단/
  );
});

test("publish gate still blocks warnings that demand human review", () => {
  // 기준일 이후 해결 흔적이 발견됐다는 신호(AGENTS.md의 stale 미해결 방지 규율)나
  // git 확인 자체가 실패한 경우는 사람이 봐야 한다. 통과시키면 안 된다.
  for (const code of [
    "open_status_resolution_evidence",
    "open_status_git_check_failed",
    "open_status_git_pickaxe_failed",
  ]) {
    assert.throws(
      () => assertPublishable(
        { status: "WARNING", issues: [{ severity: "warning", code }] },
        { env: { validationMode: "block", validationOverride: false } }
      ),
      /Redmine 반영을 중단/,
      `${code}는 게시를 차단해야 한다`
    );
  }
});
