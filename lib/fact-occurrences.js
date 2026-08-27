const TRAILING_PARTICLES = /(?:들)?(?:은|는|이|가|을|를|의|만|뿐|도|과|와|으로|로|에서|에|부터|까지)+$/;

const CANDIDATE_PRIORITY = {
  system: 0,
  test_result: 1,
  counted_quantity: 2,
  hexadecimal: 3,
  percentage: 4,
  dimension: 5,
  supported_unit: 6,
  iso_date: 7,
  version: 8,
  ratio: 9,
  bare_number: 10,
};

function nounKey(noun) {
  const stripped = noun.replace(TRAILING_PARTICLES, "");
  return stripped.length >= 2 ? stripped : noun;
}

function locate(text, start, end) {
  const before = String(text).slice(0, start);
  const lines = before.split("\n");
  return { start, end, line: lines.length, column: lines.at(-1).length + 1 };
}

function addMatches(candidates, source, pattern, build) {
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    candidates.push({ ...build(match), raw: match[0], ...locate(source, start, end) });
  }
}

function testSemantic(match, shape) {
  const semantic = shape(match);
  if (semantic.fail !== undefined) semantic.total = semantic.pass + semantic.fail;
  if (semantic.total !== undefined && semantic.fail === undefined && semantic.total >= semantic.pass) {
    semantic.fail = semantic.total - semantic.pass;
  }
  return semantic;
}

function collectCandidates(source, systemFacts) {
  const candidates = [];
  const addTest = (pattern, shape) => addMatches(candidates, source, pattern, (match) => ({
    prefix: "T",
    type: "test_result",
    kind: "test_result",
    semantic: testSemantic(match, shape),
  }));

  addTest(/PASS\s*(\d+)\s*\/\s*(\d+)/gi, (match) => ({
    pass: Number(match[1]), fail: Number(match[2]),
  }));
  addTest(/(\d+)\s*\/\s*(\d+)\s*PASS/gi, (match) => ({
    pass: Number(match[1]), total: Number(match[2]),
  }));
  addTest(/(\d+)\s*건?\s*PASS[^\n\d]{0,24}(?:실패|FAIL)\s*(\d+)\s*건?/gi, (match) => ({
    pass: Number(match[1]), fail: Number(match[2]),
  }));
  addTest(/(\d+)\s*건?\s*PASS/gi, (match) => ({ pass: Number(match[1]) }));

  const countedPattern = /(?<![A-Za-z0-9_])([+-]?\d+(?:\.\d+)?)\s*(개|건|회|가지|번|차례)(?=[\s의])\s*(?:의\s*)?([가-힣]+)/g;
  for (const match of source.matchAll(countedPattern)) {
    const start = match.index;
    const counterEnd = source.indexOf(match[2], start + match[1].length) + match[2].length;
    candidates.push({
      prefix: "Q",
      type: "counted_quantity",
      kind: "counted_quantity",
      raw: source.slice(start, counterEnd),
      subject: nounKey(match[3]),
      semantic: { quantity: Number(match[1]) },
      ...locate(source, start, counterEnd),
    });
  }

  const bareCountedPattern = /(?<![A-Za-z0-9_])([+-]?\d+(?:\.\d+)?)[ \t]+([가-힣]+)(?=\s|$|[.,:;!?()[\]{}'"`])/g;
  for (const match of source.matchAll(bareCountedPattern)) {
    const start = match.index;
    const end = start + match[1].length;
    candidates.push({
      prefix: "Q",
      type: "counted_quantity",
      kind: "counted_quantity",
      raw: match[1],
      subject: nounKey(match[2]),
      semantic: { quantity: Number(match[1]) },
      ...locate(source, start, end),
    });
  }

  const addProtected = (pattern, prefix, type, kind) => addMatches(
    candidates,
    source,
    pattern,
    (match) => ({
      prefix,
      type,
      kind,
      semantic: {
        normalized: match[0].replace(/\s+/g, "").toLowerCase(),
      },
    })
  );

  addProtected(/(?<![A-Za-z0-9_])[+-]?\d+(?:\.\d+)?\s*%/g, "Q", "measured_quantity", "percentage");
  addProtected(/(?<![A-Za-z0-9_])[+-]?\d+(?:\.\d+)?\s*[x×]\s*[+-]?\d+(?:\.\d+)?\b/gi, "Q", "measured_quantity", "dimension");
  addProtected(
    /(?<![A-Za-z0-9_])[+-]?\d+(?:\.\d+)?\s*(?:ms|us|ns|s|초|분|시간|Hz|kHz|MHz|GHz|Mbps|Gbps|KB|MB|GB|B|건|개|회|가지|번|차례)(?![A-Za-z0-9_가-힣])/gi,
    "Q",
    "measured_quantity",
    "supported_unit"
  );
  addProtected(/\b\d{4}-\d{2}-\d{2}\b/g, "V", "protected_token", "iso_date");
  addProtected(/\b0x[0-9a-f]+\b/gi, "V", "protected_token", "hexadecimal");
  addProtected(/(?<![A-Za-z0-9_])(?:v|[+-])?\d+(?:\.\d+){1,3}\b/gi, "V", "protected_token", "version");
  addProtected(/(?<![A-Za-z0-9_])[+-]?\d+(?:\.\d+)?\s*\/\s*[+-]?\d+(?:\.\d+)?\b/g, "V", "protected_token", "ratio");
  addProtected(/(?<![A-Za-z0-9_])[+-]?\d+(?:\.\d+)?\b/g, "Q", "quantity", "bare_number");

  for (const fact of systemFacts) {
    if (!fact || !fact.raw) continue;
    let start = source.indexOf(fact.raw);
    while (start !== -1) {
      const end = start + fact.raw.length;
      candidates.push({
        prefix: "S",
        type: fact.type || "system",
        kind: "system",
        raw: fact.raw,
        semantic: fact.semantic || null,
        subject: fact.subject || null,
        allowedNormalizations: Array.isArray(fact.allowedNormalizations)
          ? [...fact.allowedNormalizations]
          : [],
        ...locate(source, start, end),
      });
      start = source.indexOf(fact.raw, end);
    }
  }

  return candidates;
}

function extractSchemaV2FactOccurrences(text, options = {}) {
  const source = String(text);
  const systemFacts = Array.isArray(options.systemFacts) ? options.systemFacts : [];
  const candidates = collectCandidates(source, systemFacts)
    .sort((left, right) =>
      left.start - right.start
      || right.end - left.end
      || CANDIDATE_PRIORITY[left.kind] - CANDIDATE_PRIORITY[right.kind]
      || left.raw.localeCompare(right.raw)
    );

  const selected = [];
  let occupiedUntil = -1;
  for (const candidate of candidates) {
    if (candidate.start < occupiedUntil) continue;
    selected.push(candidate);
    occupiedUntil = candidate.end;
  }
  return selected;
}

module.exports = { extractSchemaV2FactOccurrences };
