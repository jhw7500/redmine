const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {buildSlackBriefing} = require('../slack-briefing');
const {sendSlackBriefing} = require('../slack-delivery');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redmine-slack-delivery-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const briefing = buildSlackBriefing({meetingDate:'2026-09-09',reportHash:'a'.repeat(64),
    records:{sections:[{id:'C1',path:['PIM']}],records:[{id:'R1',sectionId:'C1',text:'4채널 59.6fps 조건 한정'}]},
    selection:{sections:[{id:'C1',groups:[{items:[{id:'R1'}]}]}]}});
  return {briefing,deliveryDir:path.join(dir,'delivery'),channel:'DPRIVATE1',token:'xoxb-PRIVATE_TEST_TOKEN',
    assertSource:() => {},sleep:async () => {}};
}

test('Slack sends a parent and one-column thread, then skips identical delivery without keeping secrets', async t => {
  const f = fixture(t);
  const requests = [];
  const fetch = async (url, options) => {
    assert.equal(url, 'https://slack.com/api/chat.postMessage');
    assert.equal(options.headers.Authorization, 'Bearer ' + f.token);
    const payload = JSON.parse(options.body);
    requests.push(payload);
    return new Response(JSON.stringify({ok:true,channel:f.channel,ts:`1234567890.${requests.length.toString().padStart(6,'0')}`}));
  };
  const first = await sendSlackBriefing({...f,fetch});
  assert.equal(first.sent, 2);
  assert.equal(requests[0].thread_ts, undefined);
  assert.equal(requests[1].thread_ts, '1234567890.000001');
  assert.equal(requests[1].reply_broadcast, false);
  assert.equal((await sendSlackBriefing({...f,fetch})).sent, 0);
  assert.equal(requests.length, 2);
  for (const file of fs.readdirSync(f.deliveryDir)) {
    const target = path.join(f.deliveryDir, file);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(target,'utf8'), /PRIVATE_TEST_TOKEN|59.6fps/);
  }
  await assert.rejects(sendSlackBriefing({...f,channel:'COTHER',fetch}), /identity|recipient/);
  assert.equal(requests.length, 2);
});

for (const failure of ['timeout','http','api','wrong-channel','bad-ts','truncated']) {
  test(`Slack ${failure} keeps uncertain delivery evidence and blocks blind resend`, async t => {
    const f = fixture(t);
    let calls = 0;
    const fetch = async () => {
      calls++;
      if (failure === 'timeout') throw new Error('PRIVATE_TEST_TOKEN PRIVATE_BODY');
      return new Response(JSON.stringify({ok:failure !== 'api',error:'PRIVATE_BODY',
        channel:failure === 'wrong-channel' ? 'COTHER' : f.channel,
        ts:failure === 'bad-ts' ? 'wrong' : '1234567890.000001',
        ...(failure === 'truncated' ? {response_metadata:{warnings:['message_truncated']}} : {}),
      }), {status:failure === 'http' ? 503 : 200});
    };
    await assert.rejects(sendSlackBriefing({...f,fetch}), error => {
      assert.doesNotMatch(error.message, /PRIVATE/);
      return /not confirmed|recovery/.test(error.message);
    });
    await assert.rejects(sendSlackBriefing({...f,fetch}), /recovery/);
    assert.equal(calls, 1);
    assert.ok(fs.existsSync(path.join(f.deliveryDir, '000.started.json')));
    assert.equal(fs.existsSync(path.join(f.deliveryDir, '000.completed.json')), false);
  });
}

test('Slack missing recipient, changed source, or symlinked journal fails before network', async t => {
  const f = fixture(t);
  const fetch = () => assert.fail('must remain offline');
  await assert.rejects(sendSlackBriefing({...f,channel:'',fetch}), /recipient/);
  await assert.rejects(sendSlackBriefing({...f,channel:'CPUBLIC1',fetch}), /direct message/);
  await assert.rejects(sendSlackBriefing({...f,assertSource:() => {throw new Error('source changed');},fetch}), /source changed/);
  fs.mkdirSync(f.deliveryDir + '.real');
  fs.symlinkSync(f.deliveryDir + '.real', f.deliveryDir);
  await assert.rejects(sendSlackBriefing({...f,fetch}), /owner|directory|symlink/);
});

test('Slack persists newly created journal ancestors before the first HTTP request', async t => {
  const f = fixture(t);
  const synced = new Set();
  const fsync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', descriptor => {
    synced.add(fs.readlinkSync(`/proc/self/fd/${descriptor}`));
    return fsync(descriptor);
  });
  let calls = 0;
  await sendSlackBriefing({...f,fetch:async () => {
    assert.ok(synced.has(path.dirname(f.deliveryDir)), 'journal parent must be durable before HTTP');
    calls++;
    return new Response(JSON.stringify({ok:true,channel:f.channel,ts:`1234567890.${String(calls).padStart(6,'0')}`}));
  }});
  assert.equal(calls, 2);
});

test('Slack directory sync failure makes zero HTTP requests', async t => {
  const f = fixture(t);
  const fsync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', descriptor => {
    if (fs.readlinkSync(`/proc/self/fd/${descriptor}`) === path.dirname(f.deliveryDir)) throw new Error('fixture directory fsync failed');
    return fsync(descriptor);
  });
  let calls = 0;
  await assert.rejects(sendSlackBriefing({...f,fetch:async () => {
    calls++;
    return new Response(JSON.stringify({ok:true,channel:f.channel,ts:'1234567890.000001'}));
  }}), /fsync failed/);
  assert.equal(calls, 0);
});
