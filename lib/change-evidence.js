const { parseEnvDate } = require("./report-range");

const CONTRACT_VERSION = "v1";
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_LINKED_ISSUE_REFERENCES = 10;

const DEFINITIONS = Object.freeze({
  issue: {
    fields: [
      "Contract version",
      "Context and problem",
      "Goal",
      "Non-goals",
      "Acceptance criteria",
      "Constraints and impact",
    ],
  },
  "pull-request": {
    fields: [
      "Contract version",
      "Summary",
      "Changes",
      "Validation",
      "Impact and risks",
      "Related issue",
    ],
  },
  commit: {
    fields: ["Contract version", "Why", "Changes", "Validation", "References"],
  },
});

const PLACEHOLDER = /^(?:tbd|todo|n\/?a|unknown|미정|추후|<(?!https?:\/\/)[^>]+>)\.?$/i;
const REASONED_SENTINEL = /^(?:Unknown|Not applicable):\s+\S.+$/i;
const NOT_RUN_SENTINEL = /^Not run:\s+\S.+$/i;
const GENERIC_COMMIT_TITLE = /^(?:update|fix|wip|수정|작업)[.!]?$/i;

function renderedPlaceholderText(value) {
  let candidate = String(value || "").trim();
  for (let pass = 0; pass < 8; pass += 1) {
    const prior = candidate;
    const code = candidate.match(/^(`+)([^]*?)\1$/);
    if (code) candidate = code[2].trim();
    for (const [open, close] of [["**", "**"], ["__", "__"], ["*", "*"], ["_", "_"]]) {
      if (candidate.startsWith(open) && candidate.endsWith(close)
        && candidate.length > open.length + close.length) {
        candidate = candidate.slice(open.length, -close.length).trim();
      }
    }
    const link = candidate.match(/^\[([^\]\r\n]+)\]\([^\r\n]*\)$/);
    if (link) candidate = link[1].trim();
    if (candidate === prior) break;
  }
  return candidate;
}

function isPlaceholder(value) {
  return PLACEHOLDER.test(renderedPlaceholderText(value));
}

function hasVisibleEvidence(value) {
  return /[\p{L}\p{N}]/u.test(renderedPlaceholderText(value));
}

function fenceMarker(line) {
  const match = String(line).match(/^ {0,3}(`{3,}|~{3,})/);
  return match ? { character: match[1][0], length: match[1].length } : null;
}

function closesFence(line, fence) {
  const match = String(line).match(/^ {0,3}(`{3,}|~{3,})[ \t\r]*$/);
  return Boolean(match && match[1][0] === fence.character && match[1].length >= fence.length);
}

function analyzeHtmlComments(text) {
  const lines = String(text).split("\n");
  const visibleLines = [];
  let fence = null;
  let inComment = false;
  let invalidComment = false;
  let invalidCommentPosition = false;

  for (const line of lines) {
    if (fence) {
      visibleLines.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (!inComment) {
      const marker = fenceMarker(line);
      if (marker) {
        fence = marker;
        visibleLines.push(line);
        continue;
      }
    }

    let visible = "";
    let index = 0;
    while (index < line.length) {
      if (inComment) {
        const nestedOpen = line.indexOf("<!--", index);
        const close = line.indexOf("-->", index);
        if (nestedOpen !== -1 && (close === -1 || nestedOpen < close)) {
          invalidComment = true;
          visible += " ".repeat(nestedOpen + 4 - index);
          index = nestedOpen + 4;
          continue;
        }
        if (close === -1) {
          visible += " ".repeat(line.length - index);
          index = line.length;
          continue;
        }
        visible += " ".repeat(close + 3 - index);
        index = close + 3;
        inComment = false;
        continue;
      }

      const open = line.indexOf("<!--", index);
      const strayClose = line.indexOf("-->", index);
      if (open === -1 && strayClose === -1) {
        visible += line.slice(index);
        break;
      }
      if (strayClose !== -1 && (open === -1 || strayClose < open)) {
        visible += line.slice(index, strayClose) + "   ";
        index = strayClose + 3;
        invalidComment = true;
        continue;
      }

      visible += line.slice(index, open) + "    ";
      if (!/^ {0,3}$/.test(line.slice(0, open))) invalidCommentPosition = true;
      index = open + 4;
      inComment = true;
    }
    visibleLines.push(visible);
  }

  if (inComment) invalidComment = true;
  return {
    visibleText: visibleLines.join("\n"),
    invalidComment,
    invalidCommentPosition,
  };
}

function hideFencedCode(text) {
  const lines = String(text).split("\n");
  const visibleLines = [];
  let fence = null;
  for (const line of lines) {
    if (fence) {
      visibleLines.push(" ".repeat(line.length));
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker) {
      fence = marker;
      visibleLines.push(" ".repeat(line.length));
      continue;
    }
    visibleLines.push(line);
  }
  return visibleLines.join("\n");
}

function markdownEvidenceText(text) {
  return hideFencedCode(analyzeHtmlComments(text).visibleText);
}

function leadingIndentColumns(line) {
  let columns = 0;
  for (const character of String(line)) {
    if (character === " ") {
      columns += 1;
    } else if (character === "\t") {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
  }
  return columns;
}

function isThematicBreak(line, containerIndent = 0) {
  const indent = leadingIndentColumns(line);
  if (indent < containerIndent || indent > containerIndent + 3) return false;
  return /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\r?$/.test(
    String(line).trimStart()
  );
}

function listIndent(line, containerIndent) {
  if (isThematicBreak(line, containerIndent)) return null;
  const match = String(line).match(/^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)/);
  if (!match) return null;
  const markerIndent = leadingIndentColumns(match[1]);
  let contentIndent = markerIndent + match[2].length;
  for (const character of match[3]) {
    contentIndent += character === "\t" ? 4 - (contentIndent % 4) : 1;
  }
  return { markerIndent, contentIndent };
}

function hideIndentedCode(text) {
  const visibleLines = [];
  const activeListIndents = [];
  for (const line of String(text).split("\n")) {
    if (/^[ \t\r]*$/.test(line)) {
      visibleLines.push(line);
      continue;
    }

    const indent = leadingIndentColumns(line);
    while (activeListIndents.length
      && indent < activeListIndents[activeListIndents.length - 1]) {
      activeListIndents.pop();
    }

    const parentIndent = activeListIndents[activeListIndents.length - 1];
    const marker = listIndent(line, parentIndent === undefined ? 0 : parentIndent);
    const isVisibleListMarker = marker && (
      marker.markerIndent <= 3
      || (parentIndent !== undefined
        && marker.markerIndent >= parentIndent
        && marker.markerIndent < parentIndent + 4)
    );
    if (isVisibleListMarker) {
      activeListIndents.push(marker.contentIndent);
      visibleLines.push(line);
      continue;
    }

    const activeListIndent = activeListIndents[activeListIndents.length - 1];
    const codeIndent = activeListIndent === undefined ? 4 : activeListIndent + 4;
    visibleLines.push(indent >= codeIndent ? line.replace(/[^\r]/g, " ") : line);
  }
  return visibleLines.join("\n");
}

function hideInlineCode(text) {
  const source = String(text);
  const visible = source.split("");
  let index = 0;

  while (index < source.length) {
    if (source[index] !== "`") {
      index += 1;
      continue;
    }

    let openerEnd = index + 1;
    while (source[openerEnd] === "`") openerEnd += 1;
    const delimiterLength = openerEnd - index;
    let cursor = openerEnd;
    let closerEnd = -1;

    while (cursor < source.length) {
      const closerStart = source.indexOf("`", cursor);
      if (closerStart === -1) break;
      let candidateEnd = closerStart + 1;
      while (source[candidateEnd] === "`") candidateEnd += 1;
      if (candidateEnd - closerStart === delimiterLength) {
        closerEnd = candidateEnd;
        break;
      }
      cursor = candidateEnd;
    }

    if (closerEnd === -1) {
      index = openerEnd;
      continue;
    }
    for (let offset = index; offset < closerEnd; offset += 1) {
      if (source[offset] !== "\n" && source[offset] !== "\r") visible[offset] = " ";
    }
    index = closerEnd;
  }

  return visible.join("");
}

function markdownReferenceText(text) {
  return hideInlineCode(hideIndentedCode(markdownEvidenceText(text)));
}

function trimFieldBoundary(text) {
  const lines = String(text).split("\n");
  while (lines.length && /^[ \t\r]*$/.test(lines[0])) lines.shift();
  while (lines.length && /^[ \t\r]*$/.test(lines[lines.length - 1])) lines.pop();
  if (!lines.length) return "";
  lines[0] = lines[0].replace(/^ {1,3}(?=\S)/, "");
  return lines.map(line => line.replace(/[ \t\r]+$/, "")).join("\n");
}

function visibleFieldText(text) {
  return trimFieldBoundary(text);
}

function topLevelListItems(text) {
  const items = [];
  for (const line of markdownEvidenceText(text).split(/\r?\n/)) {
    const match = line.match(/^ {0,3}[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/);
    if (match && match[1]) items.push(match[1]);
  }
  return items;
}

function hasChecklist(text) {
  return markdownEvidenceText(text).split(/\r?\n/)
    .some(line => /^ {0,3}[-*+]\s+\[[ xX]\]\s+\S/.test(line));
}

function isNegatedRelationship(source, index) {
  const lineStart = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const prefix = source.slice(lineStart, index).slice(-64);
  return /(?:\bnot|n['’]t)[*_~]*[ \t]*$/i.test(prefix);
}

function parseMarkdownReferences(text, currentRepository = {}, options = {}) {
  const source = markdownReferenceText(text);
  const references = [];
  const negatedIssueHashes = new Set();
  let containsIssue = false;
  let containsPullRequest = false;
  const add = (owner, repo, number, index) => {
    const ref = { owner, repo, number: Number(number), index };
    if (!ref.owner || !ref.repo || !Number.isInteger(ref.number) || ref.number < 1) return;
    if (!references.some(item => item.owner === ref.owner
      && item.repo === ref.repo && item.number === ref.number)) references.push(ref);
  };

  for (const match of source.matchAll(
    /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\b/gi
  )) {
    containsIssue = true;
    add(match[1], match[2], match[3], match.index);
  }
  for (const _match of source.matchAll(
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\b/gi
  )) containsPullRequest = true;

  const relation = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|related\s+to)\s*:?[ \t]*(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi;
  for (const match of source.matchAll(relation)) {
    const hashIndex = match.index + match[0].lastIndexOf("#");
    if (isNegatedRelationship(source, match.index)) {
      negatedIssueHashes.add(hashIndex);
      continue;
    }
    containsIssue = true;
    add(match[1] || currentRepository.owner, match[2] || currentRepository.repo,
      match[3], match.index);
  }

  for (const match of source.matchAll(/(?:^|[^\w/])#(\d+)\b/g)) {
    const hashIndex = match.index + match[0].lastIndexOf("#");
    if (negatedIssueHashes.has(hashIndex)) continue;
    containsIssue = true;
    if (options.allowBare) {
      add(currentRepository.owner, currentRepository.repo, match[1], hashIndex);
    }
  }

  return {
    containsIssue,
    containsChange: containsIssue || containsPullRequest,
    issueReferences: references.sort((left, right) => left.index - right.index)
      .map(({ index: _index, ...reference }) => reference),
  };
}

function hasIssueReference(text) {
  return parseMarkdownReferences(text).containsIssue;
}

function hasChangeReference(text) {
  return parseMarkdownReferences(text).containsChange;
}

function parseFields(text) {
  const lines = String(text).split(/\r?\n/);
  const headings = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker) {
      fence = marker;
      continue;
    }
    const anyHeading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*$/);
    if (anyHeading) headings.push({
      level: anyHeading[1].length,
      name: anyHeading[2],
      line: index,
    });
  }

  const fields = {};
  const levelThree = headings.filter(heading => heading.level === 3);
  for (let index = 0; index < levelThree.length; index += 1) {
    const heading = levelThree[index];
    const next = levelThree[index + 1];
    fields[heading.name] = trimFieldBoundary(
      lines.slice(heading.line + 1, next ? next.line : lines.length).join("\n")
    );
  }
  return { fields, headings, levelThree };
}

function resemblesContract(parsed, definition) {
  const names = parsed.levelThree.map(heading => heading.name);
  return names.includes("Contract version")
    || names.some(name => definition.fields.includes(name));
}

function parseChangeEvidence(kind, document) {
  const definition = DEFINITIONS[kind];
  if (!definition) throw new Error(`Unsupported Change Evidence kind: ${kind}`);
  const raw = String(document || "");
  let title = null;
  let body = raw;
  const findings = [];

  if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) findings.push("document-too-large");
  if (raw.includes("\0")) findings.push("nul-byte");

  if (kind === "commit") {
    const match = raw.match(/^([^\r\n]+)\r?\n\r?\n([^]*)$/);
    if (!match) {
      return { classification: "legacy-unstructured", kind, version: null, findings: ["commit-envelope"] };
    }
    title = match[1].trim();
    body = match[2];
    if (!title || title.length > 72 || GENERIC_COMMIT_TITLE.test(title)) {
      findings.push("commit-title");
    }
  }

  const comments = analyzeHtmlComments(body);
  if (comments.invalidComment) findings.push("invalid-comment");
  if (comments.invalidCommentPosition) findings.push("comment-opener-position");
  const parsed = parseFields(comments.visibleText);
  const concealedMalformedContract = (comments.invalidComment || comments.invalidCommentPosition)
    && resemblesContract(parseFields(body), definition);
  if (!resemblesContract(parsed, definition) && !concealedMalformedContract) {
    return { classification: "legacy-unstructured", kind, version: null, findings: [] };
  }

  const names = parsed.levelThree.map(heading => heading.name);
  if (parsed.headings.some(heading => heading.level !== 3)) findings.push("unexpected-heading-level");
  if (names.length !== new Set(names).size) findings.push("duplicate-field");
  if (names.length !== definition.fields.length
    || !definition.fields.every((field, index) => names[index] === field)) {
    findings.push("field-order");
  }

  const fields = {};
  const lists = {};
  for (const field of definition.fields) {
    const value = visibleFieldText(parsed.fields[field] || "");
    fields[field] = value;
    lists[field] = topLevelListItems(value);
    if (!value) findings.push(`empty:${field}`);
    if (value && !/[\p{L}\p{N}]/u.test(value)) findings.push(`no-visible-evidence:${field}`);
    if (isPlaceholder(value)) findings.push(`placeholder:${field}`);
    const evidenceItems = lists[field].filter(item => hasVisibleEvidence(item));
    if (evidenceItems.some(item => isPlaceholder(item))) {
      findings.push(`placeholder:${field}`);
    }
    if (/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/.test(value)) {
      findings.push(`raw-html:${field}`);
    }
    if (/^ {0,3}\[[^\]]+\]:/m.test(value)) findings.push(`link-reference-definition:${field}`);
  }

  if (fields["Contract version"] !== CONTRACT_VERSION) findings.push("contract-version");
  if (kind === "issue") {
    if (!hasChecklist(fields["Acceptance criteria"])) findings.push("acceptance-checklist");
    for (const field of ["Non-goals", "Constraints and impact"]) {
      if (/^(?:Unknown|Not applicable):/i.test(fields[field])
        && !REASONED_SENTINEL.test(fields[field])) findings.push(`sentinel:${field}`);
    }
  }
  const absenceAllowed = kind === "issue"
    ? new Set(["Non-goals", "Constraints and impact"])
    : kind === "pull-request" ? new Set(["Impact and risks"]) : new Set();
  for (const [field, value] of Object.entries(fields)) {
    if (/^(?:Unknown|Not applicable):/i.test(value) && !absenceAllowed.has(field)) {
      findings.push(`sentinel-not-allowed:${field}`);
    }
    if (/^Not run:/i.test(value) && field !== "Validation") {
      findings.push(`not-run-not-allowed:${field}`);
    }
  }
  if (kind === "pull-request" || kind === "commit") {
    if (!lists.Changes.length) findings.push("changes-list");
    if (!lists.Validation.length && !NOT_RUN_SENTINEL.test(fields.Validation)) {
      findings.push("validation-evidence");
    }
  }
  if (kind === "pull-request") {
    if (/^(?:Unknown|Not applicable):/i.test(fields["Impact and risks"])
      && !REASONED_SENTINEL.test(fields["Impact and risks"])) {
      findings.push("sentinel:Impact and risks");
    }
    if (!hasIssueReference(fields["Related issue"])) findings.push("related-issue-reference");
  }
  if (kind === "commit" && !hasChangeReference(fields.References)) {
    findings.push("commit-reference");
  }

  return {
    classification: findings.length ? "v1-invalid" : "v1-valid",
    kind,
    version: fields["Contract version"] || null,
    ...(title ? { title } : {}),
    fields,
    lists,
    findings: [...new Set(findings)],
  };
}

function extractExplicitIssueReferences(text, currentRepository, options = {}) {
  return parseMarkdownReferences(text, currentRepository, options).issueReferences;
}

function requestError(stage, status) {
  const error = new Error(`GitHub ${stage} request failed (HTTP ${status})`);
  error.stage = stage;
  return error;
}

async function fetchJson(fetchImpl, url, headers, stage) {
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    throw requestError(stage, "network");
  }
  if (!response || !response.ok) throw requestError(stage, response ? response.status : "unknown");
  try {
    return await response.json();
  } catch {
    throw requestError(stage, "invalid-json");
  }
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function timestampInRange(value, startDate, endDate) {
  const timestamp = Date.parse(value);
  let start;
  let end;
  try {
    start = parseEnvDate(startDate, "start").getTime();
    end = parseEnvDate(endDate, "end").getTime();
  } catch {
    return false;
  }
  return Number.isFinite(timestamp) && Number.isFinite(start) && Number.isFinite(end)
    && timestamp >= start && timestamp <= end;
}

function safeBody(assertSafeBody, body) {
  if (typeof assertSafeBody === "function") assertSafeBody(body);
}

function provenanceContract(contract) {
  if (contract.classification === "v1-valid") return contract;
  return {
    classification: contract.classification,
    kind: contract.kind,
    findings: [...contract.findings],
  };
}

function normalizedError(error, repository, stage) {
  return {
    repository,
    stage: error.stage || stage,
    message: error.message || `GitHub ${stage} request failed`,
  };
}

function isSameRepositoryReference(reference, owner, repo) {
  return String(reference.owner).toLowerCase() === String(owner).toLowerCase()
    && String(reference.repo).toLowerCase() === String(repo).toLowerCase();
}

async function collectPullCommitShas(fetchImpl, headers, owner, repo, pullNumber) {
  const shas = [];
  let responseCount = 0;
  for (let page = 1; page <= 3; page += 1) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/commits?per_page=100&page=${page}`;
    const batch = await fetchJson(fetchImpl, url, headers, "pull-commits");
    if (!Array.isArray(batch)) throw requestError("pull-commits", "invalid-payload");
    responseCount += batch.length;
    shas.push(...batch
      .map(commit => commit && commit.sha)
      .filter(sha => typeof sha === "string" && /^[0-9a-f]{40,64}$/i.test(sha)));
    if (responseCount >= 250) return { shas, complete: false };
    if (batch.length < 100) return { shas, complete: true };
  }
  return { shas, complete: false };
}

async function collectMergedPullRequestEvidence(options) {
  const {
    owner,
    repo,
    startDate,
    endDate,
    token,
    fetch: fetchImpl = globalThis.fetch,
    assertSafeBody,
  } = options;
  const repository = `${owner}/${repo}`;
  const errors = [];
  const records = [];
  if (typeof fetchImpl !== "function") {
    return {
      status: "degraded",
      records,
      errors: [{ repository, stage: "pull-list", message: "GitHub fetch is unavailable" }],
    };
  }
  const headers = githubHeaders(token);
  let pulls = [];
  try {
    for (let page = 1; page <= 10; page += 1) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
      const batch = await fetchJson(fetchImpl, url, headers, "pull-list");
      if (!Array.isArray(batch)) throw requestError("pull-list", "invalid-payload");
      pulls.push(...batch.filter(pull => pull && pull.merged_at
        && timestampInRange(pull.merged_at, startDate, endDate)));
      if (batch.length < 100) break;
      if (page === 10) errors.push({
        repository,
        stage: "pull-list",
        message: "GitHub pull listing reached the 10-page safety limit",
      });
    }
  } catch (error) {
    if (error && error.code === "COMMIT_BODY_CREDENTIAL_DETECTED") throw error;
    return { status: "degraded", records, errors: [normalizedError(error, repository, "pull-list")] };
  }

  for (const pull of pulls) {
    try {
      const pullTitle = String(pull.title || "").trim();
      const rawBody = String(pull.body || "");
      safeBody(assertSafeBody, pullTitle);
      safeBody(assertSafeBody, rawBody);
      const contract = parseChangeEvidence("pull-request", rawBody);
      const relatedText = contract.classification === "v1-valid"
        ? contract.fields["Related issue"]
        : rawBody;
      const issueReferences = extractExplicitIssueReferences(
        relatedText,
        { owner, repo },
        { allowBare: contract.classification === "v1-valid" }
      );
      if (issueReferences.length > MAX_LINKED_ISSUE_REFERENCES) {
        errors.push({
          repository,
          stage: "linked-issue",
          message: `GitHub PR #${pull.number} has ${issueReferences.length} explicit Issue references; only the first ${MAX_LINKED_ISSUE_REFERENCES} are collected`,
        });
      }
      const commitCollection = await collectPullCommitShas(
        fetchImpl, headers, owner, repo, pull.number
      );
      if (!commitCollection.complete) errors.push({
        repository,
        stage: "pull-commits",
        message: `GitHub PR #${pull.number} commit listing reached GitHub's 250-commit response limit`,
      });
      const coveredCommitShas = [pull.merge_commit_sha, ...commitCollection.shas]
        .filter(sha => typeof sha === "string" && /^[0-9a-f]{40,64}$/i.test(sha));
      const issues = [];
      for (const reference of issueReferences.slice(0, MAX_LINKED_ISSUE_REFERENCES)) {
        if (!isSameRepositoryReference(reference, owner, repo)) {
          errors.push({
            repository,
            stage: "linked-issue",
            message: `Explicit reference ${reference.owner}/${reference.repo}#${reference.number} is outside the permitted repository`,
          });
          continue;
        }
        try {
          const issueUrl = `https://api.github.com/repos/${reference.owner}/${reference.repo}/issues/${reference.number}`;
          const issue = await fetchJson(fetchImpl, issueUrl, headers, "linked-issue");
          if (issue && issue.pull_request) {
            errors.push({
              repository,
              stage: "linked-issue",
              message: `Explicit reference ${reference.owner}/${reference.repo}#${reference.number} is a pull request`,
            });
            continue;
          }
          const issueTitle = String(issue && issue.title || "").trim();
          const issueBody = String(issue && issue.body || "");
          safeBody(assertSafeBody, issueTitle);
          safeBody(assertSafeBody, issueBody);
          const issueContract = parseChangeEvidence("issue", issueBody);
          issues.push({
            owner: reference.owner,
            repository: reference.repo,
            number: reference.number,
            title: issueTitle,
            url: String(issue && issue.html_url
              || `https://github.com/${reference.owner}/${reference.repo}/issues/${reference.number}`),
            ...(issueContract.classification === "v1-valid" ? { rawBody: issueBody } : {}),
            contract: provenanceContract(issueContract),
          });
        } catch (error) {
          if (error && error.code === "COMMIT_BODY_CREDENTIAL_DETECTED") throw error;
          errors.push(normalizedError(error, repository, "linked-issue"));
        }
      }
      records.push({
        id: `github:${owner}/${repo}:pull:${pull.number}`,
        owner,
        repository: repo,
        number: Number(pull.number),
        mergedAt: pull.merged_at,
        coveredCommitShas: [...new Set(coveredCommitShas)],
        pullRequest: {
          title: pullTitle,
          url: String(pull.html_url || `https://github.com/${owner}/${repo}/pull/${pull.number}`),
          ...(contract.classification === "v1-valid" ? { rawBody } : {}),
          contract: provenanceContract(contract),
        },
        issues,
      });
    } catch (error) {
      if (error && error.code === "COMMIT_BODY_CREDENTIAL_DETECTED") throw error;
      errors.push(normalizedError(error, repository, "pull-evidence"));
    }
  }

  return { status: errors.length ? "degraded" : "success", records, errors };
}

module.exports = {
  CONTRACT_VERSION,
  collectMergedPullRequestEvidence,
  extractExplicitIssueReferences,
  parseChangeEvidence,
  topLevelListItems,
};
