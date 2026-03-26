const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const BASE_URL = process.env.REDMINE_BASE_URL || "http://192.168.10.2:30002";
const API_KEY = process.env.REDMINE_API_KEY;
const WIKI_URL_ENV = process.env.WIKI_URL || "";
const PROJECT_ID = process.env.PROJECT_ID || "team-4-weekly-meeting";
const PAGE_SUFFIX = process.env.PAGE_SUFFIX || "개발4팀_주간_회의";
const SECTION_HEADER =
  process.env.SECTION_HEADER || "#### <span style=\"color:blue\">조현우</span>";
const REPO_ROOT = process.env.REPO_ROOT || "/home/jhw/ai/opencode/projects";
const REPO_LIST = process.env.REPO_LIST || "";
const AUTHOR_MATCH = process.env.AUTHOR_MATCH || "";
const EXTRA_NOTES_PATH = process.env.EXTRA_NOTES_PATH || "";
const INCLUDE_MERGES = process.env.INCLUDE_MERGES === "1";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/home/jhw/ai/opencode/projects/redmine/out";
const OUTPUT_PATH = process.env.OUTPUT_PATH || "";
const MODE = process.env.MODE || "generate"; // generate | update
const AUTO_APPROVE = process.env.AUTO_APPROVE === "1";
const AI_EN_PATH =
  process.env.AI_EN_PATH || "/home/jhw/ai/opencode/projects/redmine/templates/ai-en.md";
const AI_KO_PATH =
  process.env.AI_KO_PATH || "/home/jhw/ai/opencode/projects/redmine/templates/ai-ko.md";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "jhw7500";
const TEMPLATE_PATH =
  process.env.TEMPLATE_PATH || "/home/jhw/ai/opencode/projects/redmine/templates/jo-hyunwoo.md";
const MEETING_DATE_OVERRIDE = process.env.MEETING_DATE || ""; // YYYY-MM-DD
const AI_SUMMARIZE = process.env.AI_SUMMARIZE === "1";
const CLAUDE_CLI = process.env.CLAUDE_CLI || "claude";

if (!API_KEY) {
  console.error("Missing REDMINE_API_KEY.");
  process.exit(1);
}

console.log(`GITHUB_TOKEN: ${GITHUB_TOKEN ? "SET" : "UNSET"}`);

function aiSummarize(rawContent) {
  if (!AI_SUMMARIZE) return null;
  const prompt = `아래는 주간 회의 보고서 초안이다. 커밋 단위로 나열되어 있다.
이것을 팀 회의용으로 기능 중심 요약해라.

규칙:
1. 관련 커밋들을 기능 단위로 그룹핑한다. 커밋 단위 나열 금지.
2. 각 기능 항목 아래에 들여쓰기로 세부 내용을 1~2줄 추가한다.
3. 한글 기본, 기술 용어(영어)는 그대로 사용.
4. 사소한 커밋(gitignore, log, chore, 바이너리 업데이트, 서브모듈 업데이트 등)은 제외.
5. 중복 내용은 통합한다.
6. 너무 작은 단위의 변경은 제외.
7. 내부 구현 디테일(TLV, EVENT_PORT_RELEASE 등)은 알기 쉽게 풀어쓴다.
8. 원본과 동일한 마크다운 형식 유지 (#### 헤더, - 들여쓰기 구조).
9. **카테고리 계층 구조를 반드시 유지한다:**
   - "- PIM" 아래에 "  - Application" 하위 카테고리 유지
   - "- Wireless Lan" 아래에 "  - NXP" 하위 카테고리 유지
   - 기능 항목은 하위 카테고리 아래에 들여쓰기로 작성
10. 내용 없는 카테고리는 삭제.
11. 마지막 footer(*작성:...* 및 ---)는 생성하지 않는다. 코드에서 자동 추가한다.
12. 조현우 섹션만 출력한다. 다른 사람의 섹션은 절대 포함하지 않는다.

원본:
${rawContent}

요약된 보고서만 출력해라. 설명이나 주석 없이 마크다운 내용만.`;

  console.log("AI 요약 중...");
  const result = spawnSync(CLAUDE_CLI, ["-p", prompt, "--output-format", "text"], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env },
  });

  if (result.status !== 0) {
    console.error("AI 요약 실패:", result.stderr || result.error);
    return null;
  }

  const output = result.stdout.trim();
  if (!output) return null;
  console.log("AI 요약 완료.");
  return output + "\n";
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function targetWednesday(fromDate) {
  const day = fromDate.getDay(); // 0=Sun
  const target = 3; // Wed
  const d = new Date(fromDate);
  if (day <= target) {
    d.setDate(d.getDate() + (target - day));
  } else {
    d.setDate(d.getDate() + (7 - (day - target)));
  }
  return d;
}

function buildWikiUrl(meetingDate) {
  const title = `${formatDate(meetingDate)}_${PAGE_SUFFIX}`;
  return `${BASE_URL}/projects/${PROJECT_ID}/wiki/${encodeURIComponent(title)}`;
}

function parseMeetingDateFromTitle(title) {
  const match = title.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  return new Date(`${match[1]}T00:00:00`);
}

async function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function buildContent(meetingDate) {
  const start = new Date(meetingDate);
  start.setDate(start.getDate() - 7);
  const replacements = {
    "{{START_DATE}}": formatDate(start),
    "{{END_DATE}}": formatDate(meetingDate),
  };

  let content = fs.readFileSync(TEMPLATE_PATH, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(key).join(value);
  }
  const autoContent = await buildAutoContent(
    replacements["{{START_DATE}}"],
    replacements["{{END_DATE}}"]
  );
  for (const [key, value] of Object.entries(autoContent)) {
    content = content.split(key).join(value);
  }
  return content.trimEnd() + "\n";
}

function extractTitleFromUrl(url) {
  const pathPart = new URL(url).pathname;
  const parts = pathPart.split("/").filter(Boolean);
  let titleEnc = parts[parts.length - 1];
  if (titleEnc === "edit" && parts.length >= 2) {
    titleEnc = parts[parts.length - 2];
  }
  if (titleEnc.endsWith(".json")) {
    titleEnc = titleEnc.slice(0, -".json".length);
  }
  return decodeURIComponent(titleEnc);
}

function extractProjectIdFromUrl(url) {
  const pathPart = new URL(url).pathname;
  const parts = pathPart.split("/").filter(Boolean);
  const projectIndex = parts.indexOf("projects");
  if (projectIndex === -1 || !parts[projectIndex + 1]) return null;
  return parts[projectIndex + 1];
}

function listGitRepos(rootDir) {
  if (REPO_LIST.trim()) {
    return REPO_LIST.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((repoPath) => fs.existsSync(path.join(repoPath, ".git")));
  }
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
    .filter((repoPath) => fs.existsSync(path.join(repoPath, ".git")));
}

function getGitCommits(repoPath, since, until) {
  const args = [
    "-C",
    repoPath,
    "log",
    `--since=${since}`,
    `--until=${until}`,
    "--pretty=format:%s",
  ];
  if (AUTHOR_MATCH.trim()) args.push(`--author=${AUTHOR_MATCH}`);
  if (!INCLUDE_MERGES) args.push("--no-merges");

  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) return [];
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines;
}

function normalizeForDedup(line) {
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

function isTrivialCommit(line) {
  return /^(log|gitignore|__pycache__|chore|merge branch|Merge branch|docs\/plans|\.gitignore)/i.test(
    line.trim()
  );
}

function isWorkflowRelated(line) {
  return /(workflow|workflows|github actions|actions|ci\b|gemini|triage)/i.test(
    line
  );
}

function stripTypePrefix(line) {
  return line.replace(
    /^([A-Za-z0-9_.-]+:\s*)?(feat|fix|docs|chore|refactor|security|revert|debug|ci|restore|test|build|perf)\s*:\s*/i,
    "$1"
  );
}

function translateLine(line) {
  const rules = [
    [/Address code review feedback for PR #(\d+)/i, "PR #$1 코드 리뷰 피드백 반영"],
    [/revert:\s*Defer security improvements for production compatibility/i, "리버트: 프로덕션 호환성 위해 보안 개선 보류"],
    [/Refine postinst printk config and ignore SDK scripts/i, "postinst printk 설정 개선 및 SDK 스크립트 제외"],
    [/Update dist\/wlan\/usr\/local\/scripts\/wifi_logger_cpu\.sh/i, "dist/wlan/usr/local/scripts/wifi_logger_cpu.sh 업데이트"],
    [/Harden packaging scripts and update wlan-bridge/i, "패키징 스크립트 강화 및 wlan-bridge 업데이트"],
    [/Adjust installer time threshold/i, "installer 시간 임계치 조정"],
    [/Fix critical and high priority issues/i, "치명/고우선 이슈 수정"],
    [/post auto review without code fences/i, "코드 펜스 없이 자동 리뷰 게시"],
    [/inline gemini-dispatch actions/i, "gemini-dispatch 액션 인라인화"],
    [/call nested gemini workflows via caller/i, "caller를 통해 중첩 gemini 워크플로 호출"],
    [/make gemini-dispatch safe across events/i, "gemini-dispatch 이벤트 호환성 강화"],
    [/make automation workflows reusable/i, "automation 워크플로 재사용 가능화"],
    [/use unquoted secrets inherit/i, "따옴표 없는 secrets inherit 사용"],
    [/avoid fromJSON var parsing/i, "fromJSON 변수 파싱 회피"],
    [/remove invalid chars from scheduled triage/i, "스케줄된 triage의 잘못된 문자 제거"],
    [/Add write permission for Claude Code Review workflow/i, "Claude Code Review 워크플로 쓰기 권한 추가"],
    [/Add automated re-review request workflow/i, "자동 재리뷰 요청 워크플로 추가"],
    [/improve GitHub Actions workflows with centralized config and security enhancements/i, "중앙 설정과 보안 개선으로 GitHub Actions 워크플로 개선"],
    [/Add security documentation and GitHub Actions workflows/i, "보안 문서 및 GitHub Actions 워크플로 추가"],
    [/avoid submodule checkout in shellcheck/i, "shellcheck에서 서브모듈 체크아웃 회피"],
    [/use shared workflows/i, "공용 워크플로 사용"],
    [/add legacy gemini workflows/i, "레거시 gemini 워크플로 추가"],
    [/reorganize Gemini workflows/i, "Gemini 워크플로 재정리"],
    [/Unify review headers and Gemini prompts/i, "리뷰 헤더 및 Gemini 프롬프트 통합"],
    [/Address PR #(\d+) review feedback/i, "PR #$1 리뷰 피드백 반영"],
    [/Address PR #(\d+),\s*(\d+) review feedback/i, "PR #$1, #$2 리뷰 피드백 반영"],
    [/Address PR #([\d,\s]+) review feedback/i, "PR #$1 리뷰 피드백 반영"],
    [/code review feedback/i, "코드 리뷰 피드백"],
    [/Add write permission/i, "쓰기 권한 추가"],
    [/Add automated re-review request/i, "자동 재리뷰 요청 추가"],
    [/Defer security improvements/i, "보안 개선 보류"],
    [/Improve wifi init and cpu logging/i, "Wi-Fi 초기화 및 CPU 로깅 개선"],
    [/Update (.+)/i, "$1 업데이트"],
    [/Harden (.+)/i, "$1 강화"],
    [/Refine (.+)/i, "$1 개선"],
    [/postinst printk config/i, "postinst printk 설정"],
    [/ignore SDK scripts/i, "SDK 스크립트 제외"],
    [/installer time threshold/i, "installer 시간 임계치"],
    [/packaging scripts/i, "패키징 스크립트"],
    [/review headers/i, "리뷰 헤더"],
    [/Gemini prompts/i, "Gemini 프롬프트"],
    [/GitHub Actions workflows?/i, "GitHub Actions 워크플로우"],
    [/workflow(s)?/i, "workflow"],
    [/actions?/i, "액션"],
    [/security/i, "보안"],
    [/review/i, "리뷰"],
    [/for production compatibility/i, "프로덕션 호환성 위해"],
    [/without code fences/i, "코드 펜스 없이"],
    [/disable nested dispatch jobs/i, "중첩 디스패치 작업 비활성화"],
    [/use unquoted secrets inherit/i, "따옴표 없는 secrets inherit 사용"],
    [/avoid fromJSON var parsing/i, "fromJSON 변수 파싱 회피"],
    [/remove invalid chars from scheduled triage/i, "스케줄된 triage의 잘못된 문자 제거"],
    [/inline gemini-dispatch actions/i, "gemini-dispatch 액션 인라인화"],
    [/make gemini-dispatch safe across events/i, "gemini-dispatch 이벤트 호환성 강화"],
    [/call nested gemini workflows via caller/i, "caller로 중첩 gemini 워크플로 호출"],
    [/make automation workflows reusable/i, "automation 워크플로 재사용 가능화"],
    [/add shared Gemini\/Claude workflows/i, "공용 Gemini/Claude 워크플로 추가"],
    [/\blegacy\b/i, "레거시"],
    [/\bshared\b/i, "공용"],
    [/\brestore\b/i, "복원"],
    [/\buse\b/i, "사용"],
    [/\bavoid\b/i, "회피"],
    [/\bdisable\b/i, "비활성화"],
    [/\binline\b/i, "인라인화"],
    [/\bsafe\b/i, "안정화"],
    [/\breusable\b/i, "재사용 가능"],
    [/\bmake\b/i, "구성"],
    [/\bcall\b/i, "호출"],
    [/\badd\b/i, "추가"],
    [/\bremove\b/i, "제거"],
    [/\bimprove\b/i, "개선"],
    [/\bwith\b/gi, "및"],
    [/\band\b/gi, "및"],
    [/\bvia\b/gi, "통해"],
    [/\btriage\b/gi, "트리아주"],
    [/\bsecrets inherit\b/gi, "secrets 상속"],
  ];
  let output = stripTypePrefix(line);
  for (const [pattern, replacement] of rules) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function formatList(items, indent, emptyLabel) {
  if (!items.length) return `${indent}${emptyLabel}`;
  return items
    .map((item) => {
      if (item.startsWith("\t")) {
        const base = indent.endsWith("- ") ? indent.slice(0, -2) : indent;
        return `${base}  - ${item.slice(1)}`;
      }
      return `${indent}${item}`;
    })
    .join("\n");
}

function formatBulletsFromFile(filePath, indent, emptyLabel) {
  if (!filePath || !fs.existsSync(filePath)) return `${indent}${emptyLabel}`;
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("-") ? line.slice(1).trim() : line))
    .filter((line) => line.toLowerCase() !== "ai");
  if (!lines.length) return `${indent}${emptyLabel}`;
  return lines.map((line) => `${indent}${line}`).join("\n");
}

function normalizeSummaryLine(line) {
  const cleaned = String(line)
    .replace(/^#{1,6}\s*/g, "")
    .replace(/^summary\s*[:：-]?\s*/i, "")
    .replace(/^[-*]\s*/g, "")
    .trim();
  return cleaned;
}

function firstBodyLine(body) {
  if (!body) return null;
  const rawLines = String(body).split("\n").map((line) => line.trim());
  const summaryIndex = rawLines.findIndex((line) => /^#{1,6}\s*summary\b/i.test(line));
  if (summaryIndex !== -1) {
    for (let i = summaryIndex + 1; i < rawLines.length; i += 1) {
      const cleaned = normalizeSummaryLine(rawLines[i]);
      if (cleaned && !/^(code review|summary)$/i.test(cleaned)) return cleaned;
    }
  }
  const first = rawLines
    .map(normalizeSummaryLine)
    .find((line) => line && !/^(code review|summary)$/i.test(line));
  return first || null;
}

function extractHighlightsLines(body) {
  if (!body) return null;
  const rawLines = String(body).split("\n").map((line) => line.trim());
  const idx = rawLines.findIndex((line) => /^#{1,6}\s*highlights\b/i.test(line));
  if (idx !== -1) {
    const highlights = [];
    for (let i = idx + 1; i < rawLines.length; i += 1) {
      if (/^#{1,6}\s+/.test(rawLines[i])) break;
      const cleaned = normalizeSummaryLine(rawLines[i]);
      if (cleaned) highlights.push(cleaned);
    }
    return highlights.length ? highlights : null;
  }
  const altIdx = rawLines.findIndex((line) => /^highlights\b\s*:?/i.test(line));
  if (altIdx !== -1) {
    const highlights = [];
    for (let i = altIdx + 1; i < rawLines.length; i += 1) {
      if (/^#{1,6}\s+/.test(rawLines[i])) break;
      const cleaned = normalizeSummaryLine(rawLines[i]);
      if (cleaned) highlights.push(cleaned);
    }
    return highlights.length ? highlights : null;
  }
  return null;
}

function extractBulletLines(body) {
  if (!body) return null;
  const lines = String(body)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
  return lines.length ? lines : null;
}

function pruneHighlights(lines, maxItems = 3) {
  if (!Array.isArray(lines)) return null;
  const filtered = lines.filter((line) => {
    if (!line) return false;
    if (line.endsWith(":")) return false;
    if (/^`.+`$/.test(line)) return false;
    if (/^\\*\\*[^*]+\\*\\*:$/i.test(line)) return false;
    if (/^\*\*DEBIAN/i.test(line)) return false;
    if (line.startsWith("dist/")) return false;
    if (line.startsWith("DEBIAN/")) return false;
    return true;
  });
  const unique = [];
  const seen = new Set();
  for (const line of filtered) {
    const key = normalizeForDedup(line);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return unique.slice(0, maxItems);
}

function shortSentence(text, maxLen = 120) {
  if (!text) return null;
  const normalized = String(text).replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.*?)([.!?])(\s|$)/);
  const sentence = match ? match[1] + match[2] : normalized;
  if (sentence.length <= maxLen) return sentence;
  return sentence.slice(0, maxLen).trimEnd() + "…";
}

function summarizeKorean(text, maxLen = 60) {
  const shortened = shortSentence(text, maxLen);
  return translateLine(shortened);
}

function koreanizePrLine(text) {
  if (!text) return "주요 개선 사항 반영";
  const lower = String(text).toLowerCase();
  const tags = [];
  if (/(critical|high priority)/.test(lower)) tags.push("중요 이슈 대응");
  if (/binary verification|verify binaries/.test(lower)) tags.push("바이너리 검증 선행");
  if (/(postinst|prerm|postrm|installation|install|removal|upgrade)/.test(lower)) {
    tags.push("설치/제거 스크립트 개선");
  }
  if (/symlink|ln -sf/.test(lower)) tags.push("심볼릭 링크 처리 개선");
  if (/config\\.json|default config/.test(lower)) tags.push("기본 설정 파일 생성");
  if (/service|lifecycle/.test(lower)) tags.push("서비스 생명주기 처리");
  if (/security|ssh|vulnerabilit/.test(lower)) tags.push("보안 강화");
  if (/build|packag|distribution/.test(lower)) tags.push("빌드/패키징 안정화");
  if (/readme|documentation|docs/.test(lower)) tags.push("문서 보강");
  if (/(workflow|github actions|ci\/cd|automation)/.test(lower)) tags.push("workflow 자동화 개선");
  if (!tags.length) return "주요 개선 사항 반영";
  return Array.from(new Set(tags)).join(", ").replace(/워크플로우/gi, "workflow");
}

async function fetchPrInfo(repo, number, cache) {
  if (!GITHUB_TOKEN) return null;
  const key = `${repo}#${number}`;
  if (cache.has(key)) return cache.get(key);
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
  };
  const prUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/pulls/${number}`;
  const prRes = await fetch(prUrl, { headers });
  if (!prRes.ok) {
    cache.set(key, null);
    return null;
  }
  const prData = await prRes.json();
  const title = prData && prData.title ? String(prData.title).trim() : null;
  const summary = prData && prData.body ? firstBodyLine(prData.body) : null;

  const reviewsUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/pulls/${number}/reviews`;
  const reviewsRes = await fetch(reviewsUrl, { headers });
  let highlights = null;
  if (reviewsRes.ok) {
    const reviews = await reviewsRes.json();
    if (Array.isArray(reviews)) {
      const geminiReview = reviews.find((review) => {
        const user = review && review.user ? review.user.login : "";
        const body = review && review.body ? String(review.body) : "";
        return /gemini/i.test(user) || /gemini[-_]code[-_]assist/i.test(body);
      });
      if (geminiReview && geminiReview.body) {
        const reviewBody = String(geminiReview.body);
        highlights =
          extractHighlightsLines(reviewBody) ||
          extractBulletLines(reviewBody);
      }
    }
  }
  if (prData && prData.body) {
    const body = String(prData.body);
    const prHighlights = extractHighlightsLines(body) || extractBulletLines(body);
    if (prHighlights && prHighlights.length) {
      highlights = prHighlights;
    }
  }

  const info = title || summary || highlights ? { title, summary, highlights } : null;
  cache.set(key, info);
  return info;
}

async function enrichPrSummaries(lines, repo, cache) {
  const results = [];
  for (const line of lines) {
    const match = line.match(/PR #(\d+):\s*(.*)/i);
    if (!match) {
      results.push(line);
      continue;
    }
    const prNumber = match[1];
    const fallback = match[2]?.trim() || "리뷰 피드백 반영";
    const info = await fetchPrInfo(repo, prNumber, cache);
    const title = info && info.title ? info.title : null;
    const summary = info && info.summary ? info.summary : null;
    const titleKo = title ? koreanizePrLine(title) : koreanizePrLine(fallback);
    results.push(`PR #${prNumber}: ${titleKo}`);
    if (summary) {
      results.push(`\tsummary: ${koreanizePrLine(summary)}`);
    }
    const bullets = [];
    if (info && Array.isArray(info.highlights)) {
      const trimmed = pruneHighlights(info.highlights);
      if (trimmed && trimmed.length) bullets.push(...trimmed);
    }
    if (!bullets.length && summary) {
      bullets.push(summary);
    }
    const uniqueBullets = [];
    const seen = new Set();
    for (const b of bullets) {
      const key = normalizeForDedup(b);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueBullets.push(b);
    }
    const koreanized = uniqueBullets.map((b) => koreanizePrLine(b));
    const pruned = [];
    const seenKo = new Set();
    for (const k of koreanized) {
      if (k === "주요 개선 사항 반영") continue;
      const key = normalizeForDedup(k);
      if (seenKo.has(key)) continue;
      seenKo.add(key);
      pruned.push(k);
    }
    for (const k of pruned.slice(0, 3)) {
      results.push(`\t${k}`);
    }
  }
  return results;
}

function summarizeLines(lines) {
  const filtered = [];
  for (const line of lines) {
    const prMulti = line.match(/Address PR #([\d,\s]+) review feedback:?\s*(.*)/i);
    if (prMulti) {
      const desc = prMulti[2]?.trim();
      const ids = prMulti[1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      for (const id of ids) {
        filtered.push(desc ? `PR #${id}: ${desc}` : `PR #${id}: 리뷰 피드백 반영`);
      }
      continue;
    }
    const prSingle = line.match(/Address PR #(\d+) review feedback:?\s*(.*)/i);
    if (prSingle) {
      const desc = prSingle[2]?.trim();
      filtered.push(desc ? `PR #${prSingle[1]}: ${desc}` : `PR #${prSingle[1]}: 리뷰 피드백 반영`);
      continue;
    }
    filtered.push(line);
  }

  const normalized = filtered.map((line) => line.toLowerCase());
  const hasInstaller = normalized.some((line) =>
    line.includes("installer time threshold")
  );
  const summarized = filtered.filter(
    (line) => !line.toLowerCase().includes("installer time threshold")
  );
  if (hasInstaller) summarized.push("Adjust installer time threshold");

  return summarized;
}

function summarizeWorkflows(lines) {
  const categories = [
    {
      key: "shared",
      re: /(shared|reusable|automation workflows reusable|use shared workflows)/i,
      en: "Shared/reusable workflows introduced",
      ko: "공용/재사용 workflow 도입",
    },
    {
      key: "dispatch",
      re: /(dispatch|caller|nested gemini workflows)/i,
      en: "Dispatch workflow reliability improvements",
      ko: "Dispatch workflow 안정화",
    },
    {
      key: "triage",
      re: /triage/i,
      en: "Triage workflow refinements",
      ko: "Triage workflow 개선",
    },
    {
      key: "review",
      re: /(review|re-review|code review)/i,
      en: "Code review workflow automation updates",
      ko: "Review workflow 자동화 개선",
    },
    {
      key: "permissions",
      re: /(write permission|secrets inherit)/i,
      en: "Workflow permissions/config adjustments",
      ko: "workflow 권한/설정 보완",
    },
    {
      key: "docs",
      re: /documentation/i,
      en: "Workflow documentation updates",
      ko: "workflow 문서 업데이트",
    },
    {
      key: "legacy",
      re: /legacy/i,
      en: "Legacy workflow restoration",
      ko: "Legacy workflow 복원",
    },
    {
      key: "ci",
      re: /(shellcheck|submodule|ci\b)/i,
      en: "CI workflow reliability improvements",
      ko: "CI workflow 안정화",
    },
  ];

  const hits = new Map();
  for (const line of lines) {
    for (const cat of categories) {
      if (cat.re.test(line)) {
        hits.set(cat.key, cat);
      }
    }
  }

  if (!hits.size) {
    const deduped = Array.from(new Set(lines));
    return {
      en: deduped,
      ko: deduped.map(translateLine),
    };
  }

  const ordered = categories.filter((cat) => hits.has(cat.key));
  return {
    en: ordered.map((cat) => cat.en),
    ko: ordered.map((cat) => cat.ko),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildOutputPath(meetingDate) {
  const filename = `jo-hyunwoo-${formatDate(meetingDate)}.md`;
  return OUTPUT_PATH || path.join(OUTPUT_DIR, filename);
}

async function buildAutoContent(startDate, endDate) {
  const repos = listGitRepos(REPO_ROOT);
  const groups = {
    pimApp: [],
    wirelessNxp: [],
    workflows: [],
    etc: [],
  };
  const repoMap = {
    gstApp: "pimApp",
    max9296: "pimApp",
    "pim-package-org": "pimApp",
    streamApp: "pimApp",
    "wlan-package": "wirelessNxp",
    "wlan-driver": "wirelessNxp",
    "wpa-supplicant": "wirelessNxp",
    "wlan-bridge": "wirelessNxp",
    automation: "workflows",
    automation_repo: "workflows",
  };
  const prCache = new Map();

  for (const repoPath of repos) {
    const repoName = path.basename(repoPath);
    const groupKey = repoMap[repoName];
    if (!groupKey) continue; // 매핑되지 않은 저장소는 건너뜀
    const allCommits = getGitCommits(repoPath, startDate, endDate)
      .map((line) => line.trim())
      .filter(Boolean);
    const cleanedCommits = allCommits.map(stripTypePrefix).filter((line) => !isTrivialCommit(line));
    if (repoName === "automation" || repoName === "automation_repo") {
      groups.workflows.push(...cleanedCommits);
      continue;
    }
    const commits = cleanedCommits.filter((line) => !isWorkflowRelated(line));
    const workflowCommits = cleanedCommits
      .filter((line) => isWorkflowRelated(line))
      .map((line) => line);
    groups[groupKey].push(...commits);
    groups.workflows.push(...workflowCommits);
  }

  const dedupe = (items) => {
    const seen = new Set();
    const result = [];
    for (const item of items) {
      const key = normalizeForDedup(item);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  };

  const pimAppRaw = summarizeLines(dedupe(groups.pimApp));
  const wirelessRaw = summarizeLines(dedupe(groups.wirelessNxp));
  const etcRaw = summarizeLines(dedupe(groups.etc));
  const pimAppEn = await enrichPrSummaries(pimAppRaw, "gstApp", prCache);
  const wirelessEn = await enrichPrSummaries(wirelessRaw, "wlan-package", prCache);
  const workflowsSummary = summarizeWorkflows(dedupe(groups.workflows));
  const workflowsEn = workflowsSummary.en;
  const workflowsKo = workflowsSummary.ko;
  const pimAppKo = pimAppEn.map(translateLine);
  const wirelessKo = wirelessEn.map(translateLine);

  const extraNotes =
    EXTRA_NOTES_PATH && fs.existsSync(EXTRA_NOTES_PATH)
      ? fs
          .readFileSync(EXTRA_NOTES_PATH, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];

  const extraEn = extraNotes;
  const extraKo = extraNotes.map(translateLine);

  return {
    "{{PIM_APPLICATION_EN}}": formatList(pimAppEn, "    - ", "(no changes)"),
    "{{WIRELESS_NXP_EN}}": formatList(wirelessEn, "    - ", "(no changes)"),
    "{{WORKFLOW_EN}}": formatList(workflowsEn, "    - ", "(no changes)"),
    "{{PIM_APPLICATION_KO}}": formatList(pimAppKo, "    - ", "(변경 없음)"),
    "{{WIRELESS_NXP_KO}}": formatList(wirelessKo, "    - ", "(변경 없음)"),
    "{{WORKFLOW_KO}}": formatList(workflowsKo, "  - ", "(변경 없음)"),
    "{{AI_EN}}": formatBulletsFromFile(AI_EN_PATH, "    - ", "(수동 입력)"),
    "{{AI_KO}}": formatBulletsFromFile(AI_KO_PATH, "    - ", "(수동 입력)"),
    "{{ETC_SECTION}}": etcRaw.length
      ? `\n- ETC\n${formatList(etcRaw.map(translateLine), "    - ", "")}`
      : "",
    "{{EXTRA_NOTES_EN}}": extraEn.length
      ? `- Additional Notes\n${formatList(extraEn, "  - ", "")}`
      : "",
    "{{EXTRA_NOTES_KO}}": extraKo.length
      ? `- 추가 메모\n${formatList(extraKo, "  - ", "")}`
      : "",
  };
}

function replaceSection(body, newSection) {
  const header = SECTION_HEADER;
  const lines = body.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === header);
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("#### <span style=\"color:blue\">")) {
      endIdx = i;
      break;
    }
  }

  const before = lines.slice(0, startIdx).join("\n");
  const after = lines.slice(endIdx).join("\n");
  const joinerBefore = before.length ? before + "\n" : "";
  const joinerAfter = after.length ? "\n" + after : "";
  return `${joinerBefore}${newSection.trimEnd()}${joinerAfter}`.trimEnd() + "\n";
}

function extractSection(body) {
  const header = SECTION_HEADER;
  const lines = body.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === header);
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("#### <span style=\"color:blue\">")) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join("\n").trimEnd() + "\n";
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Redmine-API-Key": API_KEY,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse JSON response: ${err.message}`);
  }
}

async function main() {
  let meetingDate = MEETING_DATE_OVERRIDE
    ? new Date(`${MEETING_DATE_OVERRIDE}T00:00:00`)
    : null;
  let wikiUrl = WIKI_URL_ENV;

  if (!wikiUrl) {
    if (!meetingDate) meetingDate = targetWednesday(new Date());
    wikiUrl = buildWikiUrl(meetingDate);
  }

  const title = extractTitleFromUrl(wikiUrl);
  const projectId = extractProjectIdFromUrl(wikiUrl) || PROJECT_ID;

  if (!title || !projectId) {
    console.error("Failed to parse project/title from WIKI_URL.");
    process.exit(1);
  }

  if (!meetingDate) {
    meetingDate = parseMeetingDateFromTitle(title) || targetWednesday(new Date());
  }

  if (!meetingDate || Number.isNaN(meetingDate.getTime())) {
    console.error("Could not determine meeting date. Set MEETING_DATE=YYYY-MM-DD.");
    process.exit(1);
  }

  const pageUrl = `${BASE_URL}/projects/${projectId}/wiki/${encodeURIComponent(title)}.json`;
  const pageData = await fetchJson(pageUrl);

  if (!pageData || !pageData.wiki_page || !pageData.wiki_page.text) {
    console.error("Unexpected response: missing wiki_page.text");
    process.exit(1);
  }

  const original = pageData.wiki_page.text;
  const rawSection = await buildContent(meetingDate);
  const summarized = aiSummarize(rawSection);
  const generatedSection = summarized || rawSection;
  const targetOutputPath = buildOutputPath(meetingDate);
  ensureDir(path.dirname(targetOutputPath));
  if (MODE === "generate") {
    if (fs.existsSync(targetOutputPath)) {
      const backupPath = targetOutputPath.replace(/\.md$/, ".bak.md");
      fs.copyFileSync(targetOutputPath, backupPath);
      console.log(`Backup saved: ${backupPath}`);
    }
    fs.writeFileSync(targetOutputPath, generatedSection, "utf8");
    console.log(`Draft saved: ${targetOutputPath}`);
  }
  let newSection =
    MODE === "update" && fs.existsSync(targetOutputPath)
      ? fs.readFileSync(targetOutputPath, "utf8")
      : generatedSection;
  const currentSection = extractSection(original);

  if (!currentSection) {
    console.error("Could not find the target section to replace.");
    process.exit(1);
  }

  // 조현우 섹션에만 footer 추가
  const sectionStripped = newSection.replace(/\n*\*작성:.*?\*\n*---\s*$/, "").trimEnd();

  if (MODE !== "update") {
    const updated = replaceSection(original, sectionStripped + "\n");
    console.log("--- current section ---\n" + currentSection);
    console.log("--- updated section ---\n" + sectionStripped);
    if (original.trim() === updated.trim()) {
      console.log("No changes detected; skipping update.");
    } else {
      console.log("Draft generated only; skipping update.");
    }
    return;
  }

  let approver;
  if (AUTO_APPROVE) {
    approver = "auto";
  } else {
    const ok = await promptYesNo("Apply update? (y/N) ");
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
    approver = "hwjo";
  }

  const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16);
  const footerLine = approver === "auto"
    ? `*작성: Claude Code ${now} | 승인: 없음*`
    : `*작성: Claude Code ${now} | 승인: ${approver} ${now}*`;
  const finalSection = sectionStripped + `\n\n${footerLine}\n\n---`;
  const finalUpdated = replaceSection(original, finalSection);

  if (!finalUpdated) {
    console.error("Could not find the target section to replace.");
    process.exit(1);
  }

  console.log("--- current section ---\n" + currentSection);
  console.log("--- updated section ---\n" + finalSection);

  if (original.trim() === finalUpdated.trim()) {
    console.log("No changes detected; skipping update.");
    return;
  }

  const version = pageData.wiki_page.version;
  const payload = {
    wiki_page: {
      text: finalUpdated,
      comments: approver === "auto" ? "자동 업데이트 (cron)" : "자동 업데이트 (승인: hwjo)",
      version,
    },
  };

  await fetchJson(pageUrl, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  console.log("Update complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
