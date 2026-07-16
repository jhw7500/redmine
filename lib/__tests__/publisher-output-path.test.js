const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { buildOutputPath } = require("../publisher");

test("buildOutputPath: 기본 파일명에 report depth를 포함한다", () => {
  const meetingDate = new Date("2026-07-15T00:00:00");
  const config = {
    env: {
      outputDir: "/tmp/redmine-out",
      outputPath: "",
      reportDepth: 2,
    },
  };

  assert.strictEqual(
    buildOutputPath(meetingDate, config),
    path.join(config.env.outputDir, "jo-hyunwoo-2026-07-15.depth2.md")
  );
});

test("buildOutputPath: 명시한 OUTPUT_PATH는 변경하지 않는다", () => {
  const meetingDate = new Date("2026-07-15T00:00:00");
  const config = {
    env: {
      outputDir: "/tmp/redmine-out",
      outputPath: "/tmp/custom-report.md",
      reportDepth: 3,
    },
  };

  assert.strictEqual(buildOutputPath(meetingDate, config), config.env.outputPath);
});
