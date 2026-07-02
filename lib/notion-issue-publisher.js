// 발표노트(Notion KB, tag=발표노트) → Redmine 작업(Issue) 자동 등록.
// 기존 collector/AI 축약 경로 비침습. Phase 1 CLI(--page/--start/--end/--dry-run).
const { blocksToMd } = require("./notion-blocks-to-md");

const NOTION_VERSION = "2022-06-28";
const KB_DB_ID = "ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461";
const PRESENTATION_TAG = "발표노트";
const MARKER_PREFIX = "Notion-Page-Id:";

// ---- 순수 조립부 (I/O 없음) ----

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
    `> 출처: Notion KB — ${note.notionUrl}\n` +
    `> ${MARKER_PREFIX} ${note.pageId}\n` +
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

// Redmine(MySQL non-utf8mb4)는 4바이트 문자(이모지 등) 저장 시 "Incorrect string value" → HTTP 500.
// 이슈 subject/description에서 astral plane 문자를 제거한다. (publisher.js와 동일 정책)
function stripAstralChars(text) {
  return typeof text === "string" ? text.replace(/[\u{10000}-\u{10FFFF}]/gu, "") : text;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- I/O 헤더 ----

function nh(env) {
  return { Authorization: `Bearer ${env.notionKey}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
}
function rh(env) {
  return { "X-Redmine-API-Key": env.redmineKey, "Content-Type": "application/json" };
}

// ---- Notion 파싱 유틸 ----

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

// ---- Redmine/Notion I/O ----

// 트래커는 프로젝트별 활성 목록에서만 유효하다(미활성 지정 시 Redmine이 조용히 기본값 폴백).
// 선호 순서대로 활성 트래커 중 첫 매치를 쓰고, 없으면 첫 활성 트래커로 폴백 + 로그.
const TRACKER_PREFERENCE = ["새기능", "검토"];

async function resolveMeta(env) {
  const B = env.redmineBase, P = env.projectIdentifier;
  const proj = await (await fetch(`${B}/projects/${P}.json?include=trackers`, { headers: rh(env) })).json();
  const st = await (await fetch(`${B}/issue_statuses.json`, { headers: rh(env) })).json();
  const me = await (await fetch(`${B}/users/current.json`, { headers: rh(env) })).json();
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

async function queryPresentationNotes(env, startDate, endDate) {
  const res = await fetch(`https://api.notion.com/v1/databases/${KB_DB_ID}/query`, {
    method: "POST",
    headers: nh(env),
    body: JSON.stringify({
      filter: {
        and: [
          { timestamp: "created_time", created_time: { on_or_after: startDate } },
          { timestamp: "created_time", created_time: { on_or_before: endDate } },
        ],
      },
      page_size: 100,
    }),
  });
  if (!res.ok) throw new Error(`notion KB query ${res.status}`);
  const data = await res.json();
  return (data.results || [])
    .filter((pg) => hasTag(pg, "tags", PRESENTATION_TAG))
    .map((pg) => ({
      pageId: pg.id,
      title: extractTitle(pg),
      notionUrl: pg.url,
      report: extractSelectName(pg, "report"),
      createdDate: (pg.created_time || "").slice(0, 10),
    }));
}

async function findExistingIssue(env, meta, pageId) {
  const B = env.redmineBase, P = env.projectIdentifier;
  let offset = 0;
  for (;;) {
    const res = await fetch(`${B}/projects/${P}/issues.json?status_id=*&limit=100&offset=${offset}`, { headers: rh(env) });
    if (!res.ok) throw new Error(`redmine issues ${res.status}`);
    const data = await res.json();
    const issues = data.issues || [];
    for (const it of issues) {
      if (hasMarker(it.description || "", pageId)) return it.id;
    }
    offset += issues.length;
    if (!issues.length || offset >= (data.total_count || 0)) break;
  }
  return null;
}

async function createIssue(env, meta, note, md, dateStr) {
  const res = await fetch(`${env.redmineBase}/issues.json`, {
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
  if (!res.ok) throw new Error(`redmine create ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { id: data.issue.id };
}

// ---- 오케스트레이션 ----

async function publishNotes(env, notes, opts = {}) {
  const meta = await resolveMeta(env);
  const refs = [];
  for (const note of notes) {
    try {
      const existing = await findExistingIssue(env, meta, note.pageId);
      if (existing) {
        refs.push({ id: existing, title: note.title, notionUrl: note.notionUrl, reused: true });
        console.log(`[issue] reuse #${existing}: ${buildSubject(note)}`);
        continue;
      }
      const md = await fetchPageMarkdown(env, note.pageId);
      if (opts.dryRun) {
        console.log(`[dry-run] create: ${buildSubject(note)}\n--- md(${md.length}b) ---\n${md.slice(0, 800)}`);
        continue;
      }
      const { id } = await createIssue(env, meta, note, md, todayStr());
      console.log(`[issue] created #${id}: ${buildSubject(note)}`);
      refs.push({ id, title: note.title, notionUrl: note.notionUrl, reused: false });
    } catch (err) {
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
  renderNotesBlock,
  resolveMeta,
  fetchPageMarkdown,
  queryPresentationNotes,
  findExistingIssue,
  createIssue,
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
  const pageId = get("--page");
  let notes;
  if (pageId) {
    const pg = await (await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: nh(env) })).json();
    notes = [{
      pageId,
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
