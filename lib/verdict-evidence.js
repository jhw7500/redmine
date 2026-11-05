const { parseAnnotatedDraft } = require("./annotated-draft");
const { extractVerdictOccurrences } = require("./fact-occurrences");
const { annotateFactReferences, expandFactReferences } = require("./fact-references");
const { annotationOwners } = require("./team-evidence");
const { normalizeFactSource } = require("./text-normalization");
const { projectBalancedMarkdownDestinations, projectBalancedHtmlComments, projectBalancedHtmlTags } = require("./collector");

// Rejection only: never treat this lossy view as source evidence or restore it into output.
function visibleVerdictText(text) {
  const decoded = String(text)
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, value) => {
      const code = /^x/i.test(value) ? parseInt(value.slice(1), 16) : Number(value);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    // Named invisible entities cannot split an otherwise visible verdict. This
    // deletion is rejection-only, as in the existing release-state projection.
    .replace(/&[a-z][a-z0-9]+;/gi, "");
  const visible = projectBalancedHtmlTags(projectBalancedHtmlComments(decoded, false), false)
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKC");
  return projectBalancedMarkdownDestinations(visible, false).text
    .replace(/[*_`~\[\]]/g, "");
}

function stripOuterUnderline(text) {
  if (!text.startsWith("<u>") || !text.endsWith("</u>")) return text;
  let depth = 0;
  for (const match of text.matchAll(/<\/?u>/g)) {
    depth += match[0] === "<u>" ? 1 : -1;
    if (depth < 0 || (depth === 0 && match.index + match[0].length !== text.length)) return text;
  }
  return depth === 0 ? text.slice(3, -4) : text;
}

function hasAmbiguousVerdictMarkup(text) {
  // Do not grow a named-entity table or guess reference-link rendering. Every
  // entity/bracket spelling needs an exact source-owned row instead. Notion's
  // closed provenance prefix has its own directional ownership check below.
  const prose = String(text).replace(/(^|\n)[ \t]*(?:[-*+][ \t]+)?\[Notion\][ \t]+/g, "$1");
  return /&(?:#|[a-z][a-z0-9]*;)|\][ \t]*\[|[a-z]\[[^\]\r\n]*\]|\[[^\]\r\n]*\][a-z]/i.test(prose);
}

function projectionRows(parsed, typedVerdictSpans = []) {
  const rows = [];
  const headings = [];
  const bullets = [];
  let paragraph = [];
  let start = 0;
  for (const line of parsed.cleanContent.split("\n")) {
    const end = start + line.length;
    const claims = parsed.claims.filter(claim => start <= claim.cleanStart && claim.cleanEnd <= end);
    const crossing = parsed.claims.some(claim => claim.cleanStart < end && start < claim.cleanEnd
      && !claims.includes(claim));
    let canonical = line;
    for (const claim of [...claims].reverse()) {
      canonical = canonical.slice(0, claim.cleanStart - start)
        + `[[fact:${claim.factId}]]` + canonical.slice(claim.cleanEnd - start);
    }
    const trimmed = canonical.trim();
    if (!trimmed) { paragraph = []; start = end + 1; continue; }
    const heading = trimmed.match(/^(#{1,6})[ \t]+/);
    const bullet = canonical.match(/^([ \t]*)[-*+][ \t]+/);
    const body = stripOuterUnderline(trimmed.replace(/^[-*+][ \t]+/, ""));
    const notion = /^\[Notion\][ \t]+/.test(body);
    const text = body
      .replace(/^\[Notion\][ \t]+/, "");
    let ancestors;
    if (heading) {
      while (headings.length && headings.at(-1).level >= heading[1].length) headings.pop();
      ancestors = headings.map(node => node.row);
      bullets.length = 0;
      paragraph = [];
    } else if (bullet) {
      const indent = bullet[1].replace(/\t/g, "    ").length;
      while (bullets.length && bullets.at(-1).indent >= indent) bullets.pop();
      ancestors = [...headings.map(node => node.row), ...bullets.flatMap(node => [node.row, ...node.continuations])];
      paragraph = [];
    } else {
      ancestors = [...headings.map(node => node.row), ...bullets.flatMap(node => [node.row, ...node.continuations]), ...paragraph];
    }
    const parents = ancestors.map(row => row.text);
    let verdictText = line;
    for (const span of typedVerdictSpans) {
      if (start <= span.start && span.end <= end) {
        verdictText = verdictText.slice(0, span.start - start) + " ".repeat(span.end - span.start) + verdictText.slice(span.end - start);
      }
    }
    const row = { text, parents, ancestors, claims, crossing, notion, start, end,
      hasVerdict: extractVerdictOccurrences(visibleVerdictText(verdictText)).length > 0,
      ambiguousMarkup: hasAmbiguousVerdictMarkup(stripOuterUnderline(line.trim().replace(/^[-*+][ \t]+/, ""))),
    };
    row.key = JSON.stringify([parents, text]);
    rows.push(row);
    if (heading) headings.push({ level: heading[1].length, row });
    else if (bullet) bullets.push({ indent: bullet[1].replace(/\t/g, "    ").length, row, continuations: [] });
    else if (bullets.length) bullets.at(-1).continuations.push(row);
    else paragraph.push(row);
    start = end + 1;
  }
  for (const row of rows) row.descendants = rows.filter(candidate => candidate.ancestors.includes(row));
  return rows;
}

function preservesProvenance(actual, expected) {
  return !((actual.notion && !expected.notion)
    || actual.ancestors.some((ancestor, index) => ancestor.notion && !expected.ancestors[index]?.notion));
}

function sameDescendants(actual, expected) {
  return actual.descendants.length === expected.descendants.length
    && actual.descendants.every((row, index) => row.key === expected.descendants[index].key
      && preservesProvenance(row, expected.descendants[index]));
}

function licensedTypedVerdicts(sourceRows, outputRows, proofs) {
  return proofs.filter(proof => {
    const sourceRow = sourceRows.find(row => row.claims.some(claim => claim.factId === proof.factId));
    const outputRow = outputRows.find(row => row.start <= proof.start && proof.end <= row.end);
    if (!sourceRow || !outputRow || JSON.stringify(outputRow.parents) !== JSON.stringify(sourceRow.parents)) return false;
    if (outputRow.ancestors.some((row, index) => row.notion && !sourceRow.ancestors[index]?.notion)) return false;
    // The typed failure can describe only its one version leaf; neither another
    // command parent nor an extra result/descendant can borrow this license.
    const [leaf] = outputRow.descendants;
    return outputRow.descendants.length === 1 && leaf.ancestors.at(-1) === outputRow
      && leaf.text === `[[fact:${proof.factId}]]` && !leaf.notion
      && leaf.claims.length === 1 && leaf.claims[0].factId === proof.factId;
  });
}

function validateVerdictEvidence(rawContent, annotatedContent, catalog, options = {}, typedVerdictSpans = []) {
  const source = normalizeFactSource(rawContent);
  const verdicts = extractVerdictOccurrences(source);
  const parsed = parseAnnotatedDraft(annotatedContent);
  const issues = [];
  const result = { issues, typedVerdictSpans: [] };
  if (parsed.errors.length) return result; // The common marker validator owns malformed syntax.
  if (!verdicts.length && !extractVerdictOccurrences(visibleVerdictText(parsed.cleanContent)).length
    && !hasAmbiguousVerdictMarkup(parsed.cleanContent)) return result;
  const issue = (code, message, details = {}) => issues.push({ severity: "error", code, message, ...details });
  let sourceProjection;
  let owners;
  try {
    owners = annotationOwners(source, catalog);
    sourceProjection = parseAnnotatedDraft(expandFactReferences(annotateFactReferences(source, catalog), catalog));
  } catch {
    issue("verdict_catalog_mismatch", "판정어의 원문 근거를 재구성할 수 없습니다. 새 run을 생성해야 합니다.");
    return result;
  }
  const verdictOwners = new Set();
  for (const verdict of verdicts) {
    const owner = owners.find(fact => fact.sourceLocation.start <= verdict.start
      && verdict.end <= fact.sourceLocation.end
      && source.slice(fact.sourceLocation.start, fact.sourceLocation.end) === fact.raw);
    if (!owner) {
      issue("verdict_catalog_mismatch", "판정어가 catalog에 보호되어 있지 않습니다. 새 run을 생성해야 합니다.", { sourceLocation: verdict });
    } else verdictOwners.add(owner.id);
  }
  if (issues.length) return result;

  let expected = sourceProjection;
  if (options.verdictProjection !== undefined) {
    // The caller must build this from authenticated source records + selection through the code renderer.
    // An origin label or a theme-name allowlist is not a structural proof.
    if (annotatedContent !== options.verdictProjection) {
      issue("verdict_context_mismatch", "판정어 문맥이 검증된 원문 선택 렌더와 다릅니다.");
      return result;
    }
    expected = parseAnnotatedDraft(options.verdictProjection);
  }
  const expectedRows = projectionRows(expected);
  const protectedRows = expectedRows.filter(row => row.hasVerdict
    || row.claims.some(claim => verdictOwners.has(claim.factId)));
  const byId = new Map(catalog.facts.map(fact => [fact.id, fact]));
  // A neutral release number proves no milestone. Its existing typed stage validator
  // owns independently rendered deployment status, rather than selecting a test assertion.
  const selectsAssertion = claim => byId.get(claim.factId)?.type !== "release_version";
  const relatedIds = new Set(protectedRows.flatMap(row => row.claims.filter(selectsAssertion).map(claim => claim.factId)));
  const expectedCounts = new Map();
  const expectedByKey = new Map();
  for (const row of expectedRows.filter(row => protectedRows.includes(row) || row.ambiguousMarkup)) {
    expectedCounts.set(row.key, (expectedCounts.get(row.key) || 0) + 1);
    expectedByKey.set(row.key, row);
  }
  const used = new Map();
  result.typedVerdictSpans = licensedTypedVerdicts(projectionRows(sourceProjection), projectionRows(parsed), typedVerdictSpans);
  const actualRows = projectionRows(parsed, result.typedVerdictSpans);
  for (const row of actualRows) {
    if (!row.hasVerdict && !row.ambiguousMarkup && !row.claims.some(claim => relatedIds.has(claim.factId))) continue;
    // A marker cannot acquire a new verdict through its displayed value. The common validator
    // also checks complete closed surfaces; check verdict bytes here before canonical ID matching.
    const wrongVerdict = row.claims.some(claim => {
      const fact = byId.get(claim.factId);
      const expectedWords = extractVerdictOccurrences(fact?.raw || "").map(word => word.raw);
      const actualWords = extractVerdictOccurrences(visibleVerdictText(claim.surface)).map(word => word.raw);
      return JSON.stringify(expectedWords) !== JSON.stringify(actualWords);
    });
    const count = used.get(row.key) || 0;
    const expectedRow = expectedByKey.get(row.key);
    if (row.crossing || wrongVerdict || !expectedRow || !preservesProvenance(row, expectedRow)
      || !sameDescendants(row, expectedRow)) {
      issue("verdict_context_mismatch", "판정어와 테스트 대상·조건·부모 문맥이 원문 진술과 다릅니다.", {
        factIds: row.claims.map(claim => claim.factId), outputExcerpt: row.text,
      });
    } else if (count >= expectedCounts.get(row.key)) {
      issue("duplicate_verdict_claim", "같은 판정 근거를 검증된 횟수보다 많이 사용했습니다.", { factIds: row.claims.map(claim => claim.factId) });
    } else used.set(row.key, count + 1);
  }
  const selectedIds = new Set(parsed.claims.map(claim => claim.factId));
  for (const row of protectedRows) {
    const contextSelected = row.ancestors.some(ancestor => ancestor.claims.some(claim => selectsAssertion(claim) && selectedIds.has(claim.factId)));
    if (contextSelected && !used.has(row.key)) issue("verdict_context_mismatch", "선택한 테스트 대상의 판정 진술이 누락되거나 변경됐습니다.", {
      factIds: row.claims.map(claim => claim.factId),
    });
  }
  return result;
}

module.exports = { validateVerdictEvidence };
