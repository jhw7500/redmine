function blockingWarnings(validation) {
  return (validation.issues || []).filter(
    (issue) => issue.severity === "warning"
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
