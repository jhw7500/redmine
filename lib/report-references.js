// Explicit, read-only associations. Never infer a reference from a project/title.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SKIP_REPORTS = ['none', 'private', 'note', 'no-report', 'skip'];
const AUDIENCES = ['team', 'on_request'];

function invalid() {
  // Do not include URLs/config values: malformed entries may contain credentials.
  throw Object.assign(new Error('Invalid report reference; check binding, URL and audience policy'),
    { code: 'REPORT_REFERENCE_INVALID' });
}

function shortText(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && value === value.trim() && !/[\x00-\x1f\x7f\u2028\u2029\[\]<>`*\\!@]/.test(value);
}

function safeReferenceUrl(value) {
  if (typeof value !== 'string' || value.length > 2000
    || /[\s\x00-\x1f\x7f\\<>\[\]`"']/.test(value)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  // Query-bearing links may be signed/temporary. Require a stable reviewed URL.
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search
    || (url.hash && !/^#[A-Za-z0-9_-]+$/.test(url.hash))) invalid();
  const normalized = url.href.replace(/[()]/g, c => c === '(' ? '%28' : '%29');
  if (normalized.length > 2000) invalid();
  return normalized;
}

function validateBinding(entry) {
  const keys = ['sourceId', 'referencePageId', 'label', 'audience', 'url', 'version'];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || Object.keys(entry).some(key => !keys.includes(key))
    || typeof entry.sourceId !== 'string' || !entry.sourceId.startsWith('notion:')
    || !UUID.test(entry.sourceId.slice(7)) || typeof entry.referencePageId !== 'string'
    || !UUID.test(entry.referencePageId)
    || !AUDIENCES.includes(entry.audience) || !shortText(entry.label, 32)
    || (entry.version !== undefined && !shortText(entry.version, 48))) invalid();
  if (entry.url !== undefined) safeReferenceUrl(entry.url);
}

async function resolveReportReferences(items, config, fetchPage) {
  const entries = config.sources?.notion?.reportReferences;
  if (entries === undefined) return items;
  if (!Array.isArray(entries)) invalid();
  const bindings = new Map();
  const seen = new Set();
  for (const rawEntry of entries) {
    validateBinding(rawEntry);
    const entry = { ...rawEntry, sourceId: rawEntry.sourceId.toLowerCase(),
      referencePageId: rawEntry.referencePageId.toLowerCase() };
    const key = JSON.stringify([entry.sourceId, entry.referencePageId, entry.url || null]);
    if (seen.has(key)) invalid();
    seen.add(key);
    if (!bindings.has(entry.sourceId)) bindings.set(entry.sourceId, []);
    bindings.get(entry.sourceId).push(entry);
  }
  const cached = new Map();
  const skip = new Set([...SKIP_REPORTS, ...(config.sources?.notion?.reportSkipValues || [])]
    .map(value => String(value).trim().toLowerCase()));
  const output = [];
  for (const item of items) {
    const sourceId = typeof item.sourceId === 'string' && item.sourceId.startsWith('notion:')
      ? item.sourceId.toLowerCase() : item.sourceId;
    const matched = bindings.get(sourceId);
    if (!matched?.length || item.reportExcluded || skip.has(String(item.report || '').trim().toLowerCase())) {
      output.push(item);
      continue;
    }
    const references = [];
    for (const entry of matched) {
      if (!cached.has(entry.referencePageId)) {
        let page;
        try { page = await fetchPage(entry.referencePageId); }
        catch { throw Object.assign(new Error('Configured report reference is unavailable; collection stopped'),
          { code: 'REPORT_REFERENCE_UNAVAILABLE' }); }
        cached.set(entry.referencePageId, page);
      }
      const page = cached.get(entry.referencePageId);
      const report = page?.properties?.report?.select?.name;
      if (!page || typeof page.id !== 'string' || page.id.toLowerCase() !== entry.referencePageId
        || page.archived || page.in_trash
        || skip.has(String(report || '').trim().toLowerCase())
        || typeof page.last_edited_time !== 'string' || !Number.isFinite(Date.parse(page.last_edited_time))) invalid();
      const urlProperty = page.properties?.url;
      const url = safeReferenceUrl(entry.url ?? (urlProperty?.type === 'url' ? urlProperty.url : undefined));
      references.push({ referencePageId: entry.referencePageId, label: entry.label, url, audience: entry.audience,
        ...(entry.version !== undefined ? { version: entry.version } : {}), pageLastEditedTime: page.last_edited_time });
    }
    output.push({ ...item, reportReferences: references });
  }
  return output;
}

function referenceLabel(reference) {
  if (!reference || !AUDIENCES.includes(reference.audience) || !shortText(reference.label, 32)
    || (reference.version !== undefined && !shortText(reference.version, 48))) invalid();
  return reference.label + (reference.version ? ` (${reference.version})` : '')
    + (reference.audience === 'on_request' ? ' · 요청 시 공유' : '');
}

function referenceLines(item, indent) {
  if (item.reportReferences === undefined) return [];
  if (!Array.isArray(item.reportReferences)) invalid();
  const links = item.reportReferences.map(reference => {
    const label = referenceLabel(reference);
    return `[${label}](${safeReferenceUrl(reference.url)})`;
  });
  const lines = [];
  for (let index = 0; index < links.length; index += 2) {
    lines.push(`${indent}↳ 자료: ${links.slice(index, index + 2).join(' · ')}`);
  }
  return lines;
}

function assertReferenceGenerationMode(snapshot, method) {
  const hasReferences = snapshot.sources?.notion?.data?.some(item => item.reportReferences?.length)
    || snapshot.sourceDetails?.spans?.some(span => span.kind === 'report_reference');
  if (hasReferences && method !== 'source_selection') {
    throw Object.assign(new Error('Report references require source_selection generation and ownership evidence'),
      { code: 'REPORT_REFERENCES_REQUIRE_SELECTION' });
  }
}

module.exports = { resolveReportReferences, referenceLines, referenceLabel, safeReferenceUrl, assertReferenceGenerationMode };
