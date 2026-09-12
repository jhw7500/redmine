const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {setupSnapshot,makeFakeClaude} = require('./helpers/report-run-fixture');
const {runGenerateV2,runWeeklyPrepare,runWeeklyPublish} = require('../../index');
const {prepareWeeklyPair,readWeeklyPair,publishWeeklyPair,previewWeeklyPair} = require('../weekly-report-pair');

async function readyPair(t) {
  const f = setupSnapshot(t,{reportDepth:3,
    rawContent:'#### <span style="color:blue">조현우</span>\n- PIM\n  - Application\n    - [Notion] HD60 실측\n      ↳ 검증: 59.6fps, 4채널 조건 한정\n',
    autoContent:{'{{APP}}':'- updated'},categories:{app:{parent:'PIM',label:'Application',templateKey:'APP'}}});
  const fake = makeFakeClaude(f,'invalid selection');
  Object.assign(f.config.env,{aiSummarize:true,aiProvider:'codex',aiModel:'gpt-5.6-sol',aiEffort:'low',
    aiGenerationMethod:'source_selection',aiGenerationScope:'whole',sourceSelectionFallback:true,
    presentationNoteMode:'suggest',autoApprove:true});
  const pair = await prepareWeeklyPair(f.config,f.meetingDate,{
    collect:async()=>({snapshot:f.snapshot,snapshotPath:f.snapshotPath}),
    generate:(config,date)=>runGenerateV2({...config,env:{...config.env,
      aiProvider:'claude',aiModel:'sonnet',claudeCli:fake}},date),
  });
  return {...f,pair,fake};
}

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
});
