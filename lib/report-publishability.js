const NON_BLOCKING_SOURCE_ITEM_WARNINGS = new Set([
  "missing_source_id",
  "duplicate_source_id",
]);

function isNonBlockingSourceItemWarning(issue) {
  return /^N\d{4}$/.test(issue.id || "")
    && NON_BLOCKING_SOURCE_ITEM_WARNINGS.has(issue.code);
}

function blockingWarnings(validation) {
  return (validation.issues || []).filter(
    (issue) => issue.severity === "warning" && !isNonBlockingSourceItemWarning(issue)
  );
}

function isPublishable(validation) {
  if (validation.status === "PASS") return true;
  if (validation.status !== "WARNING") return false;
  return blockingWarnings(validation).length === 0;
}

module.exports = {
  blockingWarnings,
  isPublishable,
};
