// 월간 주간회의 페이지 스캐폴딩 — 대상 월의 모든 수요일에 빈 작성표 페이지를 미리 생성하고,
// 시작 페이지(Wiki) 인덱스를 기존 팀과 동일한 링크 목록 형식으로 재생성한다.
// 기존 update 흐름은 "이미 있는 페이지의 조현우 섹션만 교체"하므로, 페이지 자체는 별도로 만들어져 있어야 한다.
const fs = require("fs");
const path = require("path");
const { formatDate, buildWikiUrl } = require("./publisher");

const ROOT = path.resolve(__dirname, "..");

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 대상 월의 모든 수요일(Date 배열) 반환. monthStr: 'YYYY-MM' 또는 null(=현재 월).
function wednesdaysInMonth(monthStr) {
  let year;
  let month0;
  if (monthStr) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(monthStr).trim());
    if (!m) throw new Error(`Invalid TARGET_MONTH: ${monthStr}. Use YYYY-MM.`);
    year = Number(m[1]);
    month0 = Number(m[2]) - 1;
    if (month0 < 0 || month0 > 11) throw new Error(`Invalid month: ${monthStr}`);
  } else {
    const now = new Date();
    year = now.getFullYear();
    month0 = now.getMonth();
  }
  const result = [];
  const d = new Date(year, month0, 1);
  while (d.getMonth() === month0) {
    if (d.getDay() === 3) result.push(new Date(d)); // 3 = 수요일
    d.setDate(d.getDate() + 1);
  }
  return result;
}

// pageSuffix(예: '선행개발팀_주간_회의')에서 팀명('선행개발팀')을 추출.
function deriveTeamName(pageSuffix) {
  const stripped = pageSuffix.replace(/_*주간_*회의\s*$/, "").replace(/_/g, " ").trim();
  return stripped || pageSuffix.replace(/_/g, " ");
}

// 템플릿 placeholder 치환. {{TITLE}} = "YYYY-MM-DD <pageSuffix 공백표기>", {{DATE}}, {{SECTION_HEADER}}.
function renderSkeleton(templateText, meetingDate, config) {
  const date = formatDate(meetingDate);
  const displaySuffix = config.env.pageSuffix.replace(/_/g, " ");
  const title = `${date} ${displaySuffix}`;
  return (
    templateText
      .split("{{TITLE}}").join(title)
      .split("{{DATE}}").join(date)
      .split("{{SECTION_HEADER}}").join(config.env.sectionHeader)
      .trimEnd() + "\n"
  );
}

// 페이지 존재 여부 + 현재 버전 조회. {exists, version}.
async function fetchPage(meetingDate, config) {
  const url = `${buildWikiUrl(meetingDate, config)}.json`;
  const res = await fetch(url, {
    headers: { "X-Redmine-API-Key": config.env.apiKey },
  });
  if (res.status === 404) return { exists: false };
  if (res.ok) {
    const data = await res.json().catch(() => null);
    const version = data && data.wiki_page && data.wiki_page.version;
    return { exists: true, version };
  }
  const text = await res.text().catch(() => "");
  throw new Error(`GET ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
}

// 페이지 생성/갱신(upsert). version이 있으면 기존 페이지 덮어쓰기(낙관적 잠금).
async function writePage(meetingDate, config, skeletonText, parentTitle, version) {
  const url = `${buildWikiUrl(meetingDate, config)}.json`;
  const payload = { wiki_page: { text: skeletonText } };
  if (parentTitle) payload.wiki_page.parent_title = parentTitle;
  if (version) payload.wiki_page.version = version;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Redmine-API-Key": config.env.apiKey,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PUT ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
}

// 프로젝트의 모든 주간회의 페이지 날짜('YYYY-MM-DD')를 수집 (제목이 'YYYY-MM-DD_<pageSuffix>' 인 페이지).
async function listWeeklyDates(config) {
  const url = `${config.env.baseUrl}/projects/${config.env.projectId}/wiki/index.json`;
  const res = await fetch(url, { headers: { "X-Redmine-API-Key": config.env.apiKey } });
  if (!res.ok) throw new Error(`index GET ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pages = (data && data.wiki_pages) || [];
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})_${escapeRegExp(config.env.pageSuffix)}$`);
  const dates = [];
  for (const p of pages) {
    const m = re.exec(p.title || "");
    if (m) dates.push(m[1]);
  }
  return dates;
}

// 시작 페이지 인덱스 본문 생성: 연도 제목(#####) + 월별 collapse 블록 (모두 최신순).
function buildIndexContent(dateStrs, config, header) {
  const displaySuffix = config.env.pageSuffix.replace(/_/g, " ");
  const link = (ds) => `- [[${ds} ${displaySuffix}|${ds}]]`;

  if (!dateStrs.length) {
    return `### ${header}\n\n#### 주간 회의\n- (아직 페이지 없음)\n`;
  }

  // 연 > 월 그룹핑
  const byYear = new Map(); // year -> Map(month -> [dateStr])
  for (const ds of dateStrs) {
    const [y, m] = ds.split("-");
    if (!byYear.has(y)) byYear.set(y, new Map());
    const byMonth = byYear.get(y);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(ds);
  }

  const years = [...byYear.keys()].sort().reverse();
  const yearBlocks = years.map((y) => {
    const byMonth = byYear.get(y);
    const months = [...byMonth.keys()].sort().reverse();
    const monthBlocks = months.map((m) => {
      const days = byMonth.get(m).slice().sort().reverse();
      return `{{collapse(${Number(m)}월)\n${days.map(link).join("\n")}\n}}`;
    });
    return `##### ${y}년\n\n${monthBlocks.join("\n\n")}`;
  });

  return `### ${header}\n\n#### 주간 회의\n\n${yearBlocks.join("\n\n")}\n`;
}

// 시작 페이지(Wiki) 인덱스를 현재 존재하는 모든 주간회의 페이지 기준으로 재생성.
async function rebuildStartIndex(config, { dryRun, startPage, header }) {
  const dateStrs = await listWeeklyDates(config);
  const content = buildIndexContent(dateStrs, config, header);
  if (dryRun) {
    console.log(`\n[index] 시작 페이지 '${startPage}' 갱신 예정 (${dateStrs.length}개 링크):`);
    console.log(content);
    return { updated: false, count: dateStrs.length };
  }
  const url = `${config.env.baseUrl}/projects/${config.env.projectId}/wiki/${encodeURIComponent(startPage)}.json`;
  let version;
  const getRes = await fetch(url, { headers: { "X-Redmine-API-Key": config.env.apiKey } });
  if (getRes.ok) {
    const cur = await getRes.json();
    version = cur.wiki_page && cur.wiki_page.version;
  }
  const payload = { wiki_page: { text: content } };
  if (version) payload.wiki_page.version = version;
  const putRes = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Redmine-API-Key": config.env.apiKey },
    body: JSON.stringify(payload),
  });
  if (!putRes.ok) {
    const t = await putRes.text().catch(() => "");
    throw new Error(`index PUT ${putRes.status} ${putRes.statusText}: ${t.slice(0, 200)}`);
  }
  console.log(`[index] 시작 페이지 '${startPage}' 갱신 완료 (${dateStrs.length}개 링크)`);
  return { updated: true, count: dateStrs.length };
}

async function scaffoldMonth(config, options = {}) {
  const monthStr = options.month || process.env.TARGET_MONTH || null;
  const dryRun =
    options.dryRun !== undefined ? options.dryRun : process.env.DRY_RUN === "1";
  const parentTitle = options.parentTitle || process.env.WIKI_PARENT || "Wiki";
  const force = options.force !== undefined ? options.force : process.env.FORCE === "1";
  const skipIndex =
    options.skipIndex !== undefined ? options.skipIndex : process.env.SKIP_INDEX === "1";
  const startPage = options.startPage || process.env.WIKI_START_PAGE || "Wiki";
  const header =
    options.header ||
    process.env.WIKI_INDEX_HEADER ||
    `캔탑스 ${deriveTeamName(config.env.pageSuffix)}`;
  const templatePath =
    options.templatePath ||
    process.env.PAGE_TEMPLATE_PATH ||
    path.join(ROOT, "templates", "weekly-page.md");

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Page template not found: ${templatePath}`);
  }
  const templateText = fs.readFileSync(templatePath, "utf8");

  const dates = wednesdaysInMonth(monthStr);
  const now = new Date();
  const label =
    monthStr || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  console.log(
    `대상 월: ${label} | 수요일 ${dates.length}개 | project: ${config.env.projectId} | suffix: ${config.env.pageSuffix}`
  );
  if (dryRun) console.log("** DRY_RUN: 실제 생성하지 않음 **");
  if (force) console.warn("** FORCE: 이미 있는 페이지를 새 양식으로 덮어씁니다 (기존 작성 내용 소실 주의) **");

  const results = [];
  for (const d of dates) {
    const dateStr = formatDate(d);
    const title = `${dateStr}_${config.env.pageSuffix}`;
    try {
      const meta = await fetchPage(d, config);
      if (meta.exists && !force) {
        results.push({ date: dateStr, title, status: "skip(exists)" });
        console.log(`SKIP      ${title} (이미 존재)`);
        continue;
      }
      if (dryRun) {
        const status = meta.exists ? "would-overwrite" : "would-create";
        results.push({ date: dateStr, title, status });
        console.log(`${meta.exists ? "PLAN-OVR " : "PLAN     "} ${title}`);
        continue;
      }
      const skeleton = renderSkeleton(templateText, d, config);
      await writePage(d, config, skeleton, parentTitle, meta.exists ? meta.version : undefined);
      const status = meta.exists ? "overwritten" : "created";
      results.push({ date: dateStr, title, status });
      console.log(`${meta.exists ? "OVERWRITE" : "CREATE   "} ${title}`);
    } catch (err) {
      results.push({ date: dateStr, title, status: `error: ${err.message}` });
      console.error(`ERROR     ${title}: ${err.message}`);
    }
  }

  const count = (pred) => results.filter(pred).length;
  const created = count((r) => r.status === "created");
  const overwritten = count((r) => r.status === "overwritten");
  const skipped = count((r) => r.status.startsWith("skip"));
  const planned = count((r) => r.status === "would-create" || r.status === "would-overwrite");
  const errored = count((r) => r.status.startsWith("error"));
  console.log(
    `\n완료: 생성 ${created} | 덮어씀 ${overwritten} | 스킵 ${skipped}${dryRun ? ` | 예정 ${planned}` : ""} | 오류 ${errored}`
  );

  // 시작 페이지 인덱스 재생성 (페이지 생성 실패와 무관하게 진행)
  if (!skipIndex) {
    try {
      await rebuildStartIndex(config, { dryRun, startPage, header });
    } catch (err) {
      console.error(`[index] 갱신 실패: ${err.message}`);
    }
  }

  return results;
}

module.exports = {
  scaffoldMonth,
  wednesdaysInMonth,
  renderSkeleton,
  deriveTeamName,
  buildIndexContent,
  rebuildStartIndex,
  listWeeklyDates,
};
