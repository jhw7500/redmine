const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupSnapshot, makeFakeClaude } = require('./helpers/report-run-fixture');
const { runWeeklyPrepare, runWeeklyPublish, runGenerateV2, runUpdate } = require('../../index');
const { buildWeeklyPipelinePaths, createWeeklyAttempt, markWeeklyReady } = require('../weekly-pipeline');
const { sha256, buildPublishedPath } = require('../report-artifact');
const { collectNotionItems, queryDatabase } = require('../collect-notion-api');
const { update } = require('../publisher');

test('Notion collection JSON diagnostics exclude private response text at every endpoint', async t => {
  for (const endpoint of ['projects', 'database', 'search']) await t.test(endpoint, async t => {
    t.mock.method(global, 'fetch', async url => {
      const target = endpoint !== 'search' || String(url).endsWith('/search');
      return new Response(target ? 'SYNTHETIC_PRIVATE_JSON_BODY' : '{"results":[],"has_more":false}');
    });
    if (endpoint === 'database') {
      await assert.rejects(() => queryDatabase('fixture', { id: 'fixture', dateFilterType: 'created_time' },
        '2026-08-19T06:00:00Z', '2026-08-26T06:00:00Z'), error => {
        assert.equal(error.code, 'NOTION_JSON_INVALID');
        assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE/);
        return true;
      });
    } else {
      const warnings = [];
      t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
      const collect = () => collectNotionItems({ sources: { notion: { enabled: true, searchKeywords: ['fixture'] } } },
        '2026-08-19T06:00:00Z', '2026-08-26T06:00:00Z', 'fixture');
      if (endpoint === 'projects') await assert.rejects(collect, error => {
        assert.equal(error.code, 'NOTION_JSON_INVALID');
        assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE/);
        return true;
      });
      else {
        assert.deepEqual(await collect(), []);
        assert.equal(warnings.length, 1);
        assert.doesNotMatch(warnings[0], /SYNTH|Unexpected token/);
      }
    }
  });
});

async function failRealCollection(t) {
  const f = setupSnapshot(t, { rawContent: 'fixture report\n' });
  Object.assign(f.config.env, {
    mode: 'weekly-prepare', aiSummarize: true, aiProvider: 'codex',
    aiModel: 'gpt-5.6-sol', aiEffort: 'low', aiGenerationMethod: 'source_selection',
    aiGenerationScope: 'whole', sourceSelectionFallback: true, reportDepth: 3,
    validationMode: 'block', validationOverride: false, presentationNoteMode: 'suggest',
    forceCollect: true, templatePath: path.resolve(__dirname, '../../templates/jo-hyunwoo.md'),
  });
  f.config.sources = { notion: { enabled: true }, git: { enabled: false }, session: { enabled: false } };
  const previousKey = process.env.NOTION_API_KEY;
  process.env.NOTION_API_KEY = 'fixture-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = previousKey;
  });
  t.mock.method(global, 'fetch', async () => new Response('SYNTHETIC_COLLECTION_BODY', { status: 503 }));
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  let failure;
  await assert.rejects(() => runWeeklyPrepare(f.config, f.meetingDate), error => {
    failure = error.weeklyFailure;
    return Boolean(failure);
  });
  return { ...f, failure, logs };
}

test('Wiki revision metadata is required even without changes or before sending PUT', async t => {
  for (const mode of ['no-change', 'before-put']) await t.test(mode, async t => {
    const f = setupSnapshot(t, { rawContent: 'fixture report\n' });
    const header = f.config.env.sectionHeader;
    Object.assign(f.config.env, { autoApprove: true, apiKey: 'fixture', baseUrl: 'https://fixture.invalid', projectId: 'p',
      wikiUrl: 'https://fixture.invalid/projects/p/wiki/weekly' });
    let finalSection;
    const requests = [];
    t.mock.method(global, 'fetch', async (url, options = {}) => {
      assert.ok(String(url).startsWith('https://fixture.invalid/'));
      requests.push(options.method || 'GET');
      return new Response(JSON.stringify({ wiki_page: {
        text: finalSection && mode === 'no-change' ? finalSection : `${header}\n- old\n`,
        version: finalSection ? undefined : 1, updated_on: '2026-08-26T06:00:00Z',
      } }));
    });
    await assert.rejects(() => update(f.config, f.meetingDate, {
      draftContent: `${header}\n- replacement\n`, publishedPath: buildPublishedPath(f.reportPath),
      onFinalSection: result => { finalSection = result.finalSection; },
    }), { code: 'PUBLISH_RESPONSE_INVALID' });
    assert.deepEqual(requests, ['GET', 'GET']);
    assert.equal(fs.existsSync(buildPublishedPath(f.reportPath)), false);
  });
});

test('real collection failure retains no HTTP body in snapshot, failure artifacts or log', async t => {
  const f = await failRealCollection(t);
  for (const file of [f.snapshotPath, f.failure.jsonPath, f.failure.markdownPath]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SYNTHETIC_COLLECTION_BODY/);
  }
  assert.doesNotMatch(f.logs.join('\n'), /SYNTHETIC_COLLECTION_BODY/);
});

test('real thrown collection retains the partial snapshot path and complete-byte hash', async t => {
  const f = await failRealCollection(t);
  const snapshot = JSON.parse(fs.readFileSync(f.snapshotPath));
  assert.equal(snapshot.status, 'partial');
  const artifact = f.failure.failure.artifacts.find(item => item.path === f.snapshotPath);
  assert.ok(artifact, 'existing partial snapshot must be listed in failure evidence');
  assert.equal(artifact.sha256, sha256(fs.readFileSync(f.snapshotPath)));
});

test('invalid post-PUT Wiki revision metadata prevents every success effect', async t => {
  for (const metadata of [
    { name: 'missing version', updatedOn: '2026-08-26T06:00:00Z' },
    { name: 'zero version', version: 0, updatedOn: '2026-08-26T06:00:00Z' },
    { name: 'string version', version: '2', updatedOn: '2026-08-26T06:00:00Z' },
    { name: 'missing updatedOn', version: 2 },
    { name: 'invalid updatedOn', version: 2, updatedOn: 'not-a-date' },
  ]) await t.test(metadata.name, async t => {
    const header = '#### <span style="color:blue">조현우</span>';
    const f = setupSnapshot(t, {
      rawContent: `${header}\n- PIM\n  - Application\n    - FPS 30 to 60\n`,
      autoContent: { '{{APP}}': '- updated' },
      categories: { app: { parent: 'PIM', label: 'Application', templateKey: 'APP' } },
    });
    Object.assign(f.config.env, {
      aiSummarize: true, aiGenerationMethod: 'source_selection', sourceSelectionFallback: true,
      autoApprove: true, presentationNoteMode: 'suggest', baseUrl: 'https://fixture.invalid',
      apiKey: 'fixture', projectId: 'p', wikiUrl: 'https://fixture.invalid/projects/p/wiki/2026-08-26_weekly',
    });
    f.config.env.claudeCli = makeFakeClaude(f, JSON.stringify({ sections: [{ id: 'C0001',
      groups: [{ theme: 'stability', items: [{ id: 'R0001', highlight: false }] }] }] }));
    await runGenerateV2(f.config, f.meetingDate);
    const generation = JSON.parse(fs.readFileSync(f.generationStatePath));
    const paths = buildWeeklyPipelinePaths(f.dir, '2026-08-26');
    const attempt = '11111111-1111-4111-8111-111111111111';
    createWeeklyAttempt({ outputDir: f.dir, meetingDate: '2026-08-26', reportDepth: 3,
      attemptId: attempt, now: () => new Date().toISOString() });
    markWeeklyReady(paths, attempt, {
      snapshotPath: f.snapshotPath, snapshotHash: f.snapshot.contentHash,
      generationStatePath: f.generationStatePath, generationAttemptId: generation.attemptId,
      reportPath: f.reportPath, reportHash: sha256(fs.readFileSync(f.reportPath)),
    });
    let wikiText = `${header}\n- existing\n`;
    let written = false;
    const requests = [];
    t.mock.method(global, 'fetch', async (url, options = {}) => {
      assert.ok(String(url).startsWith('https://fixture.invalid/'));
      requests.push(options.method || 'GET');
      if (options.method === 'PUT') {
        wikiText = JSON.parse(options.body).wiki_page.text;
        written = true;
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ wiki_page: { text: wikiText,
        version: written ? metadata.version : 1,
        updated_on: written ? metadata.updatedOn : '2026-08-26T06:00:00Z',
      } }));
    });
    let closureCalls = 0;
    await assert.rejects(() => runWeeklyPublish(f.config, f.meetingDate, {
      runUpdate: (config, date, options) => runUpdate(config, date, { ...options,
        queryCompletedNotes: async () => [],
        closePresentedNotes: async () => { closureCalls += 1; return []; },
      }),
    }));
    const state = JSON.parse(fs.readFileSync(paths.statusPath));
    const failure = JSON.parse(fs.readFileSync(state.failureArtifact.replace(/\.md$/, '.json')));
    assert.equal(state.status, 'failed');
    assert.equal(failure.serverState, 'written_unverified');
    assert.equal(failure.redmineWriteAttempted, true);
    assert.equal(fs.existsSync(buildPublishedPath(f.reportPath)), false);
    assert.equal(closureCalls, 0);
    assert.deepEqual(requests, ['GET', 'GET', 'PUT', 'GET']);
  });
});
