// 발표노트(Notion KB, tag=발표노트) → Redmine 작업(Issue) 자동 등록.
// 기존 collector/AI 축약 경로 비침습. Phase 1 CLI(--page/--start/--end/--dry-run).
const { blocksToMd } = require("./notion-blocks-to-md");
const { stripAstralChars } = require("./text-normalization");

const NOTION_VERSION = "2022-06-28";
const KB_DB_ID = "ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
const PRESENTATION_TAG = "발표노트";
const COMPLETED_TAG = "발표완료";
const MARKER_PREFIX = "Notion-Page-Id:";
const PAGE_SIZE = 100;
const TRACKER_PREFERENCE = ["새기능", "검토"];

// ---- 순수 조립부 (I/O 없음) ----

function reportLabel(report) {
  if (!report) return "GEN";
  return String(report).toUpperCase();
}

function buildSubject(note) {
  return `[${reportLabel(note.report)}] ${note.title}`;
}

function buildDescription(note, md, dateStr) {
  // 중복가드 마커는 description 상단에 둔다 — 목록 API가 긴 description 끝부분을
  // 절단/누락해도 마커가 살아있어 중복 이슈 생성을 막는다. (Claude 리뷰 HIGH 반영)
  return (
    `> ${MARKER_PREFIX} ${note.pageId}\n\n` +
    md.trimEnd() +
    "\n\n---\n" +
    `> 출처: Notion KB — ${note.notionUrl}\n` +
    `> 자동 생성: redmine weekly (${dateStr})\n`
  );
}

// 마커에서 pageId를 역추출한다. hasMarker는 특정 pageId 대조용이라
// 이슈 목록을 한 번만 훑어 색인을 만드는 데는 쓸 수 없다.
function extractMarkerPageId(description) {
  const m = new RegExp(`${MARKER_PREFIX}\\s*(\\S+)`).exec(String(description || ""));
  return m ? m[1] : null;
}

function hasMarker(description, pageId) {
  return typeof description === "string" && description.includes(`${MARKER_PREFIX} ${pageId}`);
}

function renderNotesBlock(refs) {
  if (!refs || !refs.length) return "";
  return "**발표노트(상세)**\n" + refs.map((r) => `- ${r.title} — #${r.id}`).join("\n");
}

// 서버 시간대(UTC 등)에 무관하게 KST 날짜. publisher.js와 일관.
function todayStr() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

// ---- I/O 헤더/공통 ----

function nh(env) {
  return { Authorization: `Bearer ${env.notionKey}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
}
function rh(env) {
  return { "X-Redmine-API-Key": env.redmineKey, "Content-Type": "application/json" };
}

// res.ok 미확인 시 에러페이지를 .json() 파싱하다 SyntaxError → 원인 은폐. 공통 헬퍼로 상태·본문 노출.
// Redmine 쓰기 응답은 204 No Content라 본문이 없다 — fetchJson의 res.json()이 여기서 깨진다.
async function fetchNoContent(url, options) {
  const res = await fetch(url, options || {});
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch (_) { /* ignore */ }
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${String(body).slice(0, 300)}`);
  }
}

async function fetchJson(url, options) {
  const res = await fetch(url, options || {});
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch (_) { /* ignore */ }
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${String(body).slice(0, 300)}`);
  }
  return res.json();
}

// ---- Notion 파싱 유틸 ----

function extractSelectName(page, prop) {
  const p = ((page && page.properties) || {})[prop];
  return p && p.type === "select" && p.select ? p.select.name : "";
}
function extractTitle(page) {
  for (const p of Object.values((page && page.properties) || {})) {
    if (p.type === "title") return (p.title || []).map((t) => t.plain_text || "").join("");
  }
  return "";
}
function hasTag(page, prop, tag) {
  const p = ((page && page.properties) || {})[prop];
  return !!p && p.type === "multi_select" && (p.multi_select || []).some((o) => o.name === tag);
}

// ---- Redmine/Notion I/O ----

async function resolveMeta(env) {
  const B = env.redmineBase, P = env.projectIdentifier;
  // 상호 독립적인 3개 조회 → 병렬화(latency 감소).
  const [proj, st, me] = await Promise.all([
    fetchJson(`${B}/projects/${P}.json?include=trackers`, { headers: rh(env) }),
    fetchJson(`${B}/issue_statuses.json`, { headers: rh(env) }),
    fetchJson(`${B}/users/current.json`, { headers: rh(env) }),
  ]);
  // 트래커는 프로젝트 활성 목록에서만 유효(미활성 지정 시 Redmine이 조용히 기본값 폴백).
  const projTrackers = (proj.project && proj.project.trackers) || [];
  let tracker = null;
  for (const name of TRACKER_PREFERENCE) {
    tracker = projTrackers.find((t) => t.name === name);
    if (tracker) break;
  }
  if (!tracker) tracker = projTrackers[0];
  const status = (st.issue_statuses || []).find((s) => s.name === "검토");
  if (!proj.project || !tracker || !status || !me.user) throw new Error("resolveMeta: 필수 메타 조회 실패");
  console.log(`[issue] tracker: ${tracker.name} (id ${tracker.id}), status: 검토 (id ${status.id})`);
  // 종료 상태는 생성에 필수가 아니므로 없으면 null로 두고 종료 경로에서만 요구한다.
  const closeStatus = (st.issue_statuses || []).find((s) => s.name === "완료");
  return {
    projectId: proj.project.id, trackerId: tracker.id, statusId: status.id,
    assigneeId: me.user.id, closeStatusId: closeStatus ? closeStatus.id : null,
  };
}

async function notionBlockChildren(env, blockId) {
  const all = [];
  let cursor;
  do {
    const u = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    u.searchParams.set("page_size", String(PAGE_SIZE));
    if (cursor) u.searchParams.set("start_cursor", cursor);
    const data = await fetchJson(u, { headers: nh(env) });
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

async function queryPresentationNotes(env, startDate, endDate) {
  const notes = [];
  let cursor;
  do {
    const data = await fetchJson(`https://api.notion.com/v1/databases/${KB_DB_ID}/query`, {
      method: "POST",
      headers: nh(env),
      body: JSON.stringify({
        filter: {
          and: [
            { timestamp: "created_time", created_time: { on_or_after: startDate } },
            { timestamp: "created_time", created_time: { on_or_before: endDate } },
          ],
        },
        page_size: PAGE_SIZE,
        start_cursor: cursor,
      }),
    });
    for (const pg of data.results || []) {
      if (!hasTag(pg, "tags", PRESENTATION_TAG)) continue;
      notes.push({
        pageId: pg.id,
        title: extractTitle(pg),
        notionUrl: pg.url,
        report: extractSelectName(pg, "report"),
        createdDate: (pg.created_time || "").slice(0, 10),
      });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return notes;
}

async function findExistingIssue(env, meta, pageId) {
  const B = env.redmineBase, P = env.projectIdentifier;
  let offset = 0;
  for (;;) {
    const data = await fetchJson(`${B}/projects/${P}/issues.json?status_id=*&limit=${PAGE_SIZE}&offset=${offset}`, { headers: rh(env) });
    const issues = data.issues || [];
    for (const it of issues) {
      if (hasMarker(it.description || "", pageId)) {
        return { id: it.id, statusId: it.status && it.status.id };
      }
    }
    offset += issues.length;
    // total_count 부재/구조 상이에도 안전: 마지막 페이지(<PAGE_SIZE) 또는 소진 시 종료.
    if (issues.length < PAGE_SIZE || offset >= (data.total_count || 0)) break;
  }
  return null;
}

// 생성은 성공했으나 요청한 필드가 반영되지 않은 경우. id를 담아 호출부가 이슈를 버리지 않게 한다.
// field로 갈라 두 번째 병렬 에러 경로가 생기지 않게 한다.
class IssueFieldMismatchError extends Error {
  constructor({ issueId, field, requested, actual, hint }) {
    super(`createIssue: ${field} 미반영 (요청 ${requested}, 실제 ${actual}) #${issueId}. ${hint}.`);
    this.name = "IssueFieldMismatchError";
    this.issueId = issueId;
    this.field = field;
    this.requested = requested;
    this.actual = actual;
  }
}

async function createIssue(env, meta, note, md, dateStr) {
  // 기준값이 없으면 아래 status 대조가 공허하게 통과한다 — 생성 전에 막는다.
  if (!meta.statusId) {
    throw new Error("createIssue: meta.statusId가 없어 생성 상태를 검증할 수 없다.");
  }
  const data = await fetchJson(`${env.redmineBase}/issues.json`, {
    method: "POST",
    headers: rh(env),
    body: JSON.stringify({
      issue: {
        project_id: meta.projectId,
        tracker_id: meta.trackerId,
        status_id: meta.statusId,
        assigned_to_id: meta.assigneeId,
        subject: stripAstralChars(buildSubject(note)),
        description: stripAstralChars(buildDescription(note, md, dateStr)),
      },
    }),
  });
  if (!data || !data.issue || !data.issue.id) {
    throw new Error(`createIssue: 예상치 못한 응답: ${JSON.stringify(data).slice(0, 200)}`);
  }
  // 트래커는 활성 목록에서 고르는 사전 선택으로 막지만(위 resolveMeta), status는 사후 검증만 가능하다.
  // Redmine이 허용되지 않은 status_id를 오류 없이 기본값으로 폴백하기 때문이다.
  const gotStatus = data.issue.status && data.issue.status.id;
  if (gotStatus !== meta.statusId) {
    const hint = gotStatus === undefined
      ? "응답에 status가 없어 검증할 수 없다 — Redmine 응답 형태 가정이 어긋났다(버전/프록시 확인). 이 경우 모든 생성이 같은 이유로 실패한다"
      : "프로젝트/트래커 워크플로에서 해당 상태가 신규 생성에 허용되는지 확인 필요";
    throw new IssueFieldMismatchError({
      issueId: data.issue.id, field: "status_id",
      requested: meta.statusId, actual: gotStatus, hint,
    });
  }

  // assigned_to_id는 사전 선택도 사후 검증도 없던 유일한 필드였다(#64). 대상이
  // 프로젝트의 할당 가능 멤버가 아니면 조용히 미할당으로 생성될 수 있다.
  const gotAssignee = data.issue.assigned_to && data.issue.assigned_to.id;
  if (gotAssignee !== meta.assigneeId) {
    throw new IssueFieldMismatchError({
      issueId: data.issue.id, field: "assigned_to_id",
      requested: meta.assigneeId, actual: gotAssignee,
      hint: "대상 사용자가 이 프로젝트의 할당 가능한 멤버인지 확인 필요",
    });
  }
  return { id: data.issue.id };
}

// 이슈를 targetStatusId로 종료한다. Redmine 쓰기의 세 함정을 모두 다룬다.
// PUT은 전이가 막혀도 204를 반환하고 status_id만 조용히 무시하므로, 재조회 없이는 실패를 알 수 없다.
async function closeIssue(env, issueId, targetStatusId, options = {}) {
  const B = env.redmineBase;
  const cur = await fetchJson(`${B}/issues/${issueId}.json?include=allowed_statuses`, { headers: rh(env) });
  const issue = cur && cur.issue;
  if (!issue || !issue.status) {
    throw new Error(`closeIssue: #${issueId} 조회 실패 — 응답에 issue.status가 없다.`);
  }
  if (issue.status.id === targetStatusId) {
    return { id: issueId, statusId: targetStatusId, changed: false };
  }

  // 열린 하위 이슈가 있으면 Redmine이 상위 종료를 차단한다. 하위부터 올라가야 한다.
  const kids = await fetchJson(
    `${B}/issues.json?parent_id=${issueId}&status_id=open&limit=1`, { headers: rh(env) }
  );
  const openChildren = (kids && kids.total_count) || 0;
  if (openChildren > 0) {
    throw new Error(
      `closeIssue: #${issueId}에 열린 하위 이슈 ${openChildren}건이 있어 종료할 수 없다. 하위부터 종료하라.`
    );
  }

  // 트래커별로 특정 종료 상태로의 전이가 아예 없을 수 있다(예: 일감묶음에 거절 없음).
  const allowed = ((issue.allowed_statuses || []).map((x) => x.id));
  if (!allowed.includes(targetStatusId)) {
    throw new Error(
      `closeIssue: #${issueId}의 트래커 워크플로에 상태 ${targetStatusId} 전이가 없다 (허용: ${allowed.join(", ")}).`
    );
  }

  const payload = { issue: { status_id: targetStatusId } };
  if (options.notes) payload.issue.notes = options.notes;
  await fetchNoContent(`${B}/issues/${issueId}.json`, {
    method: "PUT", headers: rh(env), body: JSON.stringify(payload),
  });

  const after = await fetchJson(`${B}/issues/${issueId}.json`, { headers: rh(env) });
  const got = after && after.issue && after.issue.status && after.issue.status.id;
  if (got !== targetStatusId) {
    throw new Error(
      `closeIssue: #${issueId} status 미반영 (요청 ${targetStatusId}, 실제 ${got}). ` +
      `PUT은 성공 응답을 반환했으나 전이가 적용되지 않았다.`
    );
  }
  return { id: issueId, statusId: got, changed: true };
}

// 발표완료 태그가 붙은 KB 노트를 조회한다. 종료 표시는 노트 생성 몇 주 뒤에도
// 붙을 수 있으므로, 주간 수집 스냅샷(created_time 창)이 아니라 태그로 직접 찾는다.
async function queryCompletedNotes(env) {
  const notes = [];
  let cursor;
  try {
    do {
      const data = await fetchJson(`https://api.notion.com/v1/databases/${KB_DB_ID}/query`, {
        method: "POST",
        headers: nh(env),
        body: JSON.stringify({
          filter: { property: "tags", multi_select: { contains: COMPLETED_TAG } },
          page_size: PAGE_SIZE,
          start_cursor: cursor,
        }),
      });
      for (const pg of data.results || []) {
        notes.push({ pageId: pg.id, title: extractTitle(pg), notionUrl: pg.url });
      }
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
  } catch (err) {
    // multi_select 옵션은 누군가 처음 태그를 붙이는 순간 생긴다. 그전까지 Notion은
    // 이 필터를 400으로 거부하는데, 그것은 오류가 아니라 "완료 표시가 아직 없음"이다.
    if (/option .*not found/i.test(err.message)) {
      console.log(`[issue] ${COMPLETED_TAG} 태그가 아직 쓰인 적 없다 — 종료 대상 0건.`);
      return [];
    }
    throw err;
  }
  return notes;
}

// 프로젝트 이슈를 한 번만 훑어 pageId -> {id, statusId} 색인을 만든다.
// 노트마다 findExistingIssue를 부르면 노트 수만큼 전수 조회가 반복된다.
async function buildIssueIndexByPageId(env) {
  const B = env.redmineBase, P = env.projectIdentifier;
  const index = new Map();
  let offset = 0;
  for (;;) {
    const data = await fetchJson(
      `${B}/projects/${P}/issues.json?status_id=*&limit=${PAGE_SIZE}&offset=${offset}`,
      { headers: rh(env) }
    );
    const issues = data.issues || [];
    for (const it of issues) {
      const pageId = extractMarkerPageId(it.description || "");
      if (pageId && !index.has(pageId)) {
        index.set(pageId, { id: it.id, statusId: it.status && it.status.id });
      }
    }
    offset += issues.length;
    if (issues.length < PAGE_SIZE || offset >= (data.total_count || 0)) break;
  }
  return index;
}

async function closePresentedNotes(env, notes, opts = {}) {
  if (!notes || !notes.length) return [];
  const meta = await resolveMeta(env);
  if (!meta.closeStatusId) {
    throw new Error("closePresentedNotes: 종료 상태(완료)를 issue_statuses에서 찾지 못했다.");
  }
  const index = await buildIssueIndexByPageId(env);
  const closed = [];
  for (const note of notes) {
    const hit = index.get(note.pageId);
    if (!hit) continue;
    if (hit.statusId === meta.closeStatusId) continue;
    try {
      const r = await closeIssue(env, hit.id, meta.closeStatusId, {
        notes: opts.notes || `Notion ${COMPLETED_TAG} 태그에 따라 자동 종료 (${todayStr()}).`,
      });
      if (!r.changed) continue;
      console.log(`[issue] closed #${hit.id}: ${note.title}`);
      closed.push({ id: hit.id, title: note.title, changed: true });
    } catch (err) {
      console.warn(`[issue] close skip #${hit.id} (${note.title}): ${err.message}`);
    }
  }
  return closed;
}

// ---- 오케스트레이션 ----

async function publishNotes(env, notes, opts = {}) {
  const meta = await resolveMeta(env);
  const refs = [];
  for (const note of notes) {
    let md;
    try {
      const existing = await findExistingIssue(env, meta, note.pageId);
      if (existing) {
        const statusMismatch = existing.statusId !== meta.statusId;
        if (statusMismatch) {
          console.warn(
            `[issue] reuse #${existing.id} 상태 불일치 (요청 ${meta.statusId}, 실제 ${existing.statusId}) — Redmine에서 직접 교정하라.`
          );
        }
        refs.push({ id: existing.id, title: note.title, notionUrl: note.notionUrl, reused: true, statusMismatch });
        console.log(`[issue] reuse #${existing.id}: ${buildSubject(note)}`);
        continue;
      }
      md = await fetchPageMarkdown(env, note.pageId);
      if (opts.dryRun) {
        console.log(`[dry-run] create: ${buildSubject(note)}\n--- md(${md.length}b) ---\n${md.slice(0, 800)}`);
        continue;
      }
    } catch (err) {
      console.warn(`[issue] skip ${note.pageId} (${note.title}): ${err.message}`);
      continue;
    }

    if (opts.assertReady) await opts.assertReady();
    try {
      const { id } = await createIssue(env, meta, note, md, todayStr());
      console.log(`[issue] created #${id}: ${buildSubject(note)}`);
      refs.push({
        id, title: note.title, notionUrl: note.notionUrl,
        reused: false, statusMismatch: false, assigneeMismatch: false,
      });
    } catch (err) {
      if (err instanceof IssueFieldMismatchError) {
        // 이슈는 Redmine에 실재한다. 버리면 보고서에서 누락되고 다음 회차에 조용히 재사용된다.
        console.warn(
          `[issue] created #${err.issueId} ${err.field} 불일치 (요청 ${err.requested}, 실제 ${err.actual}): ` +
          `${buildSubject(note)} — 보고서에는 포함하되 Redmine에서 직접 교정하라.`
        );
        refs.push({
          id: err.issueId, title: note.title, notionUrl: note.notionUrl, reused: false,
          statusMismatch: err.field === "status_id",
          assigneeMismatch: err.field === "assigned_to_id",
        });
        continue;
      }
      console.warn(`[issue] skip ${note.pageId} (${note.title}): ${err.message}`);
    }
  }
  return refs;
}

module.exports = {
  MARKER_PREFIX,
  COMPLETED_TAG,
  reportLabel,
  buildSubject,
  buildDescription,
  extractMarkerPageId,
  hasMarker,
  stripAstralChars,
  renderNotesBlock,
  todayStr,
  fetchJson,
  resolveMeta,
  fetchPageMarkdown,
  queryPresentationNotes,
  queryCompletedNotes,
  buildIssueIndexByPageId,
  closePresentedNotes,
  findExistingIssue,
  createIssue,
  closeIssue,
  IssueFieldMismatchError,
  publishNotes,
};

// ---- CLI ----

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
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = args.includes("--dry-run");
  const env = envFromProcess();
  if (!env.redmineKey || !env.notionKey) throw new Error("REDMINE_API_KEY / NOTION_API_KEY 필요");
  const pageArg = get("--page");
  let notes;
  if (pageArg) {
    const pg = await fetchJson(`https://api.notion.com/v1/pages/${pageArg}`, { headers: nh(env) });
    // 마커/조회 일치를 위해 canonical(하이픈 포함) pg.id 사용 — URL의 32자 무하이픈 id 대비.
    notes = [{
      pageId: pg.id,
      title: extractTitle(pg),
      notionUrl: pg.url,
      report: extractSelectName(pg, "report"),
      createdDate: (pg.created_time || "").slice(0, 10),
    }];
  } else {
    const start = get("--start"), end = get("--end");
    if (!start || !end) throw new Error("--page <id> 또는 --start/--end 필요");
    notes = await queryPresentationNotes(env, start, end);
  }
  const refs = await publishNotes(env, notes, { dryRun });
  console.log(JSON.stringify(refs, null, 2));
}

if (require.main === module) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
