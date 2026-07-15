const { test } = require("node:test");
const assert = require("node:assert");
const { dateRange, isWithinRange } = require("../report-range");

test("report range is a Wednesday 06:00 half-open interval", () => {
  const range = dateRange(new Date(2026, 6, 15), {});

  assert.strictEqual(range.startDate, "2026-07-08T06:00:00");
  assert.strictEqual(range.endDate, "2026-07-15T05:59:59");
  assert.strictEqual(range.end.getMilliseconds(), 999);
  assert.strictEqual(range.endExclusive, new Date(2026, 6, 15, 6, 0, 0, 0).toISOString());
  assert.ok(isWithinRange(new Date(2026, 6, 15, 5, 59, 59, 999).toISOString(), range));
  assert.ok(!isWithinRange(new Date(2026, 6, 15, 6, 0, 0, 0).toISOString(), range));
});

test("date-only overrides retain the 06:00 boundary", () => {
  const range = dateRange(new Date(2026, 6, 15), {
    START_DATE: "2026-07-01",
    END_DATE: "2026-07-08",
  });

  assert.strictEqual(range.startDate, "2026-07-01T06:00:00");
  assert.strictEqual(range.endDate, "2026-07-08T05:59:59");
});
