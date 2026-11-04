#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redactWeeklyText } = require('../lib/weekly-pipeline');

const projectRoot = path.resolve(__dirname, '..');

function plain(file, kind = 'file') {
  try {
    const stat = fs.lstatSync(file);
    return !stat.isSymbolicLink() && (kind === 'directory' ? stat.isDirectory() : stat.isFile());
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function entries(dir) {
  if (!plain(dir, 'directory')) return [];
  return fs.readdirSync(dir, { withFileTypes: true });
}

function json(file) {
  if (!plain(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function text(value, limit = 140) {
  return redactWeeklyText(value, limit).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>|]/g, '\\$&');
}

function status(value) {
  return ['ready', 'failed', 'skipped', 'published', 'rejected_published'].includes(value) ? value : '불명';
}

function code(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value)
    ? redactWeeklyText(value, 80) : '불명';
}

function link(base, file, label = path.basename(file)) {
  const relative = path.relative(base, file).split(path.sep).map(encodeURIComponent).join('/');
  return `[${text(label)}](${relative})`;
}

function pairLines(outputDir, base) {
  const pairs = path.join(outputDir, 'pairs');
  return entries(pairs).filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .sort((a, b) => b.name.localeCompare(a.name)).map(e => {
      const dir = path.join(pairs, e.name);
      const manifest = json(path.join(dir, 'manifest.json'));
      const parts = [link(base, dir, e.name)];
      if (!manifest || ![1, 2].includes(manifest.schemaVersion) || !manifest.variants) {
        parts.push('실패/미완료 (manifest 없음 또는 읽기 실패)');
      } else {
        for (const depth of [2, 3]) {
          const variant = manifest.variants[depth];
          const state = variant && (variant.status || (manifest.schemaVersion === 1 ? 'ready' : null));
          parts.push(`depth${depth}: ${status(state)}${variant?.primaryIssueCode ? ` (${code(variant.primaryIssueCode)})` : ''}`);
        }
      }
      const summary = json(path.join(dir, 'summary.json'));
      parts.push(`summary: ${summary ? status(summary.status) : '없음/읽기 실패'}`);
      const receipt = json(path.join(dir, 'publication.completed.json'));
      if (receipt) {
        const variant = String(receipt.variant ?? receipt.depth);
        parts.push(`게시: ${['2', '3', 'summary'].includes(variant) ? variant : '불명'}: ${status(receipt.status ?? 'published')}`);
      } else parts.push('게시: 없음/읽기 실패');
      const published = [dir, ...['depth2', 'depth3', 'summary'].map(v => path.join(dir, v))]
        .flatMap(folder => entries(folder).filter(f => f.isFile() && f.name.endsWith('.published.md'))
          .map(f => link(base, path.join(folder, f.name), path.relative(dir, path.join(folder, f.name)))));
      parts.push(`게시본: ${published.join(', ') || '없음'}`);
      const review = json(path.join(dir, 'review-needed.json'));
      if (review) {
        const codes = Array.isArray(review.codes) ? review.codes.slice(0, 30).map(code).join(', ') : '불명';
        parts.push(`검토: ${codes || '없음'}; 알림: ${plain(path.join(dir, 'review-needed.notified')) ? '있음' : '없음'}`);
      } else parts.push('검토: 없음/읽기 실패');
      const delivery = entries(path.join(dir, 'slack-delivery')).filter(f => f.isFile());
      const count = suffix => delivery.filter(f => new RegExp(`^\\d+\\.${suffix}\\.json$`).test(f.name)).length;
      parts.push(`Slack: 완료 ${count('completed')}, 시작 ${count('started')}`);
      return `- ${parts.join(' | ')}`;
    });
}

function artifactLines(base) {
  return entries(base).filter(e => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name)).flatMap(e => {
    const file = path.join(base, e.name, 'README.md');
    if (!plain(file) || fs.statSync(file).size > 64 * 1024) return [];
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const title = lines[0].startsWith('# ') ? lines[0].slice(2) : e.name;
    const refs = field => {
      const line = lines.find(l => l.startsWith(`- ${field}:`)) || '';
      return (line.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+|#\d+/g) || []).slice(0, 20).map(v => text(v)).join(', ') || '없음';
    };
    return [`- ${link(base, file, title)} | 이슈: ${refs('이슈')} | PR: ${refs('PR')}`];
  });
}

function archiveLines(outputDir, base) {
  const dir = path.join(outputDir, 'archive');
  const archives = entries(dir).filter(e => e.isFile() && e.name.endsWith('.tar.gz'))
    .sort((a, b) => b.name.localeCompare(a.name)).map(e => {
      const readme = path.join(dir, e.name.replace(/\.tar\.gz$/, '.README.md'));
      return `- ${link(base, path.join(dir, e.name))}${plain(readme) ? ` | ${link(base, readme)}` : ' | README 없음'}`;
    });
  const backups = entries(outputDir).filter(e => e.isDirectory() && e.name.startsWith('wip-backup-'))
    .sort((a, b) => b.name.localeCompare(a.name)).map(e => `- ${link(base, path.join(outputDir, e.name))}`);
  return [...archives, ...backups];
}

function writeArtifactIndex(outputDir = process.env.OUTPUT_DIR || 'out') {
  const root = path.resolve(projectRoot, outputDir);
  const base = path.join(root, 'artifacts');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!plain(root, 'directory')) throw new Error('Invalid output directory');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { mode: 0o700 });
  if (!plain(base, 'directory')) throw new Error('Invalid artifacts directory');
  const sections = [['주간보고', pairLines(root, base)], ['작업 산출물', artifactLines(base)], ['보관', archiveLines(root, base)]];
  const content = '# 생성물 색인\n\n경로와 짧은 메타데이터만 기록합니다.\n\n'
    + sections.map(([title, lines]) => `## ${title}\n\n${lines.join('\n') || '- 없음'}\n`).join('\n');
  const file = path.join(base, 'INDEX.md');
  if (fs.existsSync(file) && !plain(file)) throw new Error('Invalid index file');
  const temp = path.join(base, `.index-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return file;
}

if (require.main === module) {
  try {
    writeArtifactIndex();
  } catch {
    console.error('[artifact-index] 색인 갱신 실패');
    process.exitCode = 1;
  }
}

module.exports = { writeArtifactIndex };
