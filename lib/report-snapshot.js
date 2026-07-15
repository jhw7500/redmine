const fs = require("fs");
const { collectNotionItems } = require("./collect-notion-api");
const { collectSessionItems } = require("./collect-session");
const { collectAll } = require("./collector");
const { mergeItemsIntoAutoContent } = require("./merger");
const { classifyPresentationNotes } = require("./presentation-note-classifier");
const {
  archiveSnapshot,
  buildSnapshotPath,
  readSnapshot,
  sealSnapshot,
  writeJsonAtomic,
} = require("./report-artifact");
const { dateRange } = require("./report-range");
const { buildContent, formatDate } = require("./publisher");

function countGitLines(gitResult) {
  return Object.values(gitResult || {}).reduce((total, value) => {
    return total + String(value || "").split("\n").filter((line) => line.trim()).length;
  }, 0);
}

function sourceEnabled(config, source, defaultValue = true) {
  const setting = config.sources && config.sources[source];
  return setting && typeof setting.enabled === "boolean" ? setting.enabled : defaultValue;
}

function sourceResult(status, count, data, error) {
  return {
    status,
    count,
    ...(error ? { error } : {}),
    data,
  };
}

function loadExistingSnapshot(snapshotPath, forceCollect) {
  if (!fs.existsSync(snapshotPath) || forceCollect) return null;
  const snapshot = readSnapshot(snapshotPath, { allowPartial: true });
  // sealed 결과만 멱등 재사용한다. partial 결과는 다음 collect에서 자동 재시도한다.
  return snapshot.status === "sealed" ? snapshot : null;
}

async function collectSnapshot(config, meetingDate, options = {}) {
  const snapshotPath = options.snapshotPath || buildSnapshotPath(meetingDate, config);
  const forceCollect = options.forceCollect ?? config.env.forceCollect;
  const existing = loadExistingSnapshot(snapshotPath, forceCollect);
  if (existing) {
    console.log(`[collect] sealed snapshot 재사용: ${snapshotPath}`);
    return { snapshot: existing, snapshotPath, reused: true };
  }

  const deps = {
    buildContent,
    classifyPresentationNotes,
    collectAll,
    collectNotionItems,
    collectSessionItems,
    dateRange,
    mergeItemsIntoAutoContent,
    ...(options.deps || {}),
  };
  const range = deps.dateRange(meetingDate);
  const failures = [];
  const warnings = [];

  let notionItems = [];
  let notionStatus = "skipped";
  if (sourceEnabled(config, "notion", false)) {
    if (!process.env.NOTION_API_KEY && !options.notionApiKey) {
      notionStatus = "failed";
      failures.push("notion: NOTION_API_KEY not set");
    } else {
      try {
        notionItems = await deps.collectNotionItems(
          config,
          range.startInclusive,
          range.end.toISOString()
        );
        notionStatus = "success";
      } catch (error) {
        notionStatus = "failed";
        failures.push(`notion: ${error.message}`);
      }
    }
  }

  let sessionItems = [];
  let sessionStatus = "skipped";
  if (sourceEnabled(config, "session", false)) {
    try {
      sessionItems = deps.collectSessionItems(config, range.startDate, range.endDate);
      sessionStatus = "success";
      if (sessionItems.some((item) => item.timePrecision === "day")) {
        warnings.push("session 항목은 날짜 정밀도라 06:00 경계를 시각 단위로 판별할 수 없음");
      }
    } catch (error) {
      sessionStatus = "failed";
      failures.push(`session: ${error.message}`);
    }
  }

  let gitResult = {};
  let gitStatus = "skipped";
  if (sourceEnabled(config, "git", true)) {
    try {
      gitResult = await deps.collectAll(config, range.startDate, range.endDate);
      gitStatus = "success";
    } catch (error) {
      gitStatus = "failed";
      failures.push(`git: ${error.message}`);
    }
  }

  const autoContent = deps.mergeItemsIntoAutoContent(
    gitResult,
    notionItems,
    sessionItems,
    config,
    {
      start: range.startInclusive,
      end: range.end.toISOString(),
      dayStart: range.startDate.slice(0, 10),
      dayEnd: range.endDate.slice(0, 10),
    }
  );
  const rawContent = deps.buildContent(meetingDate, autoContent, config);
  const presentationCandidates = deps.classifyPresentationNotes(notionItems, {
    threshold: config.env.presentationNoteThreshold,
  });

  const snapshot = sealSnapshot({
    collectedAt: new Date().toISOString(),
    meetingDate: formatDate(meetingDate),
    range: {
      startInclusive: range.startInclusive,
      endExclusive: range.endExclusive,
      displayStart: range.startDate,
      displayEnd: range.endDate,
      timeZone: "Asia/Seoul",
    },
    status: failures.length ? "partial" : "sealed",
    failures,
    warnings,
    sources: {
      git: sourceResult(gitStatus, countGitLines(gitResult), gitResult),
      notion: sourceResult(notionStatus, notionItems.length, notionItems),
      session: sourceResult(sessionStatus, sessionItems.length, sessionItems),
    },
    autoContent,
    rawContent,
    presentationCandidates,
  });

  if (fs.existsSync(snapshotPath)) {
    const previous = readSnapshot(snapshotPath, { allowPartial: true });
    if (previous.contentHash === snapshot.contentHash) {
      console.log(`[collect] 원본 변경 없음; 기존 snapshot 유지: ${snapshotPath}`);
      return { snapshot: previous, snapshotPath, reused: true };
    }
    const archived = archiveSnapshot(snapshotPath, previous);
    console.log(`[collect] 이전 snapshot 보존: ${archived}`);
  }

  writeJsonAtomic(snapshotPath, snapshot);
  console.log(`[collect] snapshot 저장: ${snapshotPath} (${snapshot.status})`);
  return { snapshot, snapshotPath, reused: false };
}

function loadSnapshot(config, meetingDate, options = {}) {
  const snapshotPath = options.snapshotPath || buildSnapshotPath(meetingDate, config);
  const snapshot = readSnapshot(snapshotPath, {
    allowPartial: options.allowPartial ?? config.env.allowPartialSnapshot,
  });
  const expectedDate = formatDate(meetingDate);
  if (snapshot.meetingDate !== expectedDate) {
    throw new Error(
      `Snapshot meetingDate mismatch: expected ${expectedDate}, got ${snapshot.meetingDate}`
    );
  }
  return { snapshot, snapshotPath };
}

module.exports = {
  collectSnapshot,
  countGitLines,
  loadSnapshot,
  sourceEnabled,
};
