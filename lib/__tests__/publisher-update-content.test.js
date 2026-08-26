const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { update } = require("../publisher");

async function startWikiServer(t, pageText) {
  let putPayload = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "PUT") {
        putPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.end(JSON.stringify({ wiki_page: { version: 2 } }));
        return;
      }
      response.end(JSON.stringify({ wiki_page: { text: pageText, version: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getPutPayload: () => putPayload,
  };
}

test("update publishes the exact draft content that runUpdate validated", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-update-content-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = '#### <span style="color:blue">조현우</span>';
  const nextHeader = '#### <span style="color:blue">다음 사람</span>';
  const pageText = `${header}\n- 기존 내용\n${nextHeader}\n- 보존 내용\n`;
  const { baseUrl, getPutPayload } = await startWikiServer(t, pageText);
  const reportPath = path.join(dir, "report.md");
  const validatedDraft = `${header}\n- 검증된 초안\n`;
  fs.writeFileSync(reportPath, `${header}\n- 경합으로 바뀐 미검증 초안\n`, "utf8");
  let readyChecks = 0;
  const config = {
    env: {
      apiKey: "test-key",
      autoApprove: true,
      baseUrl,
      outputDir: dir,
      outputPath: reportPath,
      pageSuffix: "weekly",
      projectId: "p",
      sectionHeader: header,
      wikiUrl: `${baseUrl}/projects/p/wiki/2026-08-26_weekly`,
    },
  };

  await update(config, new Date("2026-08-26T00:00:00"), {
    draftContent: validatedDraft,
    assertReady: () => { readyChecks += 1; },
  });

  const payload = getPutPayload();
  assert.ok(payload.wiki_page.text.includes("검증된 초안"));
  assert.ok(!payload.wiki_page.text.includes("경합으로 바뀐 미검증 초안"));
  assert.ok(readyChecks >= 1, "외부 쓰기 직전에 generation state를 다시 확인해야 한다");
});

test("update asserts readiness before note issue creation and before each PUT", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-update-ready-order-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = '#### <span style="color:blue">조현우</span>';
  const nextHeader = '#### <span style="color:blue">다음 사람</span>';
  const events = [];
  let putCount = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      events.push(request.method);
      response.setHeader("Content-Type", "application/json");
      if (request.method === "PUT" && putCount++ === 0) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: "conflict" }));
        return;
      }
      response.end(JSON.stringify({ wiki_page: {
        text: `${header}\n- 기존\n${nextHeader}\n- 보존\n`,
        version: putCount + 1,
      } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config = { env: {
    apiKey: "test-key",
    autoApprove: true,
    baseUrl,
    outputDir: dir,
    outputPath: path.join(dir, "report.md"),
    pageSuffix: "weekly",
    projectId: "p",
    sectionHeader: header,
    wikiUrl: `${baseUrl}/projects/p/wiki/2026-08-26_weekly`,
  } };

  await update(config, new Date("2026-08-26T00:00:00"), {
    draftContent: `${header}\n- 검증된 초안\n`,
    assertReady: () => events.push("READY"),
    loadNoteRefs: async () => {
      events.push("NOTES");
      return [];
    },
    waitBeforeRetry: async () => {},
  });

  assert.deepStrictEqual(
    events,
    [
      "READY", "GET",
      "READY", "NOTES",
      "READY", "GET", "READY", "PUT",
      "READY", "GET", "READY", "PUT",
    ]
  );
});
