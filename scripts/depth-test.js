// 상세도(depth) 비교 테스트 — 같은 주차 데이터를 1회만 수집하고
// depth 1/2/3 요약을 각각 생성해 out/jo-hyunwoo-YYYY-MM-DD.depthN.md 로 저장한다.
// 원본 보고서(jo-hyunwoo-YYYY-MM-DD.md)는 건드리지 않는다.
const path = require("path");
const fs = require("fs");
const { loadConfig } = require("../lib/config");
const { collectAll } = require("../lib/collector");
const { mergeIntoAutoContent } = require("../lib/merger");
const { collectAndSave } = require("../lib/collect-notion-api");
const { collectAndSave: collectSessionAndSave } = require("../lib/collect-session");
const {
  resolveMeetingDate,
  dateRange,
  targetWednesday,
  formatDate,
  buildWikiUrl,
  extractTitleFromUrl,
  parseMeetingDateFromTitle,
  buildContent,
  aiSummarize,
  buildOutputPath,
} = require("../lib/publisher");

const DEPTHS = [1, 2, 3];

// 출력의 bullet 최대 들여쓰기 단계 (비교 지표용)
// 2칸 들여쓰기 기준 — AI 출력은 원본 보고서 포맷(2칸)을 따른다는 가정. 탭/4칸이면 부정확.
function maxIndentLevel(text) {
  let max = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/^(\s*)- /);
    if (m) max = Math.max(max, Math.floor(m[1].length / 2) + 1);
  }
  return max;
}

async function main() {
  const config = loadConfig();

  // 회의 날짜 결정 — index.js와 동일 로직
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

  console.log(`[depth-test] Meeting date: ${formatDate(meetingDate)}`);

  // 수집 1회 — index.js와 동일 흐름
  const { startDate, endDate } = dateRange(meetingDate);
  console.log(`[depth-test] Collecting once: ${startDate} ~ ${endDate}`);
  const isoStart = startDate.slice(0, 10);
  const isoEnd = endDate.slice(0, 10);

  if (process.env.NOTION_API_KEY) {
    try {
      await collectAndSave(config, isoStart, isoEnd, config.env.outputDir);
    } catch (err) {
      console.warn(`[notion-api] Collection failed: ${err.message}`);
    }
  } else {
    console.warn("[notion-api] NOTION_API_KEY not set, skipping collection");
  }
  try {
    collectSessionAndSave(config, startDate, endDate, config.env.outputDir);
  } catch (err) {
    console.warn(`[session] Collection failed: ${err.message}`);
  }

  const gitResult = await collectAll(config, startDate, endDate);
  const autoContent = mergeIntoAutoContent(
    gitResult,
    path.join(config.env.outputDir, "notion-items.json"),
    path.join(config.env.outputDir, "session-items.json"),
    config,
    { start: isoStart, end: isoEnd }
  );

  const rawSection = buildContent(meetingDate, autoContent, config);
  const basePath = buildOutputPath(meetingDate, config);

  // depth별 요약 — 같은 rawSection 재사용, 순차 실행 (로그 분리)
  const results = [];
  for (const depth of DEPTHS) {
    const cfg = { ...config, env: { ...config.env, reportDepth: depth, aiSummarize: true } };
    const outPath = basePath.replace(/\.md$/, `.depth${depth}.md`);
    console.log(`\n[depth-test] === depth ${depth} ===`);
    const summarized = await aiSummarize(rawSection, cfg);
    if (!summarized) {
      console.warn(`[depth-test] depth ${depth}: AI 요약 실패 — 파일 저장 생략`);
      results.push({ depth, ok: false, outPath: "-", lines: 0, indent: 0 });
      continue;
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, summarized, "utf8");
    results.push({
      depth,
      ok: true,
      outPath,
      lines: summarized.trim().split("\n").length,
      indent: maxIndentLevel(summarized),
    });
    console.log(`[depth-test] depth ${depth}: saved ${outPath}`);
  }

  console.log("\n[depth-test] ===== 결과 요약 =====");
  console.log("depth | 상태 | 줄수 | 최대들여쓰기 | 파일");
  for (const r of results) {
    console.log(
      `  ${r.depth}   | ${r.ok ? "OK  " : "FAIL"} | ${String(r.lines).padStart(3)} | ${r.indent}단 | ${r.outPath}`
    );
  }

  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
