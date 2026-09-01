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
  const sourceIssues = sourceCoverage.issues.map((issue) => ({ severity: "error", ...issue }));
  const issues = [...sourceIssues, ...factResult.validation.issues];

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
