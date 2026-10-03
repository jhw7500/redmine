const { sha256 } = require("./report-artifact");
const { validateAnnotatedReport } = require("./fact-validator");
const { validateSourceCoverage } = require("./source-coverage");

function statusFromIssues(issues) {
  return issues.some((issue) => issue.severity === "error")
    ? "FAIL"
    : issues.some((issue) => issue.severity === "warning")
      ? "WARNING"
      : "PASS";
}

function sourceIssueSeverity(issue) {
  const isNotionItem = /^N\d{4}$/.test(issue.id || "");
  const advisoryCodes = new Set(["missing_source_id", "duplicate_source_id"]);
  return isNotionItem && advisoryCodes.has(issue.code) ? "warning" : "error";
}

function undefinedEvidenceIssues(content) {
  return String(content).split("\n").flatMap((line, index) =>
    /^\s*↳\s*(?:목적|변경|검증):\s*undefined\s*$/i.test(line)
      ? [{
        severity: "error",
        code: "undefined_evidence_value",
        message: "누락된 변경 근거가 undefined 문자열로 렌더링되었습니다.",
        line: index + 1,
      }]
      : []
  );
}

function validateV2ReportContract(
  rawContent,
  annotatedContent,
  factCatalog,
  coverageCatalog,
  options = {}
) {
  if (!coverageCatalog) {
    return validateAnnotatedReport(rawContent, annotatedContent, factCatalog, options);
  }

  const sourceCoverage = validateSourceCoverage(annotatedContent, coverageCatalog);
  const factResult = validateAnnotatedReport(
    rawContent,
    sourceCoverage.cleanContent,
    factCatalog,
    options
  );
  const sourceIssues = sourceCoverage.issues.map((issue) => ({
    ...issue,
    severity: sourceIssueSeverity(issue),
  }));
  const issues = [
    ...sourceIssues,
    ...factResult.validation.issues,
    ...undefinedEvidenceIssues(factResult.cleanContent),
  ];

  return {
    cleanContent: factResult.cleanContent,
    validation: {
      ...factResult.validation,
      status: statusFromIssues(issues),
      annotatedDraftHash: sha256(annotatedContent),
      sourceCoverageMode: options.sourceCoverageMode,
      coverageCatalogHash: coverageCatalog.coverageCatalogHash,
      sourceCoverage: sourceCoverage.coverage,
      issues,
    },
  };
}

module.exports = { validateV2ReportContract };
