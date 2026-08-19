const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadConfig, readJsonFile } = require("../config");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-config-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// cron 로그에는 스택 트레이스만 남아 "무엇을 읽다 실패했는지"가 드러나지 않았다.
// 파일 경로와 사유가 메시지 첫 줄에 있어야 한다.
test("a missing config file names the file and the reason", () => {
  withTempDir((dir) => {
    const missing = path.join(dir, "repo-config.json");
    assert.throws(
      () => readJsonFile(missing, "저장소 설정"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /저장소 설정 로드 실패/);
        assert.ok(err.message.includes(missing), "메시지에 파일 경로가 있어야 한다");
        assert.match(err.message, /파일이 없습니다/);
        return true;
      }
    );
  });
});

test("a broken JSON file reports a parse failure, not a raw SyntaxError", () => {
  withTempDir((dir) => {
    const broken = path.join(dir, "translation-rules.json");
    fs.writeFileSync(broken, '{"pattern": ', "utf8");

    assert.throws(
      () => readJsonFile(broken, "번역 규칙"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof SyntaxError), "가공되지 않은 SyntaxError가 새어나오면 안 된다");
        assert.match(err.message, /번역 규칙 JSON 파싱 실패/);
        assert.ok(err.message.includes(broken));
        return true;
      }
    );
  });
});

test("a valid file is parsed and returned unchanged", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "ok.json");
    fs.writeFileSync(file, JSON.stringify({ repos: { a: { path: "/tmp/a" } } }), "utf8");

    assert.deepStrictEqual(readJsonFile(file, "저장소 설정"), {
      repos: { a: { path: "/tmp/a" } },
    });
  });
});

test("a directory given instead of a file still yields a labelled error", () => {
  withTempDir((dir) => {
    assert.throws(
      () => readJsonFile(dir, "저장소 설정"),
      (err) => {
        assert.match(err.message, /저장소 설정 로드 실패/);
        return true;
      }
    );
  });
});

// 종전에는 이 경로가 process.exit(1) 이라, 이 모듈을 로드한 테스트 러너가 진단 기회
// 없이 그 자리에서 죽었다. 던지기만 하고 종료는 호출자(main)가 정한다.
test("update mode without a Redmine API key throws instead of killing the process", () => {
  const saved = {
    key: process.env.REDMINE_API_KEY,
    mode: process.env.MODE,
  };
  try {
    delete process.env.REDMINE_API_KEY;
    process.env.MODE = "update";

    assert.throws(() => loadConfig(), /REDMINE_API_KEY/);
  } finally {
    if (saved.key === undefined) delete process.env.REDMINE_API_KEY;
    else process.env.REDMINE_API_KEY = saved.key;
    if (saved.mode === undefined) delete process.env.MODE;
    else process.env.MODE = saved.mode;
  }
});

test("collect mode loads without a Redmine API key", () => {
  const saved = {
    key: process.env.REDMINE_API_KEY,
    mode: process.env.MODE,
  };
  try {
    delete process.env.REDMINE_API_KEY;
    process.env.MODE = "collect";

    const config = loadConfig();
    assert.strictEqual(config.env.mode, "collect");
    assert.ok(config.repos, "저장소 설정이 로드되어야 한다");
  } finally {
    if (saved.key === undefined) delete process.env.REDMINE_API_KEY;
    else process.env.REDMINE_API_KEY = saved.key;
    if (saved.mode === undefined) delete process.env.MODE;
    else process.env.MODE = saved.mode;
  }
});
