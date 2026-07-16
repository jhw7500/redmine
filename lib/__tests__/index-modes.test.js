const { test } = require("node:test");
const assert = require("node:assert");
const { assertPublishable, resolveRunMeetingDate } = require("../../index");

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
