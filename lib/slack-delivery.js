const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleepDefault} = require('node:timers/promises');
const {sha256} = require('./report-artifact');

function statOwned(target, directory = false) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (directory ? !stat.isDirectory() : !stat.isFile())
    || (directory ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o777) !== 0o600)) {
    throw new Error('Slack journal owner/type/mode mismatch');
  }
}

function readReceipt(file) {
  statOwned(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveReceipt(file, value) {
  // Exclusive, durable intent before the request. A partial file blocks recovery, never a resend.
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  statOwned(file);
}

function syncDirectoryParent(directory) {
  const descriptor = fs.openSync(path.dirname(path.resolve(directory)), 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function validateApprovedIdentity(value) {
  if (!value || typeof value !== 'object'
    || !/^T[A-Z0-9]+$/.test(value.teamId)
    || !/^B[A-Z0-9]+$/.test(value.botId)
    || !/^[UW][A-Z0-9]+$/.test(value.botUserId)
    || !/^[UW][A-Z0-9]+$/.test(value.peerUserId)) {
    throw new Error('Explicit approved Slack workspace, bot, and peer identities are required');
  }
  return {teamId:value.teamId,botId:value.botId,botUserId:value.botUserId,peerUserId:value.peerUserId};
}

async function slackIdentityRequest(method, {token, channel, fetchRequest}) {
  let response;
  let result;
  try {
    response = await fetchRequest(`https://slack.com/api/${method}`, {
      method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded'},
      ...(channel ? {body:new URLSearchParams({channel}).toString()} : {}),
    });
    result = await response.json();
  } catch {
    throw new Error('Slack identity verification failed before delivery');
  }
  if (!response.ok || result?.ok !== true || result.response_metadata?.warnings?.length) {
    throw new Error('Slack identity verification failed before delivery');
  }
  return result;
}

async function verifySlackIdentity({approvedIdentity, channel, token, fetchRequest}) {
  const expected = validateApprovedIdentity(approvedIdentity);
  const auth = await slackIdentityRequest('auth.test', {token,fetchRequest});
  if (auth.team_id !== expected.teamId || auth.bot_id !== expected.botId
    || auth.user_id !== expected.botUserId) throw new Error('Slack approved identity mismatch');
  const conversation = await slackIdentityRequest('conversations.info', {token,channel,fetchRequest});
  if (conversation.channel?.id !== channel || conversation.channel?.is_im !== true
    || conversation.channel?.is_mpim === true || conversation.channel?.is_ext_shared === true
    || conversation.channel?.user !== expected.peerUserId) throw new Error('Slack approved identity mismatch');
  return expected;
}

async function sendSlackBriefing({briefing, deliveryDir, channel, token, assertSource,
  approvedIdentity,
  fetch: fetchRequest = global.fetch, sleep = sleepDefault}) {
  if (typeof channel !== 'string' || !/^D[A-Z0-9]+$/.test(channel)) {
    throw new Error('An explicit Slack direct message recipient conversation ID is required');
  }
  if (typeof token !== 'string' || !/^xoxb-\S+$/.test(token)) throw new Error('Slack bot credential is required');
  if (typeof assertSource !== 'function') throw new Error('Slack source verification is required');
  assertSource();
  if (fs.existsSync(deliveryDir)) statOwned(deliveryDir, true);
  const verifiedIdentity = await verifySlackIdentity({approvedIdentity,channel,token,fetchRequest});
  if (!fs.existsSync(deliveryDir)) fs.mkdirSync(deliveryDir, {mode:0o700});
  statOwned(deliveryDir, true);
  // Persist the directory entry as well as its files before acknowledging any external send.
  syncDirectoryParent(deliveryDir);
  const identity = {schemaVersion:2,channel,...verifiedIdentity,meetingDate:briefing.meetingDate,
    reportHash:briefing.reportHash,briefingHash:sha256(JSON.stringify(briefing))};
  const manifest = path.join(deliveryDir, 'manifest.json');
  if (fs.existsSync(manifest)) {
    if (JSON.stringify(readReceipt(manifest)) !== JSON.stringify(identity)) {
      throw new Error('Slack delivery identity/recipient changed; inspect the retained journal');
    }
  } else saveReceipt(manifest, identity);

  const messages = [briefing.root, ...briefing.replies];
  let threadTs = null;
  let sent = 0;
  for (const [index, message] of messages.entries()) {
    const payload = {...message, channel, ...(index ? {thread_ts:threadTs} : {})};
    const intent = {...identity,index,payloadHash:sha256(JSON.stringify(payload))};
    const prefix = path.join(deliveryDir, String(index).padStart(3, '0'));
    const started = prefix + '.started.json';
    const completed = prefix + '.completed.json';
    if (fs.existsSync(completed)) {
      const {ts, ...recorded} = readReceipt(completed);
      if (JSON.stringify(recorded) !== JSON.stringify(intent)
        || JSON.stringify(readReceipt(started)) !== JSON.stringify(intent)
        || !/^\d+\.\d{6}$/.test(ts)) throw new Error('Slack receipt evidence mismatch; recovery required');
      if (index === 0) threadTs = ts;
      continue;
    }
    if (fs.existsSync(started)) throw new Error('Slack delivery recovery required; inspect the unconfirmed message before retrying');
    if (index) await sleep(1100);
    assertSource();
    statOwned(deliveryDir, true);
    saveReceipt(started, intent);
    let response;
    let result;
    try {
      response = await fetchRequest('https://slack.com/api/chat.postMessage', {
        method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json; charset=utf-8'},
        body:JSON.stringify(payload),
      });
      result = await response.json();
    } catch {
      throw new Error('Slack delivery not confirmed; recovery required (inspect the retained message intent)');
    }
    if (!response.ok || result?.ok !== true || result.channel !== channel
      || typeof result.ts !== 'string' || !/^\d+\.\d{6}$/.test(result.ts)
      || result.response_metadata?.warnings?.length) {
      throw new Error('Slack delivery not confirmed; recovery required (HTTP/API/response evidence)');
    }
    saveReceipt(completed, {...intent,ts:result.ts});
    if (index === 0) threadTs = result.ts;
    sent++;
  }
  return {sent,skipped:messages.length - sent,channel,threadTs,reportHash:briefing.reportHash};
}

module.exports = {sendSlackBriefing};
