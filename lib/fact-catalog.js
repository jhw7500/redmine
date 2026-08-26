const { hashObject } = require("./report-artifact");
const {
  extractTestFactOccurrences,
  extractProtectedTokenOccurrences,
  extractCountedQuantityOccurrences,
} = require("./fact-validator");

const TYPE_ORDER = { T: 0, Q: 1, V: 2 };

function lineExcerpt(text, start) {
  const source = String(text);
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = source.indexOf("\n", start);
  return source
    .slice(lineStart, lineEnd === -1 ? source.length : lineEnd)
    .trim()
    .replace(/^(?:[-*+]\s+)/, "");
}

function subjectBefore(text, start) {
  const source = String(text);
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  return source
    .slice(lineStart, start)
    .replace(/^\s*(?:[-*+]\s+)?/, "")
    .replace(/[,:;]\s*$/, "")
    .trim() || null;
}

function sourceLocation(occurrence) {
  const { start, end, line, column } = occurrence;
  return { start, end, line, column };
}

function allowedNormalizations(prefix, raw) {
  return prefix === "T" && /\d\s*\/\s*\d/.test(raw)
    ? ["whitespace_around_slash"]
    : [];
}

function mergeAndNumberOccurrences(rawContent, systemFacts = []) {
  const testOccurrences = extractTestFactOccurrences(rawContent);
  const testSpans = testOccurrences.map(({ start, end }) => ({ start, end }));
  const overlaps = (spans, start, end) => spans.some((span) => start < span.end && end > span.start);
  const quantityOccurrences = extractCountedQuantityOccurrences(rawContent)
    .filter((occurrence) => !overlaps(testSpans, occurrence.start, occurrence.end));
  const quantitySpans = quantityOccurrences.map(({ start, end }) => ({ start, end }));
  const protectedOccurrences = extractProtectedTokenOccurrences(rawContent)
    .filter((occurrence) => !overlaps(testSpans, occurrence.start, occurrence.end))
    .filter((occurrence) => !overlaps(quantitySpans, occurrence.start, occurrence.end));

  const sourceFacts = [
    ...testOccurrences.map((occurrence) => ({
      prefix: "T",
      type: "test_result",
      raw: occurrence.raw,
      semantic: {
        pass: occurrence.pass,
        ...(occurrence.total === undefined ? {} : { total: occurrence.total }),
        ...(occurrence.fail === undefined ? {} : { fail: occurrence.fail }),
      },
      subject: subjectBefore(rawContent, occurrence.start),
      sourceLocation: sourceLocation(occurrence),
      sourceExcerpt: lineExcerpt(rawContent, occurrence.start),
    })),
    ...quantityOccurrences.map((occurrence) => ({
      prefix: "Q",
      type: "counted_quantity",
      raw: occurrence.raw,
      semantic: { quantity: Number(occurrence.token.replace(/(?:개|건|회|가지|번|차례)$/, "")) },
      subject: occurrence.subject,
      sourceLocation: sourceLocation(occurrence),
      sourceExcerpt: lineExcerpt(rawContent, occurrence.start),
    })),
    ...protectedOccurrences.map((occurrence) => ({
      prefix: "V",
      type: "protected_token",
      raw: occurrence.raw,
      semantic: { normalized: occurrence.normalized },
      subject: subjectBefore(rawContent, occurrence.start),
      sourceLocation: sourceLocation(occurrence),
      sourceExcerpt: lineExcerpt(rawContent, occurrence.start),
    })),
  ].map((fact) => ({ ...fact, allowedNormalizations: allowedNormalizations(fact.prefix, fact.raw) }));

  sourceFacts.sort((left, right) =>
    left.sourceLocation.start - right.sourceLocation.start || TYPE_ORDER[left.prefix] - TYPE_ORDER[right.prefix]
  );

  const systemEntries = systemFacts.map((fact) => ({
    prefix: "S",
    type: fact.type || "system",
    raw: fact.raw,
    semantic: fact.semantic || null,
    subject: fact.subject || null,
    sourceLocation: null,
    sourceExcerpt: null,
    allowedNormalizations: Array.isArray(fact.allowedNormalizations)
      ? [...fact.allowedNormalizations]
      : [],
  }));
  const counters = { T: 0, Q: 0, V: 0, S: 0 };
  return [...sourceFacts, ...systemEntries].map(({ prefix, ...fact }) => ({
    id: `${prefix}${String(++counters[prefix]).padStart(4, "0")}`,
    ...fact,
  }));
}

function finalizeCatalog(facts) {
  const payload = { schemaVersion: 1, facts };
  return { ...payload, catalogHash: hashObject(payload) };
}

function buildFactCatalog(rawContent, systemFacts = []) {
  return finalizeCatalog(mergeAndNumberOccurrences(rawContent, systemFacts));
}

function formatFactCatalogForPrompt(catalog) {
  return catalog.facts.map((fact) => {
    const context = fact.sourceExcerpt || fact.subject;
    return `- [[fact:${fact.id}|${fact.raw}]]${context ? ` — ${context}` : ""}`;
  }).join("\n");
}

module.exports = {
  buildFactCatalog,
  formatFactCatalogForPrompt,
};
