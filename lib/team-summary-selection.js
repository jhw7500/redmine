const { hashObject } = require('./report-artifact');
const { normalizeFactSource } = require('./text-normalization');
const { summarySourceLines } = require('./summary-provenance');
const { buildTeamEvidenceFacts } = require('./team-evidence');
const { findOpenStatusOccurrences } = require('./open-status-clauses');
const { evaluateSummaryQuality } = require('./summary-quality-gate');
const { extractVerdictOccurrences } = require('./fact-occurrences');
const { projectBalancedMarkdownDestinations } = require('./collector');

const TEAM_SUMMARY_PROFILE = 'team_summary_v1';
const THEMES = Object.freeze({
  stability: '안정성',
  implementation: '구현·연동',
  verification: '검증·분석',
  delivery: '빌드·배포',
});
const TECHNICAL = /`|…|\.\.\.|#[0-9]+|\b(?:sha(?:256)?|hash|srcversion)\b|\/(?:home|usr|opt|var|srv|workspace|work|build|tmp|mnt)\/[\w./-]+|\b(?:src|lib|dist|test|scripts)\/[\w./-]+|(?<![\p{L}\p{N}_])[\p{L}\p{N}]+_[\p{L}\p{N}_]+(?![\p{L}\p{N}_])|\b[A-Za-z_]\w*\s*\(\s*\)|\b[\w.-]+\.(?:c|h|cpp|hpp|js|py|sh|ko|json|ya?ml|toml|md)\b|\b(?:git|node|python3?|bash|bitbake|pytest|curl|systemctl|jq)\s+[A-Za-z_-][\w/-]*/iu;
const DISALLOWED_ENDING = /(?:습니다|입니다|했다|하였다|되었다|한다|된다|이다|있다|없다)[.!?]?\s*$/;
const NOT_READY = /내부\s*검토용|(?:경로|언어)[^.\n]{0,20}미정|발송\s*전[^.\n]*(?:제거|정리)|남은\s*일|팀\s*공유\s*필요|(?:Claude|claude\.ai)\s*문서\s*\(\s*비공개|초안[\s\S]{0,80}(?:검토|작성)\s*중|(?:검토|작성)\s*중(?![^.\n]{0,40}(?:완료|마쳤|끝냈|종료|해결))/i;

function fail(message, code = 'TEAM_SUMMARY_RECORDS_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function samePath(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((part, index) => part === right[index]);
}

function sourceLines(source) {
  const lines = [];
  let start = 0;
  String(source).split('\n').forEach((text, index) => {
    lines.push({ index, line: index + 1, start, end: start + text.length, text });
    start += text.length + 1;
  });
  return lines;
}

function semanticSpan(line, prefix) {
  let start = line.start + prefix;
  let end = line.end;
  while (start < end && /\s/.test(line.text[start - line.start])) start += 1;
  while (end > start && /\s/.test(line.text[end - line.start - 1])) end -= 1;
  return { start, end };
}

function sentenceSpans(source, span, facts = []) {
  const spans = [];
  let start = span.start;
  let delimiters = 0;
  let code = false;
  for (let cursor = span.start; cursor < span.end; cursor += 1) {
    const char = source[cursor];
    if (char === '`') code = !code;
    if (code) continue;
    if ('([{'.includes(char)) delimiters += 1;
    if (')]}'.includes(char) && delimiters > 0) delimiters -= 1;
    if (!delimiters && '.!?'.includes(char) && /\s/.test(source[cursor + 1] || '')) {
      if (char === '.' && /\d/.test(source[cursor - 1] || '') && /\d/.test(source[cursor + 1] || '')) continue;
      let end = cursor + 1;
      while (start < end && /\s/.test(source[start])) start += 1;
      if (end > start) spans.push({ start, end });
      start = cursor + 1;
    }
  }
  while (start < span.end && /\s/.test(source[start])) start += 1;
  if (span.end > start) spans.push({ start, end: span.end });
  for (const fact of facts.filter(item => item.sourceLocation
    && item.sourceLocation.start < span.end && span.start < item.sourceLocation.end)) {
    if (fact.sourceLocation.start < span.start || fact.sourceLocation.end > span.end) return null;
    const first = spans.findIndex(part => part.start < fact.sourceLocation.end
      && fact.sourceLocation.start < part.end);
    const last = spans.findLastIndex(part => part.start < fact.sourceLocation.end
      && fact.sourceLocation.start < part.end);
    if (first === -1 || last === -1) return null;
    if (first !== last) spans.splice(first, last - first + 1, {
      start: spans[first].start,
      end: spans[last].end,
    });
  }
  return spans;
}

function transformEnding(text) {
  const match = String(text).match(/([.!?]?)$/);
  const punctuation = match[1];
  const body = text.slice(0, text.length - punctuation.length);
  const replacements = [
    ['했습니다', '했음'], ['하였다', '했음'], ['되었다', '되었음'],
    ['합니다', '함'], ['했다', '했음'], ['한다', '함'], ['된다', '됨'],
    ['있다', '있음'], ['없다', '없음'], ['이다', '임'],
  ];
  for (const [from, to] of replacements) {
    if (body.endsWith(from)) return `${body.slice(0, -from.length)}${to}${punctuation}`;
  }
  return text;
}

function factsInside(facts, spans) {
  return facts.filter(fact => fact.sourceLocation && spans.some(span =>
    fact.sourceLocation.start >= span.start && fact.sourceLocation.end <= span.end));
}

function annotateSpan(source, span, facts) {
  let text = source.slice(span.start, span.end);
  const inside = facts.filter(fact => fact.sourceLocation
    && fact.sourceLocation.start >= span.start && fact.sourceLocation.end <= span.end)
    .sort((left, right) => right.sourceLocation.start - left.sourceLocation.start);
  for (const fact of inside) {
    const start = fact.sourceLocation.start - span.start;
    const end = fact.sourceLocation.end - span.start;
    if (text.slice(start, end) !== fact.raw) fail(`Fact ${fact.id} changed inside a summary claim`);
    text = `${text.slice(0, start)}[[fact:${fact.id}]]${text.slice(end)}`;
  }
  return transformEnding(text);
}

function candidateIsReadable(candidate, source, config, section, facts) {
  const raw = candidate.spans.map(span => source.slice(span.start, span.end)).join('\n');
  if (findOpenStatusOccurrences(raw).length || TECHNICAL.test(raw) || NOT_READY.test(raw)) return false;
  const byId = new Map(facts.map(fact => [fact.id, fact.raw]));
  const bodies = candidate.projection.map(item => item.text
    .replace(/\[\[fact:([TQVS]\d{4})\]\]/g, (_reference, id) => byId.get(id) || '')
    .replace(/\s*\[\[source:[CN]\d{4}\]\]/g, ''));
  if (bodies.some(text => DISALLOWED_ENDING.test(text))) return false;
  const heading = config.env?.sectionHeader || '#### 조현우';
  const rendered = [heading, `- ${section.path[0]}`, '  - 검증·분석',
    ...candidate.projection.map((item, index) => `${'  '.repeat(2 + item.depth)}- ${bodies[index]}`)].join('\n');
  const quality = evaluateSummaryQuality(rendered, {
    ...config,
    env: { ...(config.env || {}), reportAudience: 'team', sectionHeader: heading },
  });
  return quality.blocking.length === 0;
}

function catalogHashesAreOwned(factCatalog, coverageCatalog) {
  const catalogHash = hashObject({ schemaVersion: factCatalog.schemaVersion, facts: factCatalog.facts });
  const coverageCatalogHash = hashObject({
    schemaVersion: coverageCatalog.schemaVersion,
    sections: coverageCatalog.sections,
    items: coverageCatalog.items,
    knownPaths: coverageCatalog.knownPaths,
  });
  if (catalogHash !== factCatalog.catalogHash || coverageCatalogHash !== coverageCatalog.coverageCatalogHash) {
    fail('Fact or coverage catalog ownership changed');
  }
}

function sectionForPath(sections, path) {
  return sections.find(section => samePath(section.path, path));
}

function rawOwnedChildren(lines, lineNumber, ownerIndent) {
  const children = [];
  for (let index = lineNumber; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.text.trim()) continue;
    const bullet = line.text.match(/^(\s*)[-*+]\s+(.+)$/);
    const indent = (bullet?.[1] || line.text.match(/^\s*/)[0]).replace(/\t/g, '    ').length;
    if (bullet && indent <= ownerIndent) break;
    if (!bullet && indent <= ownerIndent) return null;
    children.push({ line, bullet });
  }
  return children;
}

function bulletAncestorsAt(lines, targetIndex) {
  const stack = [];
  for (let index = 0; index <= targetIndex; index += 1) {
    const match = lines[index].text.match(/^(\s*)[-*+]\s+(.+)$/);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, '    ').length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    if (index === targetIndex) return [...stack];
    stack.push({ indent, text: match[2], index });
  }
  return [...stack];
}

function structuralMetadata(config, section) {
  const names = new Set(section.path);
  for (const category of Object.values(config.categories || {})) {
    if (category.parent === section.path[0] && typeof category.label === 'string' && category.label.trim()) {
      names.add(category.label.trim());
    }
  }
  for (const name of Object.keys(config.repos || {})) names.add(name);
  return names;
}

function unsafeAncestor(lines, lineNumber, section, config) {
  const metadata = structuralMetadata(config, section);
  return bulletAncestorsAt(lines, lineNumber - 1)
    .some(ancestor => !metadata.has(ancestor.text));
}

function childSemanticSpan(line, bullet) {
  if (bullet) return semanticSpan(line, line.text.indexOf(bullet[2]));
  const known = line.text.match(/^\s*↳\s*(?:출처 요약|목적|변경|검증|원인|수정)\s*:\s*/);
  if (known) return semanticSpan(line, known[0].length);
  return semanticSpan(line, line.text.match(/^\s*/)[0].length);
}

function notionCandidates(snapshot, source, lines, facts, coverageCatalog, sections, config) {
  const provenance = summarySourceLines(snapshot);
  const hasProvenance = Object.hasOwn(snapshot, 'sourceDetails');
  const entriesByLine = new Map(coverageCatalog.items.map(entry => [entry.sourceLocation.line, entry]));
  const result = [];
  for (const [lineNumber, entry] of entriesByLine) {
    const line = lines[lineNumber - 1];
    const match = line?.text.match(/^(\s*)[-*+]\s+\[Notion\]\s+(.+)$/);
    const section = sectionForPath(sections, entry.requiredPath);
    if (!match || !section || unsafeAncestor(lines, lineNumber, section, config)) continue;
    const titleOffset = line.text.indexOf(match[2]);
    const spans = [semanticSpan(line, titleOffset)];
    const children = rawOwnedChildren(lines, lineNumber, match[1].replace(/\t/g, '    ').length);
    if (children === null) continue;
    let ambiguous = false;
    const referenceSpans = [];
    const referenceBodies = [];
    for (const child of children) {
      if (hasProvenance) {
        const binding = provenance.get(child.line.line);
        if (!binding || binding.parentLine !== lineNumber) { ambiguous = true; break; }
        if (binding.kind === 'report_reference') {
          const prefix = child.line.text.match(/^\s*↳\s*자료\s*:\s*/)?.[0];
          if (!prefix) { ambiguous = true; break; }
          const referenceSpan = semanticSpan(child.line, prefix.length);
          referenceSpans.push({ ...referenceSpan, kind: 'report_reference' });
          referenceBodies.push(source.slice(referenceSpan.start, referenceSpan.end));
          continue;
        }
        if (binding.kind !== 'notion_summary') { ambiguous = true; break; }
      }
      const semantic = childSemanticSpan(child.line, child.bullet);
      const parts = sentenceSpans(source, semantic, facts);
      if (!parts) { ambiguous = true; break; }
      spans.push(...parts);
    }
    if (ambiguous) continue;
    const ownedFacts = factsInside(facts, spans);
    const projection = spans.map((span, index) => ({
      depth: index === 0 ? 0 : 1,
      text: `${annotateSpan(source, span, ownedFacts)}${index === 0 ? ` [[source:${entry.id}]]` : ''}`,
    }));
    if (referenceBodies.length) projection[0].text += ` · 자료: ${referenceBodies.join(' · ')}`;
    result.push({ sectionId: section.id, spans, projection, sourceIds: [entry.id], referenceSpans });
  }
  return result;
}

function gitCandidates(source, lines, facts, sections, config) {
  const bullets = lines.flatMap(line => {
    const match = line.text.match(/^(\s*)[-*+]\s+(.+)$/);
    return match ? [{ line, indent: match[1].replace(/\t/g, '    ').length, body: match[2], bodyOffset: line.text.indexOf(match[2]) }] : [];
  });
  const result = [];
  for (const bullet of bullets) {
    if (/^(?:\[Notion\]|\(변경 없음\)$)/.test(bullet.body)) continue;
    const section = sections.find(entry => {
      const startLine = entry.sourceLine;
      const next = sections.find(other => other.sourceLine > startLine)?.sourceLine || lines.length + 1;
      return bullet.line.line > startLine && bullet.line.line < next;
    });
    if (!section || bullet.indent < 2 || unsafeAncestor(lines, bullet.line.line, section, config)) continue;
    const continuations = [];
    let ambiguous = false;
    for (let index = bullet.line.index + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.text.trim()) continue;
      const child = line.text.match(/^(\s*)[-*+]\s+/);
      if (child) {
        if (child[1].replace(/\t/g, '    ').length > bullet.indent) ambiguous = true;
        break;
      }
      const label = line.text.match(/^\s*↳\s*(?:목적|변경|검증|원인|수정)\s*:\s*/)?.[0];
      if (!label) { ambiguous = true; break; }
      continuations.push({ line, label, kind: label.match(/(?:목적|변경|검증|원인|수정)/)?.[0] });
    }
    if (ambiguous || !continuations.some(item => item.kind === '목적')
      || !continuations.some(item => item.kind === '변경')) continue;
    const spans = [semanticSpan(bullet.line, bullet.bodyOffset)];
    for (const continuation of continuations) {
      const parts = sentenceSpans(source,
        semanticSpan(continuation.line, continuation.label.length), facts);
      if (!parts) { ambiguous = true; break; }
      spans.push(...parts);
    }
    if (ambiguous) continue;
    const ownedFacts = factsInside(facts, spans);
    result.push({
      sectionId: section.id,
      spans,
      projection: spans.map((span, index) => ({
        depth: index === 0 ? 0 : 1,
        text: annotateSpan(source, span, ownedFacts),
      })),
      sourceIds: [],
    });
  }
  return result;
}

function measurementContextIsIndependent(lines, item, section, config) {
  const targetIndex = item.sourceLocation.line - 1;
  const row = lines[targetIndex];
  const bullet = row.text.match(/^(\s*)[-*+]\s+(.+)$/);
  // A fragment inside another item's notes has no independent ownership proof.
  // Keep its entire Git/Notion bundle, rather than guessing which sibling text qualifies it.
  if (!bullet || unsafeAncestor(lines, row.line, section, config)) return false;
  const body = semanticSpan(row, row.text.indexOf(bullet[2]));
  if (body.start !== item.sourceLocation.start || body.end !== item.sourceLocation.end) return false;
  const indent = bullet[1].replace(/\t/g, '    ').length;
  for (let index = targetIndex + 1; index < lines.length; index += 1) {
    const next = lines[index];
    if (!next.text.trim()) continue;
    const boundary = next.text.match(/^(\s*)[-*+]\s+/);
    if (boundary && boundary[1].replace(/\t/g, '    ').length <= indent) break;
    return false;
  }
  if (extractVerdictOccurrences(row.text).length || findOpenStatusOccurrences(row.text).length) return false;
  return true;
}

function releaseComponentContext(source, lines, item, scalarFacts, section) {
  const targetIndex = item.sourceLocation.line - 1;
  const stack = [];
  for (let index = 0; index <= targetIndex; index += 1) {
    const line = lines[index];
    const match = line.text.match(/^(\s*)[-*+]\s+(.+)$/);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, '    ').length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const bodyOffset = line.text.indexOf(match[2]);
    stack.push({
      indent,
      text: match[2],
      span: semanticSpan(line, bodyOffset),
    });
  }
  for (const candidate of [...stack].reverse()) {
    if (section.path.includes(candidate.text)
      || /(?:릴리즈|release|버전|설치|배포|전달|납품|예정|계획|실패|완료|성공|적용)/i.test(candidate.text)
      || TECHNICAL.test(candidate.text)
      || findOpenStatusOccurrences(candidate.text).length
      || extractVerdictOccurrences(candidate.text).length
      || scalarFacts.some(fact => fact.sourceLocation
        && fact.sourceLocation.start < candidate.span.end
        && candidate.span.start < fact.sourceLocation.end)) continue;
    return candidate;
  }
  return null;
}

function hasReleaseIntent(text) {
  return /(?:로|으로)\s*(?:맞(?:추|춘|췄)|갱신|업데이트|올리|올렸|전환)|(?:워크플로|자동화)[^\n]*(?:맞(?:추|춘|췄)|갱신|업데이트)|canary로\s*전환/.test(text);
}

function releaseAncestorClause(source, lines, item, scalarFacts, section) {
  for (const ancestor of bulletAncestorsAt(lines, item.sourceLocation.line - 1).reverse()) {
    if (section.path.includes(ancestor.text)) continue;
    const line = lines[ancestor.index];
    const match = line.text.match(/^(\s*)[-*+]\s+(.+)$/);
    const span = semanticSpan(line, line.text.indexOf(match[2]));
    const raw = source.slice(span.start, span.end);
    if (!hasReleaseIntent(raw) || TECHNICAL.test(raw) || NOT_READY.test(raw)
      || findOpenStatusOccurrences(raw).length || extractVerdictOccurrences(raw).length
      || /(?:설치|배포|전달|납품|예정|계획)/.test(raw)
      || !scalarFacts.some(fact => /^v?\d+(?:\.\d+){1,3}/i.test(fact.raw)
        && fact.sourceLocation && span.start <= fact.sourceLocation.start
        && fact.sourceLocation.end <= span.end)) continue;
    return { span, text: annotateSpan(source, span, factsInside(scalarFacts, [span])) };
  }
  return null;
}

function releaseSourceClause(source, line, item, scalarFacts, lines, section) {
  const bullet = line.text.match(/^(\s*)[-*+]\s+(.+)$/);
  const label = line.text.match(/^\s*↳\s*(?:목적|변경|검증|원인|수정)\s*:\s*/);
  const offset = bullet ? line.text.indexOf(bullet[2]) : (label?.[0].length ?? line.text.match(/^\s*/)[0].length);
  const span = semanticSpan(line, offset);
  if (!(span.start <= item.sourceLocation.start && item.sourceLocation.end <= span.end)) return null;
  const raw = source.slice(span.start, span.end);
  const remainder = raw.replace(item.raw, '').replace(/[\s.,:;()[\]{}·-]+/g, ' ').trim();
  const generic = /^(?:(?:릴리즈|release|버전|기준|정리|업데이트|갱신|맞춤|맞춘다|정보)\s*)+$/i;
  if (!/[가-힣]/.test(remainder) || generic.test(remainder)
    || TECHNICAL.test(raw) || NOT_READY.test(raw)
    || findOpenStatusOccurrences(raw).length || extractVerdictOccurrences(raw).length
    || /(?:설치|배포|전달|납품|예정|계획)/.test(raw)) return null;
  if (bulletAncestorsAt(lines, item.sourceLocation.line - 1).some(ancestor =>
    !section.path.includes(ancestor.text)
    && (findOpenStatusOccurrences(ancestor.text).length
      || extractVerdictOccurrences(ancestor.text).length
      || /(?:설치|배포|전달|납품|예정|계획|실패|완료)/.test(ancestor.text)))) return null;
  const facts = factsInside(scalarFacts, [span]);
  return { span, text: annotateSpan(source, span, facts) };
}

function evidenceCandidates(source, scalarFacts, sections, config) {
  const lines = sourceLines(source);
  const evidence = buildTeamEvidenceFacts(source, scalarFacts);
  const evidenceKeys = new Set(evidence.map(item => `${item.sourceLocation.start}:${item.sourceLocation.end}`));
  for (const fact of scalarFacts) {
    if (!fact.sourceLocation || !/^v?\d+(?:\.\d+){1,3}/i.test(fact.raw)
      || evidenceKeys.has(`${fact.sourceLocation.start}:${fact.sourceLocation.end}`)) continue;
    const line = lines[fact.sourceLocation.line - 1];
    const raw = line?.text || '';
    if (hasReleaseIntent(raw)) {
      evidence.push({ type: 'release_version', raw: fact.raw,
        sourceLocation: fact.sourceLocation, sourceSectionPath: fact.sourceSectionPath });
    }
  }
  return evidence.flatMap(item => {
    const section = sectionForPath(sections, item.sourceSectionPath);
    if (!section) return [];
    const line = lines[item.sourceLocation.line - 1];
    if (!line) return [];
    if (item.type === 'measurement_claim') {
      const span = { start: item.sourceLocation.start, end: item.sourceLocation.end };
      if (!measurementContextIsIndependent(lines, item, section, config)) return [];
      const facts = factsInside(scalarFacts, [span]);
      return [{
        sectionId: section.id,
        spans: [span],
        projection: [{ depth: 0, text: annotateSpan(source, span, facts) }],
        sourceIds: [], meaningfulMeasurement: true,
      }];
    }
    const span = { start: item.sourceLocation.start, end: item.sourceLocation.end };
    const clause = releaseSourceClause(source, line, item, scalarFacts, lines, section);
    if (clause) return [{
      sectionId: section.id,
      spans: [clause.span],
      projection: [{ depth: 0, text: clause.text }],
      sourceIds: [], release: true,
    }];
    const ancestorClause = releaseAncestorClause(source, lines, item, scalarFacts, section);
    if (ancestorClause) return [{
      sectionId: section.id,
      spans: [ancestorClause.span],
      projection: [{ depth: 0, text: ancestorClause.text }],
      sourceIds: [], release: true,
    }];
    const context = releaseComponentContext(source, lines, item, scalarFacts, section);
    if (!context) return [];
    const facts = factsInside(scalarFacts, [span]);
    return [{
      sectionId: section.id,
      spans: [context.span, span],
      projection: [
        { depth: 0, text: `${context.text} 릴리즈 정보` },
        { depth: 1, text: `릴리즈 버전 ${annotateSpan(source, span, facts)}` },
      ],
      sourceIds: [], release: true,
    }];
  });
}

function overlap(left, right) {
  return left.sourceSpans.some(a => right.sourceSpans.some(b => {
    if (!(a.start < b.end && b.start < a.end)) return false;
    const sharedReleaseContext = left.release && right.release
      && a.start === b.start && a.end === b.end && a.raw === b.raw
      && !/\bv?\d+(?:\.\d+){1,3}\b/i.test(a.raw);
    return !sharedReleaseContext;
  }));
}

function buildTeamSummaryRecords(snapshot, factCatalog, coverageCatalog, config) {
  if (!snapshot || typeof snapshot.rawContent !== 'string' || !factCatalog || !coverageCatalog || !config) {
    fail('Snapshot, catalogs, and config are required');
  }
  catalogHashesAreOwned(factCatalog, coverageCatalog);
  const source = normalizeFactSource(snapshot.rawContent);
  const lines = sourceLines(source);
  const heading = lines.find(line => /^####\s+/.test(line.text))?.text;
  if (!heading) fail('Summary heading is missing');
  const sections = coverageCatalog.sections.map(entry => ({
    id: entry.id,
    path: [...entry.requiredPath],
    headings: entry.requiredPath.map((part, index) => index === entry.requiredPath.length - 1
      ? `${part} [[source:${entry.id}]]` : part),
    sourceLine: entry.sourceLocation?.line,
  }));
  if (!sections.length || sections.some(section => section.path.length !== 1 || !section.sourceLine)) {
    fail('Team summary requires populated project-root coverage');
  }
  const scalarFacts = factCatalog.facts.filter(fact => !/^M\d{4}$/.test(fact.id));
  if (scalarFacts.length !== factCatalog.facts.length) fail('Team summary requires a scalar-only fact catalog');
  const evidence = evidenceCandidates(source, scalarFacts, sections, config);
  const candidates = [
    ...notionCandidates(snapshot, source, lines, scalarFacts, coverageCatalog, sections, config),
    ...gitCandidates(source, lines, scalarFacts, sections, config),
    ...evidence,
  ];
  for (const candidate of candidates) {
    const raw = candidate.spans.map(span => source.slice(span.start, span.end)).join('\n');
    const ownedFacts = factsInside(scalarFacts, candidate.spans);
    if (/(?:실측|측정)/.test(raw)
      && extractVerdictOccurrences(raw).length === 0
      && findOpenStatusOccurrences(raw).length === 0
      && ownedFacts.some(fact => fact.type === 'measured_quantity'
        && !/(?:개|건|회|가지|번|차례)$/.test(fact.raw))) {
      candidate.meaningfulMeasurement = true;
    }
    for (const proof of evidence) {
      const contained = proof.spans.every(proofSpan => candidate.spans.some(span =>
        span.start <= proofSpan.start && proofSpan.end <= span.end));
      if (!contained) continue;
      if (proof.meaningfulMeasurement) candidate.meaningfulMeasurement = true;
      if (proof.release) candidate.release = true;
    }
  }
  const readableCandidates = candidates.filter(candidate => candidateIsReadable(candidate, source, config,
    sections.find(section => section.id === candidate.sectionId), scalarFacts));
  const records = readableCandidates.map((candidate, index) => {
    const sourceSpans = candidate.spans.map(span => ({
      start: span.start, end: span.end, raw: source.slice(span.start, span.end),
    }));
    const facts = factsInside(scalarFacts, candidate.spans);
    return {
      id: `R${String(index + 1).padStart(4, '0')}`,
      sectionId: candidate.sectionId,
      sourceSpans,
      factIds: facts.map(fact => fact.id),
      sourceIds: candidate.sourceIds,
      projection: candidate.projection,
      conflictingIds: [],
      ...(candidate.referenceSpans?.length ? { referenceSpans: candidate.referenceSpans.map(span => ({
        start: span.start, end: span.end, raw: source.slice(span.start, span.end), kind: span.kind,
      })) } : {}),
      ...(candidate.meaningfulMeasurement ? { meaningfulMeasurement: true } : {}),
      ...(candidate.release ? { release: true } : {}),
    };
  });
  for (const record of records) {
    record.conflictingIds = records.filter(other => other !== record && (
      overlap(record, other)
      || (record.release && other.release && record.sectionId === other.sectionId
        && record.sourceSpans[0].raw === other.sourceSpans[0].raw)
    )).map(other => other.id);
  }
  if (sections.some(section => !records.some(record => record.sectionId === section.id))) {
    fail('Every populated project root must contain an eligible immutable claim');
  }
  const payload = {
    schemaVersion: 2,
    profile: TEAM_SUMMARY_PROFILE,
    renderVersion: 1,
    snapshotHash: snapshot.contentHash,
    catalogHash: factCatalog.catalogHash,
    coverageCatalogHash: coverageCatalog.coverageCatalogHash,
    heading,
    sections: sections.map(({ sourceLine: _sourceLine, ...section }) => section),
    records,
  };
  return { ...payload, recordsHash: hashObject(payload) };
}

function stripCodeFence(text) {
  const match = /^[ \t\r\n]*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t\r\n]*$/.exec(text);
  return match ? match[1] : text;
}

function parseTeamSummarySelection(text, records, leaderHighlight = {}) {
  let value;
  try { value = JSON.parse(stripCodeFence(String(text))); } catch { fail('Selection must be one JSON object', 'TEAM_SUMMARY_SELECTION_INVALID'); }
  const invalid = message => fail(message, 'TEAM_SUMMARY_SELECTION_INVALID');
  if (!exactKeys(value, ['sections']) || !Array.isArray(value.sections)) invalid('Expected sections only');
  const byId = new Map(records.records.map(record => [record.id, record]));
  const seenSections = new Set();
  const selected = new Set();
  let highlighted = 0;
  for (const section of value.sections) {
    if (!exactKeys(section, ['id', 'groups']) || seenSections.has(section.id)
      || !records.sections.some(entry => entry.id === section.id)) invalid('Unknown or duplicate section');
    seenSections.add(section.id);
    if (!Array.isArray(section.groups) || !section.groups.length || section.groups.length > 4) invalid('Expected one to four groups');
    const themes = new Set();
    let sectionCount = 0;
    for (const group of section.groups) {
      if (!exactKeys(group, ['theme', 'items']) || typeof group.theme !== 'string'
        || !Object.hasOwn(THEMES, group.theme) || themes.has(group.theme)) invalid('Unknown or duplicate theme');
      themes.add(group.theme);
      if (!Array.isArray(group.items) || !group.items.length) invalid('Expected source items');
      for (const item of group.items) {
        if (!exactKeys(item, ['id', 'highlight']) || typeof item.id !== 'string'
          || typeof item.highlight !== 'boolean') invalid('Expected ID and boolean highlight only');
        const record = byId.get(item.id);
        if (!record || record.sectionId !== section.id || selected.has(item.id)) invalid('Unknown, moved, or duplicate record');
        if ([...selected].some(id => record.conflictingIds.includes(id))) invalid('Overlapping or conflicting records');
        selected.add(item.id);
        sectionCount += 1;
        if (item.highlight) {
          highlighted += 1;
          if (leaderHighlight.enabled !== true
            || (leaderHighlight.maxLines > 0 && highlighted > leaderHighlight.maxLines)) invalid('Highlight policy exceeded');
        }
      }
    }
    if (sectionCount > 5) invalid('A project root may contain at most five records');
  }
  if (seenSections.size !== records.sections.length) invalid('Missing project root');
  if (selected.size > 12) invalid('At most twelve records may be selected');
  for (const property of ['meaningfulMeasurement', 'release']) {
    if (records.records.some(record => record[property])
      && ![...selected].some(id => byId.get(id)[property])) invalid(`Selection must include an eligible ${property} record`);
  }
  return value;
}

function canAdd(record, chosen) {
  return !chosen.some(existing => existing.id === record.id
    || record.conflictingIds.includes(existing.id));
}

function buildTeamSummaryFallbackSelection(records, leaderHighlight = {}) {
  const chosen = [];
  for (const property of ['meaningfulMeasurement', 'release']) {
    const record = records.records.find(candidate => candidate[property] && canAdd(candidate, chosen));
    if (record) chosen.push(record);
  }
  for (const section of records.sections) {
    const available = records.records.filter(candidate => candidate.sectionId === section.id);
    const target = Math.min(3, available.length);
    for (const record of available) {
      if (chosen.length >= 12
        || chosen.filter(candidate => candidate.sectionId === section.id).length >= target) break;
      if (canAdd(record, chosen)) chosen.push(record);
    }
    if (!chosen.some(record => record.sectionId === section.id)) {
      fail(`No deterministic fallback claim for ${section.path.join(' / ')}`);
    }
  }
  const selection = { sections: records.sections.map(section => ({
    id: section.id,
    groups: [{
      theme: 'verification',
      items: chosen.filter(record => record.sectionId === section.id)
        .map(record => ({ id: record.id, highlight: false })),
    }],
  })) };
  return parseTeamSummarySelection(JSON.stringify(selection), records, leaderHighlight);
}

function renderTeamSummarySelection(records, selection, options = {}) {
  const valid = parseTeamSummarySelection(JSON.stringify(selection), records, options.leaderHighlight || {});
  const byId = new Map(records.records.map(record => [record.id, record]));
  const bySection = new Map(valid.sections.map(section => [section.id, section]));
  const lines = [records.heading, ''];
  if (options.fallback) lines.push('> 원문 기반 대체 보고서 (AI 항목 선택을 사용하지 않음)', '');
  let previousPath = [];
  for (const section of records.sections) {
    let shared = 0;
    while (shared < section.path.length && previousPath[shared] === section.path[shared]) shared += 1;
    for (let index = shared; index < section.path.length; index += 1) {
      lines.push(`${'  '.repeat(index)}- ${section.headings[index]}`);
    }
    previousPath = section.path;
    for (const group of bySection.get(section.id).groups) {
      lines.push(`${'  '.repeat(section.path.length)}- ${options.fallback ? '원문 발췌' : THEMES[group.theme]}`);
      for (const item of group.items) {
        const record = byId.get(item.id);
        record.projection.forEach((part, index) => {
          const body = item.highlight && index === 0 ? `<u>${part.text}</u>` : part.text;
          lines.push(`${'  '.repeat(section.path.length + 1 + part.depth)}- ${body}`);
        });
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function buildTeamSummaryPrompt(records, config) {
  const policy = config.reportFilter?.leaderHighlight || {};
  const teamGuidance = typeof config.reportFilter?.teamReport?.guidance === 'string'
    ? config.reportFilter.teamReport.guidance.trim() : '';
  const highlightGuidance = typeof policy.guidance === 'string' ? policy.guidance.trim() : '';
  const max = policy.enabled === true && policy.maxLines > 0
    ? `highlight=true는 전체 최대 ${policy.maxLines}개다.`
    : 'highlight는 모두 false다.';
  const source = records.sections.map(section => ({
    id: section.id,
    path: section.path,
    records: records.records.filter(record => record.sectionId === section.id).map(record => ({
      id: record.id,
      projection: record.projection.map(part => {
        const projected = projectBalancedMarkdownDestinations(part.text, false);
        if (projected.limitExceeded) fail('Reference preview is ambiguous');
        return { ...part, text: projected.text.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, '[URL omitted]') };
      }),
      conflictingIds: record.conflictingIds,
      meaningfulMeasurement: record.meaningfulMeasurement === true,
      release: record.release === true,
    })),
  }));
  return `팀 주간보고에 실을 보호 근거 묶음을 선택하고 테마로 구성한다.\n`
    + `JSON 객체 하나만 출력한다. 원문을 고치거나 새 문장을 쓰지 않는다.\n`
    + `허용 theme: stability, implementation, verification, delivery.\n`
    + `각 프로젝트 root에서 1~5개, 전체 12개 이하를 고른다. 사용 가능한 의미 있는 측정과 릴리즈는 각각 최소 하나 포함한다.\n`
    + `모든 project root ID를 정확히 한 번 포함하고, 같은 project 안에서 theme은 중복할 수 없다. conflictingIds 관계의 ID는 동시에 선택하지 않는다.\n`
    + `선택 우선순위에만 적용하며 원문 추가·삭제·재작성 권한이 아니다. 개인 AI 도구·비공개 운영 메모보다 팀 제품·고객 영향·검증 결과를 우선한다.\n`
    + `${teamGuidance ? `팀 보고 선택 기준: ${teamGuidance}\n` : ''}`
    + `${highlightGuidance ? `강조 선택 기준: ${highlightGuidance}\n` : ''}`
    + `${max}\n출력 형식: {"sections":[{"id":"C0001","groups":[{"theme":"verification","items":[{"id":"R0001","highlight":false}]}]}]}\n`
    + `원본 레코드:\n${JSON.stringify(source)}\n`;
}

module.exports = {
  TEAM_SUMMARY_PROFILE,
  buildTeamSummaryRecords,
  buildTeamSummaryPrompt,
  parseTeamSummarySelection,
  buildTeamSummaryFallbackSelection,
  renderTeamSummarySelection,
};
