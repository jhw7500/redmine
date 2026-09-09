const { test } = require("node:test");
const assert = require("node:assert");
const { filterByDateRange, mergeItemsIntoAutoContent } = require("../merger");

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

test("Notion briefing details remain nested under one report item", () => {
  const result = mergeItemsIntoAutoContent({}, [{
    source: "notion",
    category: "pimDriverCam",
    title: "360p@120 듀얼와이드 노출 결함 수정",
    briefing: {
      cause: "두 채널의 노출값이 갈려 와이드 프레임 합성이 실패했다.",
      fix: "노출 시드를 쌍 단위로 결정하고 broadcast로 기록했다.",
      verification: "수정 후 네 회차 모두 정상 전달률을 회복했다.",
    },
  }], [], {
    categories: {
      pimDriverCam: { templateKey: "CAMERA" },
    },
    sources: { notion: { projectMapping: {} } },
    reportFilter: {},
    repos: {},
  });

  assert.strictEqual(result["{{CAMERA}}"], [
    "    - [Notion] 360p@120 듀얼와이드 노출 결함 수정",
    "      ↳ 원인: 두 채널의 노출값이 갈려 와이드 프레임 합성이 실패했다.",
    "      ↳ 수정: 노출 시드를 쌍 단위로 결정하고 broadcast로 기록했다.",
    "      ↳ 검증: 수정 후 네 회차 모두 정상 전달률을 회복했다.",
  ].join("\n"));
});
