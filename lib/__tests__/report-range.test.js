const { test } = require("node:test");
const assert = require("node:assert");
const { dateRange, isWithinRange } = require("../report-range");

test("report range is a Wednesday 06:00 half-open interval", () => {
  const range = dateRange(new Date(2026, 6, 15), {});

  assert.strictEqual(range.startDate, "2026-07-08T06:00:00");
  assert.strictEqual(range.endDate, "2026-07-15T05:59:59");
  assert.strictEqual(range.end.getMilliseconds(), 999);
  assert.strictEqual(range.startInclusive, "2026-07-07T21:00:00.000Z");
  assert.strictEqual(range.endExclusive, "2026-07-14T21:00:00.000Z");
  assert.ok(isWithinRange("2026-07-14T20:59:59.999Z", range));
  assert.ok(!isWithinRange("2026-07-14T21:00:00.000Z", range));
});

test("date-only overrides retain the 06:00 boundary", () => {
  const range = dateRange(new Date(2026, 6, 15), {
    START_DATE: "2026-07-01",
    END_DATE: "2026-07-08",
  });

  assert.strictEqual(range.startDate, "2026-07-01T06:00:00");
  assert.strictEqual(range.endDate, "2026-07-08T05:59:59");
  assert.strictEqual(range.startInclusive, "2026-06-30T21:00:00.000Z");
  assert.strictEqual(range.endExclusive, "2026-07-07T21:00:00.000Z");
});

test("timezone-less datetime overrides are interpreted as KST", () => {
  const range = dateRange(new Date(2026, 6, 15), {
    START_DATE: "2026-07-01T06:00:00",
    END_DATE: "2026-07-08T05:59:59.999",
  });

  assert.strictEqual(range.startInclusive, "2026-06-30T21:00:00.000Z");
  assert.strictEqual(range.endExclusive, "2026-07-07T21:00:00.000Z");
});
