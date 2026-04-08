// Design Ref: §4.4 + §4.6 — 엔트리포인트 (워크플로 오케스트레이션 + 멀티소스 통합)
const path = require("path");
const { loadConfig } = require("./lib/config");
const { collectAll } = require("./lib/collector");
const { mergeIntoAutoContent } = require("./lib/merger");
const {
  generate,
  update,
  resolveMeetingDate,
  dateRange,
  targetWednesday,
  formatDate,
  buildWikiUrl,
  extractTitleFromUrl,
  parseMeetingDateFromTitle,
} = require("./lib/publisher");

async function main() {
  const config = loadConfig();

  // 1. 회의 날짜 결정
  let meetingDate = resolveMeetingDate(config);
  let wikiUrl = config.env.wikiUrl;

  if (!wikiUrl) {
    if (!meetingDate) meetingDate = targetWednesday(new Date());
    wikiUrl = buildWikiUrl(meetingDate, config);
  }

  if (!meetingDate) {
    const title = extractTitleFromUrl(wikiUrl);
    meetingDate = parseMeetingDateFromTitle(title) || targetWednesday(new Date());
  }

  if (!meetingDate || Number.isNaN(meetingDate.getTime())) {
    console.error("Could not determine meeting date. Set MEETING_DATE=YYYY-MM-DD.");
    process.exit(1);
  }

  console.log(`Meeting date: ${formatDate(meetingDate)}`);
  console.log(`Mode: ${config.env.mode}`);

  // 2. 커밋 수집 + 분류
  const { startDate, endDate } = dateRange(meetingDate);
  console.log(`Collecting commits: ${startDate} ~ ${endDate}`);
  // Plan SC: SC-01 — 3개 소스 통합 보고서 생성
  const gitResult = await collectAll(config, startDate, endDate);
  const autoContent = mergeIntoAutoContent(
    gitResult,
    path.join(config.env.outputDir, "notion-items.json"),
    path.join(config.env.outputDir, "session-items.json"),
    config
  );

  // 3. 모드별 실행
  if (config.env.mode === "generate") {
    const outputPath = await generate(config, meetingDate, autoContent);
    console.log(`Generated: ${outputPath}`);
  } else if (config.env.mode === "update") {
    await update(config, meetingDate, autoContent);
  } else {
    console.error(`Unknown MODE: ${config.env.mode}. Use 'generate' or 'update'.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
