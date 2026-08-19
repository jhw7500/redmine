// Design Ref: §4.2 — Git 수집 + 분류 + 번역 + PR 보강
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- 유틸리티 (config 불필요) ---

function normalizeForDedup(line) {
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

function stripReferences(line) {
  return line
    .replace(/\s*\(?\s*(issue|closes?|fixes?|resolves?)\s*#\d+\s*\)?\s*/gi, " ")
    .replace(/\s*PR\s*#\d+\s*:?\s*/gi, " ")
    .replace(/\s*#\d+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTypePrefix(line) {
  return line.replace(
    /^([A-Za-z0-9_.-]+:\s*)?(feat|fix|docs|chore|refactor|security|revert|debug|ci|restore|test|build|perf)\s*:\s*/i,
    "$1"
  );
}

function isWorkflowRelated(line) {
  return /(workflow|workflows|github actions|\.github\/|ci\b|gemini|triage|commitlint|shellcheck|bump[-_]automation|eslint|prettier)/i.test(line);
}

// --- Git 수집 ---

// 버그 관련 키워드 (body 보강 대상 판별)
const BUG_SUBJECT_PATTERN = /(이슈|버그|리포트|해결|결함|fail|bug|defect|fix|hotfix|FAIL)/i;

// body에서 우선순위 기반으로 root cause/증상/검증 라인 추출
// 우선순위: (1) 원인·드라이버·앱 코드 지시, (2) 증상·expected/got·미반영, (3) 검증 결과 PASS/FAIL 카운트
function extractBodyHighlights(body, maxLines = 8) {
  if (!body) return [];
  const lines = body.split("\n").map((l) => l.trim());

  // 후보 수집 (Co-Authored-By 이후는 중단)
  const candidates = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^Co-[Aa]uthored-[Bb]y:/.test(line)) break;
    if (/^(Signed-off-by|Reviewed-by|Acked-by):/.test(line)) continue;
    if (/^=+\s*$/.test(line)) continue;

    // 불릿/서브불릿/키워드 포함 라인만
    const isBullet = /^[-*]\s+/.test(line);
    const hasExpectedGot = /expected\s+\S+.*?\bgot\s+\S+/i.test(line) || /:\s*expected\b/i.test(line);
    const hasPassFail = /\d+\s*\/\s*\d+\s*(PASS|FAIL)/i.test(line);
    const hasRootCauseKeyword = /(드라이버|driver|\.(c|cpp|py)\b|app\b|gstApp|single\s*mode|dual\s*mode|쓰기\s*경로|미반영|원인|추정|root\s*cause)/i.test(line);
    const hasSymptomKeyword = /(expected|실측|FAIL|미반영|이슈|버그|누락|bug|defect)/i.test(line);

    if (!(isBullet || hasExpectedGot || hasPassFail)) continue;

    // 우선순위 점수: root cause 3, expected/got 2, symptom 2, bullet+PASS/FAIL 1
    let priority = 0;
    if (hasRootCauseKeyword) priority += 3;
    if (hasExpectedGot) priority += 2;
    if (hasSymptomKeyword) priority += 2;
    if (hasPassFail) priority += 1;
    // bullet 자체는 기본 점수 0, 키워드가 있어야 선택

    // Co-author/서명류 제외 후 남은 것 중 점수 >= 1만 채택
    if (priority < 1 && !isBullet) continue;

    candidates.push({
      text: line.replace(/^[-*]\s+/, "").replace(/^\*\s+/, "").trim(),
      priority,
      originalOrder: candidates.length,
    });
  }

  // 점수 내림차순 → 동점은 원본 순서
  candidates.sort((a, b) => b.priority - a.priority || a.originalOrder - b.originalOrder);

  // 중복 제거 + maxLines 제한
  const seen = new Set();
  const result = [];
  for (const c of candidates) {
    const key = c.text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
    if (result.length >= maxLines) break;
  }

  // 원본 body 순서로 재정렬 (읽기 좋게)
  result.sort((a, b) => a.originalOrder - b.originalOrder);
  return result.map((c) => c.text);
}

// 커밋 메시지에 드러나지 않는 변경은 변경 파일 경로로만 식별된다. 대형 release 커밋에
// 펌웨어 바이너리 교체가 섞이면 subject만 읽는 수집은 그 사실을 통째로 놓친다
// (2026-08-14 wlan-package 3f63094 — NXP 펌웨어 p149.115 갱신이 78파일 커밋에 묻혀
//  2026-08-19 주간보고에서 누락). 경로 신호를 subject 뒤에 덧붙여 파이프라인에 태운다.
function detectPathSignals(files, subject, config) {
  const signals = config.pathSignals || [];
  if (!signals.length || !files.length) return [];
  const labels = [];
  for (const sig of signals) {
    // subject가 이미 그 사실을 말하고 있으면 덧붙이지 않는다 — 중복 서술 방지.
    if (sig.skipIf && sig.skipIf.test(subject)) continue;
    if (!files.some((f) => sig.pattern.test(f))) continue;
    if (!labels.includes(sig.label)) labels.push(sig.label);
  }
  return labels;
}

function getGitCommits(repoPath, since, until, config, repoOpts) {
  const includeBody = repoOpts && repoOpts.includeCommitBody;
  // 파일 목록은 body 사용 여부와 무관하게 항상 받는다 — 경로 신호 판정에 필요하다.
  const args = [
    "-C", repoPath, "log",
    `--since=${since}`, `--until=${until}`,
    "--pretty=format:__COMMIT__%n%s%n__BODY__%n%b%n__END__",
    "--name-only",
  ];
  if (config.env.authorMatch.trim()) args.push(`--author=${config.env.authorMatch}`);
  if (!config.env.includeMerges) args.push("--no-merges");

  // 파일 목록이 붙어 출력이 커진다(대형 release 커밋 하나가 수백 줄).
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return [];

  // Parse __COMMIT__ ... __BODY__ ... __END__ <files> blocks
  const blocks = result.stdout.split("__COMMIT__").filter((b) => b.trim());
  const output = [];
  for (const block of blocks) {
    const bodyIdx = block.indexOf("__BODY__");
    const endIdx = block.indexOf("__END__");
    const subject = bodyIdx === -1
      ? block.trim()
      : block.slice(0, bodyIdx).trim();
    const body = bodyIdx !== -1 && endIdx !== -1
      ? block.slice(bodyIdx + "__BODY__".length, endIdx).trim()
      : "";
    const files = endIdx === -1
      ? []
      : block.slice(endIdx + "__END__".length).split("\n").map((l) => l.trim()).filter(Boolean);

    if (!subject) continue;

    // 신호는 subject에 이어붙이지 않고 하위 라인으로 둔다. 번역 규칙 중에는
    // "Harden (.+) → $1 강화"처럼 문장 끝까지 greedy로 삼키는 것이 있어,
    // 같은 줄에 붙이면 신호가 술어 안으로 빨려들어가 어순이 깨진다.
    const extras = detectPathSignals(files, subject, config).map((label) => `  ↳ ${label}`);

    // 버그 관련 subject면 body 요점을 같은 항목의 하위 라인으로 붙임
    // (별도 commit이 아니라 1개 항목으로 dedup/분류)
    if (includeBody && BUG_SUBJECT_PATTERN.test(subject)) {
      for (const h of extractBodyHighlights(body)) extras.push(`  ↳ ${h}`);
    }
    output.push(extras.length ? subject + "\n" + extras.join("\n") : subject);
  }
  return output;
}

// --- CHANGELOG 수집 ---

// CHANGELOG는 릴리스 단위로 "무엇이 바뀌었는지"를 사람이 직접 쓴 소스다. 커밋 제목이
// 그 사실을 말하지 않아도 여기에는 남으므로, 경로 신호로도 잡히지 않는 누락(설정
// 기본값·정책 변경 등)에 대한 2차 안전망이 된다.
const CHANGELOG_VERSION_HEADING = /^##\s+\[?([^\]\s(]+)\]?\s*\((\d{4}-\d{2}-\d{2})\)/;
const CHANGELOG_SECTION_HEADING = /^###\s+(.+)$/;
const MAX_CHANGELOG_BULLETS_PER_SECTION = 2;
const MAX_CHANGELOG_ENTRIES_PER_REPO = 12;
const MAX_CHANGELOG_BULLET_CHARS = 240;

function getChangelogEntries(repoPath, since, until, repoOpts) {
  const opt = repoOpts ? repoOpts.changelog : undefined;
  if (opt === false) return [];
  const file = path.join(repoPath, typeof opt === "string" ? opt : "CHANGELOG.md");
  if (!fs.existsSync(file)) return [];

  const startMs = Date.parse(since);
  const endMs = Date.parse(until);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return [];

  const entries = [];
  let version = null;
  let inRange = false;
  let section = null;
  let bullets = 0;

  for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();

    const ver = line.match(CHANGELOG_VERSION_HEADING);
    if (ver) {
      version = ver[1];
      // CHANGELOG 헤더는 날짜 정밀도라 KST 06:00 마감 경계를 시각 단위로 가릴 수 없다.
      // 수집 범위와 같은 하루 단위로만 판정한다.
      const dayMs = Date.parse(`${ver[2]}T00:00:00Z`);
      inRange = !Number.isNaN(dayMs) && dayMs >= startMs && dayMs < endMs;
      section = null;
      continue;
    }
    if (!inRange) continue;

    const sec = line.match(CHANGELOG_SECTION_HEADING);
    if (sec) {
      section = sec[1].trim();
      bullets = 0;
      continue;
    }
    if (!section) continue;
    if (!/^[-*]\s+/.test(line)) continue;
    if (bullets >= MAX_CHANGELOG_BULLETS_PER_SECTION) continue;

    const text = line.replace(/^[-*]\s+/, "").replace(/\*\*/g, "").trim();
    if (!text) continue;
    bullets += 1;
    const clipped = text.length > MAX_CHANGELOG_BULLET_CHARS
      ? `${text.slice(0, MAX_CHANGELOG_BULLET_CHARS)}…`
      : text;
    entries.push(`CHANGELOG ${version} · ${section} — ${clipped}`);
    if (entries.length >= MAX_CHANGELOG_ENTRIES_PER_REPO) break;
  }
  return entries;
}

// --- 필터/분류 (config 사용) ---

// Plan SC: SC4 — trivialPatterns 외부화
function isTrivialCommit(line, config) {
  const trimmed = line.trim();
  return config.trivialPatterns.some((re) => re.test(trimmed));
}

// Plan SC: SC2 — commitTypes 외부화
function detectCommitType(line, config) {
  // 1. conventional commit prefix 매칭
  const match = line.match(
    /^(?:[A-Za-z0-9_.-]+:\s*)?(feat|fix|docs|refactor|security|revert|debug|ci|test|build|perf|improve)\s*(?:\([^)]*\))?\s*:\s*/i
  );
  if (match) return match[1].toLowerCase();

  // 2. linePatterns 매칭 (config 기반)
  for (const [type, def] of Object.entries(config.commitTypes)) {
    for (const re of def.linePatterns) {
      if (re.test(line)) return type;
    }
  }

  return "etc";
}

function getCommitTypeLabel(type, config) {
  if (config.commitTypes[type]) return config.commitTypes[type].label;
  return "기타";
}

// Plan SC: SC2 — translationRules 외부화
function translateLine(line, config) {
  let output = stripTypePrefix(line);
  for (const rule of config.translationRules) {
    output = output.replace(rule.pattern, rule.replacement);
  }
  return output;
}

// --- 그룹핑/포맷 ---

function groupByType(lines, config) {
  const typeGroups = new Map();
  for (const line of lines) {
    const type = detectCommitType(line, config);
    const label = getCommitTypeLabel(type, config);
    if (!typeGroups.has(label)) typeGroups.set(label, []);
    typeGroups.get(label).push(stripTypePrefix(line));
  }
  return typeGroups;
}

function formatGrouped(typeGroups, indent) {
  const lines = [];
  // indent="    - " → subIndent="      - " (하이픈 위치를 공백으로 대체 후 2칸 추가)
  const subIndent = indent.replace(/-\s*$/, "").replace(/./g, " ") + "  - ";
  for (const [label, items] of typeGroups) {
    if (!items.length) continue;
    if (typeGroups.size === 1) {
      for (const item of items) lines.push(`${indent}${item}`);
    } else {
      lines.push(`${indent}${label}`);
      for (const item of items) lines.push(`${subIndent}${item}`);
    }
  }
  return lines.join("\n") || `${indent}(변경 없음)`;
}

function groupByDisplayName(lines, displayNames) {
  const groups = new Map();
  for (const line of lines) {
    const repoMatch = line.match(/^\[([^\]]+)\]\s*(.*)/);
    if (repoMatch) {
      const repoName = repoMatch[1];
      const content = repoMatch[2];
      const display = displayNames[repoName] || repoName;
      if (!groups.has(display)) groups.set(display, []);
      groups.get(display).push(content);
    } else {
      if (!groups.has("기타")) groups.set("기타", []);
      groups.get("기타").push(line);
    }
  }
  return groups;
}

function formatEtcGrouped(lines, displayNames, config) {
  const repoGroups = groupByDisplayName(lines, displayNames);
  const result = [];
  for (const [display, items] of repoGroups) {
    if (!items.length) continue;
    const cleaned = items.map(stripTypePrefix).filter((l) => !isTrivialCommit(l, config));
    if (!cleaned.length) continue;
    result.push(`  - ${display}`);
    for (const item of cleaned) result.push(`    - ${item}`);
  }
  return result.join("\n") || "  - (변경 없음)";
}

// --- PR 파싱 ---

function normalizeSummaryLine(line) {
  return String(line)
    .replace(/^#{1,6}\s*/g, "")
    .replace(/^summary\s*[:：-]?\s*/i, "")
    .replace(/^[-*]\s*/g, "")
    .trim();
}

function firstBodyLine(body) {
  if (!body) return null;
  const rawLines = String(body).split("\n").map((l) => l.trim());
  const summaryIndex = rawLines.findIndex((l) => /^#{1,6}\s*summary\b/i.test(l));
  if (summaryIndex !== -1) {
    for (let i = summaryIndex + 1; i < rawLines.length; i += 1) {
      const cleaned = normalizeSummaryLine(rawLines[i]);
      if (cleaned && !/^(code review|summary)$/i.test(cleaned)) return cleaned;
    }
  }
  const first = rawLines
    .map(normalizeSummaryLine)
    .find((l) => l && !/^(code review|summary)$/i.test(l));
  return first || null;
}

function extractHighlightsLines(body) {
  if (!body) return null;
  const rawLines = String(body).split("\n").map((l) => l.trim());
  const idx = rawLines.findIndex((l) => /^#{1,6}\s*highlights\b/i.test(l));
  if (idx !== -1) {
    const highlights = [];
    for (let i = idx + 1; i < rawLines.length; i += 1) {
      if (/^#{1,6}\s+/.test(rawLines[i])) break;
      const cleaned = normalizeSummaryLine(rawLines[i]);
      if (cleaned) highlights.push(cleaned);
    }
    return highlights.length ? highlights : null;
  }
  const altIdx = rawLines.findIndex((l) => /^highlights\b\s*:?/i.test(l));
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
    .split("\n").map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
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

// --- GitHub PR 보강 ---

async function fetchPrInfo(repo, number, cache, config) {
  if (!config.env.githubToken) return null;
  const key = `${repo}#${number}`;
  if (cache.has(key)) return cache.get(key);
  const headers = {
    Authorization: `Bearer ${config.env.githubToken}`,
    Accept: "application/vnd.github+json",
  };
  const prUrl = `https://api.github.com/repos/${config.env.githubOwner}/${repo}/pulls/${number}`;
  const prRes = await fetch(prUrl, { headers });
  if (!prRes.ok) {
    cache.set(key, null);
    return null;
  }
  const prData = await prRes.json();
  const title = prData && prData.title ? String(prData.title).trim() : null;
  const summary = prData && prData.body ? firstBodyLine(prData.body) : null;

  const reviewsUrl = `https://api.github.com/repos/${config.env.githubOwner}/${repo}/pulls/${number}/reviews`;
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
        highlights = extractHighlightsLines(reviewBody) || extractBulletLines(reviewBody);
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

async function enrichPrSummaries(lines, repo, cache, config) {
  const results = [];
  for (const line of lines) {
    const match = line.match(/PR #(\d+):\s*(.*)/i);
    if (!match) {
      results.push(line);
      continue;
    }
    const prNumber = match[1];
    const fallback = (match[2] || "").trim();
    const info = await fetchPrInfo(repo, prNumber, cache, config);
    const title = info && info.title ? info.title : null;
    const titleKo = title ? koreanizePrLine(title) : (fallback ? koreanizePrLine(fallback) : null);
    if (!titleKo || titleKo === "주요 개선 사항 반영") continue;
    results.push(stripReferences(titleKo));

    const bullets = [];
    if (info && Array.isArray(info.highlights)) {
      const trimmed = pruneHighlights(info.highlights);
      if (trimmed && trimmed.length) bullets.push(...trimmed);
    }
    const uniqueBullets = [];
    const seen = new Set();
    for (const b of bullets) {
      const key = normalizeForDedup(b);
      if (seen.has(key)) continue;
      seen.add(key);
      const ko = koreanizePrLine(b);
      if (ko && ko !== "주요 개선 사항 반영") uniqueBullets.push(ko);
    }
    for (const k of uniqueBullets.slice(0, 2)) {
      results.push(`\t${stripReferences(k)}`);
    }
  }
  return results;
}

// --- 요약 ---

function summarizeLines(lines) {
  const filtered = [];
  for (const line of lines) {
    const prWithDesc = line.match(/(?:Address\s+)?PR\s*#[\d,\s]+\s*(?:review\s*feedback)?:?\s*(.+)/i);
    if (prWithDesc) {
      const desc = prWithDesc[1].trim();
      if (desc && !/^(리뷰\s*피드백\s*반영|review\s*feedback|코드\s*리뷰)$/i.test(desc)) {
        filtered.push(stripReferences(desc));
      }
      continue;
    }
    filtered.push(stripReferences(line));
  }

  const normalized = filtered.map((l) => l.toLowerCase());
  const hasInstaller = normalized.some((l) => l.includes("installer time threshold"));
  const summarized = filtered.filter((l) => !l.toLowerCase().includes("installer time threshold"));
  if (hasInstaller) summarized.push("Adjust installer time threshold");
  return summarized;
}

function summarizeWorkflows(lines, config) {
  const categories = [
    { key: "shared", re: /(shared|reusable|automation workflows reusable|use shared workflows)/i, ko: "공용/재사용 workflow 도입" },
    { key: "dispatch", re: /(dispatch|caller|nested gemini workflows)/i, ko: "Dispatch workflow 안정화" },
    { key: "triage", re: /triage/i, ko: "Triage workflow 개선" },
    { key: "review", re: /(review|re-review|code review)/i, ko: "Review workflow 자동화 개선" },
    { key: "permissions", re: /(write permission|secrets inherit)/i, ko: "workflow 권한/설정 보완" },
    { key: "docs", re: /documentation/i, ko: "workflow 문서 업데이트" },
    { key: "legacy", re: /legacy/i, ko: "Legacy workflow 복원" },
    { key: "ci", re: /(shellcheck|submodule|ci\b)/i, ko: "CI workflow 안정화" },
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
    return { ko: deduped.map((l) => translateLine(l, config)) };
  }

  const ordered = categories.filter((cat) => hits.has(cat.key));
  return { ko: ordered.map((cat) => cat.ko) };
}

// --- 메인 수집 함수 ---

function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = normalizeForDedup(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

// Plan SC: SC1 — 신규 repo 추가 = config 1곳만 수정
async function collectAll(config, startDate, endDate) {
  const groups = {};
  for (const cat of Object.keys(config.categories)) {
    groups[cat] = [];
  }

  const prCache = new Map();

  for (const [repoName, repoDef] of Object.entries(config.repos)) {
    const groupKey = repoDef.category;
    if (!groupKey || !groups[groupKey]) continue;

    const allCommits = getGitCommits(repoDef.path, startDate, endDate, config, repoDef)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => {
        // 멀티라인 항목은 subject(첫 줄) 기준으로 trivial 판정
        const subject = l.split("\n", 1)[0];
        return !isTrivialCommit(subject, config);
      });

    // 커밋 제목이 말하지 않은 릴리스 변경을 CHANGELOG에서 보충한다.
    const changelogEntries = getChangelogEntries(repoDef.path, startDate, endDate, repoDef)
      .filter((l) => !isTrivialCommit(l, config));
    const allItems = allCommits.concat(changelogEntries);

    if (groupKey === "etc") {
      groups[groupKey].push(...allItems.map((l) => `[${repoName}] ${l}`));
    } else {
      // 워크플로우/CI 커밋은 etc로 리다이렉트
      for (const commit of allItems) {
        if (isWorkflowRelated(commit)) {
          groups["etc"].push(`[automation] ${commit}`);
        } else {
          groups[groupKey].push(commit);
        }
      }
    }
  }

  // 일반 카테고리: 타입별 그룹핑 + 한글 번역
  const result = {};
  for (const [catKey, catDef] of Object.entries(config.categories)) {
    const templateKey = catDef.templateKey;
    if (!templateKey) continue;

    if (catKey === "etc") {
      result[`{{${templateKey}}}`] = formatEtcGrouped(
        dedupe(groups[catKey] || []),
        config.displayNames,
        config
      );
    } else {
      const grouped = groupByType(dedupe(groups[catKey] || []), config);
      // 한글 번역 적용
      for (const [label, items] of grouped) {
        grouped.set(label, items.map((l) => translateLine(l, config)));
      }
      result[`{{${templateKey}}}`] = formatGrouped(grouped, "    - ");
    }
  }

  return result;
}

module.exports = { collectAll, detectPathSignals, getChangelogEntries };
