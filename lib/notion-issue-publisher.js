// 발표노트(Notion KB, tag=발표노트) → Redmine 작업(Issue) 자동 등록.
// 기존 collector/AI 축약 경로 비침습. Phase 1 CLI(--page/--start/--end/--dry-run).
const { blocksToMd } = require("./notion-blocks-to-md");
const { stripAstralChars } = require("./text-normalization");

const NOTION_VERSION = "2022-06-28";
const KB_DB_ID = "ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
const PRESENTATION_TAG = "발표노트";
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
  return { projectId: proj.project.id, trackerId: tracker.id, statusId: status.id, assigneeId: me.user.id };
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

// 생성은 성공했으나 status가 요청과 다른 경우. id를 담아 호출부가 이슈를 버리지 않게 한다.
class IssueStatusMismatchError extends Error {
  constructor({ issueId, requested, actual, hint }) {
    super(`createIssue: status_id 미반영 (요청 ${requested}, 실제 ${actual}) #${issueId}. ${hint}.`);
    this.name = "IssueStatusMismatchError";
    this.issueId = issueId;
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
    throw new IssueStatusMismatchError({
      issueId: data.issue.id, requested: meta.statusId, actual: gotStatus, hint,
    });
  }
  return { id: data.issue.id };
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
      refs.push({ id, title: note.title, notionUrl: note.notionUrl, reused: false, statusMismatch: false });
    } catch (err) {
      if (err instanceof IssueStatusMismatchError) {
        // 이슈는 Redmine에 실재한다. 버리면 보고서에서 누락되고 다음 회차에 조용히 재사용된다.
        console.warn(
          `[issue] created #${err.issueId} 상태 불일치 (요청 ${err.requested}, 실제 ${err.actual}): ` +
          `${buildSubject(note)} — 보고서에는 포함하되 Redmine에서 상태를 교정하라.`
        );
        refs.push({
          id: err.issueId, title: note.title, notionUrl: note.notionUrl,
          reused: false, statusMismatch: true,
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
  reportLabel,
  buildSubject,
  buildDescription,
  hasMarker,
  stripAstralChars,
  renderNotesBlock,
  todayStr,
  fetchJson,
  resolveMeta,
  fetchPageMarkdown,
  queryPresentationNotes,
  findExistingIssue,
  createIssue,
  IssueStatusMismatchError,
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
