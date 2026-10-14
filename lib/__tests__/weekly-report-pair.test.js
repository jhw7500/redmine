const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {setupSnapshot,makeFakeClaude} = require('./helpers/report-run-fixture');
const {runGenerateV2,runWeeklyPrepare,runWeeklyPublish} = require('../../index');
const {prepareWeeklyPair,readWeeklyPair,publishWeeklyPair,previewWeeklyPair} = require('../weekly-report-pair');

const summaryHeader = '#### <span style="color:blue">조현우</span>\n- PIM\n  - Application [[source:C0001]]\n';
const koreanSummary = summaryHeader + '    - [[fact:V0001|HD60]] 실측 검증\n      - 다채널 조건 한정 성능 확인\n';
const englishSummary = summaryHeader + '    - [[fact:V0001|HD60]] measurement verified\n      - limited multi-channel performance check\n';

// Pair variants ask for a JSON selection; only the summary asks for freeform Markdown.
function makeSummaryFake(f, summary) {
  const file = path.join(f.dir, 'fake-summary-claude.js');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(f.callsPath)}, String(Number(fs.readFileSync(${JSON.stringify(f.callsPath)}, 'utf8')) + 1));
const args = process.argv.slice(2);
process.stdout.write((args[args.indexOf('-p') + 1] || '').includes('"groups":[') ? 'invalid selection' : ${JSON.stringify(summary)});
`, {mode:0o755});
  return file;
}

async function readyPair(t, options = {}) {
  const f = setupSnapshot(t,{reportDepth:3,
    rawContent:'#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - [Notion] HD60 실측\n      ↳ 검증: 59.6fps, 4채널 조건 한정\n',
    autoContent:{'{{APP}}':'- updated'},categories:{app:{parent:'PIM',label:'Application',templateKey:'APP'}}});
  const fake = options.summary === undefined ? makeFakeClaude(f,'invalid selection') : makeSummaryFake(f, options.summary);
  Object.assign(f.config.env,{aiSummarize:true,aiProvider:'codex',aiModel:'gpt-5.6-sol',aiEffort:'low',
    aiGenerationMethod:'source_selection',aiGenerationScope:'whole',sourceSelectionFallback:true,
    presentationNoteMode:'suggest',autoApprove:true});
  const pair = await prepareWeeklyPair(f.config,f.meetingDate,{
    collect:async()=>({snapshot:f.snapshot,snapshotPath:f.snapshotPath}),
    generate:(config,date)=>(options.generate || runGenerateV2)({...config,env:{...config.env,
      aiProvider:'claude',aiModel:'sonnet',claudeCli:fake}},date),
    ...(options.alertLogPath === null ? {} : {alertLogPath:options.alertLogPath || path.join(f.dir,'ALERT.log')}),
  });
  return {...f,pair,fake};
}

function mockWiki(t, f) {
  const notionKey = process.env.NOTION_API_KEY;
  delete process.env.NOTION_API_KEY;
  t.after(() => { if (notionKey !== undefined) process.env.NOTION_API_KEY = notionKey; });
  Object.assign(f.config.env, {baseUrl:'http://weekly.invalid', apiKey:'fixture', projectId:'p',
    wikiUrl:'http://weekly.invalid/projects/p/wiki/weekly'});
  const wiki = {text:`${f.config.env.sectionHeader}\n- existing\n`, puts:0};
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    assert.ok(String(url).startsWith('http://weekly.invalid/projects/p/wiki/'));
    if (options.method === 'PUT') { wiki.text = JSON.parse(options.body).wiki_page.text; wiki.puts++; }
    return new Response(JSON.stringify({wiki_page:{text:wiki.text,version:1 + wiki.puts,updated_on:'2026-09-09T06:45:00Z'}}));
  });
  return wiki;
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const captureLogs = t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  return logs;
};

function configureSlackIdentity(config) {
  Object.assign(config.env,{slackBriefingChannelId:'DPRIVATE1',slackBotToken:'xoxb-test',
    slackBriefingTeamId:'TAPPROVED',slackBriefingBotId:'BAPPROVED',
    slackBriefingBotUserId:'UAPPBOT',slackBriefingPeerUserId:'UOWNER'});
}

function verifiedSlackFetch(config, post) {
  return async (url, options) => {
    if (url.endsWith('/auth.test')) return new Response(JSON.stringify({ok:true,
      team_id:config.env.slackBriefingTeamId,bot_id:config.env.slackBriefingBotId,
      user_id:config.env.slackBriefingBotUserId}));
    if (url.endsWith('/conversations.info')) return new Response(JSON.stringify({ok:true,
      channel:{id:config.env.slackBriefingChannelId,is_im:true,is_mpim:false,is_ext_shared:false,
        user:config.env.slackBriefingPeerUserId}}));
    return post(url,options);
  };
}

test('paired preparation retains two independently verifiable reports and mobile formatting never changes depth3',async t=>{
  const f=await readyPair(t);
  const pair=readWeeklyPair(f.config,f.meetingDate);
  assert.equal(pair.manifest.defaultPublishDepth,2);
  assert.equal(pair.variants[2].state.reportDepth,2);
  assert.equal(pair.variants[3].state.reportDepth,3);
  assert.notEqual(pair.variants[2].state.reportPath,pair.variants[3].state.reportPath);
  const d3=fs.readFileSync(pair.variants[3].state.reportPath);
  const preview=previewWeeklyPair(f.config,f.meetingDate);
  assert.equal(preview.sourceDepth,3);
  assert.ok(preview.replies.some(message=>message.text.includes('59.6fps, 4채널 조건 한정')));
  assert.deepEqual(fs.readFileSync(pair.variants[3].state.reportPath),d3);
  assert.match(d3.toString(),/원문 발췌/);
});

test('explicit depth3 selection reaches the existing publish gate without replacing either original',async t=>{
  const f=await readyPair(t);
  const pair=readWeeklyPair(f.config,f.meetingDate);
  const before=Object.fromEntries([2,3].map(depth=>[depth,fs.readFileSync(pair.variants[depth].state.reportPath)]));
  // Capture at the external update boundary; the real weekly publish state machine runs.
  await assert.rejects(publishWeeklyPair(f.config,f.meetingDate,{depth:3,dependencies:{
    runUpdate:async(config)=>{
      assert.equal(config.env.reportDepth,3);
      assert.equal(config.env.outputPath,pair.variants[3].state.reportPath);
      throw Object.assign(new Error('fixture stops before remote writes'),{code:'FIXTURE_NO_WRITE'});
    },
  }}),/fixture stops before remote writes/);
  for(const depth of [2,3]) assert.deepEqual(fs.readFileSync(pair.variants[depth].state.reportPath),before[depth]);
  await assert.rejects(publishWeeklyPair(f.config,f.meetingDate,{depth:2}),/inspect|recovery/);
});

test('a changed depth3 report blocks selection and Slack preview before any external write',async t=>{
  const f=await readyPair(t);
  const pair=readWeeklyPair(f.config,f.meetingDate);
  fs.appendFileSync(pair.variants[3].state.reportPath,'changed');
  assert.throws(()=>previewWeeklyPair(f.config,f.meetingDate),/hash|evidence/);
  await assert.rejects(publishWeeklyPair(f.config,f.meetingDate,{depth:3}),/hash|evidence/);
});

test('a widened private pair directory blocks preview before external work',async t=>{
  const f=await readyPair(t);
  fs.chmodSync(f.pair.root,0o750);
  assert.throws(()=>previewWeeklyPair(f.config,f.meetingDate),/private directory.*mode/i);
});

test('paired preparation refuses to replace an existing current bundle and preserves its original bytes',async t=>{
  const f=await readyPair(t);
  const bytes=fs.readFileSync(f.pair.manifestPath);
  await assert.rejects(prepareWeeklyPair(f.config,f.meetingDate),/already exists/);
  assert.deepEqual(fs.readFileSync(f.pair.manifestPath),bytes);
});

for (const depth of [2, 3]) test(`depth${depth} publication verifies one Wiki write, preserves both originals, and skips a completed retry`, async t => {
  const f = await readyPair(t);
  const pair = readWeeklyPair(f.config, f.meetingDate);
  const originals = [2, 3].map(d => fs.readFileSync(pair.variants[d].state.reportPath));
  const notionKey = process.env.NOTION_API_KEY;
  delete process.env.NOTION_API_KEY;
  t.after(() => { if (notionKey !== undefined) process.env.NOTION_API_KEY = notionKey; });
  let wikiText = `${f.config.env.sectionHeader}\n- existing\n`;
  let puts = 0;
  Object.assign(f.config.env, {baseUrl:'http://weekly.invalid', apiKey:'fixture', projectId:'p',
    wikiUrl:'http://weekly.invalid/projects/p/wiki/weekly'});
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    assert.ok(String(url).startsWith('http://weekly.invalid/projects/p/wiki/'));
    if (options.method === 'PUT') { wikiText = JSON.parse(options.body).wiki_page.text; puts++; }
    return new Response(JSON.stringify({wiki_page:{text:wikiText,version:1 + puts,updated_on:'2026-09-09T06:45:00Z'}}));
  });
  const result = await publishWeeklyPair(f.config, f.meetingDate, depth === 2 ? undefined : {depth});
  assert.equal(result.state.status, 'published');
  assert.equal(result.state.reportDepth, depth);
  assert.equal(puts, 1);
  assert.equal((await publishWeeklyPair(f.config, f.meetingDate, {depth})).skipped, true);
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:depth === 2 ? 3 : 2}), /explicit recovery approval/);
  assert.equal(puts, 1);
  for (const [index, d] of [2, 3].entries()) assert.deepEqual(fs.readFileSync(pair.variants[d].state.reportPath), originals[index]);
  const completed = path.join(pair.root, 'publication.completed.json');
  const receipt = JSON.parse(fs.readFileSync(completed));
  fs.writeFileSync(completed, JSON.stringify({...receipt, meetingDate:'2000-01-01'}));
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth}), /receipt|evidence/);
  assert.equal(puts, 1);
  fs.renameSync(completed, completed + '.retained');
  const started = path.join(pair.root, 'publication.started.json');
  fs.renameSync(started, started + '.retained');
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:depth === 2 ? 3 : 2}), /recovery/);
  assert.equal(puts, 1);
});

test('a symlinked variant and an invalid depth fail before publication', async t => {
  const f = await readyPair(t);
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:4}), /2 or 3/);
  const report = readWeeklyPair(f.config, f.meetingDate).variants[3].state.reportPath;
  fs.renameSync(report, report + '.retained');
  fs.symlinkSync(report + '.retained', report);
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:3}), /symlink|evidence|regular/);
  assert.equal(fs.existsSync(path.join(f.pair.root, 'publication.started.json')), false);
});

for (const depth of [2, 3]) test(`pair Slack delivery survives depth${depth} publication failure without editing the original`, async t => {
  const f = await readyPair(t);
  const {sendWeeklyPair} = require('../weekly-report-pair');
  const d3 = readWeeklyPair(f.config, f.meetingDate).variants[3].state.reportPath;
  const bytes = fs.readFileSync(d3);
  configureSlackIdentity(f.config);
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth,dependencies:{
    runUpdate:async () => { throw new Error('fixture Redmine unavailable'); },
  }}), /fixture Redmine unavailable/);
  const publicationIntent = fs.readFileSync(path.join(f.pair.root, 'publication.started.json'));
  let calls = 0;
  const dependencies = {sleep:async () => {},fetch:verifiedSlackFetch(f.config,async (url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.channel, 'DPRIVATE1');
    return new Response(JSON.stringify({ok:true,channel:payload.channel,ts:`1234567890.${String(calls).padStart(6,'0')}`}));
  })};
  const result = await sendWeeklyPair(f.config, f.meetingDate, dependencies);
  assert.equal(result.sent, 2);
  assert.equal((await sendWeeklyPair(f.config, f.meetingDate, dependencies)).sent, 0);
  assert.equal(calls, 2);
  assert.deepEqual(fs.readFileSync(d3), bytes);
  assert.deepEqual(fs.readFileSync(path.join(f.pair.root, 'publication.started.json')), publicationIntent);
  fs.appendFileSync(d3, 'changed');
  await assert.rejects(sendWeeklyPair(f.config, f.meetingDate, dependencies), /hash|evidence/);
  assert.equal(calls, 2);
});

test('pair Slack delivery rejects a changed saved mobile briefing before network', async t => {
  const f = await readyPair(t);
  const {sendWeeklyPair} = require('../weekly-report-pair');
  configureSlackIdentity(f.config);
  const saved = path.join(f.pair.root, 'slack.depth3.json');
  const briefing = JSON.parse(fs.readFileSync(saved, 'utf8'));
  briefing.root.text = 'changed after preparation';
  fs.writeFileSync(saved, JSON.stringify(briefing, null, 2) + '\n');
  let calls = 0;
  await assert.rejects(sendWeeklyPair(f.config, f.meetingDate, {sleep:async () => {},fetch:async () => {
    calls++;
    return new Response(JSON.stringify({ok:true,channel:'DPRIVATE1',ts:'1234567890.000001'}));
  }}), /saved mobile briefing.*mismatch/i);
  assert.equal(calls, 0);
});

test('legacy uncertain failed publication blocks a paired replacement before any additional Wiki request', async t => {
  const f = await readyPair(t);
  const notionKey = process.env.NOTION_API_KEY;
  delete process.env.NOTION_API_KEY;
  t.after(() => { if (notionKey !== undefined) process.env.NOTION_API_KEY = notionKey; });
  await runWeeklyPrepare(f.config, f.meetingDate, {
    runCollect:async () => ({snapshot:f.snapshot,snapshotPath:f.snapshotPath}),
    runGenerate:(config,date) => runGenerateV2({...config,env:{...config.env,
      aiProvider:'claude',aiModel:'sonnet',claudeCli:f.fake}},date),
  });
  Object.assign(f.config.env, {baseUrl:'http://weekly.invalid',apiKey:'fixture',projectId:'p',
    wikiUrl:'http://weekly.invalid/projects/p/wiki/weekly'});
  let puts = 0;
  let requests = 0;
  let wikiText = `${f.config.env.sectionHeader}\n- existing\n`;
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    requests++;
    assert.ok(String(url).startsWith('http://weekly.invalid/projects/p/wiki/'));
    if (options.method === 'PUT') { puts++; wikiText = JSON.parse(options.body).wiki_page.text; }
    else if (puts === 1) throw new Error('fixture verification GET lost');
    return new Response(JSON.stringify({wiki_page:{text:wikiText,version:1 + puts,updated_on:'2026-09-09T06:45:00Z'}}));
  });
  await assert.rejects(runWeeklyPublish(f.config, f.meetingDate));
  const {loadWeeklyStatus} = require('../weekly-pipeline');
  const legacy = loadWeeklyStatus(f.config.env.outputDir, f.pair.date);
  assert.equal(legacy.status, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(legacy.failureArtifact.replace(/\.md$/,'.json'))).serverState, 'written_unverified');
  assert.equal(puts, 1);
  const before = requests;
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate), /inspection|recovery/);
  assert.equal(requests, before);
  assert.equal(puts, 1);
});

test('pair CLI previews locally, rejects invalid publish depth, and never calls the network for either', async t => {
  const f = await readyPair(t);
  const preload = path.join(f.dir, 'pair-cli.cjs');
  const config = {...f.config,env:{...f.config.env,meetingDate:f.pair.date}};
  fs.writeFileSync(preload, `
    require(${JSON.stringify(require.resolve('../config'))}).loadConfig = () => {
      const config = ${JSON.stringify(config)};
      config.env.mode = process.env.MODE;
      config.env.weeklyPublishDepth = process.env.WEEKLY_PUBLISH_DEPTH || '2';
      return config;
    };
    global.fetch = () => { throw new Error('network disabled in offline CLI test'); };
  `);
  const cli = (mode, depth) => spawnSync(process.execPath, ['--require',preload,require.resolve('../../index')], {
    encoding:'utf8',env:{...process.env,MODE:mode,WEEKLY_PUBLISH_DEPTH:depth || ''},
  });
  const preview = cli('weekly-pair-preview');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /59.6fps/);
  assert.match(preview.stdout, /원본 depth3/);
  const bad = cli('weekly-pair-publish', '2.5');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /2 or 3/);
  assert.equal(fs.existsSync(path.join(f.pair.root, 'publication.started.json')), false);
  const send = cli('weekly-pair-send');
  assert.equal(send.status, 1);
  assert.match(send.stderr, /recipient/);
  const auto = cli('weekly-pair-publish', 'auto');
  assert.equal(auto.status, 1);
  assert.doesNotMatch(auto.stderr, /must be 2 or 3/);
  assert.match(auto.stdout, /\[summary\] fallback to depth2: summary failed: VALIDATION_FAILED/);
  assert.equal(readJson(path.join(f.pair.root, 'publication.started.json')).variant, '2');
});

test('a Korean freeform summary is kept beside the unchanged pair and auto publishes it once', async t => {
  const f = await readyPair(t, {summary:koreanSummary});
  const summary = readJson(path.join(f.pair.root, 'summary.json'));
  assert.deepEqual(f.pair.summary, summary);
  assert.equal(summary.status, 'ready');
  assert.equal(summary.reason, null);
  assert.equal(summary.snapshotHash, f.pair.manifest.snapshotHash);
  assert.deepEqual(summary.gate.blocking, []);
  assert.equal(fs.readFileSync(f.callsPath, 'utf8'), '3');
  assert.equal(fs.existsSync(path.join(f.dir, 'ALERT.log')), false);
  assert.deepEqual(Object.keys(readJson(f.pair.manifestPath).variants), ['2', '3']);
  assert.equal(fs.readFileSync(path.join(f.pair.root, 'slack.depth3.json'), 'utf8'),
    JSON.stringify(previewWeeklyPair(f.config, f.meetingDate), null, 2) + '\n');
  const {loadWeeklyStatus, buildWeeklyPipelinePaths, assertWeeklyReadyEvidence} = require('../weekly-pipeline');
  const summaryDir = path.join(f.pair.root, 'summary');
  const state = loadWeeklyStatus(summaryDir, f.pair.date);
  assert.equal(state.reportHash, summary.reportHash);
  const summaryConfig = {...f.config, env:{...f.config.env, reportDepth:3, outputDir:summaryDir,
    snapshotPath:state.snapshotPath, outputPath:state.reportPath}};
  const summaryPaths = buildWeeklyPipelinePaths(summaryDir, f.pair.date);
  // Variants keep expecting source_selection; only the summary is verified as freeform.
  assert.throws(() => assertWeeklyReadyEvidence(summaryPaths, state, summaryConfig, f.meetingDate), /metadata or hash mismatch/);
  assert.doesNotThrow(() => assertWeeklyReadyEvidence(summaryPaths, state, summaryConfig, f.meetingDate, {generationMethod:'freeform'}));
  const depth3 = readWeeklyPair(f.config, f.meetingDate).variants[3];
  assert.throws(() => assertWeeklyReadyEvidence(buildWeeklyPipelinePaths(depth3.config.env.outputDir, f.pair.date),
    depth3.state, depth3.config, f.meetingDate, {generationMethod:'freeform'}), /metadata or hash mismatch/);

  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.status, 'published');
  assert.equal(result.state.reportPath, state.reportPath);
  assert.equal(wiki.puts, 1);
  assert.match(wiki.text, /다채널 조건 한정 성능 확인/);
  const receipt = readJson(path.join(f.pair.root, 'publication.completed.json'));
  assert.deepEqual(receipt, {schemaVersion:1, meetingDate:f.pair.date, depth:3, variant:'summary', reportHash:summary.reportHash});
  assert.equal((await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'})).skipped, true);
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:3}), /explicit recovery approval/);
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate), /explicit recovery approval/);
  for (const name of ['publication.completed.json', 'publication.started.json']) {
    fs.renameSync(path.join(f.pair.root, name), path.join(f.pair.root, name + '.retained'));
  }
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:2}), /receipt is missing; recovery/);
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'}), /receipt is missing; recovery/);
  assert.equal(wiki.puts, 1);
});

test('a summary blocked by the quality gate is recorded once, warns locally, and auto publishes depth2', async t => {
  const logs = captureLogs(t);
  const f = await readyPair(t, {summary:englishSummary});
  const summary = readJson(path.join(f.pair.root, 'summary.json'));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.reason, 'quality_gate: non_korean_line');
  assert.deepEqual(summary.gate.blocking.map(issue => issue.code), ['non_korean_line', 'non_korean_line']);
  assert.match(summary.reportHash, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(f.callsPath, 'utf8'), '3');
  assert.deepEqual(logs.filter(line => line.startsWith('[summary]')),
    ['[summary][WARN] status=failed reason=quality_gate: non_korean_line']);
  assert.match(fs.readFileSync(path.join(f.dir, 'ALERT.log'), 'utf8'),
    /^\[WARN\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} redmine 요약본 미사용 — quality_gate: non_korean_line \(depth2로 게시 예정\)\n$/);
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.reportDepth, 2);
  assert.equal(wiki.puts, 1);
  assert.ok(logs.includes('[summary] fallback to depth2: summary failed: quality_gate: non_korean_line'));
  assert.deepEqual(readJson(path.join(f.pair.root, 'publication.completed.json')),
    {schemaVersion:1, meetingDate:f.pair.date, depth:2, variant:'2', reportHash:result.state.reportHash});
  assert.equal((await publishWeeklyPair(f.config, f.meetingDate, {depth:2})).skipped, true);
});

test('without an injected path the summary warning goes to OUTPUT_DIR/ALERT.log, never the checkout log', async t => {
  captureLogs(t);
  const checkoutLog = path.resolve(__dirname, '..', '..', 'out', 'ALERT.log');
  const before = fs.existsSync(checkoutLog) ? fs.readFileSync(checkoutLog) : null;
  const f = await readyPair(t, {summary:englishSummary, alertLogPath:null});
  assert.match(fs.readFileSync(path.join(path.resolve(f.config.env.outputDir), 'ALERT.log'), 'utf8'),
    /redmine 요약본 미사용 — quality_gate: non_korean_line/);
  assert.deepEqual(fs.existsSync(checkoutLog) ? fs.readFileSync(checkoutLog) : null, before);
});

test('summary generation creates only private directories, so a kill mid-summary leaves the pair readable', async t => {
  // Force a permissive umask so the assertion does not depend on the test runner's own umask.
  const runnerUmask = process.umask(0o022);
  t.after(() => process.umask(runnerUmask));
  const loose = [];
  const f = await readyPair(t, {summary:koreanSummary, generate:async (config, date) => {
    const result = await runGenerateV2(config, date);
    if (config.env.aiGenerationMethod !== 'freeform') return result;
    // Inspect before prepareSummary's finally re-privatizes the tree; a kill would never reach it.
    const pending = [config.env.outputDir];
    while (pending.length) {
      const current = pending.pop();
      if (fs.statSync(current).mode & 0o077) loose.push(path.relative(config.env.outputDir, current) || '.');
      for (const entry of fs.readdirSync(current, {withFileTypes:true})) {
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      }
    }
    return result;
  }});
  assert.equal(f.pair.summary.status, 'ready');
  assert.deepEqual(loose, []);
  const restored = process.umask(0o022);
  assert.equal(restored, 0o022);
});

test('summary generation or validation failure never fails the pair and is never retried', async t => {
  const rejected = await readyPair(t);
  const summary = readJson(path.join(rejected.pair.root, 'summary.json'));
  assert.equal(summary.status, 'failed');
  assert.match(summary.reason, /^VALIDATION_FAILED/);
  assert.equal(summary.gate, null);
  assert.equal(fs.readFileSync(rejected.callsPath, 'utf8'), '3');
  assert.match(fs.readFileSync(path.join(rejected.dir, 'ALERT.log'), 'utf8'), /요약본 미사용 — VALIDATION_FAILED/);
  assert.equal(readWeeklyPair(rejected.config, rejected.meetingDate).variants[2].state.status, 'ready');

  const thrown = await readyPair(t, {
    alertLogPath:path.join(__filename, 'ALERT.log'),
    generate:(config, date) => config.env.aiGenerationMethod === 'freeform'
      ? Promise.reject(Object.assign(new Error('fixture provider timeout'), {code:'AI_TIMEOUT'}))
      : runGenerateV2(config, date),
  });
  assert.equal(thrown.pair.summary.status, 'failed');
  assert.match(readJson(path.join(thrown.pair.root, 'summary.json')).reason, /^AI_TIMEOUT: fixture provider timeout/);
  assert.equal(fs.readFileSync(thrown.callsPath, 'utf8'), '2');
  assert.equal(readWeeklyPair(thrown.config, thrown.meetingDate).variants[3].state.status, 'ready');
});

test('auto publishes depth2 when the ready summary changed after preparation', async t => {
  const logs = captureLogs(t);
  const f = await readyPair(t, {summary:koreanSummary});
  const {loadWeeklyStatus} = require('../weekly-pipeline');
  fs.appendFileSync(loadWeeklyStatus(path.join(f.pair.root, 'summary'), f.pair.date).reportPath, 'changed');
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.reportDepth, 2);
  assert.equal(wiki.puts, 1);
  assert.ok(logs.some(line => /^\[summary\] fallback to depth2: .*hash/.test(line)));
  assert.equal(readJson(path.join(f.pair.root, 'publication.completed.json')).variant, '2');
});

test('auto rechecks the quality gate on the verified report even when summary.json was marked ready', async t => {
  const logs = captureLogs(t);
  const f = await readyPair(t, {summary:englishSummary});
  const file = path.join(f.pair.root, 'summary.json');
  const record = readJson(file);
  assert.equal(record.status, 'failed');
  fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify({...record, status:'ready', reason:null}), {mode:0o600});
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.reportDepth, 2);
  assert.equal(wiki.puts, 1);
  assert.ok(logs.includes('[summary] fallback to depth2: quality_gate: non_korean_line'));
  assert.equal(readJson(path.join(f.pair.root, 'publication.completed.json')).variant, '2');
});

test('auto announces a depth2 fallback only when the recovery guards let depth2 start', async t => {
  const logs = captureLogs(t);
  const f = await readyPair(t, {summary:koreanSummary});
  const wiki = mockWiki(t, f);
  const failing = {runUpdate:async () => {
    throw Object.assign(new Error('fixture redmine 503 before any wiki write'), {code:'publish_http_failed'});
  }};
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:'auto', dependencies:failing}), /fixture redmine 503/);
  assert.equal(readJson(path.join(f.pair.root, 'publication.started.json')).variant, 'summary');
  logs.length = 0;
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'}), /Publication needs recovery/);
  assert.deepEqual(logs.filter(line => line.startsWith('[summary]')), []);
  assert.equal(wiki.puts, 0);
});

test('an unreadable summary.json stops every publish depth for inspection without claiming a fallback', async t => {
  const logs = captureLogs(t);
  const f = await readyPair(t, {summary:koreanSummary});
  const file = path.join(f.pair.root, 'summary.json');
  const bytes = fs.readFileSync(file);
  fs.unlinkSync(file);
  fs.writeFileSync(file, bytes.subarray(0, 40), {mode:0o600});
  const wiki = mockWiki(t, f);
  for (const depth of [2, 3, 'auto']) {
    await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth}), /^Error: Invalid weekly summary record$/);
  }
  assert.equal(wiki.puts, 0);
  assert.deepEqual(logs.filter(line => line.startsWith('[summary] fallback')), []);
  assert.equal(fs.existsSync(path.join(f.pair.root, 'publication.started.json')), false);
});
