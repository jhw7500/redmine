#!/usr/bin/env node
// 셸 래퍼가 provider 우회 여부를 판단하기 위한 진입점.
//   status <outputDir> [depth]  -> exit 0=AI 선택 채택, 10=쿼터로 fallback,
//                                  11=그 밖의 fallback 또는 판정 불가
//   active-dir <baseDir>        -> 유효한 포인터가 있으면 경로를 출력(exit 0), 없으면 exit 1
const { readWeeklySelectionStatus, readActiveOutputDir } = require("../lib/weekly-selection-status");

const [, , command, target, depthArg] = process.argv;
if (!command || !target) {
  console.error("usage: weekly-selection-status.js status <outputDir> [depth] | active-dir <baseDir>");
  process.exit(64);
}

if (command === "active-dir") {
  const dir = readActiveOutputDir(target);
  if (!dir) process.exit(1);
  process.stdout.write(dir + "\n");
  process.exit(0);
}

if (command !== "status") {
  console.error(`unknown command: ${command}`);
  process.exit(64);
}

const status = readWeeklySelectionStatus(target, { depth: Number(depthArg) || 2 });
console.log(JSON.stringify(status));
if (!status) process.exit(11);
if (status.origin === "ai") process.exit(0);
process.exit(status.errorCode === "AI_QUOTA" ? 10 : 11);
