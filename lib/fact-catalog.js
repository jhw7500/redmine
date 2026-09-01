const { hashObject } = require("./report-artifact");
const { extractSchemaV2FactOccurrences } = require("./fact-occurrences");
const { sourceSectionPathAt } = require("./source-coverage");
const { stripAstralChars } = require("./text-normalization");

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
  return ["T", "V"].includes(prefix) && /\d[ \t]*\/[ \t]*\d/.test(raw)
    ? ["whitespace_around_slash"]
    : [];
}

function mergeAndNumberOccurrences(rawContent, systemFacts = [], options = {}) {
  const sourceFacts = extractSchemaV2FactOccurrences(rawContent).map((occurrence) => ({
    prefix: occurrence.prefix,
    type: occurrence.type,
    raw: occurrence.raw,
    semantic: occurrence.semantic,
    subject: occurrence.subject === undefined
      ? subjectBefore(rawContent, occurrence.start)
      : occurrence.subject,
    ...(occurrence.target === undefined ? {} : { target: occurrence.target }),
    sourceLocation: sourceLocation(occurrence),
    sourceExcerpt: lineExcerpt(rawContent, occurrence.start),
    allowedNormalizations: occurrence.allowedNormalizations
      || allowedNormalizations(occurrence.prefix, occurrence.raw),
    ...(options.knownPaths === undefined ? {} : {
      sourceSectionPath: sourceSectionPathAt(
        rawContent,
        occurrence.start,
        options.knownPaths
      ),
    }),
  }));

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

function buildFactCatalog(rawContent, systemFacts = [], options = {}) {
  const normalizedRawContent = stripAstralChars(String(rawContent));
  const normalizedSystemFacts = systemFacts.map((fact) => ({
    ...fact,
    raw: stripAstralChars(fact.raw),
    subject: stripAstralChars(fact.subject),
  }));
  return finalizeCatalog(
    mergeAndNumberOccurrences(normalizedRawContent, normalizedSystemFacts, options)
  );
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
