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
    if (url.endsWith("/pulls/7/commits?per_page=100")) {
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
