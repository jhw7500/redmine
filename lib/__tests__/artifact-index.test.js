const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../../scripts/artifact-index.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redmine-artifact-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, data) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const run = () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, OUTPUT_DIR: root },
    });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(path.join(root, 'artifacts/INDEX.md'), 'utf8');
  };
  return { root, write, run };
}

test('artifact index lists ready publication, summary, published paths and completed Slack messages', t => {
  const f = fixture(t);
  f.write('pairs/2026-11-04/manifest.json', {
    schemaVersion: 2, variants: { 2: { status: 'ready' }, 3: { status: 'ready' } },
  });
  f.write('pairs/2026-11-04/summary.json', { status: 'ready', reason: 'DO_NOT_INDEX_SUMMARY_BODY' });
  f.write('pairs/2026-11-04/publication.completed.json', { variant: 'summary', depth: 3 });
  f.write('pairs/2026-11-04/summary/report.published.md', 'DO_NOT_INDEX_REPORT_BODY sk-private-secret');
  f.write('pairs/2026-11-04/slack-delivery/manifest.json', { channel: 'DO_NOT_INDEX_CHANNEL' });
  f.write('pairs/2026-11-04/slack-delivery/000.completed.json', { ts: 'DO_NOT_INDEX_SLACK_BODY' });
  f.write('pairs/2026-11-04/slack-delivery/001.started.json', {});
  const index = f.run();
  assert.match(index, /depth2: ready/);
  assert.match(index, /depth3: ready/);
  assert.match(index, /summary: ready/);
  assert.match(index, /summary: published/);
  assert.match(index, /summary\/report.published.md/);
  assert.match(index, /Slack: 완료 1, 시작 1/);
  assert.doesNotMatch(index, /DO_NOT_INDEX|sk-private-secret/);
});

test('artifact index lists rejection codes and review notification without validation text', t => {
  const f = fixture(t);
  f.write('pairs/2026-11-04/manifest.json', { schemaVersion: 2, variants: {
    2: { status: 'failed', primaryIssueCode: 'FACT_VALIDATION', message: 'SECRET_MESSAGE', evidence: 'SECRET_EVIDENCE' },
    3: { status: 'ready' },
  } });
  f.write('pairs/2026-11-04/publication.completed.json', { variant: '2', status: 'rejected_published' });
  f.write('pairs/2026-11-04/review-needed.json', { codes: ['FACT_VALIDATION'], message: 'SECRET_MESSAGE' });
  f.write('pairs/2026-11-04/review-needed.notified', '');
  const index = f.run();
  assert.match(index, /depth2: failed \(FACT_VALIDATION\)/);
  assert.match(index, /2: rejected_published/);
  assert.match(index, /검토: FACT_VALIDATION; 알림: 있음/);
  assert.doesNotMatch(index, /SECRET_MESSAGE|SECRET_EVIDENCE/);
});

test('artifact index marks missing and malformed manifests as incomplete and sorts newest first', t => {
  const f = fixture(t);
  f.write('pairs/2026-11-11/source/snapshot.json', 'PRIVATE_SOURCE_BODY');
  f.write('pairs/2026-11-04/manifest.json', '{broken');
  const index = f.run();
  assert.equal((index.match(/실패\/미완료/g) || []).length, 2);
  assert.ok(index.indexOf('2026-11-11') < index.indexOf('2026-11-04'));
  assert.doesNotMatch(index, /PRIVATE_SOURCE_BODY/);
});

test('artifact index collects README title and issue/PR metadata, archives and retained backups', t => {
  const f = fixture(t);
  f.write('artifacts/2026-11-04-issue-144/README.md',
    '# 생성물 정리\n\n- 이슈: #144\n- PR: #145\n- 설명: PRIVATE_DESCRIPTION\n\nPRIVATE_FILE_BODY\n');
  f.write('archive/out-cleanup-2026-11-04.tar.gz', 'NOT_A_REAL_ARCHIVE_PRIVATE_BODY');
  f.write('archive/out-cleanup-2026-11-04.README.md', '# PRIVATE_ARCHIVE_DESCRIPTION');
  f.write('wip-backup-2026-11-04/README.md', '# PRIVATE_BACKUP_BODY');
  const index = f.run();
  assert.match(index, /## 주간보고/);
  assert.match(index, /## 작업 산출물/);
  assert.match(index, /## 보관/);
  assert.match(index, /생성물 정리/);
  assert.match(index, /#144/);
  assert.match(index, /#145/);
  assert.match(index, /out-cleanup-2026-11-04.README.md/);
  assert.match(index, /wip-backup-2026-11-04/);
  assert.doesNotMatch(index, /PRIVATE/);
  assert.equal(fs.statSync(path.join(f.root, 'artifacts/INDEX.md')).mode & 0o777, 0o600);
});

test('artifact index skips symlink inputs and redacts credentials from short metadata', t => {
  const f = fixture(t);
  f.write('artifacts/2026-11-04-safe/README.md', '# 확인 sk-abcdefgh123456\n- 이슈: #144\n- PR: 없음\n');
  f.write('private.json', { variants: { 2: { status: 'SECRET_STATUS' } } });
  fs.mkdirSync(path.join(f.root, 'pairs/2026-11-04'), { recursive: true });
  fs.symlinkSync(path.join(f.root, 'private.json'), path.join(f.root, 'pairs/2026-11-04/manifest.json'));
  const index = f.run();
  assert.doesNotMatch(index, /sk-abcdefgh123456|SECRET_STATUS/);
  assert.match(index, /REDACTED/);
  assert.match(index, /실패\/미완료/);
});
