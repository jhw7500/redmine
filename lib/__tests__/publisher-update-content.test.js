const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { update } = require("../publisher");

async function startWikiServer(t, pageText, options = {}) {
  let putPayload = null;
  let currentText = pageText;
  let currentVersion = 1;
  let currentUpdatedOn = "2026-08-26T09:00:00Z";
  let putSucceeded = false;
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(request.method);
      response.setHeader("Content-Type", "application/json");
      if (request.method === "PUT") {
        putPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        currentText = putPayload.wiki_page.text;
        currentVersion += 1;
        currentUpdatedOn = "2026-08-26T09:05:00Z";
        putSucceeded = true;
        if (options.disconnectPut) {
          response.destroy();
          return;
        }
        if (Object.prototype.hasOwnProperty.call(options, "putResponseBody")) {
          response.end(options.putResponseBody);
          return;
        }
        response.end(JSON.stringify({ wiki_page: {
          text: currentText,
          version: currentVersion,
          updated_on: currentUpdatedOn,
        } }));
        return;
      }
      if (putSucceeded && options.postPutStatus) {
        response.statusCode = options.postPutStatus;
        response.end(options.errorBody || JSON.stringify({ error: "post-write verification failed" }));
        return;
      }
      if (options.prePutStatus && requests.length === 2) {
        response.statusCode = options.prePutStatus;
        response.end(options.errorBody || "pre-write GET failed");
        return;
      }
      const responseText = putSucceeded && options.postPutText !== undefined
        ? options.postPutText
        : currentText;
      response.end(JSON.stringify({ wiki_page: {
        text: responseText,
        version: currentVersion,
        updated_on: currentUpdatedOn,
      } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getPutPayload: () => putPayload,
    getRequests: () => [...requests],
    setPage({ text, version, updatedOn = currentUpdatedOn }) {
      currentText = text;
      currentVersion = version;
      currentUpdatedOn = updatedOn;
    },
  };
}

test("update exposes callback boundaries and returns the exact post-write server section", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-update-content-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = '#### <span style="color:blue">조현우</span>';
  const nextHeader = '#### <span style="color:blue">다음 사람</span>';
  const pageText = `${header}\n- 기존 내용\n${nextHeader}\n- 보존 내용\n`;
  const { baseUrl, getPutPayload, getRequests } = await startWikiServer(t, pageText);
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

  const events = [];
  const result = await update(config, new Date("2026-08-26T00:00:00"), {
    draftContent: validatedDraft,
    assertReady: () => { readyChecks += 1; },
    onBeforeExternalWrite: (context) => events.push(["BEFORE_EXTERNAL_WRITE", context]),
    onFinalSection: (context) => events.push(["FINAL_SECTION", context]),
  });

  const payload = getPutPayload();
  assert.ok(payload.wiki_page.text.includes("검증된 초안"));
  assert.ok(!payload.wiki_page.text.includes("경합으로 바뀐 미검증 초안"));
  assert.ok(readyChecks >= 1, "외부 쓰기 직전에 generation state를 다시 확인해야 한다");
  assert.deepStrictEqual(events.map(([name]) => name), [
    "BEFORE_EXTERNAL_WRITE",
    "FINAL_SECTION",
  ]);
  assert.strictEqual(events[1][1].finalSection, result.finalSection);
  assert.strictEqual(events[1][1].pageUrl, result.pageUrl);
  assert.strictEqual(events[1][1].wikiTitle, "2026-08-26_weekly");
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.remote.section, result.finalSection.trimEnd() + "\n");
  assert.strictEqual(result.remote.version, 2);
  assert.strictEqual(result.remote.updatedOn, "2026-08-26T09:05:00Z");
  assert.match(result.remote.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepStrictEqual(getRequests(), ["GET", "GET", "PUT", "GET"]);
});

test("publisher HTTP errors expose structured status without retaining private response bodies", async (t) => {
  for (const afterWrite of [false, true]) await t.test(String(afterWrite), async (t) => {
    const header = '#### <span style="color:blue">조현우</span>';
    const wiki = await startWikiServer(t, `${header}\n- existing\n`, {
      ...(afterWrite ? { postPutStatus: 503 } : { prePutStatus: 503 }),
      errorBody: "PRIVATE_PUBLISHER_HTTP_BODY_SENTINEL",
    });
    await assert.rejects(() => update({ env: {
      apiKey: "fixture-key", autoApprove: true, baseUrl: wiki.baseUrl,
      outputDir: "/tmp", outputPath: "/tmp/unused-publisher-fixture.md", sectionHeader: header,
      wikiUrl: `${wiki.baseUrl}/projects/p/wiki/weekly`,
    } }, new Date("2026-08-26"), { draftContent: `${header}\n- changed\n` }), (error) => {
      assert.doesNotMatch(error.message, /PRIVATE_PUBLISHER_HTTP_BODY_SENTINEL/);
      assert.doesNotMatch(error.stack, /PRIVATE_PUBLISHER_HTTP_BODY_SENTINEL/);
      assert.strictEqual(error.code, "PUBLISH_HTTP_FAILED");
      assert.strictEqual(error.status, 503);
      assert.match(error.message, /HTTP 503/);
      assert.strictEqual(error.serverState, afterWrite ? "written_unverified" : undefined);
      return true;
    });
  });
});

test("publisher update guards reject to their caller instead of terminating the process", async (t) => {
  const header = '#### <span style="color:blue">조현우</span>';
  const cases = [
    { name: "invalid URL", code: "PUBLISH_URL_INVALID", url: "/invalid" },
    { name: "missing draft", code: "PUBLISH_DRAFT_MISSING" },
    { name: "missing header", code: "PUBLISH_SECTION_INVALID", draft: "no section header" },
    { name: "duplicate header", code: "PUBLISH_SECTION_INVALID", draft: `${header}\n${header}\n` },
    { name: "other person header", code: "PUBLISH_SECTION_INVALID",
      draft: `${header}\n#### <span style="color:blue">다음 사람</span>\n` },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-update-guards-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const wiki = await startWikiServer(t, `${header}\n- existing\n`);
    const config = { env: { apiKey: "fixture-key", autoApprove: true, baseUrl: wiki.baseUrl,
      outputDir: dir, outputPath: path.join(dir, "missing.md"), sectionHeader: header,
      wikiUrl: wiki.baseUrl + (scenario.url || "/projects/p/wiki/weekly"),
    } };
    const options = scenario.draft === undefined ? {} : { draftContent: scenario.draft };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", `
        require(${JSON.stringify(require.resolve("../publisher"))}).update(
          ${JSON.stringify(config)}, new Date("2026-08-26"), ${JSON.stringify(options)}
        ).catch((error) => { console.error("CAUGHT=" + error.code); process.exitCode = 1; });
      `], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, new RegExp(`CAUGHT=${scenario.code}`));
    assert.strictEqual(wiki.getRequests().includes("PUT"), false);
  });
});

test("update verifies applied 2xx PUTs even when their response body is unusable", async (t) => {
  const header = '#### <span style="color:blue">조현우</span>';
  const nextHeader = '#### <span style="color:blue">다음 사람</span>';
  const pageText = `${header}\n- 기존\n${nextHeader}\n- 보존\n`;

  for (const scenario of [
    { name: "malformed JSON", body: "{" },
    { name: "empty body", body: "" },
    { name: "nonessential JSON", body: JSON.stringify({ accepted: true }) },
  ]) {
    await t.test(scenario.name, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-update-put-response-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const wiki = await startWikiServer(t, pageText, { putResponseBody: scenario.body });
      const config = { env: {
        apiKey: "test-key",
        autoApprove: true,
        baseUrl: wiki.baseUrl,
        outputDir: dir,
        outputPath: path.join(dir, "report.md"),
        pageSuffix: "weekly",
        projectId: "p",
        sectionHeader: header,
        wikiUrl: `${wiki.baseUrl}/projects/p/wiki/2026-08-26_weekly`,
      } };

      const result = await update(config, new Date("2026-08-26T00:00:00"), {
        draftContent: `${header}\n- 서버 GET으로 검증할 내용\n`,
      });

      assert.strictEqual(result.changed, true);
      assert.strictEqual(result.remote.section, result.finalSection.trimEnd() + "\n");
      assert.strictEqual(result.remote.version, 2);
      assert.deepStrictEqual(wiki.getRequests(), ["GET", "GET", "PUT", "GET"]);
      assert.ok(wiki.getPutPayload().wiki_page.text.includes("서버 GET으로 검증할 내용"));
    });
  }
});

test("update does not repeat external-write callbacks when a PUT retries after 409", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-update-ready-order-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = '#### <span style="color:blue">조현우</span>';
  const nextHeader = '#### <span style="color:blue">다음 사람</span>';
  const events = [];
  let putCount = 0;
  let currentText = `${header}\n- 기존\n${nextHeader}\n- 보존\n`;
  let currentVersion = 1;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      events.push(request.method);
      response.setHeader("Content-Type", "application/json");
      if (request.method === "PUT") {
        putCount += 1;
        if (putCount === 1) {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "conflict" }));
          return;
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        currentText = payload.wiki_page.text;
        currentVersion += 1;
      }
      response.end(JSON.stringify({ wiki_page: {
        text: currentText,
        version: currentVersion,
        updated_on: "2026-08-26T09:05:00Z",
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
    onBeforeExternalWrite: () => events.push("BEFORE_EXTERNAL_WRITE"),
    onFinalSection: () => events.push("FINAL_SECTION"),
    waitBeforeRetry: async () => {},
  });

  assert.deepStrictEqual(
    events,
    [
      "READY", "GET",
      "READY", "BEFORE_EXTERNAL_WRITE", "NOTES",
      "READY", "FINAL_SECTION", "GET", "READY", "PUT",
      "READY", "GET", "READY", "PUT",
      "GET",
    ]
  );
});

test("update returns structured remote evidence and invokes callbacks when no PUT is needed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-update-no-change-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = '#### <span style="color:blue">조현우</span>';
  const nextHeader = '#### <span style="color:blue">다음 사람</span>';
  const initialText = `${header}\n- 기존\n${nextHeader}\n- 보존\n`;
  const wiki = await startWikiServer(t, initialText);
  const config = { env: {
    apiKey: "test-key",
    autoApprove: true,
    baseUrl: wiki.baseUrl,
    outputDir: dir,
    outputPath: path.join(dir, "report.md"),
    pageSuffix: "weekly",
    projectId: "p",
    sectionHeader: header,
    wikiUrl: `${wiki.baseUrl}/projects/p/wiki/2026-08-26_weekly`,
  } };
  const events = [];

  const result = await update(config, new Date("2026-08-26T00:00:00"), {
    draftContent: `${header}\n- 이미 게시된 내용\n`,
    onBeforeExternalWrite: () => events.push("BEFORE_EXTERNAL_WRITE"),
    onFinalSection: ({ finalSection }) => {
      events.push("FINAL_SECTION");
      wiki.setPage({
        text: `${finalSection.trimEnd()}\n${nextHeader}\n- 보존\n`,
        version: 7,
        updatedOn: "2026-08-26T10:00:00Z",
      });
    },
    verifyRemote: (publication) => {
      events.push("VERIFY_REMOTE");
      assert.strictEqual(publication.changed, false);
      assert.strictEqual(publication.remote.section, publication.finalSection.trimEnd() + "\n");
      assert.strictEqual(publication.remote.version, 7);
    },
  });

  assert.deepStrictEqual(events, ["BEFORE_EXTERNAL_WRITE", "FINAL_SECTION", "VERIFY_REMOTE"]);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.remote.section, result.finalSection.trimEnd() + "\n");
  assert.strictEqual(result.remote.version, 7);
  assert.strictEqual(result.remote.updatedOn, "2026-08-26T10:00:00Z");
  assert.deepStrictEqual(wiki.getRequests(), ["GET", "GET"]);
});

test("update marks successful writes unverified and does not persist when the final GET fails", async (t) => {
  const header = '#### <span style="color:blue">조현우</span>';
  const nextHeader = '#### <span style="color:blue">다음 사람</span>';
  const pageText = `${header}\n- 기존\n${nextHeader}\n- 보존\n`;

  for (const scenario of [
    {
      name: "HTTP failure after malformed successful PUT response",
      server: { putResponseBody: "{", postPutStatus: 500 },
      code: "PUBLISH_HTTP_FAILED",
      status: 500,
    },
    { name: "missing target section", server: { postPutText: `${nextHeader}\n- 보존\n` },
      code: "PUBLISH_SECTION_MISSING" },
  ]) {
    await t.test(scenario.name, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-update-unverified-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const publishedPath = path.join(dir, "published.md");
      const wiki = await startWikiServer(t, pageText, scenario.server);
      const config = { env: {
        apiKey: "test-key",
        autoApprove: true,
        baseUrl: wiki.baseUrl,
        outputDir: dir,
        outputPath: path.join(dir, "report.md"),
        pageSuffix: "weekly",
        projectId: "p",
        sectionHeader: header,
        wikiUrl: `${wiki.baseUrl}/projects/p/wiki/2026-08-26_weekly`,
      } };

      await assert.rejects(
        () => update(config, new Date("2026-08-26T00:00:00"), {
          draftContent: `${header}\n- 검증 대상\n`,
          publishedPath,
        }),
        (error) => {
          assert.strictEqual(error.code, scenario.code);
          assert.strictEqual(error.status, scenario.status);
          return error.redmineWriteAttempted === true
            && error.serverState === "written_unverified"
            && error.stage === "publish_verify";
        }
      );
      assert.strictEqual(fs.existsSync(publishedPath), false);
      assert.deepStrictEqual(wiki.getRequests(), ["GET", "GET", "PUT", "GET"]);
    });
  }
});

test("update distinguishes a disconnected PUT from a failing pre-PUT GET", async (t) => {
  for (const disconnectedPut of [true, false]) await t.test(String(disconnectedPut), async (t) => {
    const header = '#### <span style="color:blue">조현우</span>';
    const wiki = await startWikiServer(t, `${header}\n- existing\n`, disconnectedPut
      ? { disconnectPut: true } : { prePutStatus: 500 });
    await assert.rejects(() => update({ env: {
      apiKey: "fixture-key", autoApprove: true, baseUrl: wiki.baseUrl,
      outputDir: "/tmp", outputPath: "/tmp/unused-weekly-fixture.md", sectionHeader: header,
      wikiUrl: `${wiki.baseUrl}/projects/p/wiki/weekly`,
    } }, new Date("2026-08-26"), { draftContent: `${header}\n- changed\n` }), (error) => {
      if (disconnectedPut) {
        assert.strictEqual(error.wikiWriteAttempted, true);
        assert.strictEqual(error.redmineWriteAttempted, true);
        assert.strictEqual(error.serverState, "written_unverified");
        assert.strictEqual(error.stage, "publish");
        assert.deepStrictEqual(Object.keys(error).sort(), ["redmineWriteAttempted", "serverState", "stage", "wikiWriteAttempted"]);
      } else {
        assert.strictEqual(error.wikiWriteAttempted, undefined);
        assert.strictEqual(error.serverState, undefined);
      }
      return true;
    });
    assert.deepStrictEqual(wiki.getRequests(), disconnectedPut ? ["GET", "GET", "PUT"] : ["GET", "GET"]);
    assert.strictEqual(!!wiki.getPutPayload(), disconnectedPut);
  });
});

test("update validates the final appended presentation block before PUT", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redmine-update-final-notes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = '#### <span style="color:blue">조현우</span>';
  const nextHeader = '#### <span style="color:blue">다음 사람</span>';
  const pageText = `${header}\n- 기존\n${nextHeader}\n- 보존\n`;
  const { baseUrl, getPutPayload } = await startWikiServer(t, pageText);
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

  await assert.rejects(
    () => update(config, new Date("2026-08-26T00:00:00"), {
      draftContent: `${header}\n- 검증된 초안\n`,
      loadNoteRefs: async () => [{ id: 26, title: "TODO 발표 정리" }],
      assertReady: (publishContent) => {
        if (publishContent && publishContent.includes("TODO 발표 정리")) {
          throw new Error("final presentation block validation failed");
        }
      },
    }),
    /final presentation block validation failed/
  );
  assert.strictEqual(getPutPayload(), null);
});
