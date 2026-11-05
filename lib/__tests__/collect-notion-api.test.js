const { test } = require("node:test");
const assert = require("node:assert");
const {
  extractDate,
  collectNotionItems,
  fetchNotionPage,
  getPresentationNoteSchemaWarning,
  extractMultiSelect,
  formatDateInTimeZone,
  pageWithinRange,
  queryDatabase,
  retainPresentationTaggedPage,
} = require("../collect-notion-api");

const START = "2026-10-28T06:00:00+09:00";
const END = "2026-11-04T05:59:59.999+09:00";

function notionCollectionConfig(presentationNoteMode = "suggest") {
  return {
    env: { presentationNoteMode },
    sources: { notion: { enabled: true, searchKeywords: ["fixture"] } },
  };
}

function emptyNotionQuery() {
  return new Response(JSON.stringify({ object: "list", results: [], has_more: false }), {
    headers: { "content-type": "application/json" },
  });
}

function knowledgeBaseMetadata(options = [{ name: "발표노트" }]) {
  return {
    object: "database",
    properties: { tags: { type: "multi_select", multi_select: { options } } },
  };
}

test("reference page lookup uses only GET with a validated UUID and sanitizes HTTP failures", async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  assert.deepStrictEqual(await fetchNotionPage('fixture-key', id, async (url, options) => {
    assert.strictEqual(url, `https://api.notion.com/v1/pages/${id}`);
    assert.strictEqual(options.method, undefined);
    assert.strictEqual(options.body, undefined);
    return { ok: true, json: async () => ({ id }) };
  }), { id });
  await assert.rejects(fetchNotionPage('fixture-key', '../elsewhere', async () => assert.fail('fetch')), { code: 'NOTION_PAGE_INVALID' });
  await assert.rejects(fetchNotionPage('', id, async () => assert.fail('fetch')), { code: 'NOTION_PAGE_INVALID' });
  await assert.rejects(fetchNotionPage('fixture-key', id, async () => ({ ok: false, status: 403,
    text: async () => 'secret response' })), error => error.code === 'NOTION_HTTP_FAILED'
    && error.status === 403 && !error.message.includes('secret'));
});

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
    (error) => {
      assert.strictEqual(error.code, "NOTION_HTTP_FAILED");
      assert.strictEqual(error.status, 429);
      assert.doesNotMatch(error.message, /rate limited/);
      return true;
    }
  );
});

test("extractMultiSelect retains the presentation-note tag", () => {
  assert.deepStrictEqual(
    extractMultiSelect({ properties: { tags: { type: "multi_select", multi_select: [{ name: "발표노트" }] } } }, "tags"),
    ["발표노트"]
  );
});

test("empty KB collection warns when the presentation-note schema option is missing", async (t) => {
  const metadataUrl = "https://api.notion.com/v1/databases/ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
  t.mock.method(global, "fetch", async (url, options = {}) => {
    if (url === metadataUrl && (options.method || "GET") === "GET") {
      return new Response(JSON.stringify({
        object: "database",
        properties: { tags: { type: "multi_select", multi_select: { options: [{ name: "other" }] } } },
      }));
    }
    return emptyNotionQuery();
  });
  const consoleWarnings = [];
  const callbackWarnings = [];
  t.mock.method(console, "warn", (warning) => consoleWarnings.push(warning));

  const items = await collectNotionItems(
    notionCollectionConfig("auto"),
    START,
    END,
    "fixture-key",
    { onWarning: (warning) => callbackWarnings.push(warning) }
  );

  assert.deepStrictEqual(items, []);
  assert.deepStrictEqual(callbackWarnings, [
    "[issue][WARN] PRESENTATION_TAG_OPTION_MISSING: Knowledge Base의 tags 설정에서 발표노트 옵션을 확인하세요.",
  ]);
  assert.deepStrictEqual(consoleWarnings, callbackWarnings);
});

test("healthy presentation-note schema leaves an empty KB week warning-free", async (t) => {
  const metadataUrl = "https://api.notion.com/v1/databases/ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
  t.mock.method(global, "fetch", async (url, options = {}) => {
    if (url === metadataUrl && options.method === "GET") {
      return new Response(JSON.stringify(knowledgeBaseMetadata()));
    }
    return emptyNotionQuery();
  });
  const warnings = [];
  t.mock.method(console, "warn", (warning) => warnings.push(warning));

  assert.deepStrictEqual(await collectNotionItems(
    notionCollectionConfig(),
    START,
    END,
    "fixture-key",
    { onWarning: (warning) => warnings.push(warning) }
  ), []);
  assert.deepStrictEqual(warnings, []);
});

test("presentation-note schema lookup is one bounded GET with the pinned Notion version", async () => {
  const calls = [];
  const warning = await getPresentationNoteSchemaWarning("fixture-key", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(knowledgeBaseMetadata()));
  });

  assert.strictEqual(warning, null);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "https://api.notion.com/v1/databases/ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461");
  assert.strictEqual(calls[0].options.method, "GET");
  assert.strictEqual(calls[0].options.body, undefined);
  assert.strictEqual(calls[0].options.headers["Notion-Version"], "2022-06-28");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("presentation-note schema warnings distinguish missing, invalid, and unavailable shapes", async (t) => {
  const scenarios = [
    {
      name: "missing tags property",
      body: { object: "database", properties: {} },
      warning: "[issue][WARN] PRESENTATION_TAG_PROPERTY_MISSING: Knowledge Base에 tags 속성이 없습니다. tags 설정을 확인하세요.",
    },
    {
      name: "wrong tags property type",
      body: { object: "database", properties: { tags: { type: "select", select: { options: [] } } } },
      warning: "[issue][WARN] PRESENTATION_TAG_PROPERTY_INVALID: Knowledge Base의 tags 속성이 multi_select가 아닙니다. tags 설정을 확인하세요.",
    },
    {
      name: "missing presentation option",
      body: knowledgeBaseMetadata([{ name: "other" }]),
      warning: "[issue][WARN] PRESENTATION_TAG_OPTION_MISSING: Knowledge Base의 tags 설정에서 발표노트 옵션을 확인하세요.",
    },
    {
      name: "null database",
      body: null,
      warning: "[issue][WARN] PRESENTATION_TAG_SCHEMA_UNAVAILABLE: Knowledge Base tags 스키마를 조회할 수 없습니다. 접근 권한과 tags 설정을 확인하세요.",
    },
    {
      name: "malformed database object",
      body: { object: "page", properties: {} },
      warning: "[issue][WARN] PRESENTATION_TAG_SCHEMA_UNAVAILABLE: Knowledge Base tags 스키마를 조회할 수 없습니다. 접근 권한과 tags 설정을 확인하세요.",
    },
    {
      name: "null tags schema",
      body: { object: "database", properties: { tags: null } },
      warning: "[issue][WARN] PRESENTATION_TAG_SCHEMA_UNAVAILABLE: Knowledge Base tags 스키마를 조회할 수 없습니다. 접근 권한과 tags 설정을 확인하세요.",
    },
    {
      name: "malformed options",
      body: { object: "database", properties: { tags: { type: "multi_select", multi_select: { options: null } } } },
      warning: "[issue][WARN] PRESENTATION_TAG_SCHEMA_UNAVAILABLE: Knowledge Base tags 스키마를 조회할 수 없습니다. 접근 권한과 tags 설정을 확인하세요.",
    },
  ];

  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const warning = await getPresentationNoteSchemaWarning(
      "fixture-key",
      async () => new Response(JSON.stringify(scenario.body))
    );
    assert.strictEqual(warning, scenario.warning);
  });
});

test("presentation-note schema lookup sanitizes HTTP, JSON, and network failures", async (t) => {
  for (const status of [403, 404, 429]) await t.test(`HTTP ${status}`, async () => {
    const warning = await getPresentationNoteSchemaWarning(
      "PRIVATE_API_KEY",
      async () => new Response("PRIVATE_PROVIDER_BODY", { status })
    );
    assert.strictEqual(
      warning,
      `[issue][WARN] PRESENTATION_TAG_SCHEMA_UNAVAILABLE: Knowledge Base tags 스키마를 조회할 수 없습니다 (HTTP ${status}). 접근 권한과 tags 설정을 확인하세요.`
    );
    assert.doesNotMatch(warning, /PRIVATE/);
  });

  await t.test("invalid JSON", async () => {
    const warning = await getPresentationNoteSchemaWarning(
      "PRIVATE_API_KEY",
      async () => new Response("PRIVATE_JSON_BODY")
    );
    assert.strictEqual(warning, "[issue][WARN] PRESENTATION_TAG_SCHEMA_UNAVAILABLE: Knowledge Base tags 스키마를 조회할 수 없습니다. 접근 권한과 tags 설정을 확인하세요.");
    assert.doesNotMatch(warning, /PRIVATE|Unexpected token/);
  });

  await t.test("network failure", async () => {
    const warning = await getPresentationNoteSchemaWarning("PRIVATE_API_KEY", async () => {
      throw new Error("PRIVATE_NETWORK_FAILURE");
    });
    assert.strictEqual(warning, "[issue][WARN] PRESENTATION_TAG_SCHEMA_UNAVAILABLE: Knowledge Base tags 스키마를 조회할 수 없습니다. 접근 권한과 tags 설정을 확인하세요.");
    assert.doesNotMatch(warning, /PRIVATE/);
  });
});

test("healthy schema preserves a presentation-tagged report=none KB page", async (t) => {
  const metadataUrl = "https://api.notion.com/v1/databases/ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
  const kbQueryUrl = `${metadataUrl}/query`;
  let metadataCalls = 0;
  t.mock.method(global, "fetch", async (url, options = {}) => {
    if (url === metadataUrl && options.method === "GET") {
      metadataCalls++;
      return new Response(JSON.stringify(knowledgeBaseMetadata()));
    }
    if (url === kbQueryUrl) {
      return new Response(JSON.stringify({ results: [{
        id: "kb-page",
        url: "https://notion.invalid/kb-page",
        created_time: "2026-11-01T12:00:00+09:00",
        properties: {
          title: { type: "title", title: [{ plain_text: "발표 자료" }] },
          tags: { type: "multi_select", multi_select: [{ name: "발표노트" }] },
          report: { type: "select", select: { name: "none" } },
        },
      }], has_more: false }));
    }
    return emptyNotionQuery();
  });
  const warnings = [];
  t.mock.method(console, "warn", (warning) => warnings.push(warning));

  const items = await collectNotionItems(notionCollectionConfig(), START, END, "fixture-key", {
    onWarning: (warning) => warnings.push(warning),
  });

  assert.strictEqual(metadataCalls, 1);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0].tags, ["발표노트"]);
  assert.strictEqual(items[0].reportExcluded, true);
});

test("presentation mode off skips metadata without changing empty collection", async (t) => {
  const metadataUrl = "https://api.notion.com/v1/databases/ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
  t.mock.method(global, "fetch", async (url, options = {}) => {
    assert.ok(!(url === metadataUrl && options.method === "GET"), "metadata GET must be skipped");
    return emptyNotionQuery();
  });
  const warnings = [];
  t.mock.method(console, "warn", (warning) => warnings.push(warning));

  assert.deepStrictEqual(
    await collectNotionItems(notionCollectionConfig("off"), START, END, "fixture-key", {
      onWarning: (warning) => warnings.push(warning),
    }),
    []
  );
  assert.deepStrictEqual(warnings, []);
});

test("missing key and disabled Notion source do not perform metadata reads", async (t) => {
  t.mock.method(global, "fetch", async () => assert.fail("fetch must not run"));
  t.mock.method(console, "warn", () => {});

  assert.deepStrictEqual(await collectNotionItems(notionCollectionConfig(), START, END, ""), []);
  assert.deepStrictEqual(await collectNotionItems(
    { env: { presentationNoteMode: "suggest" }, sources: { notion: { enabled: false } } },
    START,
    END,
    "fixture-key"
  ), []);
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
