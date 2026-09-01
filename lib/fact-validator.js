const { sha256 } = require("./report-artifact");
const { verifyOpenIssueClaims } = require("./open-issue-verifier");
const { parseAnnotatedDraft } = require("./annotated-draft");
const { extractSchemaV2FactOccurrences } = require("./fact-occurrences");
const { splitOpenStatusClauses } = require("./open-status-clauses");
const { sourceSectionPathAt } = require("./source-coverage");
const { stripAstralChars } = require("./text-normalization");

const OPEN_STATUS_PATTERN = /(미해결|미완료|미완|보류|TODO|FIXME)/i;
const AS_OF_PATTERN = /\(\d{4}-\d{2}-\d{2}\s*기준\s*(?:미해결|미완료|미완|보류)\)/i;

function clauseHasUncoveredOpenStatus(clause) {
  const openStatuses = Array.from(clause.matchAll(new RegExp(OPEN_STATUS_PATTERN.source, "gi")));
  const asOfStatuses = Array.from(clause.matchAll(new RegExp(AS_OF_PATTERN.source, "gi")))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));

  return openStatuses.some((openStatus) => {
    const start = openStatus.index;
    const end = start + openStatus[0].length;
    const insideAsOf = asOfStatuses.some((asOf) => asOf.start <= start && asOf.end >= end);
    const followedByAsOf = asOfStatuses.some((asOf) => asOf.start >= end);
    return !insideAsOf && !followedByAsOf;
  });
}

function addIssue(issues, severity, code, message, detail = {}) {
  issues.push({ severity, code, message, ...detail });
}

function occupied(overlaps, start, end) {
  return overlaps.some((span) => start < span.end && end > span.start);
}

function fullyContained(overlaps, start, end) {
  return overlaps.some((span) => span.start <= start && span.end >= end);
}

function locate(text, start, end) {
  const before = String(text).slice(0, start);
  const lines = before.split("\n");
  return { start, end, line: lines.length, column: lines.at(-1).length + 1 };
}

function parsedTestCounts(values) {
  const fact = Object.fromEntries(
    Object.entries(values).map(([key, raw]) => [key, Number(raw)])
  );
  if (Object.values(values).some((raw) => !Number.isSafeInteger(Number(raw)))) {
    fact.unsafeCount = true;
  }
  return fact;
}

function extractTestFactOccurrences(text) {
  const source = String(text);
  const facts = [];
  const spans = [];
  const patterns = [
    {
      re: /PASS\s*(\d+)\s*\/\s*(\d+)/gi,
      build: (match) => parsedTestCounts({ pass: match[1], fail: match[2] }),
    },
    {
      re: /(\d+)\s*\/\s*(\d+)\s*PASS/gi,
      build: (match) => parsedTestCounts({ pass: match[1], total: match[2] }),
    },
    {
      re: /(\d+)\s*건?\s*PASS[^\n\d]{0,24}(?:실패|FAIL)\s*(\d+)\s*건?/gi,
      build: (match) => parsedTestCounts({ pass: match[1], fail: match[2] }),
    },
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern.re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupied(spans, start, end)) continue;
      const fact = pattern.build(match);
      if (fact.fail !== undefined) fact.total = fact.pass + fact.fail;
      if (fact.total !== undefined && fact.fail === undefined && fact.total >= fact.pass) {
        fact.fail = fact.total - fact.pass;
      }
      facts.push({ ...fact, raw: match[0], ...locate(source, start, end) });
      spans.push({ start, end });
    }
  }

  const standalone = /(\d+)\s*건?\s*PASS/gi;
  for (const match of source.matchAll(standalone)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!occupied(spans, start, end)) {
      facts.push({
        ...parsedTestCounts({ pass: match[1] }),
        raw: match[0],
        ...locate(source, start, end),
      });
      spans.push({ start, end });
    }
  }
  return facts;
}

function extractTestFacts(text) {
  return extractTestFactOccurrences(text).map(({ start, end, line, column, ...fact }) => fact);
}

function testFactSupported(outputFact, sourceFacts) {
  return sourceFacts.some((source) => {
    if (source.pass !== outputFact.pass) return false;
    if (outputFact.total !== undefined && source.total !== outputFact.total) return false;
    if (outputFact.fail !== undefined && source.fail !== outputFact.fail) return false;
    return true;
  });
}

function extractProtectedTokenOccurrences(text) {
  const source = String(text);
  const testSpans = extractTestFactOccurrences(source);
  const tokens = [];
  const patterns = [
    /\b0x[0-9a-f]+\b/gi,
    /\bv?\d+(?:\.\d+){1,3}\b/gi,
    /\b\d+(?:\.\d+)?\s*%/g,
    /\b\d+\s*[x×]\s*\d+\b/gi,
    /\b\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\b/g,
    /\b\d+(?:\.\d+)?\s*(?:ms|us|ns|s|초|분|시간|Hz|kHz|MHz|GHz|Mbps|Gbps|KB|MB|GB|B|건|개|회)(?!\w)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupied(testSpans, start, end)) continue;
      tokens.push({
        raw: match[0],
        normalized: match[0].replace(/\s+/g, "").toLowerCase(),
        ...locate(source, start, end),
      });
    }
  }
  return tokens;
}

function extractProtectedTokens(text) {
  return new Set(extractProtectedTokenOccurrences(text).map((item) => item.normalized));
}

// 버전 앞의 v는 사실이 아니라 표기 관례다. 원본 "version 3.0"을 요약이 "gstApp v3.0"으로
// 쓰면 같은 버전인데도 문자열이 달라 날조로 잡혔다(2026-08-12 주간 보고 게시 차단).
// 대조할 때만 접두를 떼고, issue에 실리는 값은 보고서에 쓰인 표기 그대로 둔다 —
// 사람이 고칠 대상은 보고서의 그 문자열이지 정규화된 형태가 아니다.
function normalizeVersionToken(token) {
  return token.replace(/^v(?=\d)/, "");
}

// 범용 조수사로만 끝나는 수량 토큰. 원본이 "3방안"·"3캠페인"처럼 구체 명사로 센 것을
// 요약이 "3개"로 바꿔 쓰는 것은 수치 날조가 아니라 조수사 표기 차이다.
// ms·MB·% 같은 물리량이나 버전은 여기 포함하지 않는다 — 그건 표기가 곧 사실이다.
// 가지·번·차례는 extractProtectedTokens의 단위 목록에 아직 없어 토큰으로 뽑히지 않는다.
// 그 목록을 넓힐 때 함께 동작하도록 미리 넣어 둔다.
const GENERIC_COUNTER_TOKEN = /^(\d+(?:\.\d+)?)(?:개|건|회|가지|번|차례)$/;

// 수량을 "숫자 + 조수사 + 센 대상"으로 분해한다. 숫자만 대조하면 원본 어딘가에 있던
// 무관한 숫자(날짜 "7월", 시간 "3분")가 "7건"·"3건" 같은 날조를 통과시킨다.
// 조사가 붙어도 맞물리도록 대상에서 조사를 떼어 키로 쓴다("방안뿐"·"방안만" → "방안").
// 앞 2글자만 쓰면 "프로젝트"와 "프로그램", "검사"와 "검토"가 같은 키가 되어
// 서로 다른 대상을 센 수치가 통과해버린다. 다만 조사를 떼면 오히려 정보가
// 사라지는 짧은 명사("제도"→"제", "경로"→"경")는 원형을 그대로 쓴다.
const TRAILING_PARTICLES = /(?:들)?(?:은|는|이|가|을|를|의|만|뿐|도|과|와|으로|로|에서|에|부터|까지)+$/;

function nounKey(noun) {
  const stripped = noun.replace(TRAILING_PARTICLES, "");
  return stripped.length >= 2 ? stripped : noun;
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

function comparableQuantitySubject(subject) {
  if (!subject) return null;
  const metricSubject = String(subject)
    .replace(/<\/?u>/gi, "")
    .replace(/^\s*\[Notion\]\s*/i, "")
    .replace(/^\s*CHANGELOG\s+Unreleased\s*[·:—-]\s*/i, "")
    .replace(
      /^\s*(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^\r\n)]*\))?!?:\s*/i,
      ""
    )
    .replace(/\s+(?:개수|건수|수)$/, "")
    .trim();
  return metricSubject || null;
}

const PARTICLE_REQUIRES_FINAL_CONSONANT = new Map([
  ["은", true], ["는", false],
  ["이", true], ["가", false],
  ["을", true], ["를", false],
]);

function splitClosedKoreanParticle(token) {
  const match = String(token).match(/^(.+?)(은|는|이|가|을|를)([),.;:!?]*)$/u);
  if (!match) return null;
  const stem = match[1];
  const lastCharacter = Array.from(stem).at(-1);
  if (/[가-힣]/.test(lastCharacter)) {
    const hasFinalConsonant = (lastCharacter.codePointAt(0) - 0xac00) % 28 !== 0;
    if (hasFinalConsonant !== PARTICLE_REQUIRES_FINAL_CONSONANT.get(match[2])) return null;
  } else if (!/[\p{L}\p{N}_+#./-]/u.test(lastCharacter)) {
    return null;
  }
  return { stem, particle: match[2], suffix: match[3] };
}

function sameQuantitySubject(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftParts = String(left).split(/(\s+)/);
  const rightParts = String(right).split(/(\s+)/);
  if (leftParts.length !== rightParts.length) return false;

  let changedParticle = false;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] === rightParts[index]) continue;
    const leftWord = splitClosedKoreanParticle(leftParts[index]);
    const rightWord = splitClosedKoreanParticle(rightParts[index]);
    if (
      !leftWord
      || !rightWord
      || leftWord.stem !== rightWord.stem
      || leftWord.suffix !== rightWord.suffix
    ) return false;
    changedParticle = true;
  }
  return changedParticle;
}

function extractCountedQuantities(text) {
  return extractCountedQuantityOccurrences(text).map(({ token, key }) => ({ token, key }));
}

function extractCountedQuantityOccurrences(text) {
  const source = String(text);
  const testSpans = extractTestFactOccurrences(source);
  const entries = [];
  // extractProtectedTokens의 (?!\w)는 한글을 막지 못해 "3개월"에서도 "3개"가 토큰으로
  // 뽑힌다. 그래도 근거 없이 통과하지 않는 이유는 아래 lookahead가 "개월"의 "개"를
  // 조수사로 보지 않아 이 토큰의 대조 대상이 비기 때문이다. 두 규칙이 맞물려 동작한다.
  // 조수사는 뒤에 공백이나 "의"가 올 때만 조수사다. "3개월"의 "개"는 복합어의 일부이며,
  // 이를 조수사로 보면 원본의 "3월"(March)이 "3개월"(3 months)의 근거가 되어버린다.
  const pattern = /(\d+(?:\.\d+)?)\s*(?:(개|건|회|가지|번|차례)(?=[\s의]))?\s*(?:의\s*)?([가-힣]+)/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const counterStart = start + match[1].length;
    const counterEnd = match[2]
      ? source.indexOf(match[2], counterStart) + match[2].length
      : counterStart;
    if (occupied(testSpans, start, counterEnd)) continue;
    entries.push({
      raw: source.slice(start, counterEnd),
      token: `${match[1]}${match[2] || ""}`,      // 보고서에서 어느 토큰이 셌는지
      key: `${match[1]} ${nounKey(match[3])}`,   // 무엇을 몇으로 셌는지 (조수사 무관)
      subject: nounKey(match[3]),
      ...locate(source, start, counterEnd),
    });
  }
  return entries;
}

// 이 토큰이 센 대상이 모두 원본에서도 같은 숫자로 세어졌는가?
// 같은 숫자를 쓴 다른 조수사("3건 수정")는 이 토큰("3개")의 근거가 아니므로 제외한다.
function countedInSource(token, outputCounts, sourceKeys) {
  const counted = outputCounts.filter((entry) => entry.token === token);
  return counted.length > 0 && counted.every((entry) => sourceKeys.has(entry.key));
}

function validateLegacyFacts(rawContent, reportContent) {
  const issues = [];
  const sourceFacts = extractTestFacts(rawContent);
  const outputFacts = extractTestFacts(reportContent);

  for (const fact of outputFacts) {
    if (fact.unsafeCount) {
      addIssue(
        issues,
        "error",
        "unsafe_test_count",
        `정밀하게 검증할 수 없는 범위의 테스트 건수입니다: ${fact.raw}`,
        { value: fact.raw }
      );
      continue;
    }
    if (fact.total !== undefined && fact.total < fact.pass) {
      addIssue(
        issues,
        "error",
        "invalid_test_ratio",
        `PASS 결과의 전체 건수(${fact.total})가 성공 건수(${fact.pass})보다 작습니다.`,
        { value: fact.raw }
      );
      continue;
    }
    if (!testFactSupported(fact, sourceFacts)) {
      addIssue(
        issues,
        "error",
        "unsupported_test_result",
        `원본에서 확인되지 않는 PASS/FAIL 결과입니다: ${fact.raw}`,
        { value: fact.raw }
      );
    }
  }

  const sourceTokens = extractProtectedTokens(rawContent);
  const sourceVersionTokens = new Set([...sourceTokens].map(normalizeVersionToken));
  const sourceKeys = new Set(extractCountedQuantities(rawContent).map((entry) => entry.key));
  const outputCounts = extractCountedQuantities(reportContent);
  for (const token of extractProtectedTokens(reportContent)) {
    if (sourceTokens.has(token)) continue;
    // v 접두만 다르고 버전 숫자가 원본과 같으면 통과시킨다.
    if (sourceVersionTokens.has(normalizeVersionToken(token))) continue;
    // 조수사 표기만 다르고 숫자·센 대상이 원본과 같으면 통과시킨다.
    if (GENERIC_COUNTER_TOKEN.test(token) && countedInSource(token, outputCounts, sourceKeys)) continue;
    addIssue(
      issues,
      "error",
      "unsupported_fact_token",
      `원본에서 확인되지 않는 수치·버전 토큰입니다: ${token}`,
      { value: token }
    );
  }

  return issues;
}

function validateNonFactRules(reportContent, options = {}) {
  const issues = [];

  for (const line of String(reportContent).split("\n")) {
    for (const clause of splitOpenStatusClauses(line)) {
      // 프로젝트 규율상 인라인 코드의 TODO/FIXME도 open 상태로 취급해 as-of 검증을 요구한다.
      if (clauseHasUncoveredOpenStatus(clause)) {
        addIssue(
          issues,
          "error",
          "open_status_without_as_of",
          "미해결·미완료·보류 상태에는 YYYY-MM-DD 기준 날짜가 필요합니다.",
          { line: clause.trim() }
        );
      }
    }
  }

  const header = options.sectionHeader;
  if (header) {
    const count = String(reportContent).split(header).length - 1;
    if (count !== 1) {
      addIssue(
        issues,
        "error",
        "section_header_count",
        `설정된 조현우 섹션 헤더가 ${count}개입니다.`,
        { expected: 1, actual: count }
      );
    }
    if (!String(reportContent).trimStart().startsWith(header)) {
      addIssue(
        issues,
        "error",
        "section_does_not_start_at_header",
        "보고서 초안은 설정된 조현우 섹션 헤더로 시작해야 합니다."
      );
    }
  }

  const markupContent = String(reportContent)
    .replace(/(`{3,})[\s\S]*?\1/g, "")
    .replace(/`[^`\n]*`/g, "");
  const underlineOpen = (markupContent.match(/<u>/g) || []).length;
  const underlineClose = (markupContent.match(/<\/u>/g) || []).length;
  if (underlineOpen !== underlineClose) {
    addIssue(
      issues,
      "error",
      "underline_unbalanced",
      `<u> 태그가 불균형합니다: open=${underlineOpen}, close=${underlineClose}`
    );
  }

  const openIssueVerification = options.repos === undefined
    ? { issues: [], checks: [] }
    : verifyOpenIssueClaims(
      reportContent,
      options.repos,
      options.openIssueVerifierOptions
    );
  issues.push(...openIssueVerification.issues);

  return { issues, openIssueChecks: openIssueVerification.checks };
}

function statusFromIssues(issues) {
  return issues.some((issue) => issue.severity === "error")
    ? "FAIL"
    : issues.some((issue) => issue.severity === "warning")
      ? "WARNING"
      : "PASS";
}

function buildLegacyValidation(rawContent, reportContent, options, issues, openIssueChecks) {
  const sourceFacts = extractTestFacts(rawContent);
  const outputFacts = extractTestFacts(reportContent);
  const sourceTokens = extractProtectedTokens(rawContent);

  return {
    schemaVersion: 1,
    status: statusFromIssues(issues),
    meetingDate: options.meetingDate,
    reportDepth: options.reportDepth,
    snapshotPath: options.snapshotPath,
    snapshotHash: options.snapshotHash,
    reportHash: sha256(reportContent),
    checkedAt: new Date().toISOString(),
    facts: {
      sourceTestResults: sourceFacts,
      outputTestResults: outputFacts,
      sourceProtectedTokens: Array.from(sourceTokens).sort(),
      outputProtectedTokens: Array.from(extractProtectedTokens(reportContent)).sort(),
      openIssueChecks,
    },
    issues,
  };
}

function validateReport(rawContent, reportContent, options = {}) {
  const issues = validateLegacyFacts(rawContent, reportContent);
  const nonFacts = validateNonFactRules(reportContent, options);
  issues.push(...nonFacts.issues);
  return buildLegacyValidation(rawContent, reportContent, options, issues, nonFacts.openIssueChecks);
}

function excerptAt(text, start) {
  const source = String(text);
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = source.indexOf("\n", start);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
}

function closedSurfaceMatches(fact, surface) {
  if (surface === fact.raw) return true;

  if (fact.allowedNormalizations.includes("whitespace_around_slash")) {
    return surface.replace(/[ \t]*\/[ \t]*/g, "/")
      === fact.raw.replace(/[ \t]*\/[ \t]*/g, "/");
  }

  if (fact.type === "protected_token" && /^v?\d+(?:\.\d+){1,3}$/i.test(fact.raw)) {
    return normalizeVersionToken(surface) === normalizeVersionToken(fact.raw);
  }

  if (/^[+-]?\d+(?:\.\d+)?[ \t]*[x×][ \t]*[+-]?\d+(?:\.\d+)?$/i.test(fact.raw)) {
    return surface.replace(/[ \t]+/g, "").replace(/x/gi, "×")
      === fact.raw.replace(/[ \t]+/g, "").replace(/x/gi, "×");
  }

  return false;
}

function claimOutputEvidence(claim, cleanContent) {
  return {
    outputLocation: {
      start: claim.cleanStart,
      end: claim.cleanEnd,
      ...claim.outputLocation,
    },
    outputExcerpt: excerptAt(cleanContent, claim.cleanStart),
  };
}

function claimQuantityContext(claim, cleanContent) {
  const occurrence = extractSchemaV2FactOccurrences(cleanContent).find((candidate) =>
    candidate.prefix === "Q"
    && candidate.start <= claim.cleanStart
    && candidate.end >= claim.cleanEnd
  );
  if (!occurrence) return { subject: null, target: null };
  return {
    subject: comparableQuantitySubject(occurrence.subject === undefined
      ? subjectBefore(cleanContent, occurrence.start)
      : occurrence.subject),
    target: comparableQuantitySubject(occurrence.target),
  };
}

function sameSectionPath(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((part, index) => part === right[index]);
}

function validateClaim(claim, byId, cleanContent, issues, options = {}) {
  const fact = byId.get(claim.factId);
  const outputEvidence = claimOutputEvidence(claim, cleanContent);
  if (!fact) {
    addIssue(
      issues,
      "error",
      "unknown_fact_id",
      `카탈로그에 없는 fact ID입니다: ${claim.factId}`,
      { value: claim.surface, factId: claim.factId, ...outputEvidence }
    );
    return;
  }

  if (options.knownPaths !== undefined && fact.sourceSectionPath) {
    const outputPath = sourceSectionPathAt(cleanContent, claim.cleanStart, options.knownPaths);
    if (!sameSectionPath(fact.sourceSectionPath, outputPath)) {
      addIssue(
        issues,
        "error",
        "fact_section_mismatch",
        `fact ID ${claim.factId}의 섹션이 원본 근거와 다릅니다.`,
        {
          value: claim.surface,
          factId: claim.factId,
          expected: fact.sourceSectionPath,
          actual: outputPath,
          sourceLocation: fact.sourceLocation,
          sourceExcerpt: fact.sourceExcerpt,
          ...outputEvidence,
        }
      );
    }
  }

  if (!closedSurfaceMatches(fact, claim.surface)) {
    addIssue(
      issues,
      "error",
      "fact_value_mismatch",
      `fact ID ${claim.factId}의 표기가 원본 근거와 다릅니다: ${claim.surface}`,
      {
        value: claim.surface,
        factId: claim.factId,
        expected: [fact.raw],
        sourceLocation: fact.sourceLocation,
        sourceExcerpt: fact.sourceExcerpt,
        ...outputEvidence,
      }
    );
    return;
  }

  if (
    fact.type === "test_result"
    && fact.semantic?.unsafeCount
  ) {
    addIssue(
      issues,
      "error",
      "unsafe_test_count",
      `정밀하게 검증할 수 없는 범위의 테스트 건수입니다: ${claim.surface}`,
      {
        value: claim.surface,
        factId: claim.factId,
        sourceLocation: fact.sourceLocation,
        sourceExcerpt: fact.sourceExcerpt,
        ...outputEvidence,
      }
    );
    return;
  }

  if (
    fact.type === "test_result"
    && fact.semantic?.total !== undefined
    && fact.semantic.total < fact.semantic.pass
  ) {
    addIssue(
      issues,
      "error",
      "invalid_test_ratio",
      `PASS 결과의 전체 건수(${fact.semantic.total})가 성공 건수(${fact.semantic.pass})보다 작습니다.`,
      {
        value: claim.surface,
        factId: claim.factId,
        sourceLocation: fact.sourceLocation,
        sourceExcerpt: fact.sourceExcerpt,
        ...outputEvidence,
      }
    );
    return;
  }

  if (!fact.id.startsWith("Q") || (!fact.subject && !fact.target)) return;
  const actualContext = claimQuantityContext(claim, cleanContent);
  const expectedSubject = comparableQuantitySubject(fact.subject);
  if (fact.subject && !sameQuantitySubject(actualContext.subject, expectedSubject)) {
    addIssue(
      issues,
      "error",
      "fact_subject_mismatch",
      `fact ID ${claim.factId}의 센 대상이 원본 근거와 다릅니다: ${actualContext.subject || "없음"}`,
      {
        value: claim.surface,
        factId: claim.factId,
        expected: [fact.subject],
        actual: actualContext.subject,
        sourceLocation: fact.sourceLocation,
        sourceExcerpt: fact.sourceExcerpt,
        ...outputEvidence,
      }
    );
  }
  const expectedTarget = comparableQuantitySubject(fact.target);
  if (fact.target && actualContext.target !== expectedTarget) {
    addIssue(
      issues,
      "error",
      "fact_subject_mismatch",
      `fact ID ${claim.factId}의 붙임 대상이 원본 근거와 다릅니다: ${actualContext.target || "없음"}`,
      {
        value: claim.surface,
        factId: claim.factId,
        expected: [fact.target],
        actual: actualContext.target,
        sourceLocation: fact.sourceLocation,
        sourceExcerpt: fact.sourceExcerpt,
        ...outputEvidence,
      }
    );
  }
}

function extractSchemaV2UnmarkedOccurrences(text, catalog, markedSpans) {
  return extractSchemaV2FactOccurrences(text, {
    systemFacts: catalog.facts.filter((candidate) => candidate.id.startsWith("S")),
    markedSpans,
  });
}

function findUnmarkedProtectedFacts(cleanContent, markedCleanSpans, catalog, issues) {
  for (const occurrence of extractSchemaV2UnmarkedOccurrences(
    cleanContent,
    catalog,
    markedCleanSpans
  )) {
    addIssue(
      issues,
      "error",
      "unmarked_protected_fact",
      `fact marker 밖의 보호 사실입니다: ${occurrence.raw}`,
      {
        value: occurrence.raw,
        outputLocation: locate(cleanContent, occurrence.start, occurrence.end),
        outputExcerpt: excerptAt(cleanContent, occurrence.start),
      }
    );
  }
}

function validateAnnotatedReport(rawContent, annotatedContent, catalog, options = {}) {
  const normalizedAnnotatedContent = stripAstralChars(String(annotatedContent));
  const parsed = parseAnnotatedDraft(normalizedAnnotatedContent);
  const issues = parsed.errors.map((issue) => ({ severity: "error", ...issue }));
  const byId = new Map(catalog.facts.map((fact) => [fact.id, fact]));
  for (const claim of parsed.claims) {
    validateClaim(claim, byId, parsed.cleanContent, issues, options);
  }
  findUnmarkedProtectedFacts(parsed.cleanContent, parsed.markedCleanSpans, catalog, issues);
  const nonFacts = validateNonFactRules(parsed.cleanContent, options);
  issues.push(...nonFacts.issues);

  return {
    cleanContent: parsed.cleanContent,
    validation: {
      schemaVersion: 2,
      status: statusFromIssues(issues),
      attemptId: options.attemptId,
      snapshotHash: options.snapshotHash,
      catalogHash: catalog.catalogHash,
      annotatedDraftHash: sha256(annotatedContent),
      checkedAt: new Date().toISOString(),
      facts: { openIssueChecks: nonFacts.openIssueChecks },
      issues,
    },
  };
}

module.exports = {
  extractCountedQuantityOccurrences,
  extractProtectedTokenOccurrences,
  extractProtectedTokens,
  extractTestFactOccurrences,
  extractTestFacts,
  testFactSupported,
  validateAnnotatedReport,
  validateNonFactRules,
  validateReport,
};
