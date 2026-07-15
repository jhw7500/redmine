const { test } = require("node:test");
const assert = require("node:assert");
const { filterByDateRange } = require("../merger");

test("day-precision session items use the KST display boundary dates", () => {
  const range = {
    start: "2026-07-07T21:00:00.000Z",
    end: "2026-07-14T20:59:59.999Z",
    dayStart: "2026-07-08",
    dayEnd: "2026-07-15",
  };
  const items = [
    { date: "2026-07-07", timestamp: null, title: "before" },
    { date: "2026-07-08", timestamp: null, title: "start" },
    { date: "2026-07-15", timestamp: null, title: "end" },
    { date: "2026-07-16", timestamp: null, title: "after" },
  ];

  assert.deepStrictEqual(
    filterByDateRange(items, range).map((item) => item.title),
    ["start", "end"]
  );
});

test("timestamped items still use the exact half-open-adjacent boundary", () => {
  const range = {
    start: "2026-07-07T21:00:00.000Z",
    end: "2026-07-14T20:59:59.999Z",
    dayStart: "2026-07-08",
    dayEnd: "2026-07-15",
  };
  const items = [
    { date: "2026-07-15", timestamp: "2026-07-14T20:59:59.999Z", title: "inside" },
    { date: "2026-07-15", timestamp: "2026-07-14T21:00:00.000Z", title: "next" },
  ];

  assert.deepStrictEqual(
    filterByDateRange(items, range).map((item) => item.title),
    ["inside"]
  );
});
