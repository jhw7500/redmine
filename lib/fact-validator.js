const { sha256 } = require("./report-artifact");
const { verifyOpenIssueClaims } = require("./open-issue-verifier");

const OPEN_STATUS_PATTERN = /(미해결|미완료|미완|보류|TODO|FIXME)/i;
const AS_OF_PATTERN = /\(\d{4}-\d{2}-\d{2}\s*기준\s*(?:미해결|미완료|미완|보류)\)/i;

function addIssue(issues, severity, code, message, detail = {}) {
  issues.push({ severity, code, message, ...detail });
}

function occupied(overlaps, start, end) {
  return overlaps.some((span) => start < span.end && end > span.start);
}

function extractTestFacts(text) {
  const facts = [];
  const spans = [];
  const patterns = [
    {
      re: /PASS\s*(\d+)\s*\/\s*(\d+)/gi,
      build: (match) => ({ pass: Number(match[1]), fail: Number(match[2]) }),
    },
    {
      re: /(\d+)\s*\/\s*(\d+)\s*PASS/gi,
      build: (match) => ({ pass: Number(match[1]), total: Number(match[2]) }),
    },
    {
      re: /(\d+)\s*건?\s*PASS[^\n\d]{0,24}(?:실패|FAIL)\s*(\d+)\s*건?/gi,
      build: (match) => ({ pass: Number(match[1]), fail: Number(match[2]) }),
    },
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupied(spans, start, end)) continue;
      const fact = pattern.build(match);
      if (fact.fail !== undefined) fact.total = fact.pass + fact.fail;
      if (fact.total !== undefined && fact.fail === undefined && fact.total >= fact.pass) {
        fact.fail = fact.total - fact.pass;
      }
      facts.push({ ...fact, raw: match[0] });
      spans.push({ start, end });
    }
  }

  const standalone = /(\d+)\s*건?\s*PASS/gi;
  for (const match of text.matchAll(standalone)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!occupied(spans, start, end)) {
      facts.push({ pass: Number(match[1]), raw: match[0] });
    }
  }
  return facts;
}

function testFactSupported(outputFact, sourceFacts) {
  return sourceFacts.some((source) => {
    if (source.pass !== outputFact.pass) return false;
    if (outputFact.total !== undefined && source.total !== outputFact.total) return false;
    if (outputFact.fail !== undefined && source.fail !== outputFact.fail) return false;
    return true;
  });
}

function maskTestFacts(text) {
  return String(text)
    .replace(/PASS\s*\d+\s*\/\s*\d+/gi, " ")
    .replace(/\d+\s*\/\s*\d+\s*PASS/gi, " ")
    .replace(/\d+\s*건?\s*PASS[^\n\d]{0,24}(?:실패|FAIL)\s*\d+\s*건?/gi, " ")
    .replace(/\d+\s*건?\s*PASS/gi, " ");
}

function extractProtectedTokens(text) {
  const source = maskTestFacts(text);
  const tokens = new Set();
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
      tokens.add(match[0].replace(/\s+/g, "").toLowerCase());
    }
  }
  return tokens;
}

// 범용 조수사로만 끝나는 수량 토큰. 원본이 "3방안"·"3캠페인"처럼 구체 명사로 센 것을
// 요약이 "3개"로 바꿔 쓰는 것은 수치 날조가 아니라 조수사 표기 차이다.
// ms·MB·% 같은 물리량이나 버전은 여기 포함하지 않는다 — 그건 표기가 곧 사실이다.
// 가지·번·차례는 extractProtectedTokens의 단위 목록에 아직 없어 토큰으로 뽑히지 않는다.
// 그 목록을 넓힐 때 함께 동작하도록 미리 넣어 둔다.
const GENERIC_COUNTER_TOKEN = /^(\d+(?:\.\d+)?)(?:개|건|회|가지|번|차례)$/;

// 수량을 "숫자 + 조수사 + 센 대상"으로 분해한다. 숫자만 대조하면 원본 어딘가에 있던
// 무관한 숫자(날짜 "7월", 시간 "3분")가 "7건"·"3건" 같은 날조를 통과시킨다.
// 조사가 붙어도 맞물리도록 대상은 앞 2글자만 키로 쓴다("방안뿐"·"방안만" → "방안").
function extractCountedQuantities(text) {
  const entries = [];
  // extractProtectedTokens의 (?!\w)는 한글을 막지 못해 "3개월"에서도 "3개"가 토큰으로
  // 뽑힌다. 그래도 근거 없이 통과하지 않는 이유는 아래 lookahead가 "개월"의 "개"를
  // 조수사로 보지 않아 이 토큰의 대조 대상이 비기 때문이다. 두 규칙이 맞물려 동작한다.
  // 조수사는 뒤에 공백이나 "의"가 올 때만 조수사다. "3개월"의 "개"는 복합어의 일부이며,
  // 이를 조수사로 보면 원본의 "3월"(March)이 "3개월"(3 months)의 근거가 되어버린다.
  const pattern = /(\d+(?:\.\d+)?)\s*(?:(개|건|회|가지|번|차례)(?=[\s의]))?\s*(?:의\s*)?([가-힣]+)/g;
  for (const match of maskTestFacts(text).matchAll(pattern)) {
    entries.push({
      token: `${match[1]}${match[2] || ""}`,      // 보고서에서 어느 토큰이 셌는지
      key: `${match[1]} ${match[3].slice(0, 2)}`, // 무엇을 몇으로 셌는지 (조수사 무관)
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

function validateReport(rawContent, reportContent, options = {}) {
  const issues = [];
  const sourceFacts = extractTestFacts(rawContent);
  const outputFacts = extractTestFacts(reportContent);

  for (const fact of outputFacts) {
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
  const sourceKeys = new Set(extractCountedQuantities(rawContent).map((entry) => entry.key));
  const outputCounts = extractCountedQuantities(reportContent);
  for (const token of extractProtectedTokens(reportContent)) {
    if (sourceTokens.has(token)) continue;
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

  for (const line of String(reportContent).split("\n")) {
    // 프로젝트 규율상 인라인 코드의 TODO/FIXME도 open 상태로 취급해 as-of 검증을 요구한다.
    if (OPEN_STATUS_PATTERN.test(line) && !AS_OF_PATTERN.test(line)) {
      addIssue(
        issues,
        "error",
        "open_status_without_as_of",
        "미해결·미완료·보류 상태에는 YYYY-MM-DD 기준 날짜가 필요합니다.",
        { line: line.trim() }
      );
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

  const status = issues.some((issue) => issue.severity === "error")
    ? "FAIL"
    : issues.some((issue) => issue.severity === "warning")
      ? "WARNING"
      : "PASS";

  return {
    schemaVersion: 1,
    status,
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
      openIssueChecks: openIssueVerification.checks,
    },
    issues,
  };
}

module.exports = {
  extractProtectedTokens,
  extractTestFacts,
  testFactSupported,
  validateReport,
};
