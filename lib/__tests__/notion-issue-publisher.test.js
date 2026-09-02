const { test } = require("node:test");
const assert = require("node:assert");
const {
  reportLabel,
  buildSubject,
  buildDescription,
  closeIssue,
  createIssue,
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
