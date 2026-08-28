const { spawnSync } = require("child_process");
const { splitOpenStatusClauses } = require("./open-status-clauses");

const OPEN_STATUS_PATTERN = /(미해결|미완료|미완|보류|TODO|FIXME)/i;
const AS_OF_PATTERN = /\((\d{4}-\d{2}-\d{2})\s*기준\s*(?:미해결|미완료|미완|보류)\)/i;
const RESOLUTION_SUBJECT_PATTERN = /(fix|fixed|resolve|resolved|correct|repair|해결|수정|완료|정정)/i;
const STOP_WORDS = new Set([
  "기준", "미해결", "미완료", "미완", "보류", "todo", "fixme",
  "작업", "항목", "상태", "현재", "관련", "대한", "위한", "진행",
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractSymbols(line) {
  const inline = Array.from(String(line).matchAll(/`([^`\n]{2,100})`/g), (match) => match[1].trim());
  const codeLike = Array.from(
    String(line).matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_./:-][A-Za-z0-9_[\]./:-]+)+\b/g),
    (match) => match[0]
  );
  return unique([...inline, ...codeLike])
    .filter((value) => !/^https?:/i.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value))
    .slice(0, 6);
}

function extractKeywords(line) {
  return unique(
    String(line)
      .replace(/`[^`]+`/g, " ")
      .replace(/\([^)]*기준[^)]*\)/g, " ")
      .match(/[A-Za-z][A-Za-z0-9-]{3,}|[가-힣]{2,}/g) || []
  )
    .map((word) => word.toLowerCase())
    .filter((word) => !STOP_WORDS.has(word))
    .slice(0, 8);
}

function extractOpenStatusClaims(reportContent) {
  return String(reportContent)
    .split("\n")
    .flatMap((line, index) => splitOpenStatusClauses(line)
      .map((clause) => ({ line: clause, lineNumber: index + 1 })))
    .filter((claim) => claim.line && OPEN_STATUS_PATTERN.test(claim.line))
    .map((claim) => {
      const asOf = claim.line.match(AS_OF_PATTERN);
      return {
        ...claim,
        asOf: asOf ? asOf[1] : null,
        symbols: extractSymbols(claim.line),
        keywords: extractKeywords(claim.line),
      };
    });
}

function defaultRunGit(repoPath, args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    error: result.status === 0 ? null : (result.stderr || `git exit ${result.status}`).trim(),
  };
}

function parseLog(stdout) {
  return String(stdout)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, ...subject] = line.split("\t");
      return { hash, subject: subject.join("\t") };
    });
}

function subjectMatchesClaim(subject, claim) {
  const lower = String(subject).toLowerCase();
  if (!RESOLUTION_SUBJECT_PATTERN.test(lower)) return false;
  return [...claim.keywords, ...claim.symbols.map((symbol) => symbol.toLowerCase())]
    .some((term) => term.length >= 3 && lower.includes(term));
}

function verifyOpenIssueClaims(reportContent, repos, options = {}) {
  const claims = extractOpenStatusClaims(reportContent);
  const runGit = options.runGit || defaultRunGit;
  const issues = [];
  const checks = [];

  for (const claim of claims) {
    // 기준일 누락은 fact-validator가 별도 오류로 처리한다.
    if (!claim.asOf) continue;
    const claimCheck = { ...claim, repos: [] };

    if (!claim.symbols.length) {
      issues.push({
        severity: "warning",
        code: "open_status_pickaxe_unavailable",
        message: "미해결 상태를 pickaxe로 확인할 코드 심볼이 없습니다. 수동 검토가 필요합니다.",
        line: claim.line,
      });
    }

    for (const [repoName, repo] of Object.entries(options.unavailableRepos || {})) {
      const error = repo.reason || `Git checkout unavailable: ${repo.gitPath || repo.path}`;
      issues.push({
        severity: "error",
        code: "open_status_repo_unavailable",
        message: `${repoName} 저장소를 확인할 수 없어 미해결 상태 검증을 완료하지 못했습니다: ${error}`,
        line: claim.line,
        repo: repoName,
        path: repo.path,
      });
      claimCheck.repos.push({
        repo: repoName,
        path: repo.path,
        available: false,
        error,
      });
    }

    for (const [repoName, repo] of Object.entries(repos || {})) {
      const since = `--since=${claim.asOf}T00:00:00+09:00`;
      const titleResult = runGit(repo.path, ["log", since, "--format=%H%x09%s"]);
      const repoCheck = {
        repo: repoName,
        path: repo.path,
        titleCheck: { ok: titleResult.ok, matches: [] },
        pickaxeChecks: [],
      };

      if (!titleResult.ok) {
        repoCheck.titleCheck.error = titleResult.error;
        issues.push({
          severity: "warning",
          code: "open_status_git_check_failed",
          message: `${repoName} Git 제목 이력 확인에 실패했습니다: ${titleResult.error}`,
          line: claim.line,
        });
      } else {
        repoCheck.titleCheck.matches = parseLog(titleResult.stdout)
          .filter((commit) => subjectMatchesClaim(commit.subject, claim));
      }

      for (const symbol of claim.symbols) {
        const result = runGit(repo.path, [
          "log", since, "-S", symbol, "--format=%H%x09%s",
        ]);
        if (!result.ok) {
          issues.push({
            severity: "warning",
            code: "open_status_git_pickaxe_failed",
            message: `${repoName} Git pickaxe (${symbol}) 확인에 실패했습니다: ${result.error}`,
            line: claim.line,
          });
        }
        repoCheck.pickaxeChecks.push({
          symbol,
          ok: result.ok,
          matches: result.ok ? parseLog(result.stdout) : [],
          ...(result.ok ? {} : { error: result.error }),
        });
      }

      const evidence = unique([
        ...repoCheck.titleCheck.matches.map((commit) => `${commit.hash} ${commit.subject}`),
        ...repoCheck.pickaxeChecks.flatMap((check) =>
          check.matches.map((commit) => `${commit.hash} ${commit.subject} (-S ${check.symbol})`)
        ),
      ]);
      if (evidence.length) {
        issues.push({
          severity: "warning",
          code: "open_status_resolution_evidence",
          message: `${repoName}에서 기준일 이후 해결 가능성이 있는 변경을 찾았습니다. 완료 여부를 확인하세요.`,
          line: claim.line,
          evidence,
        });
      }
      claimCheck.repos.push(repoCheck);
    }
    checks.push(claimCheck);
  }

  return { issues, checks };
}

module.exports = {
  extractKeywords,
  extractOpenStatusClaims,
  extractSymbols,
  subjectMatchesClaim,
  verifyOpenIssueClaims,
};
