const { hashObject } = require("./report-artifact");
const { normalizeProjectName } = require("./merger");
const { referenceLines } = require("./report-references");

function invalid(message) {
  throw Object.assign(new Error(message), { code: "SOURCE_RECORDS_INVALID" });
}

function sourceBlock(autoContent, rawLines, templateKey, emittedBlock) {
  if (typeof templateKey !== "string" || typeof autoContent?.[templateKey] !== "string") {
    invalid("Summary template block is missing");
  }
  const block = autoContent[templateKey].split("\n").map(line => line.trimEnd());
  if (emittedBlock !== undefined) {
    if (!emittedBlock || !Number.isSafeInteger(emittedBlock.offset)
      || !Number.isSafeInteger(emittedBlock.length) || emittedBlock.offset < 0
      || emittedBlock.length !== block.length
      || block.some((part, index) => rawLines[emittedBlock.offset + index] !== part)) {
      invalid("Summary source block has an invalid emitted location");
    }
    return { offset: emittedBlock.offset, length: emittedBlock.length };
  }
  const matches = rawLines.flatMap((line, index) => line === block[0]
    && block.every((part, n) => rawLines[index + n] === part) ? [index] : []);
  if (matches.length !== 1) invalid("Summary source block has no unique raw location");
  return { offset: matches[0], length: block.length };
}

// New snapshots bind offsets at emission; legacy callers without a block table use unique text lookup.
function bindSummaryProvenance(autoContent, rawContent, spans, repos = {}, emittedBlocks) {
  if (!spans.length) return undefined;
  const hasEmittedBlocks = emittedBlocks !== undefined;
  if (hasEmittedBlocks && (!emittedBlocks || typeof emittedBlocks !== "object"
    || Array.isArray(emittedBlocks))) invalid("Invalid emitted summary blocks");
  const rawLines = rawContent.split("\n").map(line => line.trimEnd());
  const offsets = new Map();
  const blocks = {};
  for (const { templateKey } of spans) {
    if (offsets.has(templateKey)) continue;
    if (hasEmittedBlocks && !Object.hasOwn(emittedBlocks, templateKey)) {
      invalid("Summary source block has no emitted location");
    }
    const emittedBlock = hasEmittedBlocks ? emittedBlocks[templateKey] : undefined;
    const block = sourceBlock(autoContent, rawLines, templateKey, emittedBlock);
    offsets.set(templateKey, block.offset);
    blocks[templateKey] = block;
  }
  const projectNames = Object.fromEntries(Object.entries(repos)
    .filter(([, repo]) => repo.displayName).map(([name, repo]) => [name, { displayName: repo.displayName }]));
  return { schemaVersion: 1, projectNames, blocks, spans: spans.map(span => ({
    ...span,
    parentLine: span.parentLine + offsets.get(span.templateKey),
    startLine: span.startLine + offsets.get(span.templateKey),
    endLine: span.endLine + offsets.get(span.templateKey),
  })) };
}

function summarySourceLines(snapshot) {
  const result = new Map();
  if (!Object.hasOwn(snapshot, "sourceDetails")) return result;
  const details = snapshot.sourceDetails;
  if (!details || details.schemaVersion !== 1 || !Array.isArray(details.spans)) {
    invalid("Unsupported summary source provenance");
  }
  const hasBlocks = Object.hasOwn(details, "blocks");
  if (hasBlocks && (!details.blocks || typeof details.blocks !== "object"
    || Array.isArray(details.blocks))) invalid("Invalid summary source blocks");
  const lines = String(snapshot.rawContent).split("\n");
  const rawLines = lines.map(line => line.trimEnd());
  const blocks = new Map();
  for (const span of details.spans) {
    if (!span || !["notion_summary", "report_reference"].includes(span.kind)
      || ![span.sourceIndex, span.itemLineIndex, span.parentLine, span.startLine, span.endLine].every(Number.isSafeInteger)
      || span.sourceIndex < 0 || span.itemLineIndex < 0 || span.parentLine < 1 || span.startLine <= span.parentLine
      || span.endLine < span.startLine || span.endLine > lines.length) {
      invalid("Invalid summary source span");
    }
    if (!blocks.has(span.templateKey)) {
      if (hasBlocks && !Object.hasOwn(details.blocks, span.templateKey)) {
        invalid("Summary source block has no emitted location");
      }
      const emittedBlock = hasBlocks ? details.blocks[span.templateKey] : undefined;
      blocks.set(span.templateKey,
        sourceBlock(snapshot.autoContent, rawLines, span.templateKey, emittedBlock));
    }
    const block = blocks.get(span.templateKey);
    if (span.parentLine <= block.offset || span.endLine > block.offset + block.length) {
      invalid("Summary span belongs to a different template block");
    }
    const gitBlock = snapshot.sources?.git?.data?.[span.templateKey];
    if (typeof gitBlock === "string" && snapshot.autoContent[span.templateKey].startsWith(gitBlock + "\n")
      && span.parentLine <= block.offset + gitBlock.split("\n").length) {
      invalid("Existing Git detail cannot become an optional summary");
    }
    const source = snapshot.sources?.notion?.data?.[span.sourceIndex];
    const parent = lines[span.parentLine - 1];
    const isReference = span.kind === "report_reference";
    if (!source || hashObject(source) !== span.sourceHash
      || (!isReference && (typeof source.summary !== "string" || !source.summary.trim()))
      || (isReference && (!Array.isArray(source.reportReferences) || !source.reportReferences.length))
      || source.reportExcluded || parent !== span.parentText
      || !/^ *- \[Notion\] .+/.test(parent)) {
      invalid("Summary source or parent binding changed");
    }
    const sourceLines = Array.isArray(source.items) && source.items.length
      ? source.items : [source.title || source.summary];
    const original = sourceLines[span.itemLineIndex];
    if (typeof original !== "string") invalid("Summary source parent is missing");
    const parentIndent = parent.match(/^ */)[0];
    const expectedParent = `${parentIndent}- [Notion] ${normalizeProjectName(original, details.projectNames)}`.split("\n");
    if (span.parentLine + expectedParent.length > span.startLine
      || expectedParent.some((line, index) => line !== lines[span.parentLine - 1 + index])) {
      invalid("Summary parent does not match the original source item");
    }
    const indent = parent.match(/^ */)[0] + "  ";
    let expected;
    try {
      expected = isReference ? referenceLines(source, indent)
        : source.summary.split(/\r\n?|\n/).map(part => `${indent}↳ 출처 요약: ${part}`.trimEnd());
    } catch { invalid("Invalid source reference metadata"); }
    if (span.endLine - span.startLine + 1 !== expected.length) invalid("Incomplete summary source span");
    for (let n = 0; n < expected.length; n++) {
      const line = span.startLine + n;
      if (result.has(line) || lines[line - 1].trimEnd() !== expected[n]) {
        invalid("Summary source text or span overlap changed");
      }
      result.set(line, isReference ? { ...span, references: source.reportReferences.slice(n * 2, n * 2 + 2) } : span);
    }
  }
  return result;
}

module.exports = { bindSummaryProvenance, summarySourceLines };
