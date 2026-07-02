# 발표노트 → Redmine 작업(Issue) 자동 등록 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notion KB의 `발표노트` 태그 항목을 Redmine `advance-development-team` 프로젝트의 작업(Issue)으로 자동 등록하고, 주간보고 Wiki에 `#id`로 연결한다.

**Architecture:** 기존 collector/AI 축약 경로를 건드리지 않는 독립 모듈 2개(`notion-blocks-to-md`, `notion-issue-publisher`) 추가. Phase 1은 CLI 수동 파일럿, Phase 2는 `generate`(depth3) 파이프라인 통합.

**Tech Stack:** Node 24 (CommonJS, global `fetch`), 테스트는 의존성 없는 `node --test`(`node:test`+`node:assert`). 신규 npm 의존성 없음.

## Global Constraints

- 대상 저장소: `/home/jhw/ai/opencode/projects/redmine`, 브랜치 `feat/notion-presentation-note-issue`.
- 신규 npm 의존성 추가 금지 (package.json 없음 유지). 전역 `fetch` 사용.
- 시크릿: `REDMINE_API_KEY`/`NOTION_API_KEY`는 `process.env`에서만 읽음. 코드/커밋/로그에 값 노출 금지.
- Redmine base `http://192.168.10.2:30002`, project identifier `advance-development-team`.
- 이슈 필드: tracker `검토`(id 9), status `검토`(id 7), assignee hwjo(id 36) — **id는 하드코딩 말고 이름으로 resolve**.
- KB DB id `ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461`, Notion-Version `2022-06-28`.
- 중복가드 마커: 이슈 description에 `Notion-Page-Id: <pageId>` (하이픈 포함 원문 36자, 그대로 비교).
- 커밋은 각 Task 끝에서. CommonJS 스타일·기존 `lib/*.js` 컨벤션 준수.

---

## File Structure

- Create `lib/notion-blocks-to-md.js` — Notion blocks → Markdown 직렬화(재귀·페이지네이션).
- Create `lib/notion-issue-publisher.js` — meta resolve, 발표노트 조회, 중복가드, 이슈 생성, refs 반환, CLI.
- Create `lib/__tests__/notion-blocks-to-md.test.js` — 블록→md 단위테스트.
- Create `lib/__tests__/notion-issue-publisher.test.js` — subject/description/중복가드/블록삽입 단위테스트.
- Modify `lib/publisher.js` — `generate` 경로에 "📎 발표노트(상세)" 블록 append 함수 추가/호출(Phase 2).
- Modify `index.js` — generate(depth3) 경로에서 `publishNotes` 호출 → refs를 generate에 전달(Phase 2).

순수 함수(포맷/직렬화/삽입)와 I/O(fetch)를 함수 경계로 분리해 I/O 없이 단위테스트 가능하게 한다.

---

## Phase 1 — 파일럿 (CLI 수동, cron 미변경)

### Task 1: `notion-blocks-to-md` — 인라인 rich_text 직렬화

**Files:**
- Create: `lib/notion-blocks-to-md.js`
- Test: `lib/__tests__/notion-blocks-to-md.test.js`

**Interfaces:**
- Produces: `richToMd(richArr) -> string` (rich_text 배열 → Markdown 인라인). annotations: bold `**`, italic `*`, code `` ` ``, link `[t](url)`.

- [ ] **Step 1: 실패 테스트 작성**

```js
// lib/__tests__/notion-blocks-to-md.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { richToMd } = require("../notion-blocks-to-md");

test("richToMd: plain/bold/code/link", () => {
  const rich = [
    { plain_text: "a ", annotations: {}, href: null },
    { plain_text: "bold", annotations: { bold: true }, href: null },
    { plain_text: " ", annotations: {}, href: null },
    { plain_text: "code", annotations: { code: true }, href: null },
    { plain_text: "link", annotations: {}, href: "http://x" },
  ];
  assert.strictEqual(richToMd(rich), "a **bold** `code` [link](http://x)");
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test lib/__tests__/notion-blocks-to-md.test.js` → FAIL (Cannot find module).

- [ ] **Step 3: 최소 구현**

```js
// lib/notion-blocks-to-md.js
function richToMd(richArr) {
  if (!Array.isArray(richArr)) return "";
  return richArr
    .map((t) => {
      let s = t.plain_text != null ? t.plain_text : "";
      const a = t.annotations || {};
      if (a.code) s = "`" + s + "`";
      if (a.bold) s = "**" + s + "**";
      if (a.italic) s = "*" + s + "*";
      if (t.href) s = "[" + s + "](" + t.href + ")";
      return s;
    })
    .join("");
}

module.exports = { richToMd };
```

- [ ] **Step 4: 통과 확인** — Run: `node --test lib/__tests__/notion-blocks-to-md.test.js` → PASS.

- [ ] **Step 5: 커밋** — `git add lib/notion-blocks-to-md.js lib/__tests__/notion-blocks-to-md.test.js && git commit -m "feat(notion): richToMd 인라인 직렬화"`

### Task 2: `notion-blocks-to-md` — 블록 → Markdown (순수, children 주입)

**Files:**
- Modify: `lib/notion-blocks-to-md.js`
- Test: `lib/__tests__/notion-blocks-to-md.test.js`

**Interfaces:**
- Produces: `blocksToMd(blocks) -> string`. `blocks`는 각 원소가 Notion block 객체이며, list/table 등 자식은 `block.__children`(배열)로 이미 주입돼 있다고 가정(I/O 분리). 지원: heading_1/2/3(`#`/`##`/`###`), paragraph, bulleted_list_item(`- `), numbered_list_item(`1. `), code(```lang 펜스), quote(`> `), divider(`---`), table(+table_row: `| a | b |`, 헤더 다음 구분행). 미지원: `<!-- unsupported: {type} -->` + plain 폴백.

- [ ] **Step 1: 실패 테스트 추가**

```js
const { blocksToMd } = require("../notion-blocks-to-md");

test("blocksToMd: heading/para/list/code", () => {
  const blocks = [
    { type: "heading_2", heading_2: { rich_text: [{ plain_text: "제목", annotations: {} }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "본문", annotations: {} }] } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "항목", annotations: {} }] } },
    { type: "code", code: { language: "bash", rich_text: [{ plain_text: "iw reg get", annotations: {} }] } },
    { type: "divider", divider: {} },
  ];
  const md = blocksToMd(blocks);
  assert.match(md, /## 제목/);
  assert.match(md, /\n본문\n/);
  assert.match(md, /- 항목/);
  assert.match(md, /```bash\niw reg get\n```/);
  assert.match(md, /\n---\n/);
});

test("blocksToMd: table with header row", () => {
  const row = (a, b) => ({ type: "table_row", table_row: { cells: [[{ plain_text: a, annotations: {} }], [{ plain_text: b, annotations: {} }]] } });
  const blocks = [{ type: "table", table: {}, __children: [row("k", "v"), row("1", "2")] }];
  const md = blocksToMd(blocks);
  assert.match(md, /\| k \| v \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| 1 \| 2 \|/);
});

test("blocksToMd: unsupported fallback", () => {
  const md = blocksToMd([{ type: "callout", callout: { rich_text: [{ plain_text: "hi", annotations: {} }] } }]);
  assert.match(md, /<!-- unsupported: callout -->/);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test lib/__tests__/notion-blocks-to-md.test.js` → FAIL.

- [ ] **Step 3: 구현 추가** (`richToMd` 아래, exports 위)

```js
function tableRowMd(cells) {
  return "| " + cells.map((c) => richToMd(c).replace(/\|/g, "\\|")).join(" | ") + " |";
}

function blocksToMd(blocks) {
  const out = [];
  let numberCounter = 0;
  for (const b of blocks || []) {
    const t = b.type;
    const data = b[t] || {};
    if (t !== "numbered_list_item") numberCounter = 0;
    switch (t) {
      case "heading_1": out.push("# " + richToMd(data.rich_text)); break;
      case "heading_2": out.push("## " + richToMd(data.rich_text)); break;
      case "heading_3": out.push("### " + richToMd(data.rich_text)); break;
      case "paragraph": out.push(richToMd(data.rich_text)); break;
      case "bulleted_list_item": out.push("- " + richToMd(data.rich_text)); break;
      case "numbered_list_item": out.push(++numberCounter + ". " + richToMd(data.rich_text)); break;
      case "quote": out.push("> " + richToMd(data.rich_text)); break;
      case "code":
        out.push("```" + (data.language || "") + "\n" + richToMd(data.rich_text) + "\n```");
        break;
      case "divider": out.push("---"); break;
      case "table": {
        const rows = (b.__children || []).filter((c) => c.type === "table_row");
        if (rows.length) {
          const cellsOf = (r) => (r.table_row.cells || []);
          out.push(tableRowMd(cellsOf(rows[0])));
          out.push("| " + cellsOf(rows[0]).map(() => "---").join(" | ") + " |");
          for (const r of rows.slice(1)) out.push(tableRowMd(cellsOf(r)));
        }
        break;
      }
      default:
        out.push("<!-- unsupported: " + t + " -->" + (data.rich_text ? "\n" + richToMd(data.rich_text) : ""));
    }
  }
  return out.join("\n\n") + "\n";
}
```
그리고 exports 갱신: `module.exports = { richToMd, blocksToMd };`

- [ ] **Step 4: 통과 확인** — Run: `node --test lib/__tests__/notion-blocks-to-md.test.js` → PASS (4 tests).

- [ ] **Step 5: 커밋** — `git add -A lib && git commit -m "feat(notion): blocksToMd 블록→Markdown 직렬화"`

### Task 3: `notion-issue-publisher` — subject/description 조립 (순수)

**Files:**
- Create: `lib/notion-issue-publisher.js`
- Test: `lib/__tests__/notion-issue-publisher.test.js`

**Interfaces:**
- Produces:
  - `reportLabel(report) -> string` (`wlan-bsp`→`WLAN-BSP`; falsy→`GEN`).
  - `buildSubject(note) -> string` = `[${reportLabel(note.report)}] ${note.title}`.
  - `buildDescription(note, md, dateStr) -> string` = 본문 md + footer(출처 URL, `Notion-Page-Id: <id>`, 자동생성일).
  - `MARKER_PREFIX = "Notion-Page-Id:"`.
  - `hasMarker(description, pageId) -> boolean`.

- [ ] **Step 1: 실패 테스트**

```js
// lib/__tests__/notion-issue-publisher.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { reportLabel, buildSubject, buildDescription, hasMarker } = require("../notion-issue-publisher");

test("reportLabel", () => {
  assert.strictEqual(reportLabel("wlan-bsp"), "WLAN-BSP");
  assert.strictEqual(reportLabel(""), "GEN");
});

test("buildSubject", () => {
  assert.strictEqual(buildSubject({ report: "wlan-bsp", title: "regulatory.db 커널 임베드" }), "[WLAN-BSP] regulatory.db 커널 임베드");
});

test("buildDescription embeds marker + source", () => {
  const d = buildDescription({ pageId: "abc-123", notionUrl: "http://n/abc" }, "# 본문\n내용", "2026-07-02");
  assert.match(d, /# 본문/);
  assert.match(d, /Notion-Page-Id: abc-123/);
  assert.match(d, /출처: Notion KB — http:\/\/n\/abc/);
  assert.ok(hasMarker(d, "abc-123"));
  assert.ok(!hasMarker(d, "zzz-999"));
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test lib/__tests__/notion-issue-publisher.test.js` → FAIL.

- [ ] **Step 3: 최소 구현** (I/O 없는 부분만; fetch 함수는 Task 4~5에서 추가)

```js
// lib/notion-issue-publisher.js
const MARKER_PREFIX = "Notion-Page-Id:";

function reportLabel(report) {
  if (!report) return "GEN";
  return String(report).toUpperCase();
}

function buildSubject(note) {
  return `[${reportLabel(note.report)}] ${note.title}`;
}

function buildDescription(note, md, dateStr) {
  return (
    md.trimEnd() +
    "\n\n---\n" +
    `> 📎 출처: Notion KB — ${note.notionUrl}\n` +
    `> ${MARKER_PREFIX} ${note.pageId}\n` +
    `> 자동 생성: redmine weekly (${dateStr})\n`
  );
}

function hasMarker(description, pageId) {
  return typeof description === "string" && description.includes(`${MARKER_PREFIX} ${pageId}`);
}

module.exports = { MARKER_PREFIX, reportLabel, buildSubject, buildDescription, hasMarker };
```

- [ ] **Step 4: 통과 확인** — Run: `node --test lib/__tests__/notion-issue-publisher.test.js` → PASS.

- [ ] **Step 5: 커밋** — `git add -A lib && git commit -m "feat(notion): 이슈 subject/description 조립 + 마커"`

### Task 4: `notion-issue-publisher` — Notion/Redmine I/O 함수

**Files:**
- Modify: `lib/notion-issue-publisher.js`

**Interfaces:**
- Produces (모두 async, `env`는 `{redmineBase, redmineKey, notionKey, projectIdentifier}`):
  - `resolveMeta(env) -> {projectId, trackerId, statusId, assigneeId}` — `/projects/{ident}.json`,`/trackers.json`,`/issue_statuses.json`,`/users/current.json`에서 이름(`검토`/`검토`)·current user로 확정. 실패 시 throw.
  - `fetchPageMarkdown(env, pageId) -> string` — `blocks/{id}/children` 재귀(has_more 페이지네이션), 자식 있는 블록은 `__children` 주입 후 `blocksToMd`.
  - `queryPresentationNotes(env, startDate, endDate) -> [{pageId, title, notionUrl, report, createdDate}]` — KB DB query: created_time ∈ [start,end] AND `tags` multi_select contains `발표노트`. `report`는 select명.
  - `findExistingIssue(env, meta, pageId) -> issueId|null` — `/projects/{ident}/issues.json?limit=100&status_id=*`(offset 페이지네이션) description에서 `hasMarker`.
  - `createIssue(env, meta, note, md, dateStr) -> {id}` — `POST /issues.json`.

- [ ] **Step 1: 구현 추가** (exports에 추가)

```js
const { blocksToMd } = require("./notion-blocks-to-md");
const NOTION_VERSION = "2022-06-28";
const KB_DB_ID = "ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
const PRESENTATION_TAG = "발표노트";

function nh(env) { return { Authorization: `Bearer ${env.notionKey}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" }; }
function rh(env) { return { "X-Redmine-API-Key": env.redmineKey, "Content-Type": "application/json" }; }

async function resolveMeta(env) {
  const B = env.redmineBase, P = env.projectIdentifier;
  const proj = await (await fetch(`${B}/projects/${P}.json`, { headers: rh(env) })).json();
  const trk = await (await fetch(`${B}/trackers.json`, { headers: rh(env) })).json();
  const st = await (await fetch(`${B}/issue_statuses.json`, { headers: rh(env) })).json();
  const me = await (await fetch(`${B}/users/current.json`, { headers: rh(env) })).json();
  const tracker = (trk.trackers || []).find((t) => t.name === "검토");
  const status = (st.issue_statuses || []).find((s) => s.name === "검토");
  if (!proj.project || !tracker || !status || !me.user) throw new Error("resolveMeta: 필수 메타 조회 실패");
  return { projectId: proj.project.id, trackerId: tracker.id, statusId: status.id, assigneeId: me.user.id };
}

async function notionBlockChildren(env, blockId) {
  const all = [];
  let cursor;
  do {
    const u = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    u.searchParams.set("page_size", "100");
    if (cursor) u.searchParams.set("start_cursor", cursor);
    const res = await fetch(u, { headers: nh(env) });
    if (!res.ok) throw new Error(`notion children ${res.status}`);
    const data = await res.json();
    for (const blk of data.results || []) {
      if (blk.has_children) blk.__children = await notionBlockChildren(env, blk.id);
      all.push(blk);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

async function fetchPageMarkdown(env, pageId) {
  const blocks = await notionBlockChildren(env, pageId);
  return blocksToMd(blocks);
}

function extractSelectName(page, prop) {
  const p = (page.properties || {})[prop];
  return p && p.type === "select" && p.select ? p.select.name : "";
}
function extractTitle(page) {
  for (const p of Object.values(page.properties || {})) {
    if (p.type === "title") return (p.title || []).map((t) => t.plain_text || "").join("");
  }
  return "";
}
function hasTag(page, prop, tag) {
  const p = (page.properties || {})[prop];
  return !!p && p.type === "multi_select" && (p.multi_select || []).some((o) => o.name === tag);
}

async function queryPresentationNotes(env, startDate, endDate) {
  const res = await fetch(`https://api.notion.com/v1/databases/${KB_DB_ID}/query`, {
    method: "POST",
    headers: nh(env),
    body: JSON.stringify({
      filter: { and: [
        { timestamp: "created_time", created_time: { on_or_after: startDate } },
        { timestamp: "created_time", created_time: { on_or_before: endDate } },
      ] },
      page_size: 100,
    }),
  });
  if (!res.ok) throw new Error(`notion KB query ${res.status}`);
  const data = await res.json();
  return (data.results || [])
    .filter((pg) => hasTag(pg, "tags", PRESENTATION_TAG))
    .map((pg) => ({ pageId: pg.id, title: extractTitle(pg), notionUrl: pg.url, report: extractSelectName(pg, "report"), createdDate: (pg.created_time || "").slice(0, 10) }));
}

async function findExistingIssue(env, meta, pageId) {
  const B = env.redmineBase, P = env.projectIdentifier;
  let offset = 0;
  for (;;) {
    const res = await fetch(`${B}/projects/${P}/issues.json?status_id=*&limit=100&offset=${offset}`, { headers: rh(env) });
    if (!res.ok) throw new Error(`redmine issues ${res.status}`);
    const data = await res.json();
    for (const it of data.issues || []) {
      if (hasMarker(it.description || "", pageId)) return it.id;
    }
    offset += (data.issues || []).length;
    if (offset >= (data.total_count || 0) || !(data.issues || []).length) break;
  }
  return null;
}

async function createIssue(env, meta, note, md, dateStr) {
  const res = await fetch(`${env.redmineBase}/issues.json`, {
    method: "POST",
    headers: rh(env),
    body: JSON.stringify({ issue: {
      project_id: meta.projectId,
      tracker_id: meta.trackerId,
      status_id: meta.statusId,
      assigned_to_id: meta.assigneeId,
      subject: buildSubject(note),
      description: buildDescription(note, md, dateStr),
    } }),
  });
  if (!res.ok) throw new Error(`redmine create ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { id: data.issue.id };
}
```
exports 갱신: `module.exports = { MARKER_PREFIX, reportLabel, buildSubject, buildDescription, hasMarker, resolveMeta, fetchPageMarkdown, queryPresentationNotes, findExistingIssue, createIssue };`

- [ ] **Step 2: 로드 스모크** — Run: `node -e "require('./lib/notion-issue-publisher')" ` → 무출력(문법 OK).

- [ ] **Step 3: 커밋** — `git add -A lib && git commit -m "feat(notion): Notion blocks fetch + Redmine 이슈 I/O"`

### Task 5: `publishNotes` 오케스트레이션 + CLI (`--page`, `--dry-run`)

**Files:**
- Modify: `lib/notion-issue-publisher.js`
- Test: `lib/__tests__/notion-issue-publisher.test.js`

**Interfaces:**
- Produces:
  - `publishNotes(env, notes, {dryRun}) -> [{id, title, notionUrl, reused}]` — notes 각각: `findExistingIssue`→있으면 reuse, 없으면 `fetchPageMarkdown`+`createIssue`. per-note try/catch(실패 skip+warn). meta는 1회 resolve.
  - `renderNotesBlock(refs) -> string` — `**📎 발표노트(상세)**\n- {title} — #{id}\n...` (refs 비면 "" 반환).
  - CLI: `--page <id>`(단건), `--start/--end`(기간 조회), `--dry-run`.

- [ ] **Step 1: renderNotesBlock 실패 테스트**

```js
const { renderNotesBlock } = require("../notion-issue-publisher");
test("renderNotesBlock", () => {
  assert.strictEqual(renderNotesBlock([]), "");
  const b = renderNotesBlock([{ id: 12, title: "regulatory.db 커널 임베드" }]);
  assert.match(b, /\*\*📎 발표노트\(상세\)\*\*/);
  assert.match(b, /- regulatory\.db 커널 임베드 — #12/);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test lib/__tests__/notion-issue-publisher.test.js` → FAIL.

- [ ] **Step 3: 구현 추가**

```js
function renderNotesBlock(refs) {
  if (!refs || !refs.length) return "";
  return "**📎 발표노트(상세)**\n" + refs.map((r) => `- ${r.title} — #${r.id}`).join("\n");
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function publishNotes(env, notes, opts = {}) {
  const meta = await resolveMeta(env);
  const refs = [];
  for (const note of notes) {
    try {
      const existing = await findExistingIssue(env, meta, note.pageId);
      if (existing) { refs.push({ id: existing, title: note.title, notionUrl: note.notionUrl, reused: true }); continue; }
      const md = await fetchPageMarkdown(env, note.pageId);
      if (opts.dryRun) { console.log(`[dry-run] create: ${buildSubject(note)}\n--- md(${md.length}b) ---\n${md.slice(0, 800)}`); continue; }
      const { id } = await createIssue(env, meta, note, md, todayStr());
      console.log(`[issue] created #${id}: ${buildSubject(note)}`);
      refs.push({ id, title: note.title, notionUrl: note.notionUrl, reused: false });
    } catch (err) {
      console.warn(`[issue] skip ${note.pageId} (${note.title}): ${err.message}`);
    }
  }
  return refs;
}
```
그리고 CLI 진입부(파일 맨 아래, exports 뒤):

```js
function envFromProcess() {
  return {
    redmineBase: process.env.REDMINE_BASE || "http://192.168.10.2:30002",
    redmineKey: process.env.REDMINE_API_KEY,
    notionKey: process.env.NOTION_API_KEY,
    projectIdentifier: process.env.REDMINE_PROJECT || "advance-development-team",
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dryRun = args.includes("--dry-run");
  const env = envFromProcess();
  if (!env.redmineKey || !env.notionKey) throw new Error("REDMINE_API_KEY / NOTION_API_KEY 필요");
  const pageId = get("--page");
  let notes;
  if (pageId) {
    const pg = await (await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: nh(env) })).json();
    notes = [{ pageId, title: extractTitle(pg), notionUrl: pg.url, report: extractSelectName(pg, "report"), createdDate: (pg.created_time || "").slice(0, 10) }];
  } else {
    const start = get("--start"), end = get("--end");
    if (!start || !end) throw new Error("--page <id> 또는 --start/--end 필요");
    notes = await queryPresentationNotes(env, start, end);
  }
  const refs = await publishNotes(env, notes, { dryRun });
  console.log(JSON.stringify(refs, null, 2));
}

if (require.main === module) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
```
exports에 `publishNotes, renderNotesBlock` 추가.

- [ ] **Step 4: 통과 확인** — Run: `node --test lib/__tests__/notion-issue-publisher.test.js` → PASS.

- [ ] **Step 5: 커밋** — `git add -A lib && git commit -m "feat(notion): publishNotes 오케스트레이션 + CLI"`

### Task 6: 파일럿 실증 (regulatory.db)

**Files:** 없음(실행 검증만).

- [ ] **Step 1: dry-run** — Run(리포 루트, .env 소싱):
  `set -a; source .env; set +a; export NOTION_API_KEY=$(grep -E '^\s*export\s+NOTION_API_KEY=' ~/.bashrc | tail -1 | sed -E 's/.*=//; s/^"|"$//g'); node lib/notion-issue-publisher.js --page 3908a230-a04e-81aa-a38b-c52b189d6785 --dry-run`
  Expected: `[dry-run] create: [WLAN-BSP] regulatory.db …` + md 미리보기(헤딩/표/코드 정상).
- [ ] **Step 2: 실제 생성** — 위 명령에서 `--dry-run` 제거 → `[issue] created #N` + refs JSON.
- [ ] **Step 3: 육안 검증** — 브라우저/`curl .../issues/N.json`로: subject/tracker(검토)/status(검토)/assignee(hwjo)/본문 Markdown 렌더/footer 마커 확인.
- [ ] **Step 4: 중복가드 검증** — 같은 명령 재실행 → `reused: true`, 새 이슈 생성 안 됨.
- [ ] **Step 5: 체크포인트** — 결과를 사용자에게 보고하고 Phase 2 진행 승인 요청.

---

## Phase 2 — 파이프라인 통합 (generate depth3)

> Phase 1 파일럿 검증 통과 후 진행. `update`는 순수 발행이라 초안을 만드는 `generate`에 통합.

### Task 7: `publisher.generate`에 📎 블록 append

**Files:**
- Modify: `lib/publisher.js` (generate가 조현우 섹션/autoContent를 확정한 뒤, 초안 파일 쓰기 직전)
- Modify: `index.js` (generate 경로, depth3에서만 refs 생성)

**Interfaces:**
- Consumes: `renderNotesBlock(refs)`, `publishNotes(env, notes, opts)`, `queryPresentationNotes(env, start, end)`.
- Produces: 초안 조현우 섹션 말미에 `renderNotesBlock` 결과 삽입.

- [ ] **Step 1: index.js generate 경로에 refs 생성 (depth3 게이트)**

`index.js`의 generate 분기(현 89행 `generate(...)` 호출 직전)에서:
```js
let noteRefs = [];
const depth = Number(process.env.REPORT_DEPTH || 0);
if (depth === 3 && process.env.NOTION_API_KEY && config.env.mode === "generate") {
  try {
    const { queryPresentationNotes, publishNotes } = require("./lib/notion-issue-publisher");
    const env = { redmineBase: config.env.baseUrl, redmineKey: process.env.REDMINE_API_KEY, notionKey: process.env.NOTION_API_KEY, projectIdentifier: config.env.projectId };
    const notes = await queryPresentationNotes(env, isoStart, isoEnd);
    noteRefs = await publishNotes(env, notes, {});
  } catch (err) { console.warn(`[issue] publishNotes failed: ${err.message}`); }
}
```
그리고 `generate(config, meetingDate, autoContent)` 호출을 `generate(config, meetingDate, autoContent, noteRefs)`로 변경.

- [ ] **Step 2: publisher.generate 시그니처 확장 + 블록 삽입**

`lib/publisher.js`의 `generate(config, meetingDate, autoContent)` → `generate(config, meetingDate, autoContent, noteRefs = [])`. 조현우 섹션 텍스트(AI 축약 완료본)를 파일에 쓰기 직전:
```js
const { renderNotesBlock } = require("./notion-issue-publisher");
const notesBlock = renderNotesBlock(noteRefs);
if (notesBlock) {
  // 조현우 섹션 본문 끝(작성 서명 줄 앞)에 삽입
  finalSection = finalSection.replace(/(\n\*작성: )/, `\n\n${notesBlock}\n$1`);
}
```
(정확한 변수명은 publisher.generate 내부 조현우 섹션 조립 지점에 맞춰 적용. 서명 패턴이 다르면 섹션 문자열 끝에 append.)

- [ ] **Step 3: 통합 스모크(로컬 generate, depth3, dry 확인)** — Run: `MODE=generate REPORT_DEPTH=3 OUTPUT_PATH=/tmp/wk.md bash run-generate-env.sh` 후 `/tmp/wk.md`에 `📎 발표노트(상세)` + `#N` 존재 확인. (이슈는 Phase1에서 생성되어 reused로 잡힘)

- [ ] **Step 4: 회귀 확인** — `node --test lib/__tests__/` 전체 PASS.

- [ ] **Step 5: 커밋** — `git add -A && git commit -m "feat(redmine): generate depth3에 발표노트 이슈 등록+링크 통합"`

### Task 8: 문서/마무리

- [ ] **Step 1** README 또는 `AGENTS.md`에 `발표노트` 태그 운용법 1줄 추가.
- [ ] **Step 2** 커밋: `git commit -m "docs: 발표노트 태그 운용법"`.
- [ ] **Step 3** 사용자에게 PR/머지 방침 확인.

---

## Self-Review

- **Spec coverage**: 표식(Task4 hasTag)/중복가드(Task4-5)/본문 Markdown(Task1-2,4)/트래커·상태·담당자 resolve(Task4)/링크 블록(Task5,7)/Phase 구분(Task6 체크포인트) — 스펙 §3 전 항목 대응.
- **Placeholder scan**: 코드 스텝은 실제 코드 포함. Task7 Step2만 publisher 내부 변수명이 파일 실제에 의존 → "서명 패턴 다르면 끝에 append" 명시로 모호성 제거.
- **Type consistency**: `note` 형태 `{pageId,title,notionUrl,report,createdDate}` 전 Task 일관. `refs` `{id,title,notionUrl,reused}` 일관. `env` `{redmineBase,redmineKey,notionKey,projectIdentifier}` 일관. `meta` `{projectId,trackerId,statusId,assigneeId}` 일관.
