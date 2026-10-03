const { test } = require("node:test");
const assert = require("node:assert");

const {
  collectMergedPullRequestEvidence,
  extractExplicitIssueReferences,
  parseChangeEvidence,
} = require("../change-evidence");

const VALID_PR_BODY = `### Contract version
v1

### Summary
카메라 재시작 시 이전 스트림 상태를 안전하게 복구한다.

### Changes
- 오래된 런타임 값을 거부하고 기본 상태를 다시 계산한다.

### Validation
- node --test: 12/12 PASS

### Impact and risks
기존 설정 파일 형식은 유지한다.

### Related issue
Closes #42`;

const VALID_ISSUE_BODY = `### Contract version
v1

### Context and problem
카메라 재시작 후 이전 스트림 값이 남아 복구가 실패했다.

### Goal
재시작 후 유효한 스트림 상태만 복원한다.

### Non-goals
Not applicable: 장치 펌웨어는 변경하지 않는다.

### Acceptance criteria
- [x] 오래된 상태가 거부된다.

### Constraints and impact
기존 설정 파일과 호환되어야 한다.`;

const VALID_COMMIT_BODY = `### Contract version
v1

### Why
재시작 후 오래된 스트림 값이 남았다.

### Changes
- 오래된 값을 거부하고 기본 상태를 다시 계산한다.

### Validation
- node --test: 12/12 PASS

### References
#42`;

test("Change Evidence v1 parser accepts canonical PR, Issue, and commit fields", () => {
  const pullRequest = parseChangeEvidence("pull-request", VALID_PR_BODY);
  const issue = parseChangeEvidence("issue", VALID_ISSUE_BODY);
  const commit = parseChangeEvidence(
    "commit",
    `fix(camera): restore a valid stream state\n\n${VALID_COMMIT_BODY}`
  );

  assert.strictEqual(pullRequest.classification, "v1-valid");
  assert.strictEqual(pullRequest.fields.Summary,
    "카메라 재시작 시 이전 스트림 상태를 안전하게 복구한다.");
  assert.deepStrictEqual(pullRequest.lists.Changes,
    ["오래된 런타임 값을 거부하고 기본 상태를 다시 계산한다."]);
  assert.strictEqual(issue.classification, "v1-valid");
  assert.strictEqual(issue.fields.Goal, "재시작 후 유효한 스트림 상태만 복원한다.");
  assert.strictEqual(commit.classification, "v1-valid");
  assert.deepStrictEqual(commit.lists.Validation, ["node --test: 12/12 PASS"]);
});

test("declared v1 with reordered or placeholder fields is never consumed as valid", () => {
  const reordered = VALID_PR_BODY
    .replace("### Summary\n카메라 재시작 시 이전 스트림 상태를 안전하게 복구한다.\n\n### Changes",
      "### Changes\n- 오래된 값을 거부한다.\n\n### Summary")
    .replace("### Changes\n- 오래된 런타임 값을 거부하고 기본 상태를 다시 계산한다.\n\n### Validation",
      "### Validation");
  const placeholder = VALID_PR_BODY.replace(
    "기존 설정 파일 형식은 유지한다.",
    "TBD"
  );

  assert.strictEqual(parseChangeEvidence("pull-request", reordered).classification, "v1-invalid");
  assert.strictEqual(parseChangeEvidence("pull-request", placeholder).classification, "v1-invalid");
  assert.strictEqual(parseChangeEvidence("pull-request", "Legacy prose only").classification,
    "legacy-unstructured");
  assert.strictEqual(parseChangeEvidence("pull-request", VALID_PR_BODY.replace(
    "Closes #42",
    "<https://github.com/acme/camera/issues/42>"
  )).classification, "v1-valid");
  assert.strictEqual(parseChangeEvidence("pull-request", VALID_PR_BODY.replace(
    "Closes #42",
    "https://github.com/acme/camera/pull/42"
  )).classification, "v1-invalid");
});

test("Markdown-wrapped placeholders are rejected as rendered placeholder evidence", () => {
  const summaryPlaceholder = VALID_PR_BODY.replace(
    "카메라 재시작 시 이전 스트림 상태를 안전하게 복구한다.",
    "`TBD`"
  );
  const changesPlaceholder = VALID_PR_BODY.replace(
    "오래된 런타임 값을 거부하고 기본 상태를 다시 계산한다.",
    "**TODO**"
  );
  const validationPlaceholder = VALID_PR_BODY.replace(
    "node --test: 12/12 PASS",
    "_TBD_"
  );

  for (const body of [summaryPlaceholder, changesPlaceholder, validationPlaceholder]) {
    const result = parseChangeEvidence("pull-request", body);
    assert.strictEqual(result.classification, "v1-invalid");
    assert.ok(result.findings.some(finding => finding.startsWith("placeholder:")));
  }
});

test("placeholder lists cannot be padded with punctuation-only items", () => {
  const changesPlaceholder = VALID_PR_BODY.replace(
    "- 오래된 런타임 값을 거부하고 기본 상태를 다시 계산한다.",
    "- TODO\n- ..."
  );
  const validationPlaceholder = VALID_PR_BODY.replace(
    "- node --test: 12/12 PASS",
    "- `TBD`\n- ---"
  );

  for (const [field, body] of [
    ["Changes", changesPlaceholder],
    ["Validation", validationPlaceholder],
  ]) {
    const result = parseChangeEvidence("pull-request", body);
    assert.strictEqual(result.classification, "v1-invalid");
    assert.ok(result.findings.includes(`placeholder:${field}`));
  }
});

test("fenced and commented examples are not live references or checklists", async () => {
  const exampleReferences = [
    "```text",
    "Closes #42",
    "```",
    "<!-- Related to #43 -->",
  ].join("\n");
  const pullBody = VALID_PR_BODY.replace("Closes #42", exampleReferences);
  const pullRequest = parseChangeEvidence("pull-request", pullBody);
  const issue = parseChangeEvidence("issue", VALID_ISSUE_BODY.replace(
    "- [x] 오래된 상태가 거부된다.",
    "```md\n- [x] example only\n```\n<!-- - [x] hidden example -->"
  ));
  const commit = parseChangeEvidence(
    "commit",
    `fix(camera): ignore reference examples\n\n${VALID_COMMIT_BODY.replace(
      "#42",
      "```text\n#42\n```\n<!-- #43 -->"
    )}`
  );

  assert.strictEqual(pullRequest.classification, "v1-invalid");
  assert.ok(pullRequest.findings.includes("related-issue-reference"));
  assert.strictEqual(issue.classification, "v1-invalid");
  assert.ok(issue.findings.includes("acceptance-checklist"));
  assert.strictEqual(commit.classification, "v1-invalid");
  assert.ok(commit.findings.includes("commit-reference"));
  assert.deepStrictEqual(extractExplicitIssueReferences(
    exampleReferences,
    { owner: "acme", repo: "camera" },
    { allowBare: true }
  ), []);

  const requests = [];
  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch: async (url) => {
      requests.push(url);
      if (url.includes("/pulls?")) return response([{
        number: 7,
        title: "fix(camera): ignore reference examples",
        body: pullBody,
        merged_at: "2026-09-25T03:00:00Z",
      }]);
      if (url.includes("/pulls/7/commits")) return response([]);
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.strictEqual(result.status, "success");
  assert.deepStrictEqual(result.records[0].issues, []);
  assert.strictEqual(Object.hasOwn(result.records[0].pullRequest, "rawBody"), false);
  assert.strictEqual(requests.some(url => /\/issues\/\d+$/.test(url)), false);
});

test("inline and indented code examples are not live references", async () => {
  const exampleReferences = [
    "`Closes #42`",
    "",
    "    Related to #43",
  ].join("\n");
  const pullBody = VALID_PR_BODY.replace("Closes #42", exampleReferences);
  const pullRequest = parseChangeEvidence("pull-request", pullBody);
  const commit = parseChangeEvidence(
    "commit",
    `fix(camera): ignore inline reference examples\n\n${VALID_COMMIT_BODY.replace(
      "#42",
      "`#42`\n\n    #43"
    )}`
  );

  assert.strictEqual(pullRequest.classification, "v1-invalid");
  assert.ok(pullRequest.findings.includes("related-issue-reference"));
  assert.strictEqual(commit.classification, "v1-invalid");
  assert.ok(commit.findings.includes("commit-reference"));
  assert.deepStrictEqual(extractExplicitIssueReferences(
    exampleReferences,
    { owner: "acme", repo: "camera" },
    { allowBare: true }
  ), []);

  const requests = [];
  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch: async (url) => {
      requests.push(url);
      if (url.includes("/pulls?")) return response([{
        number: 7,
        title: "fix(camera): ignore inline reference examples",
        body: pullBody,
        merged_at: "2026-09-25T03:00:00Z",
      }]);
      if (url.includes("/pulls/7/commits")) return response([]);
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.strictEqual(result.status, "success");
  assert.deepStrictEqual(result.records[0].issues, []);
  assert.strictEqual(Object.hasOwn(result.records[0].pullRequest, "rawBody"), false);
  assert.strictEqual(requests.some(url => /\/issues\/\d+$/.test(url)), false);
});

test("leading indented code stays non-live while list continuations remain visible", async () => {
  const indentedExample = "    Closes #42";
  const pullBody = VALID_PR_BODY.replace("Closes #42", indentedExample);
  const pullRequest = parseChangeEvidence("pull-request", pullBody);
  const commit = parseChangeEvidence(
    "commit",
    `fix(camera): ignore a leading indented example\n\n${VALID_COMMIT_BODY.replace(
      "#42",
      "    #42"
    )}`
  );
  const visibleListContinuation = [
    "- Related work:",
    "    Closes #42",
  ].join("\n");
  const visiblePullRequest = parseChangeEvidence(
    "pull-request",
    VALID_PR_BODY.replace("Closes #42", visibleListContinuation)
  );

  assert.strictEqual(pullRequest.classification, "v1-invalid");
  assert.ok(pullRequest.findings.includes("related-issue-reference"));
  assert.strictEqual(commit.classification, "v1-invalid");
  assert.ok(commit.findings.includes("commit-reference"));
  assert.deepStrictEqual(extractExplicitIssueReferences(
    indentedExample,
    { owner: "acme", repo: "camera" },
    { allowBare: true }
  ), []);
  assert.strictEqual(visiblePullRequest.classification, "v1-valid");
  assert.deepStrictEqual(extractExplicitIssueReferences(
    visibleListContinuation,
    { owner: "acme", repo: "camera" }
  ), [{ owner: "acme", repo: "camera", number: 42 }]);

  const requests = [];
  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch: async (url) => {
      requests.push(url);
      if (url.includes("/pulls?")) return response([{
        number: 7,
        title: "fix(camera): ignore a leading indented example",
        body: pullBody,
        merged_at: "2026-09-25T03:00:00Z",
      }]);
      if (url.includes("/pulls/7/commits")) return response([]);
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.strictEqual(result.status, "success");
  assert.deepStrictEqual(result.records[0].issues, []);
  assert.strictEqual(requests.some(url => /\/issues\/\d+$/.test(url)), false);
});

test("thematic breaks do not turn following indented code into live references", async () => {
  for (const relatedIssue of [
    "- - -\n\n    Closes #42",
    "* * *\n\n    Closes #42",
    "- Parent\n    - - -\n\n        Closes #42",
    "- Parent\n    * * *\n\n        Closes #42",
  ]) {
    const pullBody = VALID_PR_BODY.replace("Closes #42", relatedIssue);
    const parsed = parseChangeEvidence("pull-request", pullBody);
    assert.strictEqual(parsed.classification, "v1-invalid");
    assert.ok(parsed.findings.includes("related-issue-reference"));
    assert.deepStrictEqual(extractExplicitIssueReferences(
      relatedIssue,
      { owner: "acme", repo: "camera" }
    ), []);

    const requests = [];
    const result = await collectMergedPullRequestEvidence({
      owner: "acme",
      repo: "camera",
      startDate: "2026-09-24T00:00:00Z",
      endDate: "2026-09-26T00:00:00Z",
      token: "test-token",
      fetch: async (url) => {
        requests.push(url);
        if (url.includes("/pulls?")) return response([{
          number: 7,
          title: "fix(camera): keep thematic-break examples non-live",
          body: pullBody,
          merged_at: "2026-09-25T03:00:00Z",
        }]);
        if (url.includes("/pulls/7/commits")) return response([]);
        throw new Error(`unexpected request: ${url}`);
      },
    });

    assert.strictEqual(result.status, "success");
    assert.deepStrictEqual(result.records[0].issues, []);
    assert.strictEqual(requests.some(url => /\/issues\/\d+$/.test(url)), false);
  }
});

test("nested list continuations keep live references visible", async () => {
  for (const relatedIssue of [
    "- Parent\n    - Related work:\n        Closes #42",
    "1. Parent\n   1. Related work:\n      Closes #42",
  ]) {
    const pullBody = VALID_PR_BODY.replace("Closes #42", relatedIssue);
    const parsed = parseChangeEvidence("pull-request", pullBody);
    assert.strictEqual(parsed.classification, "v1-valid");
    assert.deepStrictEqual(extractExplicitIssueReferences(
      relatedIssue,
      { owner: "acme", repo: "camera" }
    ), [{ owner: "acme", repo: "camera", number: 42 }]);
  }

  const pullBody = VALID_PR_BODY.replace(
    "Closes #42",
    "- Parent\n    - Related work:\n        Closes #42"
  );
  const requests = [];
  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch: async (url) => {
      requests.push(url);
      if (url.includes("/pulls?")) return response([{
        number: 7,
        title: "fix(camera): keep nested list references live",
        body: pullBody,
        merged_at: "2026-09-25T03:00:00Z",
      }]);
      if (url.includes("/pulls/7/commits")) return response([]);
      if (url.endsWith("/issues/42")) return response({
        number: 42,
        title: "Nested list reference",
        body: VALID_ISSUE_BODY,
      });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.strictEqual(result.status, "success");
  assert.deepStrictEqual(result.records[0].issues.map(issue => issue.number), [42]);
  assert.strictEqual(requests.filter(url => url.endsWith("/issues/42")).length, 1);
});

test("unclosed HTML comments cannot conceal v1 PR, Issue, or commit contracts", async () => {
  const hiddenPullRequest = `<!--\n${VALID_PR_BODY}`;
  const hiddenIssue = `<!--\n${VALID_ISSUE_BODY}`;
  const hiddenCommit = `fix(camera): reject hidden evidence\n\n<!--\n${VALID_COMMIT_BODY}`;

  for (const [kind, document] of [
    ["pull-request", hiddenPullRequest],
    ["issue", hiddenIssue],
    ["commit", hiddenCommit],
  ]) {
    const parsed = parseChangeEvidence(kind, document);
    assert.strictEqual(parsed.classification, "v1-invalid");
    assert.ok(parsed.findings.includes("invalid-comment"));
  }

  const requests = [];
  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch: async (url) => {
      requests.push(url);
      if (url.includes("/pulls?")) return response([{
        number: 7,
        title: "fix(camera): reject a hidden PR contract",
        body: hiddenPullRequest,
        merged_at: "2026-09-25T02:00:00Z",
      }, {
        number: 8,
        title: "fix(camera): reject a hidden Issue contract",
        body: VALID_PR_BODY,
        merged_at: "2026-09-25T03:00:00Z",
      }]);
      if (url.includes("/pulls/7/commits") || url.includes("/pulls/8/commits")) {
        return response([]);
      }
      if (url.endsWith("/issues/42")) return response({
        number: 42,
        title: "hidden Issue contract",
        body: hiddenIssue,
      });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  const hiddenPullRecord = result.records.find(record => record.number === 7);
  const hiddenIssueRecord = result.records.find(record => record.number === 8);
  assert.strictEqual(hiddenPullRecord.pullRequest.contract.classification, "v1-invalid");
  assert.strictEqual(Object.hasOwn(hiddenPullRecord.pullRequest, "rawBody"), false);
  assert.strictEqual(hiddenIssueRecord.issues[0].contract.classification, "v1-invalid");
  assert.strictEqual(Object.hasOwn(hiddenIssueRecord.issues[0], "rawBody"), false);
  assert.strictEqual(requests.filter(url => url.endsWith("/issues/42")).length, 1);
});

test("malformed HTML comment delimiters invalidate declared or concealed contracts", () => {
  const strayCloser = parseChangeEvidence(
    "pull-request",
    VALID_PR_BODY.replace("### Summary", "-->\n### Summary")
  );
  const misplacedConcealment = parseChangeEvidence(
    "pull-request",
    `prefix <!--\n${VALID_PR_BODY}\n-->`
  );

  assert.strictEqual(strayCloser.classification, "v1-invalid");
  assert.ok(strayCloser.findings.includes("invalid-comment"));
  assert.strictEqual(misplacedConcealment.classification, "v1-invalid");
  assert.ok(misplacedConcealment.findings.includes("comment-opener-position"));
});

test("linked Issues require an explicit relationship and never infer incidental numbers", () => {
  assert.deepStrictEqual(extractExplicitIssueReferences([
    "Closes #42 and refs #43.",
    "See #99 for similar work.",
    "https://github.com/acme/camera/issues/44",
    "https://github.com/acme/camera/pull/45",
    "Related to platform/runtime#46",
  ].join("\n"), { owner: "acme", repo: "camera" }), [
    { owner: "acme", repo: "camera", number: 42 },
    { owner: "acme", repo: "camera", number: 43 },
    { owner: "acme", repo: "camera", number: 44 },
    { owner: "platform", repo: "runtime", number: 46 },
  ]);
});

test("negated relationship phrases never link or validate Issues", () => {
  const negated = [
    "does not fix #41",
    "will not close #42",
    "not related to #43",
    "doesn't resolve #44",
  ].join("\n");

  assert.deepStrictEqual(extractExplicitIssueReferences(
    negated,
    { owner: "acme", repo: "camera" },
    { allowBare: true }
  ), []);

  const pullRequest = parseChangeEvidence(
    "pull-request",
    VALID_PR_BODY.replace("Closes #42", "does not fix #42")
  );
  assert.strictEqual(pullRequest.classification, "v1-invalid");
  assert.ok(pullRequest.findings.includes("related-issue-reference"));
});

test("merged PR collection seals raw PR/Issue evidence and covered commit SHAs", async () => {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    if (url.includes("/pulls?") && url.includes("page=1")) {
      return response([{
        number: 7,
        title: "fix(camera): restore a valid stream state",
        body: VALID_PR_BODY,
        html_url: "https://github.com/acme/camera/pull/7",
        merged_at: "2026-09-25T03:00:00Z",
        merge_commit_sha: "a".repeat(40),
      }]);
    }
    if (url.endsWith("/pulls/7/commits?per_page=100&page=1")) {
      return response([{ sha: "b".repeat(40) }]);
    }
    if (url.endsWith("/issues/42")) {
      return response({
        number: 42,
        title: "재시작 상태 복구",
        body: VALID_ISSUE_BODY,
        html_url: "https://github.com/acme/camera/issues/42",
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch,
  });

  assert.strictEqual(result.status, "success");
  assert.strictEqual(result.records.length, 1);
  assert.deepStrictEqual(result.records[0].coveredCommitShas,
    ["a".repeat(40), "b".repeat(40)]);
  assert.strictEqual(result.records[0].pullRequest.rawBody, VALID_PR_BODY);
  assert.strictEqual(result.records[0].pullRequest.contract.classification, "v1-valid");
  assert.strictEqual(result.records[0].issues[0].rawBody, VALID_ISSUE_BODY);
  assert.strictEqual(result.records[0].issues[0].contract.classification, "v1-valid");
  assert.ok(requests.every(url => !url.includes("test-token")));
});

test("cross-repository linked Issues degrade without an authenticated fetch", async () => {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    if (url.includes("/pulls?")) return response([{
      number: 7,
      title: "fix(camera): reject an untrusted Issue reference",
      body: VALID_PR_BODY.replace("Closes #42", "Closes private/secret#7"),
      merged_at: "2026-09-25T03:00:00Z",
    }]);
    if (url.includes("/pulls/7/commits")) return response([]);
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await collectMergedPullRequestEvidence({
    owner: "public",
    repo: "source",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch,
  });

  assert.strictEqual(result.status, "degraded");
  assert.deepStrictEqual(result.records[0].issues, []);
  assert.strictEqual(requests.some(url => url.includes("/repos/private/secret/")), false);
  assert.ok(result.errors.some(error => error.stage === "linked-issue"
    && error.message.includes("outside the permitted repository")));
});

test("timezone-less report boundaries stay KST under UTC and Asia/Seoul hosts", async () => {
  const originalTimeZone = process.env.TZ;
  try {
    for (const timeZone of ["UTC", "Asia/Seoul"]) {
      process.env.TZ = timeZone;
      const result = await collectMergedPullRequestEvidence({
        owner: "acme",
        repo: "camera",
        startDate: "2026-09-23T06:00:00",
        endDate: "2026-09-30T05:59:59",
        fetch: async (url) => {
          if (url.includes("/pulls?")) return response([{
            number: 1,
            title: "fix: include work just after the KST start",
            body: "",
            merged_at: "2026-09-22T21:00:00.001Z",
          }, {
            number: 2,
            title: "fix: exclude work after the KST end",
            body: "",
            merged_at: "2026-09-29T21:00:00.000Z",
          }]);
          if (url.includes("/pulls/1/commits")) return response([]);
          throw new Error(`unexpected request: ${url}`);
        },
      });

      assert.strictEqual(result.status, "success");
      assert.deepStrictEqual(result.records.map(record => record.number), [1]);
    }
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
});

test("linked Issue references beyond the collection bound degrade explicitly", async () => {
  const requests = [];
  const references = Array.from({ length: 11 }, (_, index) =>
    `https://github.com/acme/camera/issues/${index + 1}`);
  const fetch = async (url) => {
    requests.push(url);
    if (url.includes("/pulls?")) return response([{
      number: 9,
      title: "fix(camera): restore a valid stream state",
      body: VALID_PR_BODY.replace("Closes #42", references.join("\n")),
      merged_at: "2026-09-25T03:00:00Z",
      merge_commit_sha: "a".repeat(40),
    }]);
    if (url.includes("/pulls/9/commits")) return response([]);
    const issueMatch = url.match(/\/issues\/(\d+)$/);
    if (issueMatch) return response({
      number: Number(issueMatch[1]),
      title: `Issue ${issueMatch[1]}`,
      body: VALID_ISSUE_BODY,
    });
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch,
  });

  assert.strictEqual(result.status, "degraded");
  assert.strictEqual(result.records[0].issues.length, 10);
  assert.ok(result.errors.some(error => error.stage === "linked-issue"
    && error.message.includes("11 explicit Issue references")));
  assert.strictEqual(requests.some(url => url.endsWith("/issues/11")), false);
});

test("merged PR collection paginates beyond 100 covered commits", async () => {
  const requests = [];
  const shas = Array.from({ length: 101 }, (_, index) =>
    (index + 1).toString(16).padStart(40, "0"));
  const fetch = async (url) => {
    requests.push(url);
    if (url.includes("/pulls?")) return response([{
      number: 8,
      title: "chore: publish a large release",
      body: "Legacy PR prose.",
      merged_at: "2026-09-25T03:00:00Z",
      merge_commit_sha: shas[0],
    }]);
    if (url.endsWith("/pulls/8/commits?per_page=100&page=1")) {
      return response(shas.slice(0, 100).map(sha => ({ sha })));
    }
    if (url.endsWith("/pulls/8/commits?per_page=100&page=2")) {
      return response([{ sha: shas[100] }]);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch,
  });

  assert.strictEqual(result.status, "success");
  assert.deepStrictEqual(result.records[0].coveredCommitShas, shas);
  assert.ok(requests.some(url => url.endsWith("page=2")));
});

test("merged PR collection marks GitHub's 250-commit response cap incomplete", async () => {
  const requests = [];
  const shas = Array.from({ length: 250 }, (_, index) =>
    (index + 1).toString(16).padStart(40, "0"));
  const fetch = async (url) => {
    requests.push(url);
    if (url.includes("/pulls?")) return response([{
      number: 9,
      title: "chore: publish a capped release",
      body: "Legacy PR prose.",
      merged_at: "2026-09-25T03:00:00Z",
      merge_commit_sha: shas[0],
    }]);
    const page = Number(new URL(url).searchParams.get("page"));
    if (url.includes("/pulls/9/commits")) {
      const start = (page - 1) * 100;
      return response(shas.slice(start, start + 100).map(sha => ({ sha })));
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch,
  });

  assert.strictEqual(result.status, "degraded");
  assert.deepStrictEqual(result.records[0].coveredCommitShas, shas);
  assert.ok(result.errors.some(error => error.stage === "pull-commits"
    && error.message.includes("250-commit response limit")));
  assert.strictEqual(requests.filter(url => url.includes("/pulls/9/commits")).length, 3);
});

test("GitHub API failure is an explicit degraded result, not an exception", async () => {
  const result = await collectMergedPullRequestEvidence({
    owner: "acme",
    repo: "camera",
    startDate: "2026-09-24T00:00:00Z",
    endDate: "2026-09-26T00:00:00Z",
    token: "test-token",
    fetch: async () => response({ message: "rate limited" }, 403),
  });

  assert.deepStrictEqual(result.records, []);
  assert.strictEqual(result.status, "degraded");
  assert.match(result.errors[0].message, /HTTP 403/);
  assert.doesNotMatch(JSON.stringify(result), /test-token/);
});

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}
