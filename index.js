const fs = require("fs");
const { loadConfig } = require("./lib/config");
const { validateReport } = require("./lib/fact-validator");
const { publishNotes } = require("./lib/notion-issue-publisher");
const { selectPresentationNotes } = require("./lib/presentation-note-classifier");
const {
  buildCandidatesPath,
  buildPublishedPath,
  buildValidationPath,
  writeJsonAtomic,
} = require("./lib/report-artifact");
const { collectSnapshot, loadSnapshot } = require("./lib/report-snapshot");
const {
  buildOutputPath,
  buildWikiUrl,
  extractTitleFromUrl,
  formatDate,
  generate,
  parseMeetingDateFromTitle,
  resolveMeetingDate,
  targetWednesday,
  update,
} = require("./lib/publisher");

function resolveRunMeetingDate(config, now = new Date()) {
  let meetingDate = resolveMeetingDate(config);
  let wikiUrl = config.env.wikiUrl;

  if (!wikiUrl) {
    if (!meetingDate) meetingDate = targetWednesday(now);
    wikiUrl = buildWikiUrl(meetingDate, config);
  }

  if (!meetingDate) {
    const title = extractTitleFromUrl(wikiUrl);
    meetingDate = parseMeetingDateFromTitle(title) || targetWednesday(now);
  }

  if (!meetingDate || Number.isNaN(meetingDate.getTime())) {
    throw new Error("Could not determine meeting date. Set MEETING_DATE=YYYY-MM-DD.");
  }
  return meetingDate;
}

function writeCandidates(snapshot, snapshotPath, meetingDate, config) {
  const candidatesPath = buildCandidatesPath(meetingDate, config);
  writeJsonAtomic(candidatesPath, {
    schemaVersion: 1,
    meetingDate: snapshot.meetingDate,
    snapshotPath,
    snapshotHash: snapshot.contentHash,
    mode: config.env.presentationNoteMode,
    candidates: snapshot.presentationCandidates || [],
  });
  console.log(`[presentation] 후보 저장: ${candidatesPath}`);
  return candidatesPath;
}

function validateDraft(snapshot, snapshotPath, reportPath, meetingDate, config) {
  const reportContent = fs.readFileSync(reportPath, "utf8");
  const validation = validateReport(snapshot.rawContent, reportContent, {
    meetingDate: formatDate(meetingDate),
    reportDepth: config.env.reportDepth,
    sectionHeader: config.env.sectionHeader,
    snapshotHash: snapshot.contentHash,
    snapshotPath,
    repos: config.repos,
  });
  const validationPath = buildValidationPath(reportPath);
  writeJsonAtomic(validationPath, validation);
  console.log(`[validation] ${validation.status}: ${validationPath}`);
  for (const issue of validation.issues) {
    console.warn(`[validation] ${issue.severity} ${issue.code}: ${issue.message}`);
  }
  return { validation, validationPath };
}

// 게시를 막지 않는 warning은 여기 등록된 것뿐이다. open_status_pickaxe_unavailable은
// 코드 심볼이 없는 문장이라 pickaxe 자동 확인이 불가능할 뿐이며, 문구 수정으로 없앨 수
// 없어 게시를 영구 차단했다. 반면 해결 흔적 발견(open_status_resolution_evidence)이나
// git 확인 실패는 AGENTS.md의 stale "미해결" 방지 규율상 사람이 봐야 하므로 계속 막는다.
// 기본값이 "차단"이므로 새 warning 코드가 생겨도 조용히 통과하지 않는다.
const NON_BLOCKING_WARNING_CODES = new Set(["open_status_pickaxe_unavailable"]);

function blockingWarnings(validation) {
  return (validation.issues || []).filter(
    (issue) => issue.severity === "warning" && !NON_BLOCKING_WARNING_CODES.has(issue.code)
  );
}

// generate와 update가 같은 기준을 쓰도록 게시 가능 판정을 한 곳에 모은다.
function isPublishable(validation) {
  if (validation.status === "PASS") return true;
  if (validation.status !== "WARNING") return false;
  return blockingWarnings(validation).length === 0;
}

function assertPublishable(validation, config) {
  if (isPublishable(validation)) {
    if (validation.status === "WARNING") {
      console.warn(
        "[validation] WARNING — 게시를 막는 항목은 없습니다. 경고는 수동 확인이 필요합니다."
      );
    }
    return;
  }
  if (config.env.validationOverride) {
    console.warn(`[validation] VALIDATION_OVERRIDE=1 — ${validation.status} 결과를 수동 우회합니다.`);
    return;
  }
  if (config.env.validationMode === "block") {
    throw new Error(`보고서 검증 ${validation.status}: Redmine 반영을 중단합니다.`);
  }
  console.warn(`[validation] VALIDATION_MODE=warn — ${validation.status} 상태로 계속합니다.`);
}

async function runCollect(config, meetingDate) {
  const result = await collectSnapshot(config, meetingDate);
  writeCandidates(result.snapshot, result.snapshotPath, meetingDate, config);
  if (result.snapshot.status !== "sealed" && !config.env.allowPartialSnapshot) {
    throw new Error(
      `수집 snapshot이 ${result.snapshot.status} 상태입니다: ${result.snapshot.failures.join("; ")}`
    );
  }
  return result;
}

async function runGenerate(config, meetingDate) {
  const { snapshot, snapshotPath } = loadSnapshot(config, meetingDate);
  writeCandidates(snapshot, snapshotPath, meetingDate, config);
  const reportPath = await generate(
    config,
    meetingDate,
    snapshot.autoContent,
    [],
    { rawContent: snapshot.rawContent }
  );
  const validationResult = validateDraft(
    snapshot,
    snapshotPath,
    reportPath,
    meetingDate,
    config
  );
  return { snapshot, snapshotPath, reportPath, ...validationResult };
}

function buildIssueEnv(config) {
  return {
    redmineBase: config.env.baseUrl,
    redmineKey: config.env.apiKey,
    notionKey: process.env.NOTION_API_KEY,
    projectIdentifier: config.env.projectId,
  };
}

async function runUpdate(config, meetingDate) {
  const { snapshot, snapshotPath } = loadSnapshot(config, meetingDate);
  const reportPath = buildOutputPath(meetingDate, config);
  if (!fs.existsSync(reportPath)) {
    throw new Error(`초안 파일이 없습니다: ${reportPath}`);
  }

  writeCandidates(snapshot, snapshotPath, meetingDate, config);
  const { validation, validationPath } = validateDraft(
    snapshot,
    snapshotPath,
    reportPath,
    meetingDate,
    config
  );
  assertPublishable(validation, config);

  // 발표노트 자동 등록은 프로젝트 정책상 운영 프로필인 depth3 update에서만 수행한다.
  const candidates = Number(config.env.reportDepth) === 3
    ? selectPresentationNotes(
      snapshot.presentationCandidates || [],
      config.env.presentationNoteMode
    )
    : [];
  const loadNoteRefs = candidates.length
    ? async () => {
      if (!process.env.NOTION_API_KEY) {
        throw new Error("발표노트 Issue 생성에 NOTION_API_KEY가 필요합니다.");
      }
      const refs = await publishNotes(buildIssueEnv(config), candidates, {});
      console.log(`[issue] presentation notes: ${refs.length}`);
      return refs;
    }
    : null;

  const publishedPath = buildPublishedPath(reportPath);
  const result = await update(config, meetingDate, { loadNoteRefs, publishedPath });
  return {
    snapshot,
    snapshotPath,
    reportPath,
    validation,
    validationPath,
    publishedPath: result && result.publishedPath,
  };
}

async function main() {
  const config = loadConfig();
  const meetingDate = resolveRunMeetingDate(config);
  console.log(`Meeting date: ${formatDate(meetingDate)}`);
  console.log(`Mode: ${config.env.mode}`);

  switch (config.env.mode) {
    case "collect":
      return runCollect(config, meetingDate);
    case "generate": {
      const result = await runGenerate(config, meetingDate);
      // update의 게시 게이트와 같은 기준을 쓴다. 다르면 게시 가능한 WARNING이
      // generate에서 실패 종료코드가 되어 cron이 매주 헛알림을 낸다.
      if (!isPublishable(result.validation) && config.env.validationMode === "block") {
        process.exitCode = 2;
      }
      return result;
    }
    case "update":
      return runUpdate(config, meetingDate);
    default:
      throw new Error(`Unknown MODE: ${config.env.mode}. Use collect, generate, or update.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  assertPublishable,
  isPublishable,
  main,
  resolveRunMeetingDate,
  runCollect,
  runGenerate,
  runUpdate,
  validateDraft,
  writeCandidates,
};
