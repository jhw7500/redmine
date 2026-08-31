const { parseAnnotatedDraft } = require("./annotated-draft");
const { extractSchemaV2FactOccurrences } = require("./fact-occurrences");
const { stripAstralChars } = require("./text-normalization");

function annotateFactReferences(rawContent, catalog) {
  const source = stripAstralChars(String(rawContent));
  let annotated = source;
  const sourceFacts = catalog.facts
    .filter((fact) => fact.sourceLocation)
    .sort((left, right) => left.sourceLocation.start - right.sourceLocation.start);

  let previousEnd = -1;
  for (const fact of sourceFacts) {
    const { start, end } = fact.sourceLocation;
    if (start < previousEnd) {
      const error = new Error(`fact ${fact.id} overlaps another source span`);
      error.code = "FACT_SOURCE_OVERLAP";
      throw error;
    }
    if (source.slice(start, end) !== fact.raw) {
      const error = new Error(`fact ${fact.id} does not match its source span`);
      error.code = "FACT_SOURCE_MISMATCH";
      throw error;
    }
    previousEnd = end;
  }

  for (const fact of [...sourceFacts].reverse()) {
    const { start, end } = fact.sourceLocation;
    annotated = `${annotated.slice(0, start)}[[fact:${fact.id}]]${annotated.slice(end)}`;
  }
  return annotated;
}

function expandFactReferences(content, catalog) {
  const byId = new Map(catalog.facts.map((fact) => [fact.id, fact]));
  return String(content).replace(/\[\[fact:([TQVS]\d{4})\]\]/g, (reference, factId) => {
    const fact = byId.get(factId);
    return fact ? `[[fact:${factId}|${fact.raw}]]` : reference;
  });
}

function lineAt(text, start) {
  const source = String(text);
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = source.indexOf("\n", start);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
}

function identifierContextTokens(text, identifier) {
  const ignored = String(identifier).toLowerCase();
  return new Set(
    (String(text).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])
      .filter((token) => token !== ignored && Array.from(token).length >= 2)
  );
}

function selectIdentifierFact(candidates, outputLine, identifier) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const outputTokens = identifierContextTokens(outputLine, identifier);
  const ranked = candidates
    .map((fact) => ({
      fact,
      score: Array.from(identifierContextTokens(fact.sourceExcerpt, identifier))
        .filter((token) => outputTokens.has(token)).length,
    }))
    .sort((left, right) => right.score - left.score);
  if (ranked[0].score < 2 || ranked[0].score === ranked[1].score) return null;
  return ranked[0].fact;
}

function quantityContextTokens(text) {
  return new Set(
    (String(text).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])
      .filter((token) => Array.from(token).length >= 2 && !/\p{N}/u.test(token))
  );
}

function quantityLexeme(raw) {
  return String(raw).match(/^[+-]?\d+(?:\.\d+)?/)?.[0] || null;
}

function selectCountedQuantityFact(candidates, outputLine) {
  if (candidates.length === 0) return null;

  const outputTokens = quantityContextTokens(outputLine);
  const ranked = candidates
    .map((fact) => ({
      fact,
      score: Array.from(quantityContextTokens(fact.sourceExcerpt))
        .filter((token) => outputTokens.has(token)).length,
    }))
    .sort((left, right) => right.score - left.score);
  if (ranked[0].score < 2) return null;
  if (ranked[1] && ranked[0].score === ranked[1].score) return null;
  return ranked[0].fact;
}

function countedQuantityOccurrenceEnd(source, occurrence) {
  if (!occurrence.target) return occurrence.end;
  return source.startsWith(occurrence.target, occurrence.end)
    ? occurrence.end + occurrence.target.length
    : occurrence.end;
}

function restoreUnmarkedCountedQuantityReferences(content, catalog) {
  const source = String(content);
  const parsed = parseAnnotatedDraft(source);
  const markedSpans = [
    ...parsed.claims.map((claim) => ({
      start: claim.annotatedStart,
      end: claim.annotatedEnd,
    })),
    ...parsed.errors.map((error) => ({ start: error.start, end: error.end })),
  ];
  const factsByQuantity = new Map();
  for (const fact of catalog.facts) {
    if (fact.type !== "counted_quantity" || !fact.sourceLocation) continue;
    const quantity = quantityLexeme(fact.raw);
    if (!quantity) continue;
    const candidates = factsByQuantity.get(quantity) || [];
    candidates.push(fact);
    factsByQuantity.set(quantity, candidates);
  }

  const recoverable = extractSchemaV2FactOccurrences(source, { markedSpans })
    .filter((occurrence) => occurrence.kind === "counted_quantity")
    .map((occurrence) => {
      const quantity = quantityLexeme(occurrence.raw);
      return {
        occurrence,
        fact: selectCountedQuantityFact(
          factsByQuantity.get(quantity) || [],
          lineAt(source, occurrence.start)
        ),
      };
    })
    .filter(({ fact }) => fact);

  let restored = source;
  for (const { occurrence, fact } of recoverable.reverse()) {
    const marker = `[[fact:${fact.id}|${fact.raw}]]${fact.target || ""}`;
    const end = countedQuantityOccurrenceEnd(source, occurrence);
    restored = `${restored.slice(0, occurrence.start)}${marker}${restored.slice(end)}`;
  }
  return restored;
}

function restoreUnmarkedIdentifierReferences(content, catalog) {
  const source = String(content);
  const parsed = parseAnnotatedDraft(source);
  const markedSpans = [
    ...parsed.claims.map((claim) => ({
      start: claim.annotatedStart,
      end: claim.annotatedEnd,
    })),
    ...parsed.errors.map((error) => ({ start: error.start, end: error.end })),
  ];
  const factsBySurface = new Map();
  for (const fact of catalog.facts) {
    if (fact.type !== "protected_token" || !fact.sourceLocation) continue;
    const candidates = factsBySurface.get(fact.raw) || [];
    candidates.push(fact);
    factsBySurface.set(fact.raw, candidates);
  }

  const recoverable = extractSchemaV2FactOccurrences(source, { markedSpans })
    .filter((occurrence) =>
      occurrence.kind === "alphanumeric_identifier"
      && !/^v\d/i.test(occurrence.raw)
    )
    .map((occurrence) => ({
      occurrence,
      fact: selectIdentifierFact(
        factsBySurface.get(occurrence.raw) || [],
        lineAt(source, occurrence.start),
        occurrence.raw
      ),
    }))
    .filter(({ fact }) => fact);

  let restored = source;
  for (const { occurrence, fact } of recoverable.reverse()) {
    const marker = `[[fact:${fact.id}|${fact.raw}]]`;
    restored = `${restored.slice(0, occurrence.start)}${marker}${restored.slice(occurrence.end)}`;
  }
  return restored;
}

function formatSystemFactReferences(catalog) {
  return catalog.facts
    .filter((fact) => !fact.sourceLocation)
    .map((fact) => `- ${fact.subject || fact.type}: [[fact:${fact.id}]]`)
    .join("\n");
}

module.exports = {
  annotateFactReferences,
  expandFactReferences,
  formatSystemFactReferences,
  restoreUnmarkedCountedQuantityReferences,
  restoreUnmarkedIdentifierReferences,
};
