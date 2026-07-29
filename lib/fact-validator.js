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
const GENERIC_COUNTER_TOKEN = /^(\d+(?:\.\d+)?)(?:개|건|회|가지|번|차례)$/;

// 원본에서 "숫자 + 한글 명사" 형태로 등장한 수량의 숫자만 모은다.
function extractQuantityNumbers(text) {
  const numbers = new Set();
  for (const match of maskTestFacts(text).matchAll(/(\d+(?:\.\d+)?)\s*[가-힣]+/g)) {
    numbers.add(match[1]);
  }
  return numbers;
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
  const sourceQuantities = extractQuantityNumbers(rawContent);
  for (const token of extractProtectedTokens(reportContent)) {
    if (sourceTokens.has(token)) continue;
    // 조수사만 다르고 숫자는 원본과 같으면 통과시킨다. 숫자가 다르면 그대로 오류다.
    const counter = GENERIC_COUNTER_TOKEN.exec(token);
    if (counter && sourceQuantities.has(counter[1])) continue;
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
