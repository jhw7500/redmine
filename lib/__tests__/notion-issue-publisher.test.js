const { test } = require("node:test");
const assert = require("node:assert");
const {
  reportLabel,
  buildSubject,
  buildDescription,
  closeIssue,
  closePresentedNotes,
  createIssue,
  extractMarkerPageId,
  hasMarker,
  publishNotes,
  queryCompletedNotes,
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
      body = { issue: { id: 100 + issuePosts, status: { id: 9 } } };
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

// #61 — Redmine은 허용되지 않은 status_id를 오류 없이 무시하고 기본 상태로 생성한다.
// 응답의 status를 대조하지 않으면 호출부가 이를 알 수 없다.
function stubCreateIssueFetch(t, issueBody) {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.includes("/issues.json") || options.method !== "POST") {
      throw new Error(`unexpected fake URL: ${target}`);
    }
    const body = { issue: issueBody };
    return {
      ok: true,
      status: 201,
      statusText: "Created",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

const CREATE_ENV = { redmineBase: "http://127.0.0.1:3000", redmineKey: "test-key" };
const CREATE_META = { projectId: 7, trackerId: 8, statusId: 9, assigneeId: 10 };
const CREATE_NOTE = { pageId: "page-1", title: "첫 발표", notionUrl: "http://notion/1", report: "wlan" };

test("createIssue rejects when the created issue status differs from the requested one", async (t) => {
  stubCreateIssueFetch(t, { id: 4823, status: { id: 1, name: "신규" } });
  await assert.rejects(
    () => createIssue(CREATE_ENV, CREATE_META, CREATE_NOTE, "# 본문", "2026-09-02"),
    /status_id 미반영/
  );
});

test("createIssue rejects when the response carries no status to verify", async (t) => {
  stubCreateIssueFetch(t, { id: 4823 });
  await assert.rejects(
    () => createIssue(CREATE_ENV, CREATE_META, CREATE_NOTE, "# 본문", "2026-09-02"),
    /응답에 status가 없어/
  );
});

test("createIssue rejects when meta carries no statusId to verify against", async (t) => {
  stubCreateIssueFetch(t, { id: 4823, status: { id: 9, name: "검토" } });
  await assert.rejects(
    () => createIssue(CREATE_ENV, { ...CREATE_META, statusId: undefined }, CREATE_NOTE, "# 본문", "2026-09-02"),
    /statusId가 없어/
  );
});

// 해피패스 가드 — 되돌려도 통과하므로 #61 수정의 증거가 아니다. 과잉 거부와 반환 형태를 고정한다.
test("createIssue returns the id when the requested status is applied", async (t) => {
  stubCreateIssueFetch(t, { id: 4823, status: { id: 9, name: "검토" } });
  const r = await createIssue(CREATE_ENV, CREATE_META, CREATE_NOTE, "# 본문", "2026-09-02");
  assert.deepStrictEqual(r, { id: 4823 });
});

// #61 후속 — 불일치를 감지하되 생성된 이슈를 보고서에서 버리지 않는다.
function stubPublishFetch(t, { post, list }) {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = { posts: 0 };
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
      calls.posts += 1;
      body = { issue: post };
    } else if (target.includes("/issues.json")) {
      body = { issues: list || [], total_count: (list || []).length };
    } else if (target.includes("api.notion.com/v1/blocks/")) {
      body = { results: [], has_more: false };
    } else {
      throw new Error(`unexpected fake URL: ${target}`);
    }
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => body, text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

const PUBLISH_ENV = {
  redmineBase: "http://127.0.0.1:3000",
  redmineKey: "test-key",
  notionKey: "test-notion",
  projectIdentifier: "p",
};
const PUBLISH_NOTES = [{ pageId: "page-1", title: "첫 발표", notionUrl: "http://notion/1", report: "wlan" }];

test("publishNotes keeps a status-mismatched new issue in refs instead of dropping it", async (t) => {
  stubPublishFetch(t, { post: { id: 4823, status: { id: 1, name: "신규" } } });
  const refs = await publishNotes(PUBLISH_ENV, PUBLISH_NOTES);
  assert.strictEqual(refs.length, 1, "생성된 이슈가 보고서 참조에서 누락되면 안 된다");
  assert.strictEqual(refs[0].id, 4823);
  assert.strictEqual(refs[0].reused, false);
  assert.strictEqual(refs[0].statusMismatch, true);
});

test("publishNotes flags a reused issue whose status differs from the requested one", async (t) => {
  const calls = stubPublishFetch(t, {
    post: { id: 9999, status: { id: 9 } },
    list: [{ id: 4597, description: "> Notion-Page-Id: page-1", status: { id: 1, name: "신규" } }],
  });
  const refs = await publishNotes(PUBLISH_ENV, PUBLISH_NOTES);
  assert.strictEqual(calls.posts, 0, "재사용 경로에서 중복 생성이 일어나면 안 된다");
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].id, 4597);
  assert.strictEqual(refs[0].reused, true);
  assert.strictEqual(refs[0].statusMismatch, true);
});

test("publishNotes marks a reused issue with the expected status as matching", async (t) => {
  stubPublishFetch(t, {
    post: { id: 9999, status: { id: 9 } },
    list: [{ id: 4597, description: "> Notion-Page-Id: page-1", status: { id: 9, name: "검토" } }],
  });
  const refs = await publishNotes(PUBLISH_ENV, PUBLISH_NOTES);
  assert.strictEqual(refs[0].statusMismatch, false);
});

// #62 — 종료 기계장치. Redmine 쓰기의 세 함정(열린 하위, 워크플로 전이 부재,
// 204를 주면서 status_id만 무시)을 각각 고정한다.
function stubCloseFetch(t, { before, openChildren = 0, after }) {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = { puts: 0, lastBody: null };
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (options.method === "PUT") {
      calls.puts += 1;
      calls.lastBody = JSON.parse(options.body);
      // 실제 Redmine은 204 No Content — 본문이 없어 res.json()은 throw한다.
      return {
        ok: true, status: 204, statusText: "No Content",
        json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
        text: async () => "",
      };
    }
    let body;
    if (target.includes("parent_id=")) {
      body = { issues: [], total_count: openChildren };
    } else if (target.includes("include=allowed_statuses")) {
      body = { issue: before };
    } else if (/\/issues\/\d+\.json/.test(target)) {
      body = { issue: after || before };
    } else {
      throw new Error(`unexpected fake URL: ${target}`);
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
  };
  return calls;
}

const CLOSE_ENV = { redmineBase: "http://127.0.0.1:3000", redmineKey: "test-key" };
const ALLOWED_ALL = [{ id: 2, name: "진행" }, { id: 5, name: "완료" }, { id: 6, name: "거절" }];

test("closeIssue refuses while open subtasks remain and does not write", async (t) => {
  const calls = stubCloseFetch(t, {
    before: { id: 4597, status: { id: 7, name: "검토" }, allowed_statuses: ALLOWED_ALL },
    openChildren: 2,
  });
  await assert.rejects(() => closeIssue(CLOSE_ENV, 4597, 5), /열린 하위 이슈/);
  assert.strictEqual(calls.puts, 0, "차단 조건에서 쓰기가 나가면 안 된다");
});

test("closeIssue refuses when the tracker workflow has no transition to the target", async (t) => {
  const calls = stubCloseFetch(t, {
    before: { id: 1058, status: { id: 2, name: "진행" }, allowed_statuses: [{ id: 2, name: "진행" }, { id: 5, name: "완료" }] },
  });
  await assert.rejects(() => closeIssue(CLOSE_ENV, 1058, 6), /전이가 없다/);
  assert.strictEqual(calls.puts, 0);
});

test("closeIssue throws when the write returns 204 but the status did not change", async (t) => {
  const calls = stubCloseFetch(t, {
    before: { id: 4597, status: { id: 7, name: "검토" }, allowed_statuses: ALLOWED_ALL },
    after: { id: 4597, status: { id: 7, name: "검토" } },
  });
  await assert.rejects(() => closeIssue(CLOSE_ENV, 4597, 5), /미반영/);
  assert.strictEqual(calls.puts, 1, "쓰기는 나갔고 검증에서 걸려야 한다");
});

test("closeIssue closes and verifies the result by re-fetching", async (t) => {
  const calls = stubCloseFetch(t, {
    before: { id: 4597, status: { id: 7, name: "검토" }, allowed_statuses: ALLOWED_ALL },
    after: { id: 4597, status: { id: 5, name: "완료", is_closed: true } },
  });
  const r = await closeIssue(CLOSE_ENV, 4597, 5, { notes: "자동 종료" });
  assert.deepStrictEqual(r, { id: 4597, statusId: 5, changed: true });
  assert.strictEqual(calls.puts, 1);
  assert.strictEqual(calls.lastBody.issue.status_id, 5);
  assert.strictEqual(calls.lastBody.issue.notes, "자동 종료");
});

test("closeIssue is idempotent when the issue already carries the target status", async (t) => {
  const calls = stubCloseFetch(t, {
    before: { id: 4597, status: { id: 5, name: "완료", is_closed: true }, allowed_statuses: ALLOWED_ALL },
  });
  const r = await closeIssue(CLOSE_ENV, 4597, 5);
  assert.deepStrictEqual(r, { id: 4597, statusId: 5, changed: false });
  assert.strictEqual(calls.puts, 0);
});

// #62 트리거 — 발표완료 태그로 대응 이슈를 종료한다.
// 종료 표시는 노트 생성 몇 주 뒤에 붙을 수 있으므로 주간 수집 스냅샷에 의존하면 안 된다.

test("extractMarkerPageId pulls the page id back out of a description", () => {
  const d = buildDescription({ pageId: "abc-123", notionUrl: "http://n/abc" }, "본문", "2026-09-02");
  assert.strictEqual(extractMarkerPageId(d), "abc-123");
  assert.strictEqual(extractMarkerPageId("마커 없는 본문"), null);
  assert.strictEqual(extractMarkerPageId(null), null);
});

function stubClosePipeline(t, { statuses, issues, notionPages, afterById = {} }) {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = { puts: 0, notionBodies: [], closedIds: [] };
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (options.method === "PUT") {
      const m = /\/issues\/(\d+)\.json/.exec(target);
      calls.puts += 1;
      calls.closedIds.push(Number(m[1]));
      return { ok: true, status: 204, statusText: "No Content",
        json: async () => { throw new SyntaxError("no body"); }, text: async () => "" };
    }
    let body;
    if (target.includes("api.notion.com") && options.method === "POST") {
      calls.notionBodies.push(JSON.parse(options.body));
      body = { results: notionPages, has_more: false };
    } else if (target.includes("/projects/p.json")) {
      body = { project: { id: 7, trackers: [{ id: 8, name: "새기능" }] } };
    } else if (target.includes("/issue_statuses.json")) {
      body = { issue_statuses: statuses };
    } else if (target.includes("/users/current.json")) {
      body = { user: { id: 10 } };
    } else if (target.includes("parent_id=")) {
      body = { issues: [], total_count: 0 };
    } else if (target.includes("/projects/p/issues.json")) {
      body = { issues, total_count: issues.length };
    } else if (/\/issues\/(\d+)\.json/.test(target)) {
      const id = Number(/\/issues\/(\d+)\.json/.exec(target)[1]);
      const base = issues.find((x) => x.id === id);
      const done = calls.closedIds.includes(id);
      body = { issue: done ? afterById[id] : { ...base, allowed_statuses: [{ id: 5, name: "완료" }, { id: 7, name: "검토" }] } };
    } else {
      throw new Error(`unexpected fake URL: ${target}`);
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
  };
  return calls;
}

const CLOSE_STATUSES = [{ id: 7, name: "검토" }, { id: 5, name: "완료" }];
const CLOSE_PIPE_ENV = {
  redmineBase: "http://127.0.0.1:3000", redmineKey: "k",
  notionKey: "n", projectIdentifier: "p",
};

test("queryCompletedNotes filters by tag with no date window", async (t) => {
  const calls = stubClosePipeline(t, {
    statuses: CLOSE_STATUSES, issues: [],
    notionPages: [{
      id: "page-1", url: "http://notion/1",
      properties: { title: { type: "title", title: [{ plain_text: "발표한 노트" }] } },
    }],
  });
  const notes = await queryCompletedNotes(CLOSE_PIPE_ENV);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].pageId, "page-1");
  const body = calls.notionBodies[0];
  assert.strictEqual(JSON.stringify(body.filter).includes("발표완료"), true);
  assert.strictEqual(JSON.stringify(body).includes("created_time"), false,
    "종료 표시는 생성 주간과 무관하므로 날짜 필터가 있으면 안 된다");
});

test("closePresentedNotes closes the issue matched by the page marker", async (t) => {
  const calls = stubClosePipeline(t, {
    statuses: CLOSE_STATUSES,
    issues: [{ id: 4597, description: "> Notion-Page-Id: page-1", status: { id: 7, name: "검토" } }],
    notionPages: [],
    afterById: { 4597: { id: 4597, status: { id: 5, name: "완료", is_closed: true } } },
  });
  const closed = await closePresentedNotes(CLOSE_PIPE_ENV, [{ pageId: "page-1", title: "발표한 노트" }]);
  assert.strictEqual(calls.puts, 1);
  assert.deepStrictEqual(calls.closedIds, [4597]);
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(closed[0].id, 4597);
  assert.strictEqual(closed[0].changed, true);
});

test("closePresentedNotes skips a note that has no matching issue", async (t) => {
  const calls = stubClosePipeline(t, {
    statuses: CLOSE_STATUSES,
    issues: [{ id: 4597, description: "> Notion-Page-Id: other-page", status: { id: 7, name: "검토" } }],
    notionPages: [],
  });
  const closed = await closePresentedNotes(CLOSE_PIPE_ENV, [{ pageId: "page-1", title: "대응 없음" }]);
  assert.strictEqual(calls.puts, 0);
  assert.strictEqual(closed.length, 0);
});

test("closePresentedNotes does not rewrite an issue already at the close status", async (t) => {
  const calls = stubClosePipeline(t, {
    statuses: CLOSE_STATUSES,
    issues: [{ id: 4597, description: "> Notion-Page-Id: page-1", status: { id: 5, name: "완료" } }],
    notionPages: [],
  });
  const closed = await closePresentedNotes(CLOSE_PIPE_ENV, [{ pageId: "page-1", title: "이미 종료" }]);
  assert.strictEqual(calls.puts, 0, "멱등이어야 한다");
  assert.strictEqual(closed.length, 0);
});

test("queryCompletedNotes treats a never-used tag as zero completed notes", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  // Notion은 존재하지 않는 multi_select 옵션으로 필터하면 400 validation_error를 낸다.
  global.fetch = async () => ({
    ok: false, status: 400, statusText: "Bad Request",
    text: async () => JSON.stringify({
      object: "error", code: "validation_error",
      message: 'multi_select option "발표완료" not found for property "tags".',
    }),
    json: async () => ({}),
  });
  const notes = await queryCompletedNotes(CLOSE_PIPE_ENV);
  assert.deepStrictEqual(notes, [], "태그를 아직 아무도 안 쓴 상태는 오류가 아니라 0건이다");
});

test("queryCompletedNotes still propagates unrelated failures", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    ok: false, status: 401, statusText: "Unauthorized",
    text: async () => JSON.stringify({ object: "error", code: "unauthorized", message: "API token is invalid." }),
    json: async () => ({}),
  });
  await assert.rejects(() => queryCompletedNotes(CLOSE_PIPE_ENV), /401/);
});
