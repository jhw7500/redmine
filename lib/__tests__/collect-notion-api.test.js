const { test } = require("node:test");
const assert = require("node:assert");
const {
  extractDate,
  extractMultiSelect,
  formatDateInTimeZone,
  pageWithinRange,
  queryDatabase,
  retainPresentationTaggedPage,
} = require("../collect-notion-api");

test("pageWithinRange applies the exact 06:00 boundary", () => {
  const start = "2026-07-08T06:00:00+09:00";
  const end = "2026-07-15T05:59:59.999+09:00";

  assert.ok(pageWithinRange({ created_time: "2026-07-15T05:59:59.999+09:00" }, start, end));
  assert.ok(!pageWithinRange({ created_time: "2026-07-15T06:00:00+09:00" }, start, end));
});

test("date-property query uses KST calendar days", async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ results: [], has_more: false }) };
  };
  await queryDatabase(
    "key",
    { id: "decision", dateFilterType: "date", dateProperty: "date" },
    "2026-07-07T21:00:00.000Z",
    "2026-07-14T20:59:59.999Z",
    fetchImpl
  );

  assert.strictEqual(body.filter.and[0].property, "date");
  assert.strictEqual(body.filter.and[0].date.on_or_after, "2026-07-08");
  assert.strictEqual(body.filter.and[1].date.on_or_before, "2026-07-15");
});

test("database query failure is surfaced instead of becoming empty success", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    text: async () => "rate limited",
  });
  await assert.rejects(
    queryDatabase(
      "key",
      { id: "kb", dateFilterType: "created_time" },
      "2026-07-07T21:00:00.000Z",
      "2026-07-14T20:59:59.999Z",
      fetchImpl
    ),
    /DB query failed \(429\)/
  );
});

test("extractMultiSelect retains the presentation-note tag", () => {
  assert.deepStrictEqual(
    extractMultiSelect({ properties: { tags: { type: "multi_select", multi_select: [{ name: "발표노트" }] } } }, "tags"),
    ["발표노트"]
  );
});

test("presentation-tagged KB pages survive report=none for candidate publishing", () => {
  assert.strictEqual(
    retainPresentationTaggedPage({ skip: true }, ["발표노트"]),
    true
  );
  assert.strictEqual(retainPresentationTaggedPage({ skip: true }, []), false);
});

test("date properties use KST calendar days instead of UTC string slices", () => {
  assert.strictEqual(formatDateInTimeZone("2026-07-07T21:00:00.000Z"), "2026-07-08");
  assert.strictEqual(formatDateInTimeZone("2026-07-14T20:59:59.999Z"), "2026-07-15");
  assert.strictEqual(
    extractDate({ properties: { date: { type: "date", date: { start: "2026-07-15" } } } }, "date"),
    "2026-07-15"
  );
});
