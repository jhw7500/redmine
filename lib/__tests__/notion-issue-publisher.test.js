const { test } = require("node:test");
const assert = require("node:assert");
const {
  reportLabel,
  buildSubject,
  buildDescription,
  hasMarker,
  publishNotes,
  renderNotesBlock,
} = require("../notion-issue-publisher");

test("reportLabel", () => {
  assert.strictEqual(reportLabel("wlan-bsp"), "WLAN-BSP");
  assert.strictEqual(reportLabel(""), "GEN");
});

test("buildSubject", () => {
  assert.strictEqual(
    buildSubject({ report: "wlan-bsp", title: "regulatory.db 커널 임베드" }),
    "[WLAN-BSP] regulatory.db 커널 임베드"
  );
});

test("buildDescription embeds marker + source", () => {
  const d = buildDescription({ pageId: "abc-123", notionUrl: "http://n/abc" }, "# 본문\n내용", "2026-07-02");
  assert.match(d, /# 본문/);
  assert.match(d, /Notion-Page-Id: abc-123/);
  assert.match(d, /출처: Notion KB — http:\/\/n\/abc/);
  assert.ok(hasMarker(d, "abc-123"));
  assert.ok(!hasMarker(d, "zzz-999"));
});

test("renderNotesBlock", () => {
  assert.strictEqual(renderNotesBlock([]), "");
  const b = renderNotesBlock([{ id: 12, title: "regulatory.db 커널 임베드" }]);
  assert.match(b, /\*\*발표노트\(상세\)\*\*/);
  assert.match(b, /- regulatory\.db 커널 임베드 — #12/);
});

test("publishNotes checks readiness immediately before every issue creation", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let issuePosts = 0;
  let evidenceValid = true;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    let body;
    if (target.includes("/projects/p.json")) {
      body = { project: { id: 7, trackers: [{ id: 8, name: "새기능" }] } };
    } else if (target.includes("/issue_statuses.json")) {
      body = { issue_statuses: [{ id: 9, name: "검토" }] };
    } else if (target.includes("/users/current.json")) {
      body = { user: { id: 10 } };
    } else if (target.includes("/issues.json") && options.method === "POST") {
      issuePosts += 1;
      evidenceValid = false;
      body = { issue: { id: 100 + issuePosts } };
    } else if (target.includes("/issues.json")) {
      body = { issues: [], total_count: 0 };
    } else if (target.includes("api.notion.com/v1/blocks/")) {
      body = { results: [], has_more: false };
    } else {
      throw new Error(`unexpected fake URL: ${target}`);
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  const env = {
    redmineBase: "http://127.0.0.1:3000",
    redmineKey: "test-key",
    notionKey: "test-notion",
    projectIdentifier: "p",
  };
  const notes = [
    { pageId: "page-1", title: "첫 발표", notionUrl: "http://notion/1", report: "wlan" },
    { pageId: "page-2", title: "둘째 발표", notionUrl: "http://notion/2", report: "wlan" },
  ];

  await assert.rejects(
    () => publishNotes(env, notes, {
      assertReady: () => {
        if (!evidenceValid) throw new Error("publish evidence invalid");
      },
    }),
    /publish evidence invalid/
  );
  assert.strictEqual(issuePosts, 1);
});
