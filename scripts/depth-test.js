// 동일한 sealed snapshot으로 depth 1/2/3/4를 생성·검증한다.
const path = require("path");
const { loadConfig } = require("../lib/config");
const { validateReport } = require("../lib/fact-validator");
const {
  buildValidationPath,
  writeJsonAtomic,
} = require("../lib/report-artifact");
const { loadSnapshot } = require("../lib/report-snapshot");
const {
  buildOutputPath,
  formatDate,
  generate,
} = require("../lib/publisher");
const { resolveRunMeetingDate } = require("../index");

const DEPTHS = [1, 2, 3, 4];

function maxIndentLevel(text) {
  let max = 0;
  for (const line of text.split("\n")) {
    const match = line.match(/^(\s*)- /);
    if (match) max = Math.max(max, Math.floor(match[1].length / 2) + 1);
  }
  return max;
}

async function main() {
  const config = loadConfig();
  const meetingDate = resolveRunMeetingDate(config);
  const { snapshot, snapshotPath } = loadSnapshot(config, meetingDate);
  console.log(`[depth-test] Meeting date: ${formatDate(meetingDate)}`);
  console.log(`[depth-test] Snapshot: ${snapshotPath} (${snapshot.contentHash})`);

  const basePath = buildOutputPath(meetingDate, config);
  const results = [];
  for (const depth of DEPTHS) {
    const outPath = basePath.replace(/(?:\.depth[1-4])?\.md$/, `.depth${depth}.md`);
    const depthConfig = {
      ...config,
      env: {
        ...config.env,
        aiSummarize: true,
        outputPath: outPath,
        reportDepth: depth,
      },
    };
    console.log(`\n[depth-test] === depth ${depth} ===`);
    const generatedPath = await generate(
      depthConfig,
      meetingDate,
      snapshot.autoContent,
      [],
      { rawContent: snapshot.rawContent }
    );
    const reportContent = require("fs").readFileSync(generatedPath, "utf8");
    const validation = validateReport(snapshot.rawContent, reportContent, {
      meetingDate: formatDate(meetingDate),
      reportDepth: depth,
      sectionHeader: config.env.sectionHeader,
      snapshotHash: snapshot.contentHash,
      snapshotPath,
      repos: config.repos,
    });
    writeJsonAtomic(buildValidationPath(generatedPath), validation);
    results.push({
      depth,
      ok: validation.status === "PASS",
      status: validation.status,
      outPath: generatedPath,
      lines: reportContent.trim().split("\n").length,
      indent: maxIndentLevel(reportContent),
    });
  }

  console.log("\n[depth-test] ===== 결과 요약 =====");
  console.log("depth | 검증 | 줄수 | 최대들여쓰기 | 파일");
  for (const result of results) {
    console.log(
      `  ${result.depth}   | ${result.status.padEnd(7)} | ${String(result.lines).padStart(3)} | `
      + `${result.indent}단 | ${result.outPath}`
    );
  }
  if (results.some((result) => !result.ok)) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main, maxIndentLevel };
