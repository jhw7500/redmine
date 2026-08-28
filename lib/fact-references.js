function annotateFactReferences(rawContent, catalog) {
  const source = String(rawContent);
  let annotated = source;
  const sourceFacts = catalog.facts
    .filter((fact) => fact.sourceLocation)
    .sort((left, right) => left.sourceLocation.start - right.sourceLocation.start);

  let previousEnd = -1;
  for (const fact of sourceFacts) {
    const { start, end } = fact.sourceLocation;
    if (start < previousEnd) {
      const error = new Error(`fact ${fact.id} overlaps another source span`);
      error.code = "FACT_SOURCE_OVERLAP";
      throw error;
    }
    if (source.slice(start, end) !== fact.raw) {
      const error = new Error(`fact ${fact.id} does not match its source span`);
      error.code = "FACT_SOURCE_MISMATCH";
      throw error;
    }
    previousEnd = end;
  }

  for (const fact of [...sourceFacts].reverse()) {
    const { start, end } = fact.sourceLocation;
    annotated = `${annotated.slice(0, start)}[[fact:${fact.id}]]${annotated.slice(end)}`;
  }
  return annotated;
}

function expandFactReferences(content, catalog) {
  const byId = new Map(catalog.facts.map((fact) => [fact.id, fact]));
  return String(content).replace(/\[\[fact:([TQVS]\d{4})\]\]/g, (reference, factId) => {
    const fact = byId.get(factId);
    return fact ? `[[fact:${factId}|${fact.raw}]]` : reference;
  });
}

function formatSystemFactReferences(catalog) {
  return catalog.facts
    .filter((fact) => !fact.sourceLocation)
    .map((fact) => `- ${fact.subject || fact.type}: [[fact:${fact.id}]]`)
    .join("\n");
}

module.exports = {
  annotateFactReferences,
  expandFactReferences,
  formatSystemFactReferences,
};
