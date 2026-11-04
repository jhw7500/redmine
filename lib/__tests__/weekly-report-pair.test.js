const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {setupSnapshot,makeFakeClaude} = require('./helpers/report-run-fixture');
const {runGenerateV2,runWeeklyPrepare,runWeeklyPublish} = require('../../index');
const {prepareWeeklyPair,readWeeklyPair,publishWeeklyPair,previewWeeklyPair} = require('../weekly-report-pair');
const {loadWeeklyStatus} = require('../weekly-pipeline');
const {buildPublishedPath} = require('../report-artifact');

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
    rawContent:options.rawContent||'#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - [Notion] HD60 실측\n      ↳ 검증: 59.6fps, 4채널 조건 한정\n',
    autoContent:{'{{APP}}':'- updated'},categories:{app:{parent:'PIM',label:'Application',templateKey:'APP'}}});
  const fake = options.summary === undefined ? makeFakeClaude(f,'invalid selection') : makeSummaryFake(f, options.summary);
  if(options.teamReport) f.config.reportFilter.teamReport={enabled:true};
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

test('team summary uses project coverage through real prepare and auto publication verification',async t=>{
  const summary='#### <span style="color:blue">조현우</span>\n- PIM [[source:C0001]]\n  - 영상 검증\n    - [[fact:V0001|HD60]] 실측 검증\n      - 다채널 조건 한정 성능 확인\n';
  const f=await readyPair(t,{teamReport:true,summary});
  assert.equal(f.pair.summary.status,'ready');
  const pair=readWeeklyPair(f.config,f.meetingDate);
  assert.match(fs.readFileSync(pair.variants[2].state.reportPath,'utf8'),/  - Application/);
  const dir=path.join(f.pair.root,'summary');
  const state=loadWeeklyStatus(dir,f.pair.date);
  const coverage=readJson(path.join(dir,'runs',f.pair.date,state.generationAttemptId,'source-coverage.json'));
  assert.deepEqual(coverage.knownPaths,[['PIM']]);
  const wiki=mockWiki(t,f);
  await publishWeeklyPair(f.config,f.meetingDate,{depth:'auto'});
  assert.match(wiki.text,/- PIM\n  - 영상 검증/);
  assert.doesNotMatch(wiki.text,/Application/);
  assert.equal(readJson(path.join(f.pair.root,'publication.completed.json')).variant,'summary');
});

test('team measurements survive generation, evidence checks and auto summary publication',async t=>{
  const summary='#### <span style="color:blue">조현우</span>\n- PIM [[source:C0001]]\n  - 녹화 복구\n    - <u>[[fact:M0001]]</u> [[source:N0001]]\n';
  const rawContent='#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - [Notion] 접수→액션 시작 시간 10→5.2초 단축\n';
  const f=await readyPair(t,{teamReport:true,summary,rawContent});
  assert.equal(f.pair.summary.status,'ready');
  const state=loadWeeklyStatus(path.join(f.pair.root,'summary'),f.pair.date);
  const run=path.join(f.pair.root,'summary','runs',f.pair.date,state.generationAttemptId);
  assert.match(fs.readFileSync(path.join(run,'draft.ai.annotated.md'),'utf8'),/\[\[fact:M0001\]\]/);
  assert.match(fs.readFileSync(state.reportPath,'utf8'),/<u>접수→액션 시작 시간 10→5.2초 단축<\/u>/);
  const wiki=mockWiki(t,f);
  await publishWeeklyPair(f.config,f.meetingDate,{depth:'auto'});
  assert.match(wiki.text,/<u>접수→액션 시작 시간 10→5.2초 단축<\/u>/);
  assert.equal(readJson(path.join(f.pair.root,'publication.completed.json')).variant,'summary');
});

test('enabling the team profile never changes a prepared legacy summary into a depth2 fallback',async t=>{
  const summary=summaryHeader+'    - [[fact:V0001|HD60]] 실측 결과를 확인했습니다.\n';
  const f=await readyPair(t,{summary});
  assert.equal(f.pair.summary.status,'ready');
  f.config.reportFilter.teamReport={enabled:true};
  const wiki=mockWiki(t,f);
  await publishWeeklyPair(f.config,f.meetingDate,{depth:'auto'});
  assert.match(wiki.text,/실측 결과를 확인했습니다/);
  assert.equal(readJson(path.join(f.pair.root,'publication.completed.json')).variant,'summary');
});

test('disabling the team profile preserves the prepared team audience and its highlight policy',async t=>{
  const summary='#### <span style="color:blue">조현우</span>\n- PIM [[source:C0001]]\n  - 영상 검증\n    - <u>[[fact:V0001|HD60]] 실측 검증</u>\n';
  const f=await readyPair(t,{teamReport:true,summary});
  assert.equal(f.pair.summary.status,'ready');
  f.config.reportFilter.teamReport.enabled=false;
  f.config.reportFilter.leaderHighlight={enabled:false,maxLines:0};
  const wiki=mockWiki(t,f);
  await publishWeeklyPair(f.config,f.meetingDate,{depth:'auto'});
  assert.match(wiki.text,/<u>HD60 실측 검증<\/u>/);
  assert.equal(readJson(path.join(f.pair.root,'publication.completed.json')).variant,'summary');
});

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

test('pair CLI prepare logs each depth variant status, naming the issue code of a failed one', t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'redmine-pair-prepare-log-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const preload = path.join(dir, 'pair-prepare.cjs');
  // Only the prepare result is faked; index.js prints the real log line for it.
  fs.writeFileSync(preload, `
    require(${JSON.stringify(require.resolve('../config'))}).loadConfig = () => ({env:{mode:process.env.MODE,
      meetingDate:'2026-11-04', wikiUrl:'http://weekly.invalid/projects/p/wiki/weekly'}});
    require(${JSON.stringify(require.resolve('../weekly-report-pair'))}).prepareWeeklyPair = async () => ({
      manifestPath:'/fixture/pairs/2026-11-04/manifest.json',
      manifest:JSON.parse(process.env.FIXTURE_MANIFEST)});
    global.fetch = () => { throw new Error('network disabled in offline CLI test'); };
  `);
  const prepare = variants => spawnSync(process.execPath, ['--require', preload, require.resolve('../../index')], {
    encoding:'utf8', env:{...process.env, MODE:'weekly-pair-prepare', FIXTURE_MANIFEST:JSON.stringify({variants})}});
  const failed = prepare({2:{status:'ready'}, 3:{status:'failed', primaryIssueCode:'open_status_without_as_of'}});
  assert.equal(failed.status, 0, failed.stderr);
  assert.ok(failed.stdout.split('\n').includes(
    '[pair] depth2=ready depth3=failed(open_status_without_as_of) preserved: /fixture/pairs/2026-11-04/manifest.json'), failed.stdout);
  const ready = prepare({2:{status:'ready'}, 3:{status:'ready'}});
  assert.equal(ready.status, 0, ready.stderr);
  assert.ok(ready.stdout.split('\n').includes(
    '[pair] depth2=ready depth3=ready preserved: /fixture/pairs/2026-11-04/manifest.json'), ready.stdout);
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
  // An all-ready week carries no review block and leaves nothing for the wrapper's [REVIEW] notice.
  assert.doesNotMatch(wiki.text, /\*\*검토 필요\(자동\)\*\*/);
  assert.equal(fs.existsSync(path.join(f.pair.root, 'review-needed.json')), false);
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

const sha256Of = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const openStatusSource = '#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - [Notion] HD60 실측 미해결\n      ↳ 검증: 59.6fps, 4채널 조건 한정\n';

test('a failed depth3 still prepares depth2 and records the failure in the manifest', async t => {
  captureLogs(t);
  // The same source feeds both depths, so a validation failure cannot be depth-specific; a depth3-only
  // provider failure exercises the same recorded-failure path (no rejected report exists to point at).
  const f = await readyPair(t, {summary:koreanSummary,
    generate:(config, date) => config.env.reportDepth === 3 && config.env.aiGenerationMethod !== 'freeform'
      ? Promise.reject(Object.assign(new Error('fixture provider timeout'), {code:'AI_TIMEOUT'}))
      : runGenerateV2(config, date)});
  const manifest = readJson(path.join(f.pair.root, 'manifest.json'));
  assert.equal(manifest.schemaVersion, 2);
  const failed = manifest.variants['3'];
  assert.equal(failed.status, 'failed');
  assert.equal(typeof failed.primaryIssueCode, 'string');
  assert.equal(typeof failed.issueCounts, 'object');
  assert.match(failed.pipelineAttemptId, /^[0-9a-f-]{36}$/);
  assert.equal(failed.rejectedReportPath, null);
  assert.equal(failed.rejectedReportHash, null);
  assert.equal(manifest.variants['2'].status, 'ready');
  assert.match(manifest.variants['2'].reportHash, /^[a-f0-9]{64}$/);
  assert.equal(readJson(path.join(f.pair.root, 'summary.json')).status, 'ready');
  // Without depth3 run files the mobile briefing falls back to depth2's selection (#138 R3).
  assert.equal(readJson(path.join(f.pair.root, 'slack.depth3.json')).reportHash, manifest.variants['2'].reportHash);
  const pair = readWeeklyPair(f.config, f.meetingDate, {detailOnly:true});
  assert.equal(pair.variants[3].failed, true);
  assert.equal(readWeeklyPair(f.config, f.meetingDate).variants[2].state.status, 'ready');
});

test('both depth variants failing still writes a manifest with two failed variants', async t => {
  captureLogs(t);
  const f = await readyPair(t, {rawContent:openStatusSource});
  const manifest = readJson(path.join(f.pair.root, 'manifest.json'));
  assert.equal(manifest.schemaVersion, 2);
  for (const depth of ['2', '3']) {
    assert.equal(manifest.variants[depth].status, 'failed');
    assert.equal(manifest.variants[depth].primaryIssueCode, 'open_status_without_as_of');
    assert.ok(manifest.variants[depth].issueCounts.open_status_without_as_of >= 1);
    assert.equal(path.basename(manifest.variants[depth].validationPath), 'validation.001.json');
    assert.equal(path.basename(manifest.variants[depth].rejectedReportPath), 'report.rejected.001.md');
    assert.equal(sha256Of(manifest.variants[depth].rejectedReportPath), manifest.variants[depth].rejectedReportHash);
  }
  assert.ok(fs.existsSync(path.join(f.pair.root, 'summary.json')));
  assert.doesNotThrow(() => readWeeklyPair(f.config, f.meetingDate, {detailOnly:true}));
});

// Fails the selected generations with a provider timeout, so they retain no report or run files.
const timeoutFor = (depths, {summary = false} = {}) => (config, date) =>
  (config.env.aiGenerationMethod === 'freeform' ? summary : depths.includes(config.env.reportDepth))
    ? Promise.reject(Object.assign(new Error('fixture provider timeout'), {code:'AI_TIMEOUT'}))
    : runGenerateV2(config, date);
const openSummary = summaryHeader + '    - [[fact:V0001|HD60]] 실측 미해결\n';
const pairFile = (f, name) => path.join(f.pair.root, name);
const alertLog = f => fs.readFileSync(path.join(path.resolve(f.config.env.outputDir), 'ALERT.log'), 'utf8');
function rejectedSummaryReport(f) {
  const runs = path.join(f.pair.root, 'summary', 'runs', f.pair.date);
  const [attempt] = fs.readdirSync(runs);
  return path.join(runs, attempt, 'report.rejected.001.md');
}
function treeDigest(root) {
  const entries = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, {withFileTypes:true})) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else entries.push(`${path.relative(root, file)}:${sha256Of(file)}`);
    }
  }
  return entries.sort();
}

test('auto publishes ready depth2 with a review block when depth3 failed', async t => {
  captureLogs(t);
  const f = await readyPair(t, {generate:timeoutFor([3])});
  const manifest = readJson(f.pair.manifestPath);
  assert.equal(manifest.variants['3'].status, 'failed');
  const code = manifest.variants['3'].primaryIssueCode;
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.status, 'published');
  assert.equal(result.state.reportDepth, 2);
  assert.equal(wiki.puts, 1);
  assert.ok(wiki.text.includes(fs.readFileSync(result.state.reportPath, 'utf8').trimEnd()));
  const block = wiki.text.slice(wiki.text.indexOf('**검토 필요(자동)**'));
  assert.ok(block.startsWith(`**검토 필요(자동)**\n- 게시본: depth2 (통과)\n- depth3: ${code}`), wiki.text);
  assert.match(block, /\n- 요약: `failed` `VALIDATION_FAILED/);
  assert.match(block, /\n\n\*작성: [^\n]*\*\n\n---\n$/);
  assert.deepEqual(readJson(pairFile(f, 'publication.completed.json')),
    {schemaVersion:1, meetingDate:f.pair.date, depth:2, variant:'2', reportHash:result.state.reportHash});
  assert.deepEqual(readJson(pairFile(f, 'review-needed.json')),
    {schemaVersion:1, meetingDate:f.pair.date, variant:'2', label:'depth2', codes:[code, 'summary_failed']});
  assert.match(alertLog(f), new RegExp(`\\n\\[WARN\\] \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} redmine 검토 필요 — depth2 \\(${code},summary_failed\\)\\n$`));
});

test('auto publishes the rejected summary as is when no variant passed', async t => {
  captureLogs(t);
  const f = await readyPair(t, {rawContent:openStatusSource, summary:openSummary});
  const manifest = readJson(f.pair.manifestPath);
  assert.deepEqual([manifest.variants['2'].status, manifest.variants['3'].status], ['failed', 'failed']);
  assert.equal(readJson(pairFile(f, 'summary.json')).status, 'failed');
  const rejected = rejectedSummaryReport(f);
  const body = fs.readFileSync(rejected, 'utf8').trimEnd();
  assert.match(body, /미해결/);
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.status, 'rejected_published');
  assert.equal(wiki.puts, 1);
  const bodyAt = wiki.text.indexOf(body);
  const blockAt = wiki.text.indexOf('**검토 필요(자동)**\n- 게시본: 요약본 (검증 실패 그대로 게시)\n- depth2: open_status_without_as_of');
  assert.ok(bodyAt >= 0 && blockAt > bodyAt && wiki.text.indexOf('*작성: ') > blockAt, wiki.text);
  assert.match(wiki.text.slice(blockAt), /\n  - `[^`\n]*미해결[^`\n]*`\n/);
  assert.equal(wiki.text.split(f.config.env.sectionHeader).length - 1, 1);
  assert.deepEqual(readJson(pairFile(f, 'publication.completed.json')), {schemaVersion:1, meetingDate:f.pair.date,
    depth:3, variant:'summary', reportHash:sha256Of(rejected), status:'rejected_published'});
  // The published section, review block included, is kept locally beside the rejected report.
  assert.equal(result.updateResult.publishedPath, buildPublishedPath(rejected));
  const published = fs.readFileSync(buildPublishedPath(rejected), 'utf8');
  assert.equal(published, wiki.text);
  assert.ok(published.includes(body) && published.includes('**검토 필요(자동)**'));
  const review = readJson(pairFile(f, 'review-needed.json'));
  assert.equal(review.variant, 'summary');
  assert.equal(review.label, '요약본');
  assert.ok(review.codes.includes('open_status_without_as_of') && review.codes.includes('summary_failed'));
});

test('the review block excerpts the published rejected summary\'s own problem lines', async t => {
  captureLogs(t);
  // A clause only the summary has, so the excerpt cannot come from the unpublished depth2/depth3 lines.
  // An inline-code TODO stays an open_status_without_as_of error; a plain 보류/미해결 is dated by generation.
  const summaryOnly = '요약본 단독 정리';
  const f = await readyPair(t, {rawContent:openStatusSource,
    summary:summaryHeader + `    - [[fact:V0001|HD60]] 실측 검증\n      - ${summaryOnly} \`TODO\`\n`});
  const manifest = readJson(f.pair.manifestPath);
  for (const depth of ['2', '3']) {
    assert.equal(manifest.variants[depth].status, 'failed');
    assert.ok(!fs.readFileSync(manifest.variants[depth].rejectedReportPath, 'utf8').includes(summaryOnly));
  }
  assert.match(readJson(pairFile(f, 'summary.json')).reason, /^VALIDATION_FAILED/);
  assert.ok(fs.readFileSync(rejectedSummaryReport(f), 'utf8').includes(summaryOnly));
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.status, 'rejected_published');
  assert.equal(readJson(pairFile(f, 'publication.completed.json')).variant, 'summary');
  const blockAt = wiki.text.indexOf('**검토 필요(자동)**');
  const publishedBody = wiki.text.slice(0, blockAt).split('\n');
  const lines = wiki.text.slice(blockAt).split('\n');
  const summaryAt = lines.findIndex(line => line.startsWith('- 요약: '));
  assert.ok(summaryAt > 0, wiki.text);
  const excerpts = [];
  for (const line of lines.slice(summaryAt + 1)) {
    if (!line.startsWith('  - ')) break;
    const match = /^  - `([^`\n]*)`$/.exec(line);
    if (match) excerpts.push(match[1]);
  }
  const own = excerpts.filter(text => text.includes(summaryOnly));
  assert.equal(own.length, 1, wiki.text);
  // The block swaps backticks and < for look-alikes; undo that to find the excerpt in the published body.
  const excerpt = own[0].replace(/ˋ/g, '`').replace(/＜/g, '<');
  assert.ok(publishedBody.some(line => line.includes(excerpt)), wiki.text);
});

// Excerpts of one review-block entry: the "  - `...`" lines right after the line that starts with prefix.
function reviewEntry(text, prefix) {
  const lines = text.slice(text.indexOf('**검토 필요(자동)**')).split('\n');
  const at = lines.findIndex(line => line.startsWith(prefix));
  assert.ok(at > 0, text);
  const excerpts = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('  - ')) break;
    excerpts.push(/^  - `([^`\n]*)`$/.exec(line)?.[1]);
  }
  return {head:lines[at], excerpts};
}
const rewriteIssues = (file, issues) => {
  const validation = readJson(file);
  fs.writeFileSync(file, JSON.stringify({...validation, issues:[...issues, ...validation.issues]}, null, 2) + '\n');
};

test('the review block excerpts numbered issue lines from each variant\'s own rejected report, once per line', async t => {
  captureLogs(t);
  const f = await readyPair(t, {rawContent:openStatusSource, summary:openSummary});
  const manifest = readJson(f.pair.manifestPath);
  const report = fs.readFileSync(manifest.variants['2'].rejectedReportPath, 'utf8').split('\n');
  assert.equal(report[5], '  - Application');
  assert.equal(report[6], '    - [Notion] HD60 실측 미해결');
  assert.equal(report[7], '      ↳ 검증: 59.6fps, 4채널 조건 한정');
  // Shapes copied from the 2026-11-11 rehearsal's depth2 validation.001.json, with lines moved onto this report.
  const malformed = {severity:'error', code:'malformed_fact_marker', line:8, column:147, start:410, end:438};
  const unmarked = (value, line) => ({severity:'error', code:'unmarked_protected_fact',
    message:`fact marker 밖의 보호 사실입니다: ${value}`, value,
    outputLocation:{start:365, end:370, line, column:147}, outputExcerpt:'↳ 변경: 보호 사실 발췌…'});
  // The parser is the producer of the top-level numbered shape; the validator adds only the severity.
  const {parseAnnotatedDraft} = require('../annotated-draft');
  assert.deepEqual(Object.keys({severity:'error', ...parseAnnotatedDraft('x \\[[fact:[[fact:V0005|Q0072]]]]').errors[0]}).sort(),
    ['code', 'column', 'end', 'line', 'severity', 'start']);
  assert.deepEqual(Object.keys(malformed).sort(), ['code', 'column', 'end', 'line', 'severity', 'start']);
  assert.equal(typeof malformed.line, 'number');
  assert.equal(unmarked('V0005', 8).line, undefined);
  assert.equal(unmarked('V0005', 8).outputLocation.line, 8);
  rewriteIssues(manifest.variants['2'].validationPath, [
    malformed,
    unmarked('V0005', 8),
    unmarked('04-weekly', 6),
    unmarked('Q0072', 999),
    // A snapshot line number (source-selection.js) never names a line of the report.
    {severity:'error', code:'source_selection_detail_missing', id:'C0001', sectionId:'S0001', line:5,
      message:'depth3 대체보고서에서 상세 원문 C0001 누락'},
  ]);
  // A depth3 report changed after prepare no longer matches its recorded hash, so none of its lines are excerpted.
  const depth3Report = manifest.variants['3'].rejectedReportPath;
  const depth3Lines = fs.readFileSync(depth3Report, 'utf8').split('\n');
  assert.equal(depth3Lines[8], '        ↳ 검증: 59.6fps, 4채널 조건 한정');
  depth3Lines[8] = '        ↳ 검증: 변조된 줄';
  fs.writeFileSync(depth3Report, depth3Lines.join('\n'));
  rewriteIssues(manifest.variants['3'].validationPath, [unmarked('V0005', 9)]);
  const summaryRun = path.dirname(rejectedSummaryReport(f));
  const summaryReport = fs.readFileSync(rejectedSummaryReport(f), 'utf8').split('\n');
  assert.equal(summaryReport[3], '    - HD60 실측 (2026-08-26 기준 미해결)');
  rewriteIssues(path.join(summaryRun, 'validation.001.json'), [unmarked('HD60', 4)]);
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.status, 'rejected_published');
  assert.equal(readJson(pairFile(f, 'publication.completed.json')).variant, 'summary');
  const depth2 = reviewEntry(wiki.text, '- depth2: ');
  // Every issue still counts, including the ones whose line is dropped or not excerpted.
  assert.equal(depth2.head, '- depth2: open_status_without_as_of 외 코드별 개수 malformed_fact_marker 1, '
    + 'unmarked_protected_fact 3, source_selection_detail_missing 1, open_status_without_as_of 1, '
    + 'source_selection_status_unverified 1');
  // Line 8 twice is excerpted once, line 999 is out of range, the snapshot line 5 (- PIM) is dropped,
  // and the open-status text line passes as is.
  assert.deepEqual(depth2.excerpts, ['↳ 검증: 59.6fps, 4채널 조건 한정', '- Application', '- [Notion] HD60 실측 미해결']);
  assert.deepEqual(reviewEntry(wiki.text, '- depth3: ').excerpts, ['- [Notion] HD60 실측 미해결']);
  assert.ok(!wiki.text.includes('변조된 줄'), wiki.text);
  assert.ok(reviewEntry(wiki.text, '- 요약: ').excerpts.includes('- HD60 실측 (2026-08-26 기준 미해결)'), wiki.text);
});

test('a summary part failure keeps no validation file, so the review block excerpts none of its issues', async t => {
  captureLogs(t);
  // A team summary validated per project part fails before any report is assembled (AI_PART_VALIDATION).
  const f = await readyPair(t, {teamReport:true,
    summary:'#### <span style="color:blue">조현우</span>\n- PIM [[source:C0001]]\n  - 영상 검증\n    - [[fact:V0001|HD60]] 실측 7건 검증\n'});
  const record = readJson(pairFile(f, 'summary.json'));
  assert.equal(record.status, 'failed');
  assert.match(record.reason, /^AI_PART_VALIDATION/);
  const runs = path.join(f.pair.root, 'summary', 'runs', f.pair.date);
  const [attempt] = fs.readdirSync(runs);
  const state = readJson(path.join(runs, attempt, 'state.json'));
  // The part failure does carry numbered output lines; the block must still not read them.
  assert.ok(state.partFailure.issues.some(issue => issue.severity === 'error' && Number.isInteger(issue.outputLocation?.line)));
  assert.equal(fs.existsSync(path.join(runs, attempt, 'validation.001.json')), false);
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.reportDepth, 2);
  assert.deepEqual(reviewEntry(wiki.text, '- 요약: ').excerpts, []);
});

test('auto publishes a quality-gate-blocked summary as is when no variant passed', async t => {
  captureLogs(t);
  const f = await readyPair(t, {rawContent:openStatusSource, summary:englishSummary});
  const record = readJson(pairFile(f, 'summary.json'));
  assert.equal(record.reason, 'quality_gate: non_korean_line');
  const report = loadWeeklyStatus(path.join(f.pair.root, 'summary'), f.pair.date).reportPath;
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.status, 'rejected_published');
  assert.ok(wiki.text.includes(fs.readFileSync(report, 'utf8').trimEnd()));
  assert.match(wiki.text, /\*\*검토 필요\(자동\)\*\*\n- 게시본: 요약본 \(검증 실패 그대로 게시\)/);
  assert.match(wiki.text, /\n  - `non_korean_line \(line \d+\)`\n/);
  assert.deepEqual(readJson(pairFile(f, 'publication.completed.json')), {schemaVersion:1, meetingDate:f.pair.date,
    depth:3, variant:'summary', reportHash:record.reportHash, status:'rejected_published'});
});

test('no publishable report fails with NO_PUBLISHABLE_REPORT and writes nothing', async t => {
  captureLogs(t);
  const f = await readyPair(t, {generate:timeoutFor([2, 3], {summary:true})});
  const before = treeDigest(f.dir);
  let requests = 0;
  t.mock.method(global, 'fetch', async () => { requests++; throw new Error('fixture network must not be used'); });
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'}),
    error => error.code === 'NO_PUBLISHABLE_REPORT');
  assert.equal(requests, 0);
  assert.deepEqual(treeDigest(f.dir), before);
});

test('re-running publish after a rejected publication skips it; a mismatching receipt is still refused', async t => {
  captureLogs(t);
  const f = await readyPair(t, {rawContent:openStatusSource, summary:openSummary});
  const wiki = mockWiki(t, f);
  await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(wiki.puts, 1);
  const receipt = readJson(pairFile(f, 'publication.completed.json'));
  const before = treeDigest(f.dir);
  const rerun = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(rerun.skipped, true);
  assert.equal(rerun.state.status, 'rejected_published');
  assert.equal(rerun.state.reportHash, receipt.reportHash);
  assert.equal(wiki.puts, 1);
  assert.deepEqual(treeDigest(f.dir), before);
  // A receipt for another report still needs explicit recovery approval.
  for (const name of ['publication.started.json', 'publication.completed.json']) {
    fs.writeFileSync(pairFile(f, name), JSON.stringify({...receipt, reportHash:'0'.repeat(64)}, null, 2) + '\n');
  }
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'}),
    /Already published; replacing a report requires explicit recovery approval/);
  assert.equal(wiki.puts, 1);
  fs.renameSync(pairFile(f, 'publication.completed.json'), pairFile(f, 'publication.completed.json.retained'));
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'}), /Publication needs recovery/);
  assert.equal(wiki.puts, 1);
});

test('a snapshot security-contract change since prepare refuses the rejected publish before any Wiki request', async t => {
  captureLogs(t);
  const f = await readyPair(t, {rawContent:openStatusSource, summary:openSummary});
  // A repository whose commit bodies the sealed snapshot never scanned changes the bound contract, as on the ready path.
  f.config.repos = {...f.config.repos, extra:{path:f.dir, includeCommitBody:true}};
  Object.assign(f.config.env, {baseUrl:'http://weekly.invalid', apiKey:'fixture', projectId:'p',
    wikiUrl:'http://weekly.invalid/projects/p/wiki/weekly'});
  let requests = 0;
  t.mock.method(global, 'fetch', async () => { requests++; throw new Error('fixture network must not be used'); });
  await assert.rejects(publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'}), error =>
    error.code === 'rejected_evidence_mismatch' && error.cause?.code === 'SNAPSHOT_SECURITY_CONTRACT_MISSING');
  assert.equal(requests, 0);
  assert.equal(fs.existsSync(pairFile(f, 'publication.completed.json')), false);
  assert.equal(fs.existsSync(pairFile(f, 'review-needed.json')), false);
});

test('a failed variant path outside the pair root is never read or published', async t => {
  captureLogs(t);
  // The default fake makes the rejected summary headerless, so auto moves on to depth2 and then depth3.
  const f = await readyPair(t, {rawContent:openStatusSource});
  const manifest = readJson(f.pair.manifestPath);
  const outside = path.join(f.dir, 'outside.rejected.md');
  fs.copyFileSync(manifest.variants['2'].rejectedReportPath, outside);
  manifest.variants['2'].rejectedReportPath = outside;
  fs.writeFileSync(f.pair.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const wiki = mockWiki(t, f);
  const result = await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(result.state.status, 'rejected_published');
  assert.equal(wiki.puts, 1);
  assert.equal(readJson(pairFile(f, 'publication.completed.json')).variant, '3');
  assert.match(wiki.text, /\n- depth2: open_status_without_as_of 외 코드별 개수 [^\n]*rejected_path_outside_pair 1\n/);
  assert.ok(readJson(pairFile(f, 'review-needed.json')).codes.includes('rejected_path_outside_pair'));
});

test('a validation-failed depth3 builds the Slack briefing from its retained source selection', async t => {
  captureLogs(t);
  const {sendWeeklyPair} = require('../weekly-report-pair');
  const f = await readyPair(t, {rawContent:openStatusSource});
  const manifest = readJson(f.pair.manifestPath);
  assert.equal(manifest.variants['3'].status, 'failed');
  const saved = readJson(pairFile(f, 'slack.depth3.json'));
  assert.equal(saved.reportHash, manifest.variants['3'].rejectedReportHash);
  assert.deepEqual(previewWeeklyPair(f.config, f.meetingDate), saved);
  configureSlackIdentity(f.config);
  let calls = 0;
  const result = await sendWeeklyPair(f.config, f.meetingDate, {sleep:async () => {},
    fetch:verifiedSlackFetch(f.config, async (url, options) => {
      calls++;
      return new Response(JSON.stringify({ok:true,channel:JSON.parse(options.body).channel,
        ts:`1234567890.${String(calls).padStart(6, '0')}`}));
    })});
  assert.equal(result.sent, saved.replies.length + 1);
  assert.equal(calls, result.sent);
});

test('a depth3 failure without run files builds the Slack briefing from depth2', async t => {
  captureLogs(t);
  const {sendWeeklyPair} = require('../weekly-report-pair');
  const f = await readyPair(t, {generate:timeoutFor([3])});
  const depth2 = readWeeklyPair(f.config, f.meetingDate).variants[2];
  const saved = readJson(pairFile(f, 'slack.depth3.json'));
  assert.equal(saved.reportHash, depth2.state.reportHash);
  configureSlackIdentity(f.config);
  let calls = 0;
  const result = await sendWeeklyPair(f.config, f.meetingDate, {sleep:async () => {},
    fetch:verifiedSlackFetch(f.config, async (url, options) => {
      calls++;
      return new Response(JSON.stringify({ok:true,channel:JSON.parse(options.body).channel,
        ts:`1234567890.${String(calls).padStart(6, '0')}`}));
    })});
  assert.equal(result.sent, saved.replies.length + 1);
});

test('without any retained source selection the Slack briefing is skipped with a warning', async t => {
  captureLogs(t);
  const {sendWeeklyPair} = require('../weekly-report-pair');
  const f = await readyPair(t, {summary:koreanSummary, generate:timeoutFor([2, 3])});
  assert.equal(fs.existsSync(pairFile(f, 'slack.depth3.json')), false);
  const wiki = mockWiki(t, f);
  await publishWeeklyPair(f.config, f.meetingDate, {depth:'auto'});
  assert.equal(readJson(pairFile(f, 'publication.completed.json')).variant, 'summary');
  assert.match(wiki.text, /\n- 모바일 브리핑: 생략[^\n]*\n/);
  assert.ok(readJson(pairFile(f, 'review-needed.json')).codes.includes('briefing_skipped'));
  configureSlackIdentity(f.config);
  let calls = 0;
  const result = await sendWeeklyPair(f.config, f.meetingDate, {sleep:async () => {},
    fetch:async () => { calls++; throw new Error('fixture Slack must not be called'); }});
  assert.equal(result.sent, 0);
  assert.equal(calls, 0);
  assert.match(alertLog(f), /\n\[WARN\] [^\n]* redmine 모바일 브리핑 생략 — [^\n]*\n$/);
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
