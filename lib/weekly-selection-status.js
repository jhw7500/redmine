// 주간보고 prepare 가 AI 선택을 실제로 채택했는지, fallback 이라면 그 원인이
// 무엇인지 산출물에서 읽는다. provider 우회 판단의 입력이며, 판단 자체는
// 셸 래퍼가 한다.
const fs = require("node:fs");
const path = require("node:path");

function readWeeklySelectionStatus(outputDir, options = {}) {
  const depth = options.depth || 2;
  const pairsDir = path.join(outputDir, "pairs");
  if (!fs.existsSync(pairsDir)) return null;
  const meetingDate = options.meetingDate || fs.readdirSync(pairsDir)
    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().at(-1);
  if (!meetingDate) return null;
  const generationPath = path.join(pairsDir, meetingDate, `depth${depth}`,
    `report-${meetingDate}.depth${depth}.generation.json`);
  if (!fs.existsSync(generationPath)) return null;
  const generation = JSON.parse(fs.readFileSync(generationPath, "utf8"));
  if (!generation.runDir) return null;
  const selectionPath = path.join(generation.runDir, "source-selection.json");
  if (!fs.existsSync(selectionPath)) return null;
  const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
  return {
    meetingDate, depth,
    origin: selection.origin ?? null,
    errorCode: selection.errorCode ?? null,
  };
}

const POINTER_NAME = "weekly-active-output-dir.json";

// prepare 가 provider 를 우회해 다른 OUTPUT_DIR 을 정본으로 삼았을 때,
// 뒤따르는 publish/send 가 같은 곳을 보게 하는 포인터. cron 세 단계는 서로
// 독립 실행이라 상태를 파일로 넘긴다.
//
// 포인터는 늙지 않는다. send 의 중복 전송 방지와 publish 의 중복 게시 방지는
// 모두 <OUTPUT_DIR>/pairs/<date>/ 아래 영수증으로 하므로, 시간이 지나 base 로
// 되돌아가면 우회 디렉터리에 남은 영수증을 못 보고 base 의 빈 원장을 읽어
// Slack 스레드를 재전송하고 위키를 덮어쓴다. 대신 prepare 가 시작할 때 지난
// 포인터를 지우고, 읽을 때 대상이 그 회의 pair 를 여전히 갖고 있는지 본다.
function writeActiveOutputDir(baseDir, { meetingDate, outputDir }) {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, POINTER_NAME), JSON.stringify({
    meetingDate, outputDir, createdAt: new Date().toISOString(),
  }) + "\n", "utf8");
}

function readActiveOutputDir(baseDir) {
  const pointerPath = path.join(baseDir, POINTER_NAME);
  if (!fs.existsSync(pointerPath)) return null;
  let pointer;
  try { pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8")); }
  catch { return null; }
  if (!pointer.outputDir || !pointer.meetingDate) return null;
  // 대상이 사라졌거나 다른 회의 것이면 따라가지 않는다.
  if (!readWeeklySelectionStatus(pointer.outputDir, { meetingDate: pointer.meetingDate })) return null;
  return pointer.outputDir;
}

function clearActiveOutputDir(baseDir) {
  fs.rmSync(path.join(baseDir, POINTER_NAME), { force: true });
}

module.exports = {
  readWeeklySelectionStatus, writeActiveOutputDir, readActiveOutputDir, clearActiveOutputDir,
};
