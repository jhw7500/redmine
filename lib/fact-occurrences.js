const CANDIDATE_PRIORITY = {
  system: 0,
  test_result: 1,
  counted_quantity: 2,
  hexadecimal: 3,
  percentage: 4,
  dimension: 5,
  scientific_notation: 6,
  supported_unit: 7,
  attached_unit: 8,
  iso_date: 9,
  version: 10,
  alphanumeric_identifier: 11,
  ratio: 12,
  bare_number: 13,
};

// SI base/derived units and common prefixed forms are generated as a family so a
// missing one-off allowlist entry (for example mAh, µF, px) cannot expose the suffix.
// 2022 SI prefix set: quecto..quetta, with ASCII `u` accepted for micro.
const SI_PREFIX_SOURCE = "(?:da|[qryzafpnumcdhkMGTPEZYRQ]|µ|μ)?";
const SI_UNIT_BODY_SOURCE = "(?:byte|bit|mol|kat|rad|sr|Bq|Gy|Sv|Wb|Ah|Wh|Hz|Pa|eV|Da|ohm|ppi|px|pt|lm|lx|cd|[AVWΩFHJNCSTKmsgLB])";
// `as`(atto-second), `am`(atto-metre)는 공백 뒤에서 영어 접속사/시간표기와 충돌한다.
// 붙여 쓴 `10as`/`10am`은 generic attached-unit grammar가 계속 보호한다.
const SI_PREFIXED_UNIT_SOURCE = `(?!a(?:m|s)(?![A-Za-z0-9_⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻^]))${SI_PREFIX_SOURCE}${SI_UNIT_BODY_SOURCE}`;
const LEGACY_SUPPORTED_UNITS = [
  "Tbps", "Gbps", "Mbps", "Kbps", "bps", "fps", "pps", "rpm", "dpi",
  "bytes", "byte", "bits", "bit", "GiB", "MiB", "KiB", "TB", "GB", "MB", "KB", "B",
  "GHz", "MHz", "kHz", "Hz", "ns", "us", "µs", "μs", "ms", "sec", "min", "hr", "s", "h",
  "kWh", "mWh", "Wh", "mV", "kV", "V", "µA", "μA", "uA", "mA", "kA", "A",
  "mW", "kW", "MW", "W", "MΩ", "kΩ", "Ω", "ohm",
  "MPa", "kPa", "Pa", "bar", "mbar", "psi", "psia", "psig", "atm", "Torr", "mmHg", "inHg",
  "dBm", "dB", "mm", "cm", "km", "mg", "kg", "lux", "lm", "m", "g", "N",
  "°C", "°F", "℃", "℉", "K", "초", "분", "시간", "건", "개", "회", "가지", "번", "차례",
];
function asciiCaseInsensitiveLiteralSource(value) {
  return Array.from(value, (character) => {
    if (/[A-Za-z]/.test(character)) {
      return `[${character.toLowerCase()}${character.toUpperCase()}]`;
    }
    return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
}
// The historical allowlist accepted ASCII case variants (FPS, Mhz, OHM). Keep
// that compatibility local instead of making the case-sensitive SI grammar global-i.
const LEGACY_SUPPORTED_UNIT_SOURCE = LEGACY_SUPPORTED_UNITS
  .map(asciiCaseInsensitiveLiteralSource)
  .join("|");
const SUPPORTED_UNIT_ATOM_SOURCE = `${SI_PREFIXED_UNIT_SOURCE}|${LEGACY_SUPPORTED_UNIT_SOURCE}`;
const HORIZONTAL_SPACE_SOURCE = "[\\t\\p{Zs}]";
const UNICODE_WORD_CHARACTER_SOURCE = "[\\p{L}\\p{M}\\p{N}_]";
const ASCII_IDENTIFIER_CHARACTER_SOURCE = "[A-Za-z0-9_-]";
const UNIT_EXPONENT_SOURCE = "(?:\\^[+-]?\\d+|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+)?";
const SUPPORTED_UNIT_TERM_SOURCE = `(?:${SUPPORTED_UNIT_ATOM_SOURCE})${UNIT_EXPONENT_SOURCE}`;
const SUPPORTED_UNIT_SOURCE = `${SUPPORTED_UNIT_TERM_SOURCE}(?:${HORIZONTAL_SPACE_SOURCE}*(?:\\/|[·⋅×])${HORIZONTAL_SPACE_SOURCE}*${SUPPORTED_UNIT_TERM_SOURCE})*`;

const SCIENTIFIC_WITH_UNIT_PATTERN = new RegExp(
  `(?<!${UNICODE_WORD_CHARACTER_SOURCE})[+-]?\\d+(?:\\.\\d+)?[eE][+-]?\\d+(?:${HORIZONTAL_SPACE_SOURCE}*(?:${SUPPORTED_UNIT_SOURCE})|[A-Za-z]+)(?!${UNICODE_WORD_CHARACTER_SOURCE})`,
  "gu"
);
const SUPPORTED_UNIT_PATTERN = new RegExp(
  `(?<!${UNICODE_WORD_CHARACTER_SOURCE})[+-]?\\d+(?:\\.\\d+)?${HORIZONTAL_SPACE_SOURCE}*(?:${SUPPORTED_UNIT_SOURCE})(?!${UNICODE_WORD_CHARACTER_SOURCE})`,
  "gu"
);
const MARKER_SUFFIX_UNIT_PATTERN = new RegExp(
  `[+-]?\\d+(?:\\.\\d+)?${HORIZONTAL_SPACE_SOURCE}*(?:${SUPPORTED_UNIT_SOURCE})(?!${UNICODE_WORD_CHARACTER_SOURCE})`,
  "gu"
);
const ATTACHED_UNIT_PATTERN = new RegExp(
  `(?<!${UNICODE_WORD_CHARACTER_SOURCE})[+-]?\\d+(?:\\.\\d+)?(?:°[A-Za-z]+|[℃℉]|-[A-Za-z]+|[A-Za-z]+)(?:\\d+(?:\\.\\d+)?(?:°[A-Za-z]+|[℃℉]|-[A-Za-z]+|[A-Za-z]+))*(?!${UNICODE_WORD_CHARACTER_SOURCE})`,
  "giu"
);
const ALPHANUMERIC_IDENTIFIER_PATTERN = new RegExp(
  `(?<!${ASCII_IDENTIFIER_CHARACTER_SOURCE})(?=[A-Za-z0-9_-]*\\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z][A-Za-z0-9_-]*(?!${ASCII_IDENTIFIER_CHARACTER_SOURCE})`,
  "gu"
);

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
  if (match.slice(1).some((value) => value !== undefined && !Number.isSafeInteger(Number(value)))) {
    semantic.unsafeCount = true;
  }
  if (semantic.fail !== undefined) semantic.total = semantic.pass + semantic.fail;
  if (semantic.total !== undefined && semantic.fail === undefined && semantic.total >= semantic.pass) {
    semantic.fail = semantic.total - semantic.pass;
  }
  return semantic;
}

function fullyContained(spans, start, end) {
  return spans.some((span) => span.start <= start && span.end >= end);
}

function partiallyIntersects(spans, start, end) {
  return spans.some((span) => start < span.end && end > span.start)
    && !fullyContained(spans, start, end);
}

function collectCandidates(source, systemFacts) {
  const candidates = [];
  const addTest = (pattern, shape) => addMatches(candidates, source, pattern, (match) => ({
    prefix: "T",
    type: "test_result",
    kind: "test_result",
    semantic: testSemantic(match, shape),
  }));

  // Schema-v2 fact separators are horizontal: \s would join separate source lines.
  addTest(/PASS[ \t]*(\d+)[ \t]*\/[ \t]*(\d+)/gi, (match) => ({
    pass: Number(match[1]), fail: Number(match[2]),
  }));
  addTest(/(\d+)[ \t]*\/[ \t]*(\d+)[ \t]*PASS/gi, (match) => ({
    pass: Number(match[1]), total: Number(match[2]),
  }));
  addTest(/(\d+)[ \t]*건?[ \t]*PASS[^\r\n\d]{0,24}(?:실패|FAIL)[ \t]*(\d+)[ \t]*건?/gi, (match) => ({
    pass: Number(match[1]), fail: Number(match[2]),
  }));
  addTest(/(\d+)[ \t]*건?[ \t]*PASS/gi, (match) => ({ pass: Number(match[1]) }));

  const countedPattern = /(?<![A-Za-z0-9_])([+-]?\d+(?:\.\d+)?)[ \t]*(개|건|회|가지|번|차례)(?=[ \t의])[ \t]*(?:의[ \t]*)?([가-힣]+)/g;
  for (const match of source.matchAll(countedPattern)) {
    const start = match.index;
    const counterEnd = source.indexOf(match[2], start + match[1].length) + match[2].length;
    candidates.push({
      prefix: "Q",
      type: "counted_quantity",
      kind: "counted_quantity",
      raw: source.slice(start, counterEnd),
      subject: match[3],
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
      subject: match[2],
      semantic: { quantity: Number(match[1]) },
      ...locate(source, start, end),
    });
  }

  // `2채널`처럼 숫자에 바로 붙은 한글 대상도 숫자 fact의 일부로 묶는다.
  // marker surface는 기존 계약대로 숫자만 유지하되, 앞 문맥(subject)과 붙임 대상(target)을
  // 각각 검증해 `gstApp 2채널` → `WLAN 2포트` 양쪽 변조를 모두 차단한다.
  const attachedKoreanTargetPattern = /(?<![A-Za-z0-9_])([+-]?\d+(?:\.\d+)?)([가-힣]+)/g;
  for (const match of source.matchAll(attachedKoreanTargetPattern)) {
    const start = match.index;
    const end = start + match[1].length;
    candidates.push({
      prefix: "Q",
      type: "counted_quantity",
      kind: "counted_quantity",
      raw: match[1],
      target: match[2],
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
        normalized: match[0].replace(/[\t\p{Zs}]+/gu, "").toLowerCase(),
      },
    })
  );

  addProtected(/(?<![A-Za-z0-9_])[+-]?\d+(?:\.\d+)?[ \t]*%/g, "Q", "measured_quantity", "percentage");
  addProtected(/(?<![A-Za-z0-9_])[+-]?\d+(?:\.\d+)?[ \t]*[x×][ \t]*[+-]?\d+(?:\.\d+)?\b/gi, "Q", "measured_quantity", "dimension");
  addProtected(
    SCIENTIFIC_WITH_UNIT_PATTERN,
    "Q",
    "measured_quantity",
    "scientific_notation"
  );
  addProtected(
    /(?<![A-Za-z0-9_])[+-]?\d+(?:\.\d+)?[eE][+-]?\d+(?![A-Za-z0-9_])/g,
    "Q",
    "measured_quantity",
    "scientific_notation"
  );
  addProtected(
    SUPPORTED_UNIT_PATTERN,
    "Q",
    "measured_quantity",
    "supported_unit"
  );
  addProtected(
    ATTACHED_UNIT_PATTERN,
    "Q",
    "measured_quantity",
    "attached_unit"
  );
  addProtected(/\b\d{4}-\d{2}-\d{2}\b/g, "V", "protected_token", "iso_date");
  addProtected(/(?<![A-Za-z0-9_])[+-]?0x[0-9a-f]+\b/gi, "V", "protected_token", "hexadecimal");
  addProtected(/(?<![A-Za-z0-9_])v\d+\b/gi, "V", "protected_token", "version");
  addProtected(/(?<![A-Za-z0-9_])(?:v|[+-])?\d+(?:\.\d+){1,3}\b/gi, "V", "protected_token", "version");
  addProtected(ALPHANUMERIC_IDENTIFIER_PATTERN, "V", "protected_token", "alphanumeric_identifier");
  addProtected(/(?<![A-Za-z0-9_])[+-]?\d+(?:\.\d+)?[ \t]*\/[ \t]*[+-]?\d+(?:\.\d+)?\b/g, "V", "protected_token", "ratio");
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

function collectMarkerSuffixCandidates(source, markedSpans) {
  const candidates = [];
  const addProtected = (pattern, kind) => addMatches(candidates, source, pattern, (match) => ({
    prefix: "Q",
    type: "measured_quantity",
    kind,
    semantic: {
      normalized: match[0].replace(/[\t\p{Zs}]+/gu, "").toLowerCase(),
    },
  }));

  addProtected(/[+-]?\d+(?:\.\d+)?[ \t]*%/g, "percentage");
  addProtected(
    MARKER_SUFFIX_UNIT_PATTERN,
    "supported_unit"
  );
  return candidates.filter((candidate) =>
    partiallyIntersects(markedSpans, candidate.start, candidate.end)
  );
}

function extractSchemaV2FactOccurrences(text, options = {}) {
  const source = String(text);
  const systemFacts = Array.isArray(options.systemFacts) ? options.systemFacts : [];
  const markedSpans = Array.isArray(options.markedSpans) ? options.markedSpans : [];
  const candidates = [
    ...collectCandidates(source, systemFacts),
    ...collectMarkerSuffixCandidates(source, markedSpans),
  ]
    .filter((candidate) => !fullyContained(markedSpans, candidate.start, candidate.end))
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
