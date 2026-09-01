const { sha256 } = require("./report-artifact");
const { validateAnnotatedReport } = require("./fact-validator");
const { validateSourceCoverage } = require("./source-coverage");

function scopeError(message) {
  const error = new Error(message);
  error.code = "AI_SCOPE_OUTPUT";
  return error;
}

function projectRoots(config) {
  return Object.values(config.categories || {}).reduce((roots, category) => {
    const root = String(category.parent || "").trim();
    return root && !roots.includes(root) ? [...roots, root] : roots;
  }, []);
}

function topLevelLabel(line) {
  const match = String(line).match(/^-\s+(.+?)\s*$/);
  if (!match) return null;
  return match[1]
    .replace(/\s*\[\[source:[CN]\d{4}\]\]\s*/g, " ")
    .trim();
}

function trimTrailingBlankLines(lines) {
  const result = [...lines];
  while (result.length > 0 && result.at(-1).trim() === "") result.pop();
  return result;
}

function rootBlock(lines, startIndex) {
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (topLevelLabel(line) !== null) {
      endIndex = index;
      break;
    }
    if (line.trim() !== "" && !/^\s/.test(line)) {
      endIndex = index;
      break;
    }
  }
  return trimTrailingBlankLines(lines.slice(startIndex, endIndex));
}

function splitProjectSources(rawContent, config) {
  const source = String(rawContent);
  const lines = source.split("\n");
  const header = config.env.sectionHeader;
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) throw scopeError("조현우 section header가 없습니다.");

  const roots = projectRoots(config);
  const seen = new Set();
  const calls = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const label = topLevelLabel(lines[index]);
    if (!roots.includes(label)) continue;
    if (seen.has(label)) throw scopeError(`최상위 프로젝트가 중복됐습니다: ${label}`);
    seen.add(label);
    const block = rootBlock(lines, index);
    calls.push({
      id: label,
      source: `${header}\n\n${block.join("\n")}\n`,
    });
  }
  return roots.flatMap((root) => calls.filter((call) => call.id === root));
}

function finalizeCalls(calls, config, meetingDate, promptOptions, promptBuilder) {
  return calls.map((call) => {
    const options = call.id === "whole"
      ? { ...promptOptions }
      : { ...promptOptions, generationRoot: call.id };
    const prompt = promptBuilder(call.source, config, meetingDate, options);
    return {
      ...call,
      prompt,
      promptHash: sha256(prompt),
      promptLength: prompt.length,
    };
  });
}

function buildGenerationPlan(rawContent, config, meetingDate, promptOptions, promptBuilder) {
  if (typeof promptBuilder !== "function") {
    throw new TypeError("promptBuilder must be a function");
  }
  const scope = config.env.aiGenerationScope || "whole";
  const calls = scope === "project"
    ? splitProjectSources(rawContent, config)
    : [{ id: "whole", source: String(rawContent) }];
  if (calls.length === 0) throw scopeError("생성할 최상위 프로젝트가 없습니다.");
  const finalizedCalls = finalizeCalls(
    calls,
    config,
    meetingDate,
    promptOptions || {},
    promptBuilder
  );
  const promptHash = scope === "whole"
    ? finalizedCalls[0].promptHash
    : sha256(JSON.stringify(finalizedCalls.map(({ id, promptHash: hash, promptLength }) => ({
      id,
      promptHash: hash,
      promptLength,
    }))));
  return { scope, calls: finalizedCalls, promptHash };
}

function outputRootBlock(output, expectedRoot, sectionHeader) {
  const lines = String(output).split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === sectionHeader);
  if (headerIndex === -1) {
    throw scopeError(`${expectedRoot} 출력에 조현우 section header가 없습니다.`);
  }
  const topLevelIndexes = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (topLevelLabel(lines[index]) !== null) topLevelIndexes.push(index);
  }
  if (topLevelIndexes.length !== 1) {
    throw scopeError(`${expectedRoot} 출력의 최상위 프로젝트는 정확히 하나여야 합니다.`);
  }
  const rootIndex = topLevelIndexes[0];
  const actualRoot = topLevelLabel(lines[rootIndex]);
  if (actualRoot !== expectedRoot) {
    throw scopeError(`${expectedRoot} 출력에 다른 프로젝트가 있습니다: ${actualRoot}`);
  }
  return rootBlock(lines, rootIndex).join("\n");
}

function mergeProjectOutputs(outputs, sectionHeader) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw scopeError("병합할 프로젝트 출력이 없습니다.");
  }
  const blocks = outputs.map(({ id, content }) => outputRootBlock(content, id, sectionHeader));
  return `${sectionHeader}\n\n${blocks.join("\n\n")}\n`;
}

function rootCoverageCatalog(catalog, root) {
  if (!catalog) return null;
  const belongsToRoot = (entry) => entry.requiredPath?.[0] === root;
  return {
    ...catalog,
    sections: catalog.sections.filter(belongsToRoot),
    items: catalog.items.filter(belongsToRoot),
    knownPaths: catalog.knownPaths.filter((knownPath) => knownPath[0] === root),
  };
}

function sourceIssueSeverity(issue) {
  const notionItem = /^N\d{4}$/.test(issue.id || "");
  return notionItem && ["missing_source_id", "duplicate_source_id"].includes(issue.code)
    ? "warning"
    : "error";
}

function validateProjectOutput({ id, content }, rawContent, config, options = {}) {
  try {
    mergeProjectOutputs([{ id, content }], config.env.sectionHeader);
  } catch (error) {
    const validationError = scopeError(error.message);
    validationError.code = "AI_PART_VALIDATION";
    validationError.partId = id;
    validationError.issues = [{ severity: "error", code: error.code, message: error.message }];
    throw validationError;
  }

  const coverage = rootCoverageCatalog(options.coverageCatalog, id);
  const sourceResult = coverage
    ? validateSourceCoverage(content, coverage)
    : { cleanContent: content, issues: [] };
  const factResult = options.factCatalog
    ? validateAnnotatedReport(rawContent, sourceResult.cleanContent, options.factCatalog, {
      meetingDate: options.meetingDate,
      sectionHeader: config.env.sectionHeader,
      knownPaths: options.coverageCatalog?.knownPaths,
    })
    : { validation: { issues: [] } };
  const sourceIssues = sourceResult.issues.map((issue) => ({
      ...issue,
      severity: sourceIssueSeverity(issue),
    }));
  const issues = [...factResult.validation.issues, ...sourceIssues];
  if (issues.some((issue) => issue.severity === "error")) {
    const error = new Error(`${id} 부분 출력이 fact/source 계약을 위반했습니다.`);
    error.code = "AI_PART_VALIDATION";
    error.partId = id;
    error.issues = issues;
    throw error;
  }
  return { id, status: issues.length ? "WARNING" : "PASS", issues };
}

module.exports = {
  buildGenerationPlan,
  mergeProjectOutputs,
  projectRoots,
  splitProjectSources,
  validateProjectOutput,
};
