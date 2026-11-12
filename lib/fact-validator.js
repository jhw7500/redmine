const { sha256 } = require("./report-artifact");
const { verifyOpenIssueClaims } = require("./open-issue-verifier");
const { parseAnnotatedDraft } = require("./annotated-draft");
const { extractSchemaV2FactOccurrences } = require("./fact-occurrences");
const { splitOpenStatusClauseSpans, findOpenStatusOccurrences } = require("./open-status-clauses");
const { sourceSectionPathAt } = require("./source-coverage");
const { normalizeFactSource, stripAstralChars } = require("./text-normalization");
const { annotationOwners, assertTeamEvidenceFacts, releaseStageClaims, releaseStageEvidence } = require("./team-evidence");
const { annotateFactReferences, expandFactReferences } = require("./fact-references");
const { validateVerdictEvidence } = require("./verdict-evidence");
const { readFactContextProjection } = require("./fact-context-projection");

const AS_OF_PATTERN = /\(\d{4}-\d{2}-\d{2}\s*기준\s*(?:미해결|미완료|미완|보류)\)/i;
const PROJECTED_SUBJECT_CONTEXT=Symbol('projected subject context');

function clauseHasUncoveredOpenStatus(clause, openStatuses) {
  const asOfStatuses = Array.from(clause.matchAll(new RegExp(AS_OF_PATTERN.source, "gi")))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));

  return openStatuses.some((openStatus) => {
    const { start, end } = openStatus;
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
    const occurrences = findOpenStatusOccurrences(line);
    for (const clause of splitOpenStatusClauseSpans(line)) {
      const claims = occurrences.filter(item => clause.start <= item.start && item.end <= clause.end)
        .map(item => ({ ...item, start: item.start - clause.start, end: item.end - clause.start }));
      // 프로젝트 규율상 인라인 코드의 TODO/FIXME도 open 상태로 취급해 as-of 검증을 요구한다.
      if (clauseHasUncoveredOpenStatus(clause.text, claims)) {
        addIssue(
          issues,
          "error",
          "open_status_without_as_of",
          "미해결·미완료·보류 상태에는 YYYY-MM-DD 기준 날짜가 필요합니다.",
          { line: clause.text }
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
  if(fact.id.startsWith('M')) return surface===fact.display;
  if (surface === fact.raw) return true;

  if (fact.allowedNormalizations.includes("whitespace_around_slash")) {
    return surface.replace(/[ \t]*\/[ \t]*/g, "/")
      === fact.raw.replace(/[ \t]*\/[ \t]*/g, "/");
  }

  if (["protected_token", "named_version"].includes(fact.type) && /^v?\d+(?:\.\d+){1,3}$/i.test(fact.raw)) {
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

function claimQuantityContext(claim, cleanContent, fact) {
  const prefix = fact.type === "named_version" ? "V" : "Q";
  // Parse display-independent text, mapping marker offsets to that view. Keeping
  // offsets while inserting spaces would break attached targets such as 4채널.
  const withoutUnderline = (value) => String(value).replace(/<\/?u>/gi, "");
  const start = withoutUnderline(cleanContent.slice(0, claim.cleanStart)).length;
  const end = withoutUnderline(cleanContent.slice(0, claim.cleanEnd)).length;
  const content = withoutUnderline(cleanContent);
  const occurrence = extractSchemaV2FactOccurrences(content, {
    legacyCountedVersions: prefix === "Q",
    legacyHashReferences: fact.type !== "reference_number",
  }).find((candidate) =>
    candidate.prefix === prefix
    && candidate.start <= start
    && candidate.end >= end
  );
  if (!occurrence) return { type: null, subject: null, target: null };
  return {
    type: occurrence.type,
    referenceContext: occurrence.semantic?.referenceContext,
    subject: comparableQuantitySubject(occurrence.subject === undefined
      ? subjectBefore(content, occurrence.start)
      : occurrence.subject),
    target: comparableQuantitySubject(occurrence.target),
  };
}

function sameReferenceContext(expected, actual) {
  return Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length
    && expected.every((line, index) => typeof line === "string" && (line === actual[index]
      || (/^\[Notion\][ \t]+/u.test(line)
        && line.replace(/^\[Notion\][ \t]+/u, "") === actual[index])));
}

function sameSectionPath(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((part, index) => part === right[index]);
}

function validateClaim(claim, byId, cleanContent, issues, options = {}, projectedContext, sourceReferences) {
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
      if(fact.id.startsWith('M')) addIssue(
        issues,'error','fact_evidence_mismatch','수치 근거의 프로젝트 소유권이 변경됐습니다.',
        {factId:fact.id,expected:fact.sourceSectionPath,actual:outputPath,...outputEvidence}
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

  if(['measurement_claim','release_version'].includes(fact.type)) {
    const line=excerptAt(cleanContent,claim.cleanStart);
    const bullet=line.match(/^[-*+]\s+(.+)$/);
    if(!bullet||![fact.display,`<u>${fact.display}</u>`].includes(bullet[1])) addIssue(
      issues,'error','measurement_claim_structure','수치 근거는 전체 구절을 독립 불릿으로 유지해야 합니다.',
      {factId:fact.id,...outputEvidence}
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

  const hasQuantityContext = fact.id.startsWith("Q")
    || fact.type === "named_version" || fact.type === "reference_number";
  if (!hasQuantityContext || (fact.type !== "reference_number" && !fact.subject && !fact.target)) return;
  const actualContext = claimQuantityContext(claim, cleanContent, fact);
  const expectedSubject = comparableQuantitySubject(fact.subject);
  if (fact.type === "reference_number") {
    const source = sourceReferences.get(fact.sourceLocation?.start);
    const expectedContext = fact.semantic?.referenceContext;
    const sourceMatches = source?.end === fact.sourceLocation?.end && source?.raw === fact.raw
      && source?.line === fact.sourceLocation?.line && source?.column === fact.sourceLocation?.column
      && source?.subject === fact.subject
      && source?.semantic.referenceKind === fact.semantic?.referenceKind
      && source?.semantic.referenceNumber === fact.semantic?.referenceNumber;
    const contextMatches = expectedSubject !== "hash_reference" || (Array.isArray(expectedContext)
      && JSON.stringify(source?.semantic.referenceContext) === JSON.stringify(expectedContext));
    if (!sourceMatches || !contextMatches) {
      addIssue(issues, "error", "fact_evidence_mismatch", "참조 번호의 종류·문맥이 원문 근거와 일치하지 않습니다.", {
        factId: claim.factId, value: claim.surface, sourceLocation: fact.sourceLocation,
        sourceExcerpt: fact.sourceExcerpt, ...outputEvidence,
      });
      return;
    }
  }
  const referenceContextMismatch = fact.type === "reference_number"
    && (actualContext.type !== "reference_number" || actualContext.subject !== expectedSubject
      || (expectedSubject === "hash_reference" && projectedContext !== PROJECTED_SUBJECT_CONTEXT
        && !sameReferenceContext(fact.semantic.referenceContext, actualContext.referenceContext)));
  if (referenceContextMismatch || (fact.subject && projectedContext!==PROJECTED_SUBJECT_CONTEXT
    && !sameQuantitySubject(actualContext.subject, expectedSubject))) {
    addIssue(
      issues,
      "error",
      "fact_subject_mismatch",
      referenceContextMismatch ? `fact ID ${claim.factId}의 참조 종류·문맥이 원본 근거와 다릅니다.`
        : `fact ID ${claim.factId}의 센 대상이 원본 근거와 다릅니다: ${actualContext.subject || "없음"}`,
      {
        value: claim.surface,
        factId: claim.factId,
        expected: expectedSubject === "hash_reference" ? fact.semantic.referenceContext : [fact.subject],
        actual: expectedSubject === "hash_reference" ? actualContext.referenceContext : actualContext.subject,
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

const FILE_TOKEN_CHARACTER = /^[\p{L}\p{N}_.\-:/\\∖]$/u;

function fileTokenAt(text, start, end) {
  const source = String(text);
  let tokenStart = start;
  let tokenEnd = end;
  while (tokenStart > 0 && FILE_TOKEN_CHARACTER.test(source[tokenStart - 1])) tokenStart -= 1;
  while (tokenEnd < source.length && FILE_TOKEN_CHARACTER.test(source[tokenEnd])) tokenEnd += 1;
  return {
    start: tokenStart,
    end: tokenEnd,
    raw: source.slice(tokenStart, tokenEnd),
  };
}

function sourceLineExcerpt(text, start) {
  return excerptAt(text, start).replace(/^(?:[-*+]\s+)/, "");
}

function sourceBackslashCandidates(source, parsed, owners) {
  const candidates = [];
  for (const claim of parsed.claims) {
    const fact = owners.get(claim.factId);
    const location = fact?.sourceLocation;
    if (
      !location || !Number.isInteger(location.start) || !Number.isInteger(location.end)
      || location.start < 1 || location.end <= location.start || location.end > source.length
      || source[location.start - 1] !== "\\"
      || parsed.cleanContent[claim.cleanStart - 1] !== "∖"
      || source.slice(location.start, location.end) !== fact.raw
      || sourceLineExcerpt(source, location.start) !== fact.sourceExcerpt
    ) continue;
    const actual = locate(source, location.start, location.end);
    if (actual.line !== location.line || actual.column !== location.column) continue;
    candidates.push({claim, outputOffset: claim.cleanStart - 1, sourceOffset: location.start - 1});
  }
  return candidates;
}

function outerUnderline(text) {
  if (!text.startsWith("<u>") || !text.endsWith("</u>")) return false;
  let depth = 0;
  for (const match of text.matchAll(/<\/?u>/g)) {
    depth += match[0] === "<u>" ? 1 : -1;
    if (depth < 0 || (depth === 0 && match.index + match[0].length !== text.length)) return false;
  }
  return depth === 0;
}

function factComparisonLines(content, claims) {
  const rows = [];
  let start = 0, cursor = 0;
  for (const line of content.split("\n")) {
    const end = start + line.length;
    const rowClaims = [];
    let crossing = false;
    while (cursor < claims.length && claims[cursor].cleanStart <= end) {
      const claim = claims[cursor++];
      if (claim.cleanStart >= start && claim.cleanEnd <= end) rowClaims.push(claim);
      else crossing = true;
    }
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*+][ \t]+/)?.[0] || "";
    const bodyStart = start + line.length - line.trimStart().length + bullet.length;
    const body = trimmed.slice(bullet.length);
    const views = [];
    for (const [text, offset] of [[body, bodyStart], ...(outerUnderline(body) ? [[body.slice(3, -4), bodyStart + 3]] : [])]) {
      const complete = !crossing && rowClaims.every(claim => claim.cleanStart >= offset && claim.cleanEnd <= offset + text.length);
      views.push({text, start: offset, signature: complete ? JSON.stringify(rowClaims.map(claim => [
        claim.factId, claim.cleanStart - offset, claim.cleanEnd - offset,
      ])) : null});
    }
    rows.push({claims: rowClaims, views});
    start = end + 1;
  }
  return rows;
}

function sourceBackslashReplacements(source, parsed, catalog, issues) {
  const replacements = new Map();
  if (!parsed.cleanContent.includes("∖")) return replacements;
  const owners = new Map(annotationOwners(source, catalog).map(fact => [fact.id, fact]));
  const candidates = sourceBackslashCandidates(source, parsed, owners);
  if (!candidates.length) return replacements;
  let projected;
  try {
    // Comparison only, after the AI response: never rewrite its annotated bytes
    // or introduce a pre-AI round-trip gate. Expansion includes M.display rules.
    projected = parseAnnotatedDraft(expandFactReferences(annotateFactReferences(source, catalog), catalog));
  } catch {
    projected = null;
  }
  const sourceRows = projected && !projected.errors.length
    ? factComparisonLines(projected.cleanContent, projected.claims) : [];
  const sourceOffsets = projected && !projected.errors.length
    ? new Set(sourceBackslashCandidates(source, projected, owners).map(candidate => candidate.outputOffset))
    : new Set();
  const sourceById = new Map();
  const genuineByBody = new Map();
  for (const row of sourceRows) {
    for (const claim of row.claims) sourceById.set(claim.factId, row);
    for (const view of row.views) {
      const genuine = genuineByBody.get(view.text) || new Set();
      for (let offset = 0; offset < view.text.length; offset += 1) {
        if (view.text[offset] === "∖" && !sourceOffsets.has(view.start + offset)) genuine.add(offset);
      }
      genuineByBody.set(view.text, genuine);
    }
  }
  const candidateByClaim = new Map(candidates.map(candidate => [candidate.claim, candidate]));
  const handled = new Set();
  const reject = (candidate, reason) => addIssue(issues, "error", "fact_evidence_mismatch", "원천 문맥으로 역슬래시 복원 위치를 확정할 수 없습니다.", {
    factId: candidate.claim.factId,
    reason,
    outputLocation: locate(parsed.cleanContent, candidate.outputOffset, candidate.outputOffset + 1),
    outputExcerpt: excerptAt(parsed.cleanContent, candidate.outputOffset),
  });
  for (const row of factComparisonLines(parsed.cleanContent, parsed.claims)) {
    const group = row.claims.map(claim => candidateByClaim.get(claim)).filter(Boolean);
    if (!group.length) continue;
    for (const candidate of group) handled.add(candidate);
    const sourceRow = sourceById.get(group[0].claim.factId);
    const expected = sourceRow?.views[0];
    const view = expected?.signature && row.views.find(candidate => candidate.text === expected.text
      && candidate.signature === expected.signature);
    const ambiguous = view && group.some(candidate =>
      genuineByBody.get(view.text)?.has(candidate.outputOffset - view.start));
    if (view && !ambiguous) {
      for (const candidate of group) replacements.set(candidate.outputOffset, candidate.sourceOffset);
    } else {
      reject(group[0], ambiguous ? "backslash_context_ambiguous" : "backslash_context_mismatch");
    }
  }
  for (const candidate of candidates) {
    if (!handled.has(candidate)) reject(candidate, "backslash_context_multiline");
  }
  return replacements;
}

function restoreSourceBackslashes(content, replacements) {
  if (!replacements.size) return content;
  const characters = content.split("");
  for (const offset of replacements.keys()) characters[offset] = "\\";
  return characters.join("");
}

function sameFileToken(sourceToken, outputToken, replacements) {
  if (sourceToken.raw.length !== outputToken.raw.length) return false;
  for (let index = 0; index < sourceToken.raw.length; index += 1) {
    if (sourceToken.raw[index] === outputToken.raw[index]) continue;
    if (
      sourceToken.raw[index] !== "\\" || outputToken.raw[index] !== "∖"
      || replacements.get(outputToken.start + index) !== sourceToken.start + index
    ) return false;
  }
  return true;
}

function hasFileEvidence(token) {
  return /[\\/]/.test(token) || /\.[\p{L}\p{N}_-]+$/u.test(token);
}

function dateTailBelongsToMarkedSourceFile(
  occurrence,
  cleanContent,
  claimsByCleanEnd,
  byId,
  normalizedRawContent,
  selectedSourceIsoDates,
  replacements
) {
  if (occurrence.kind !== "attached_unit") return false;
  const claim = claimsByCleanEnd.get(occurrence.start + 2);
  if (!claim || occurrence.start !== claim.cleanEnd - 2 || occurrence.end <= claim.cleanEnd) {
    return false;
  }

  const fact = byId.get(claim.factId);
  const location = fact?.sourceLocation;
  if (
    fact?.type !== "protected_token"
    || !/^\d{4}-\d{2}-\d{2}$/.test(fact.raw)
    || claim.surface !== fact.raw
    || claim.cleanEnd - claim.cleanStart !== claim.surface.length
    || !location
    || normalizedRawContent.slice(location.start, location.end) !== fact.raw
    || sourceLineExcerpt(normalizedRawContent, location.start) !== fact.sourceExcerpt
  ) {
    return false;
  }

  const selectedDate = selectedSourceIsoDates().get(location.start);
  if (
    !selectedDate
    || selectedDate.end !== location.end
    || selectedDate.raw !== fact.raw
    || selectedDate.line !== location.line
    || selectedDate.column !== location.column
  ) {
    return false;
  }

  const sourceToken = fileTokenAt(normalizedRawContent, location.start, location.end);
  const outputToken = fileTokenAt(cleanContent, occurrence.start, occurrence.end);
  if (
    claim.cleanStart < outputToken.start
    || occurrence.end > outputToken.end
    || !hasFileEvidence(sourceToken.raw)
  ) {
    return false;
  }
  return sameFileToken(sourceToken, outputToken, replacements);
}

function findUnmarkedProtectedFacts(
  cleanContent,
  markedCleanSpans,
  catalog,
  issues,
  normalizedRawContent,
  claims,
  replacements,
  canonicalCleanContent,
  typedVerdictSpans
) {
  const claimsByCleanEnd = new Map(claims.map((claim) => [claim.cleanEnd, claim]));
  const byId = new Map(catalog.facts.map((fact) => [fact.id, fact]));
  let sourceIsoDates;
  const selectedSourceIsoDates = () => {
    if (!sourceIsoDates) {
      sourceIsoDates = new Map(
        extractSchemaV2FactOccurrences(normalizedRawContent)
          .filter((candidate) => candidate.kind === "iso_date")
          .map((candidate) => [candidate.start, candidate])
      );
    }
    return sourceIsoDates;
  };
  for (const occurrence of extractSchemaV2UnmarkedOccurrences(
    cleanContent,
    catalog,
    [...markedCleanSpans, ...typedVerdictSpans]
  )) {
    if (dateTailBelongsToMarkedSourceFile(
      occurrence,
      cleanContent,
      claimsByCleanEnd,
      byId,
      normalizedRawContent,
      selectedSourceIsoDates,
      replacements
    )) continue;
    addIssue(
      issues,
      "error",
      "unmarked_protected_fact",
      `fact marker 밖의 보호 사실입니다: ${occurrence.raw}`,
      {
        value: occurrence.raw,
        outputLocation: locate(canonicalCleanContent, occurrence.start, occurrence.end),
        outputExcerpt: excerptAt(canonicalCleanContent, occurrence.start),
      }
    );
  }
}

function validateReleaseStages(rawContent, cleanContent, claims, catalog, issues) {
  const byId=new Map(catalog.facts.filter(f=>/^M\d{4}$/.test(f.id)&&f.type==='release_version').map(f=>[f.id,f]));
  const releases=claims.filter(c=>byId.has(c.factId));
  if(!releases.length) return [];
  const verdictSpans=[];
  const usedVerdictEvidence=new Set();
  const nodes=[];
  const stack=[];
  const visible=cleanContent.replace(/<!--[\s\S]*?-->/g,c=>c.replace(/[^\n]/g,' '));
  let offset=0;
  for(const line of visible.split('\n')) {
    const match=line.match(/^(\s*)[-*+]\s+(.*)$/);
    if(match) {
      while(stack.length&&nodes[stack.at(-1)].indent>=match[1].length) {
        nodes[stack.pop()].end=offset;
      }
      nodes.push({start:offset,end:cleanContent.length,indent:match[1].length,textStart:offset+line.length-match[2].length,
        parent:stack.at(-1),text:match[2]});
      stack.push(nodes.length-1);
    }
    offset+=line.length+1;
  }
  const within=(node)=>releases.filter(c=>node.start<=c.cleanStart&&c.cleanStart<node.end);
  const records=nodes.map(node=>({node,stages:releaseStageClaims(node.text),anchors:within(node)}))
    .filter(record=>record.stages.length);
  const owned=new Set(records.flatMap(record=>record.anchors));
  const pending=[];
  for(const record of records) {
    if(record.anchors.length) continue;
    const siblings=nodes.filter(node=>node.parent===record.node.parent);
    const index=siblings.indexOf(record.node);
    record.candidates=[siblings[index-1],siblings[index+1]].filter(node=>node
      &&within(node).length===1&&within(node).every(claim=>!owned.has(claim)));
    const context=record.node.parent===undefined?releases:within(nodes[record.node.parent]);
    if(context.length) pending.push(record);
  }
  // Flat milestone/version pairs may point left or right. Resolve only forced
  // one-to-one adjacent pairs; never choose a version by its compatible meaning.
  while(pending.length) {
    const forced=pending.filter(record=>record.candidates.length===1);
    if(!forced.length) break;
    const counts=new Map();
    for(const record of forced) counts.set(record.candidates[0],(counts.get(record.candidates[0])||0)+1);
    if([...counts.values()].some(count=>count>1)) break;
    for(const record of forced) {
      record.anchors=within(record.candidates[0]);
      pending.splice(pending.indexOf(record),1);
    }
    for(const record of pending) record.candidates=record.candidates.filter(node=>!counts.has(node));
  }
  for(const {node,stages,anchors} of records) {
    if(pending.some(record=>record.node===node)) {
      addIssue(issues,'error','release_stage_mismatch','릴리즈 단계와 버전의 인접 관계가 불명확합니다.',{line:node.text});
      continue;
    }
    for(const claim of anchors) {
      const fact=byId.get(claim.factId);
      const evidence=releaseStageEvidence(rawContent,fact,catalog.facts);
      for(const stage of stages) {
        if(evidence.some(e=>e.stage===stage.stage&&e.state===stage.state)) {
          // Only an exact, single typed failure clause receives a verdict span.
          // Arbitrary extra tests/clauses cannot borrow release milestone evidence.
          const body=node.text.trim();
          const canonical=outerUnderline(body)?body.slice(3,-4):body;
          const patterns={production:/^(?:패키지 제작|제작|빌드|패키징) 실패$/,
            installation:/^(?:장비 설치|설치) 실패$/,delivery:/^(?:고객 전달|납품) 실패$/};
          const key=JSON.stringify([fact.id,stage.stage,stage.state]);
          if(anchors.length===1&&stages.length===1&&stage.state==='failed'
            &&patterns[stage.stage]?.test(canonical)&&!usedVerdictEvidence.has(key)) {
            const start=node.textStart+node.text.indexOf('실패');
            verdictSpans.push({start,end:start+2,factId:fact.id,stage:stage.stage,state:stage.state,
              sourceLocation:evidence.find(e=>e.stage===stage.stage&&e.state===stage.state).sourceLocation});
            usedVerdictEvidence.add(key);
          }
          continue;
        }
        addIssue(issues,'error','release_stage_mismatch','릴리즈의 제작·설치·고객 전달 단계가 같은 버전의 원문 근거와 다릅니다.',
          {factId:fact.id,stage:stage.stage,state:stage.state,line:node.text,
            sourceLocation:fact.sourceLocation,sourceExcerpt:fact.sourceExcerpt});
      }
    }
  }
  return verdictSpans;
}

function validateAnnotatedReport(rawContent, annotatedContent, catalog, options = {}) {
  const normalizedAnnotatedContent = stripAstralChars(String(annotatedContent));
  // The fact catalog's view of the source, built once so both source checks below read the same value.
  const normalizedRawContent = normalizeFactSource(rawContent);
  const parsed = parseAnnotatedDraft(normalizedAnnotatedContent);
  const issues = parsed.errors.map((issue) => ({ severity: "error", ...issue }));
  let projectedContext;
  if(options.factContextProjection!==undefined) {
    try {
      readFactContextProjection(options.factContextProjection,{
        content:normalizedAnnotatedContent,
        catalogHash:catalog.catalogHash,
      });
      projectedContext=PROJECTED_SUBJECT_CONTEXT;
    } catch {
      addIssue(issues,'error','fact_context_projection_mismatch','사실 문맥 projection이 현재 보고서와 일치하지 않습니다.');
    }
  }
  let validEvidence=true;
  try {
    assertTeamEvidenceFacts(normalizedRawContent,catalog);
  } catch(error) {
    validEvidence=false;
    addIssue(issues,'error','fact_evidence_mismatch',error.message);
  }
  const selected=new Set();
  for(const claim of parsed.claims) {
    if(!claim.factId.startsWith('M')) continue;
    if(selected.has(claim.factId)) addIssue(issues,'error','duplicate_fact_claim','같은 수치 근거를 중복 선택했습니다.',{factId:claim.factId});
    selected.add(claim.factId);
  }
  const roots=new Set(catalog.facts.filter(f=>f.id.startsWith('M')
    &&(!options.generationRoot||f.sourceSectionPath?.[0]===options.generationRoot))
    .map(f=>f.sourceSectionPath?.[0]||null));
  for(const root of roots) {
    if(!catalog.facts.some(f=>selected.has(f.id)&&(f.sourceSectionPath?.[0]||null)===root)) addIssue(
      issues,'error','measurement_claim_omitted','유용한 수치 근거가 있는 프로젝트에서 수치를 전부 생략했습니다.',{project:root}
    );
  }
  const byId = new Map(catalog.facts.map((fact) => [fact.id, fact]));
  // Authenticate stored reference metadata against the source, including when
  // an opaque projection later permits code-owned regrouping in the output.
  const sourceReferences = new Map(catalog.facts.some(fact => fact.type === "reference_number")
    ? extractSchemaV2FactOccurrences(normalizedRawContent)
      .filter(occurrence => occurrence.type === "reference_number")
      .map(occurrence => [occurrence.start, occurrence]) : []);
  // Parse only the safe annotated copy. Restore source-bound characters in the
  // semantic/clean view, keeping its UTF-16 offsets and the annotated bytes intact.
  const replacements = validEvidence
    ? sourceBackslashReplacements(normalizedRawContent, parsed, catalog, issues)
    : new Map();
  const cleanContent = restoreSourceBackslashes(parsed.cleanContent, replacements);
  for (const claim of parsed.claims) {
    validateClaim(claim, byId, cleanContent, issues, options, projectedContext, sourceReferences);
  }
  const typedVerdictSpans = validEvidence
    ? validateReleaseStages(normalizedRawContent, cleanContent, parsed.claims, catalog, issues) : [];
  const verdictEvidence = validateVerdictEvidence(normalizedRawContent, normalizedAnnotatedContent, catalog, options, typedVerdictSpans);
  issues.push(...verdictEvidence.issues);
  findUnmarkedProtectedFacts(
    parsed.cleanContent,
    parsed.markedCleanSpans,
    catalog,
    issues,
    normalizedRawContent,
    parsed.claims,
    replacements,
    cleanContent,
    verdictEvidence.typedVerdictSpans
  );
  const nonFacts = validateNonFactRules(cleanContent, options);
  issues.push(...nonFacts.issues);

  return {
    cleanContent,
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
