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

for (const { name, items, gitLines } of [
  {
    name: "a duplicate title",
    items: undefined,
    gitLines: ["    - 노출 결함 수정"],
  },
  {
    name: "fully duplicated item lines",
    items: ["노출 결함 수정", "노출 설정 정리"],
    gitLines: ["    - 노출 결함 수정", "    - 노출 설정 정리"],
  },
]) {
  test(`Notion briefing survives ${name} exactly once`, () => {
    const item = {
      source: "notion",
      category: "pimDriverCam",
      title: "노출 결함 수정",
      items,
      briefing: {
        cause: "두 채널의 노출값이 달랐다.",
        fix: "노출 시드를 통일했다.",
        verification: "네 회차 검증을 통과했다.",
      },
    };
    const result = mergeItemsIntoAutoContent({
      "{{CAMERA}}": gitLines.join("\n"),
    }, [item, item], [], {
      categories: { pimDriverCam: { templateKey: "CAMERA" } },
    });

    assert.strictEqual(result["{{CAMERA}}"], [
      ...gitLines,
      "    - [Notion] 노출 결함 수정",
      "      ↳ 원인: 두 채널의 노출값이 달랐다.",
      "      ↳ 수정: 노출 시드를 통일했다.",
      "      ↳ 검증: 네 회차 검증을 통과했다.",
    ].join("\n"));
  });
}

test("mixed duplicate and new Notion lines retain each briefing detail once", () => {
  const result = mergeItemsIntoAutoContent({
    "{{CAMERA}}": "    - 노출 결함 수정",
  }, [{
    category: "pimDriverCam",
    items: ["노출 결함 수정", "회귀 검증 추가", "회귀 검증 추가"],
    briefing: {
      cause: "두 채널의 노출값이 달랐다.",
      fix: "노출 시드를 통일했다.",
      verification: "네 회차 검증을 통과했다.",
    },
  }], [], {
    categories: { pimDriverCam: { templateKey: "CAMERA" } },
  });

  const lines = result["{{CAMERA}}"].split("\n");
  for (const expectedLine of [
    "    - 노출 결함 수정",
    "    - [Notion] 회귀 검증 추가",
    "      ↳ 원인: 두 채널의 노출값이 달랐다.",
    "      ↳ 수정: 노출 시드를 통일했다.",
    "      ↳ 검증: 네 회차 검증을 통과했다.",
  ]) {
    assert.strictEqual(lines.filter((line) => line === expectedLine).length, 1);
  }
});

test("distinct Notion titles retain their shared verification under each item", () => {
  const result = mergeItemsIntoAutoContent({}, [{
    category: "pimDriverCam",
    title: "노출 결함 수정",
    briefing: { verification: "네 회차 검증을 통과했다." },
  }, {
    category: "pimDriverCam",
    title: "색상 결함 수정",
    briefing: { verification: "네 회차 검증을 통과했다." },
  }], [], {
    categories: { pimDriverCam: { templateKey: "CAMERA" } },
  });

  assert.strictEqual(result["{{CAMERA}}"], [
    "    - [Notion] 노출 결함 수정",
    "      ↳ 검증: 네 회차 검증을 통과했다.",
    "    - [Notion] 색상 결함 수정",
    "      ↳ 검증: 네 회차 검증을 통과했다.",
  ].join("\n"));
});

test("matching Notion titles in separate categories retain their own briefing", () => {
  const result = mergeItemsIntoAutoContent({}, [{
    category: "pimDriverCam",
    title: "설정 처리 수정",
    briefing: { verification: "회귀 테스트를 통과했다." },
  }, {
    category: "etc",
    title: "설정 처리 수정",
    briefing: { verification: "회귀 테스트를 통과했다." },
  }], [], {
    categories: {
      pimDriverCam: { templateKey: "CAMERA" },
      etc: { templateKey: "ETC" },
    },
  });

  assert.deepStrictEqual(result, {
    "{{CAMERA}}": "    - [Notion] 설정 처리 수정\n      ↳ 검증: 회귀 테스트를 통과했다.",
    "{{ETC}}": "  - [Notion] 설정 처리 수정\n    ↳ 검증: 회귀 테스트를 통과했다.",
  });
});

test("briefing under an unrelated Git title cannot suppress a Notion item's evidence", () => {
  const result = mergeItemsIntoAutoContent({
    "{{CAMERA}}": [
      "    - 노출 결함 수정",
      "    - 색상 결함 수정",
      "      ↳ 검증: 네 회차 검증을 통과했다.",
    ].join("\n"),
  }, [{
    category: "pimDriverCam",
    title: "노출 결함 수정",
    briefing: { verification: "네 회차 검증을 통과했다." },
  }], [], {
    categories: { pimDriverCam: { templateKey: "CAMERA" } },
  });

  assert.strictEqual(result["{{CAMERA}}"], [
    "    - 노출 결함 수정",
    "    - 색상 결함 수정",
    "      ↳ 검증: 네 회차 검증을 통과했다.",
    "    - [Notion] 노출 결함 수정",
    "      ↳ 검증: 네 회차 검증을 통과했다.",
  ].join("\n"));
});

for (const { name, briefing, gitDetails } of [
  { name: "no briefing", briefing: undefined, gitDetails: [] },
  { name: "blank briefing", briefing: { cause: "  ", fix: null }, gitDetails: [] },
  {
    name: "already rendered briefing",
    briefing: { cause: "두 채널의 노출값이 달랐다." },
    gitDetails: ["      ↳ 원인: 두 채널의 노출값이 달랐다."],
  },
]) {
  test(`duplicate Notion title with ${name} adds no report row`, () => {
    const gitResult = {
      "{{CAMERA}}": ["    - 노출 결함 수정", ...gitDetails].join("\n"),
    };
    const result = mergeItemsIntoAutoContent(gitResult, [{
      source: "notion",
      category: "pimDriverCam",
      title: "노출 결함 수정",
      briefing,
    }], [], {
      categories: { pimDriverCam: { templateKey: "CAMERA" } },
    });

    assert.deepStrictEqual(result, gitResult);
  });
}

test("session fallback preserves category coverage and duplicate title handling", () => {
  const result = mergeItemsIntoAutoContent({
    "{{CAMERA}}": "    - 노출 결함 수정",
  }, [], [{
    category: "pimDriverCam",
    title: "이미 보고된 카테고리의 세션 기록",
  }, {
    category: "etc",
    items: ["보고서 작성", "보고서 작성"],
    briefing: { cause: "Notion 전용 상세" },
  }], {
    categories: {
      pimDriverCam: { templateKey: "CAMERA" },
      etc: { templateKey: "ETC" },
    },
  });

  assert.deepStrictEqual(result, {
    "{{CAMERA}}": "    - 노출 결함 수정",
    "{{ETC}}": "  - [CC] 보고서 작성",
  });
});
