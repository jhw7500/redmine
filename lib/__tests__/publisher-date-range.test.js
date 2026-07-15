const { test } = require("node:test");
const assert = require("node:assert");
const { dateRange } = require("../publisher");

function withDateEnv(startDate, endDate, callback) {
  const previousStart = process.env.START_DATE;
  const previousEnd = process.env.END_DATE;

  if (startDate === undefined) delete process.env.START_DATE;
  else process.env.START_DATE = startDate;
  if (endDate === undefined) delete process.env.END_DATE;
  else process.env.END_DATE = endDate;

  try {
    return callback();
  } finally {
    if (previousStart === undefined) delete process.env.START_DATE;
    else process.env.START_DATE = previousStart;
    if (previousEnd === undefined) delete process.env.END_DATE;
    else process.env.END_DATE = previousEnd;
  }
}

test("dateRange: automatic weekly range uses the Wednesday 06:00 cutoff", () => {
  withDateEnv(undefined, undefined, () => {
    const range = dateRange(new Date(2026, 6, 15));

    assert.strictEqual(range.startDate, "2026-07-08T06:00:00");
    assert.strictEqual(range.endDate, "2026-07-15T05:59:59");
    assert.strictEqual(range.end.getMilliseconds(), 999);
  });
});

test("dateRange: date-only overrides use the same 06:00 cutoff", () => {
  withDateEnv("2026-07-01", "2026-07-08", () => {
    const range = dateRange(new Date(2026, 6, 15));

    assert.strictEqual(range.startDate, "2026-07-01T06:00:00");
    assert.strictEqual(range.endDate, "2026-07-08T05:59:59");
    assert.strictEqual(range.end.getMilliseconds(), 999);
  });
});
