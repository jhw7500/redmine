// Design Ref: §4.2 — Git 수집 + 분류 + 번역 + PR 보강
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { parseEnvDate } = require("./report-range");
const {
  collectMergedPullRequestEvidence,
  parseChangeEvidence,
} = require("./change-evidence");

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

const CONVENTIONAL_COMMIT_PATTERN = /^(?:([A-Za-z0-9_.-]+:\s*))?(feat|fix|docs|chore|refactor|security|revert|debug|ci|restore|test|build|perf|improve)\s*(?:\([^\r\n)]*\))?!?\s*:\s*/i;

function parseConventionalCommit(line) {
  const match = String(line).match(CONVENTIONAL_COMMIT_PATTERN);
  if (!match) return null;
  return {
    repositoryPrefix: match[1] || "",
    type: match[2].toLowerCase(),
    prefixLength: match[0].length,
  };
}

function stripTypePrefix(line) {
  const text = String(line);
  const parsed = parseConventionalCommit(text);
  if (!parsed) return text;
  return parsed.repositoryPrefix + text.slice(parsed.prefixLength);
}

function isWorkflowRelated(line) {
  const subject = String(line).split("\n", 1)[0];
  return /(workflow|workflows|github actions|\.github\/|ci\b|gemini|triage|commitlint|shellcheck|bump[-_]automation|eslint|prettier)/i.test(subject);
}

// --- Git 수집 ---

const BODY_TRAILER_PATTERN = /^(?:Co-Authored-By|Claude-Session|Signed-off-by|Reviewed-by|Acked-by):/i;
const BODY_NOISE_PATTERN = /^(?:review[- ]fix\s+round\s+\d+|=+)\.?$/i;
const BODY_BACKGROUND_PATTERN = /(?:Reviewer\s+[A-Z]|Codex\s+P\d|원인|근인|문제|결함|누락|불일치|회귀|실패|버그|fail(?:ed|ure|-open)?|bug|defect|regression)/i;
const BODY_CHANGE_PATTERN = /(?:수정|변경|추가|제거|정리|보존|차단|거부|요구|이제|(?:\bnow\b)|(?:\b(?:add|remove|replace|update|preserve|reject|require|fix)(?:s|ed|ing)?\b))/i;
const BODY_VERIFICATION_PATTERN = /(?:검증|테스트|실측|tests?|test suite|build|lint|typecheck|pytest|node --test).*(?:\d+\s*\/\s*\d+|PASS|FAIL|exit\s*(?:code\s*)?0|통과|성공|완료|warnings?\s*\d+|errors?\s*0)/i;
const BODY_SECTION_LABEL_PATTERN = /^(배경|background|설명|summary|changes?|변경|수정|검증|verification|tests?)\s*[:：-]?\s*$/i;
const MAX_BODY_DETAIL_CHARS = 220;
const MAX_SERIALIZED_CREDENTIAL_NORMALIZATION_PASSES = 8;
const COMMIT_BODY_MARKUP_PATTERN = /[<>\[\]]/;
const COMMIT_BODY_UNDERSCORE_EMPHASIS_PATTERN = /(?<![\p{L}\p{N}])(_{1,2})(?=\S)([^\r\n]*?\S)\1(?![\p{L}\p{N}])/mu;
const HTML_CREDENTIAL_ENTITY_VALUES = Object.freeze({
  amp: "&",
  apos: "'",
  colon: ":",
  equals: "=",
  gt: ">",
  lt: "<",
  lowbar: "_",
  underbar: "_",
  period: ".",
  quot: '"',
  sol: "/",
});
const COMMIT_CREDENTIAL_PATTERNS = Object.freeze([
  ["credential_html_entity", /(?:REDMINE|GITHUB|NOTION|SLACK|X-Redmine)[A-Za-z0-9_-]*&(?:#x?[0-9a-f]+|[a-z][a-z0-9]+);?[A-Za-z0-9_-]*(?:TOKEN|KEY|URL)\s*(?::|\+?=)/i],
  ["credential_assignment", /(?:^|[^A-Za-z0-9_])(?:["'`]|\*{1,2}|_{1,2})*(?:REDMINE_API_KEY|GITHUB_TOKEN|NOTION_API_KEY|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|SLACK_WEBHOOK_URL)(?:["'`]|\*{1,2}|_{1,2})*\s*(?::|\+?=)\s*["']?[^"'\s,;}]+/im],
  ["redmine_api_key", /["']?_{0,2}X-Redmine-API-Key_{0,2}["']?\s*[:=]\s*["']?[^"'\s,;}]+/i],
  ["authorization", /(?:^|[^A-Za-z0-9_])(?:["'`]|\*{1,2}|_{1,2})*Authorization(?:["'`]|\*{1,2}|_{1,2})*\s*[:=]\s*["']?_{0,2}(?:Bearer|Basic|token)\s+[^"'\s,;}]+/im],
  ["github_token", /(?:^|[^A-Za-z0-9])(?:gh[pour]_[A-Za-z0-9._-]{20,}|github_pat_[A-Za-z0-9._-]{20,}|ghs_[A-Za-z0-9._-]{36,})/i],
  ["provider_api_key", /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}\b/],
  ["slack_token", /(?:^|[^A-Za-z0-9])(?:xox[baprs]|xox[ecd]|xapp|xwfp|xoxe\.xox[bp])-[A-Za-z0-9._-]+\b/i],
  ["slack_webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+/i],
  ["credential_url", /(?:^|[^A-Za-z0-9])[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+(?::[^/\s@]*)?@/i],
]);

function commitCredentialError(kind) {
  const error = new Error(`Commit evidence rejected: credential material (${kind})`);
  // Public callers already key off this code. Keep it stable while extending the
  // protected boundary from commit bodies to commit subjects as well.
  error.code = "COMMIT_BODY_CREDENTIAL_DETECTED";
  return error;
}

function containsCommitBodyMarkup(body) {
  return COMMIT_BODY_MARKUP_PATTERN.test(body)
    || COMMIT_BODY_UNDERSCORE_EMPHASIS_PATTERN.test(body);
}

function decodeHtmlCredentialEntities(text) {
  return text.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]+));?/gi,
    (entity, hexadecimal, decimal, named) => {
      if (named) return HTML_CREDENTIAL_ENTITY_VALUES[named.toLowerCase()] ?? entity;
      const codePoint = Number.parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
      if (codePoint < 1 || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return entity;
      return String.fromCodePoint(codePoint);
    }
  );
}

function normalizeCredentialMarkup(text) {
  return String(text)
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/gs, "")
    .replace(/!\[([^\[\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\[\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\[\]]*)\]\[[^\[\]]*\]/g, "$1")
    .replace(/\[([^\[\]]*)\]/g, "$1");
}

function normalizeCredentialScanTexts(text) {
  let current = String(text);
  const scanTexts = new Set();
  for (let pass = 0; pass < MAX_SERIALIZED_CREDENTIAL_NORMALIZATION_PASSES; pass += 1) {
    const serialized = normalizeSerializedCredentialText(current);
    const entities = decodeHtmlCredentialEntities(serialized);
    const markup = normalizeCredentialMarkup(entities);
    const normalized = markup.replace(/\*{1,2}|`+/g, "");
    for (const candidate of [current, serialized, entities, markup, normalized]) {
      scanTexts.add(candidate);
    }
    if (normalized === current) {
      return { scanTexts: [...scanTexts], exhausted: false };
    }
    current = normalized;
  }
  const serialized = normalizeSerializedCredentialText(current);
  const entities = decodeHtmlCredentialEntities(serialized);
  const markup = normalizeCredentialMarkup(entities);
  const normalized = markup.replace(/\*{1,2}|`+/g, "");
  return { scanTexts: [...scanTexts], exhausted: normalized !== current };
}

function scanCommitCredentials(text) {
  const normalized = normalizeCredentialScanTexts(text);
  if (normalized.exhausted) return ["normalization_limit", /(?:)/];
  return COMMIT_CREDENTIAL_PATTERNS.find(([, pattern]) =>
    normalized.scanTexts.some((candidate) => pattern.test(candidate))
  );
}

function normalizeSerializedCredentialText(text) {
  return text
    .replace(/\\(["'`\\])/g, "$1")
    .replace(/\\\//g, "/")
    .replace(/\\[nrtfb]/g, " ")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/\\(.)/gs, (match, character) => {
      const code = character.charCodeAt(0);
      const isAsciiPunctuation = (code >= 33 && code <= 47)
        || (code >= 58 && code <= 64)
        || (code >= 91 && code <= 96)
        || (code >= 123 && code <= 126);
      return isAsciiPunctuation ? character : match;
    });
}

function assertSafeCommitEvidence(value) {
  // Scan raw and intermediate representations while serialized escapes, HTML entities,
  // and Markdown/HTML markup converge together. Anything still changing after the
  // bounded pass count is rejected rather than treated as safe.
  const matched = scanCommitCredentials(String(value || ""));
  if (matched) throw commitCredentialError(matched[0]);
}

function bodyParagraphs(body) {
  if (!body) return [];
  const paragraphs = [];
  let current = [];
  let inFence = false;
  const flush = () => {
    const paragraph = current.join(" ").replace(/\s+/g, " ").trim();
    current = [];
    if (paragraph && !BODY_NOISE_PATTERN.test(paragraph)) paragraphs.push(paragraph);
  };

  for (const rawLine of String(body).split("\n")) {
    const line = rawLine.trim();
    if (/^(?:```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (BODY_TRAILER_PATTERN.test(line)) {
      flush();
      break;
    }
    if (!line) {
      flush();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flush();
      if (BODY_SECTION_LABEL_PATTERN.test(heading[1])) {
        current.push(heading[1]);
        flush();
      }
      continue;
    }
    if (/^\|?\s*:?-{3,}/.test(line)) {
      flush();
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      flush();
      current.push(bullet[1]);
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return paragraphs;
}

function bodySectionRole(label) {
  const match = String(label).match(BODY_SECTION_LABEL_PATTERN);
  if (!match) return null;
  const normalized = match[1].toLowerCase();
  if (normalized === "배경" || normalized === "background") return "background";
  if (normalized === "변경" || normalized === "수정" || /^changes?$/.test(normalized)) {
    return "change";
  }
  if (normalized === "검증" || normalized === "verification" || /^tests?$/.test(normalized)) {
    return "verification";
  }
  return "description";
}

function associateBodySectionRoles(paragraphs) {
  const associated = [];
  let activeRole = null;
  for (const paragraph of paragraphs) {
    const role = bodySectionRole(paragraph);
    if (role) {
      activeRole = role;
      continue;
    }
    associated.push({ text: paragraph, role: activeRole });
  }
  return associated;
}

function compactBodyDetail(text) {
  const normalized = String(text)
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:배경|설명|변경|수정|검증|background|summary|changes?|verification|tests?)\s*[:：-]\s*/i, "");
  if (normalized.length <= MAX_BODY_DETAIL_CHARS) return normalized;
  const clipped = normalized.slice(0, MAX_BODY_DETAIL_CHARS - 1);
  const boundary = clipped.lastIndexOf(" ");
  const end = boundary > MAX_BODY_DETAIL_CHARS / 2 ? boundary : clipped.length;
  return `${clipped.slice(0, end).trimEnd()}…`;
}

// commit body를 다시 서술하지 않고 원문 단락을 최대 3개까지 역할별로 보존한다.
// 상세 포맷이 없는 과거 commit도 첫 설명, 실제 변경, 검증 결과를 순서대로 제공한다.
function extractBodyHighlights(body, maxLines = 3) {
  const paragraphs = associateBodySectionRoles(bodyParagraphs(body));
  if (!paragraphs.length || maxLines <= 0) return [];
  const selected = [];
  const seen = new Set();
  const add = (label, entry) => {
    const paragraph = entry && entry.text;
    if (!paragraph || selected.length >= maxLines) return;
    const detail = compactBodyDetail(paragraph);
    if (!detail) return;
    const key = normalizeForDedup(detail);
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(`${label}: ${detail}`);
  };

  const verification = [...paragraphs].reverse().find((entry) => entry.role === "verification")
    || [...paragraphs].reverse().find((entry) => !entry.role
      && BODY_VERIFICATION_PATTERN.test(entry.text));
  const background = paragraphs.find((entry) => entry.role === "background")
    || paragraphs.find((entry) => !entry.role && entry !== verification
      && BODY_BACKGROUND_PATTERN.test(entry.text));
  const change = paragraphs.find((entry) => entry.role === "change")
    || paragraphs.find((entry) => !entry.role && entry !== verification && entry !== background
      && BODY_CHANGE_PATTERN.test(entry.text));
  const description = paragraphs.find((entry) => entry.role === "description")
    || paragraphs.find((entry) => !entry.role && entry !== verification
      && entry !== background && entry !== change);

  add(background ? "배경" : "설명", background || description || change);
  if (change && change !== background) add("변경", change);
  if (!change && description && description !== background) add("설명", description);
  add("검증", verification);
  return selected;
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

function gitLogParseError() {
  const error = new Error("Git log rejected: malformed NUL-delimited record");
  error.code = "GIT_LOG_PARSE_INVALID";
  return error;
}

function parseGitLogRecords(stdout) {
  const fields = String(stdout || "").split("\0");
  const records = [];
  let index = 0;

  while (index < fields.length) {
    while (index < fields.length && fields[index] === "") index += 1;
    if (index >= fields.length) break;
    if (index + 2 >= fields.length) throw gitLogParseError();

    const hash = fields[index++];
    const subject = fields[index++];
    const body = fields[index++];
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) throw gitLogParseError();

    const files = [];
    let terminated = false;
    while (index < fields.length) {
      const field = fields[index++];
      if (field === "") {
        terminated = true;
        break;
      }
      // git inserts one layout newline before the first --name-only path.
      const file = field.replace(/^\n/, "");
      if (file) files.push(file);
    }
    if (!terminated) throw gitLogParseError();
    records.push({ hash, subject, body, files });
  }

  return records;
}

function getGitCommitRecords(repoPath, since, until, config, repoOpts, dependencies = {}) {
  const includeBody = repoOpts && repoOpts.includeCommitBody;
  // 파일 목록은 body 사용 여부와 무관하게 항상 받는다 — 경로 신호 판정에 필요하다.
  const args = [
    "-C", repoPath, "log",
    `--since=${since}`, `--until=${until}`,
    "--pretty=format:%H%x00%s%x00%b%x00",
    "--name-only",
    "-z",
  ];
  if (config.env.authorMatch.trim()) args.push(`--author=${config.env.authorMatch}`);
  if (!config.env.includeMerges) args.push("--no-merges");

  // 파일 목록이 붙어 출력이 커진다(대형 release 커밋 하나가 수백 줄). 실측으로는
  // 주간 범위 한 저장소가 최대 65KB(pim-package-jhw, 2026-08-12~19)라 종전 10MB로도
  // 충분하지만, --name-only 만큼의 증가분과 저장소 추가를 감안해 여유를 둔다.
  const spawnGit = dependencies.spawnSync || spawnSync;
  let result;
  try {
    result = spawnGit("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    const error = new Error("Git log collection failed (spawn exception)");
    error.code = "GIT_LOG_FAILED";
    throw error;
  }
  if (!result) {
    const error = new Error("Git log collection failed (missing result)");
    error.code = "GIT_LOG_FAILED";
    throw error;
  }
  if (result.status !== 0 || result.signal || result.error) {
    const reason = result.error && result.error.code
      ? `spawn ${result.error.code}`
      : result.signal
        ? `signal ${result.signal}`
        : `exit ${result.status}`;
    const error = new Error(`Git log collection failed (${reason})`);
    error.code = "GIT_LOG_FAILED";
    throw error;
  }

  const output = [];
  for (const { hash, subject, body, files } of parseGitLogRecords(result.stdout)) {
    if (!subject) continue;
    assertSafeCommitEvidence(subject);

    // 신호는 subject에 이어붙이지 않고 하위 라인으로 둔다. 번역 규칙 중에는
    // "Harden (.+) → $1 강화"처럼 문장 끝까지 greedy로 삼키는 것이 있어,
    // 같은 줄에 붙이면 신호가 술어 안으로 빨려들어가 어순이 깨진다.
    const pathSignalLines = detectPathSignals(files, subject, config)
      .map((label) => `  ↳ ${label}`);
    const extras = [...pathSignalLines];

    // 설정된 저장소는 subject 종류와 무관하게 body 근거를 같은 항목의 하위 라인으로 붙인다.
    // body가 없거나 유효한 단락이 없으면 기존 subject fallback을 그대로 유지한다.
    const contract = parseChangeEvidence("commit", `${subject}\n\n${body}`);
    let usedEvidence = "commit_subject";
    let safeRawBody;
    if (contract.classification === "v1-valid") {
      assertSafeCommitEvidence(body);
      const purpose = compactBodyDetail(contract.fields.Why);
      const changes = compactBodyDetail(contract.lists.Changes.slice(0, 2).join("; "));
      const validation = compactBodyDetail(
        contract.lists.Validation.join("; ") || contract.fields.Validation
      );
      if (purpose) extras.push(`  ↳ 목적: ${purpose}`);
      if (changes) extras.push(`  ↳ 변경: ${changes}`);
      if (validation) extras.push(`  ↳ 검증: ${validation}`);
      usedEvidence = "structured_commit";
      safeRawBody = body;
    } else if (contract.classification === "v1-invalid") {
      // invalid-v1도 parsed fields를 만들므로, provenance 축약 전에 원문을 검사한다.
      assertSafeCommitEvidence(body);
    } else if (includeBody && !containsCommitBodyMarkup(body)) {
      assertSafeCommitEvidence(body);
      const highlights = extractBodyHighlights(body);
      for (const h of highlights) extras.push(`  ↳ ${h}`);
      if (highlights.length) {
        usedEvidence = "commit_body";
        safeRawBody = body;
      }
    }
    output.push({
      hash,
      subject,
      body,
      files,
      contract,
      usedEvidence,
      pathSignalLines,
      ...(safeRawBody === undefined ? {} : { safeRawBody }),
      rendered: extras.length ? subject + "\n" + extras.join("\n") : subject,
    });
  }
  return output;
}

function getGitCommits(repoPath, since, until, config, repoOpts, dependencies = {}) {
  return getGitCommitRecords(repoPath, since, until, config, repoOpts, dependencies)
    .map(record => record.rendered);
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

  let startMs;
  let endMs;
  try {
    startMs = parseEnvDate(since, "start").getTime();
    endMs = parseEnvDate(until, "end").getTime();
  } catch {
    return [];
  }

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
  const conventional = parseConventionalCommit(line);
  if (conventional) return conventional.type;

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
  const [subject, ...continuations] = String(line).split("\n");
  let output = stripTypePrefix(subject);
  for (const rule of config.translationRules) {
    output = output.replace(rule.pattern, rule.replacement);
  }
  return [output, ...continuations].join("\n");
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
    const [subject, ...continuations] = String(line).split("\n");
    const repoMatch = subject.match(/^\[([^\]]+)\]\s*(.*)/);
    if (repoMatch) {
      const repoName = repoMatch[1];
      const content = [repoMatch[2], ...continuations].join("\n");
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

function repositoryUrl(config, repoName, repoDef) {
  const owner = repoDef.githubOwner || config.env.githubOwner;
  const repository = repoDef.githubRepo || repoName;
  return {
    owner,
    repository,
    baseUrl: owner && repository ? `https://github.com/${owner}/${repository}` : null,
  };
}

function evidenceLine(label, value) {
  const detail = compactBodyDetail(value);
  return detail ? `  ↳ ${label}: ${detail}` : null;
}

function structuredCommitDetails(record) {
  if (!record || record.contract.classification !== "v1-valid") return {};
  return {
    purpose: record.contract.fields.Why,
    change: record.contract.lists.Changes.slice(0, 2).join("; "),
    validation: record.contract.lists.Validation.join("; ") || record.contract.fields.Validation,
  };
}

function provenanceContract(contract) {
  if (contract.classification === "v1-valid") return contract;
  return {
    classification: contract.classification,
    kind: contract.kind,
    findings: [...contract.findings],
  };
}

function pullRequestItem(record, coveredCommits) {
  const pullContract = record.pullRequest.contract;
  const validPull = pullContract.classification === "v1-valid" ? pullContract : null;
  const linkedIssue = record.issues.find(issue => issue.contract.classification === "v1-valid");
  const structuredCommit = coveredCommits.find(commit =>
    commit.contract.classification === "v1-valid");
  const commitDetails = structuredCommitDetails(structuredCommit);
  const subjectFallback = coveredCommits.slice(0, 2)
    .map(commit => stripTypePrefix(commit.subject))
    .join("; ");
  const details = {
    purpose: validPull?.fields.Summary || linkedIssue?.contract.fields.Goal || commitDetails.purpose,
    change: validPull?.lists.Changes.slice(0, 2).join("; ")
      || commitDetails.change
      || subjectFallback,
    validation: validPull
      ? (validPull.lists.Validation.join("; ") || validPull.fields.Validation)
      : commitDetails.validation,
  };
  const continuations = [
    evidenceLine("목적", details.purpose),
    evidenceLine("변경", details.change),
    evidenceLine("검증", details.validation),
    ...new Set(coveredCommits.flatMap(commit => commit.pathSignalLines || [])),
  ].filter(Boolean);
  const subject = record.pullRequest.title
    || coveredCommits[0]?.subject
    || `PR #${record.number}`;
  const usedEvidence = [];
  if (validPull) usedEvidence.push("pull_request");
  else usedEvidence.push("pull_request_title");
  if (linkedIssue) usedEvidence.push("linked_issue");
  if (!validPull && structuredCommit) {
    usedEvidence.push("structured_commit");
  } else if (!validPull && subjectFallback) {
    usedEvidence.push("commit_subject");
  }
  return {
    rendered: continuations.length ? `${subject}\n${continuations.join("\n")}` : subject,
    provenance: {
      ...record,
      usedEvidence: [...new Set(usedEvidence)],
      coveredCommits: coveredCommits.map(commit => ({
        hash: commit.hash,
        subject: commit.subject,
        url: record.owner && record.repository
          ? `https://github.com/${record.owner}/${record.repository}/commit/${commit.hash}`
          : null,
        contract: provenanceContract(commit.contract),
        ...(commit.safeRawBody === undefined ? {} : { rawBody: commit.safeRawBody }),
      })),
      renderedItem: continuations.length ? `${subject}\n${continuations.join("\n")}` : subject,
    },
  };
}

function commitItem(record, config, repoName, repoDef) {
  const repository = repositoryUrl(config, repoName, repoDef);
  return {
    rendered: record.rendered,
    provenance: {
      id: `git:${repoName}:commit:${record.hash}`,
      owner: repository.owner || null,
      repository: repository.repository,
      usedEvidence: [record.usedEvidence],
      commit: {
        hash: record.hash,
        subject: record.subject,
        url: repository.baseUrl ? `${repository.baseUrl}/commit/${record.hash}` : null,
        contract: provenanceContract(record.contract),
        ...(record.safeRawBody === undefined ? {} : { rawBody: record.safeRawBody }),
      },
      renderedItem: record.rendered,
    },
  };
}

async function integrateRepositoryEvidence(
  config,
  repoName,
  repoDef,
  commits,
  startDate,
  endDate,
  options
) {
  const repository = repositoryUrl(config, repoName, repoDef);
  const token = config.env.githubToken;
  let github = { status: "skipped", records: [], errors: [] };
  if (token && repository.owner && repository.repository) {
    github = await collectMergedPullRequestEvidence({
      owner: repository.owner,
      repo: repository.repository,
      startDate,
      endDate,
      token,
      fetch: options.fetch || globalThis.fetch,
      assertSafeBody: assertSafeCommitEvidence,
    });
  }

  const byHash = new Map(commits.map(commit => [commit.hash.toLowerCase(), commit]));
  const covered = new Set();
  const items = [];
  const provenance = [];
  for (const pull of github.records) {
    const matching = pull.coveredCommitShas
      .map(sha => byHash.get(sha.toLowerCase()))
      .filter(Boolean);
    if (config.env.authorMatch.trim() && matching.length === 0) continue;
    for (const commit of matching) covered.add(commit.hash);
    const item = pullRequestItem(pull, matching);
    items.push(item.rendered);
    provenance.push(item.provenance);
  }
  for (const commit of commits) {
    if (covered.has(commit.hash)) continue;
    const item = commitItem(commit, config, repoName, repoDef);
    items.push(item.rendered);
    provenance.push(item.provenance);
  }
  return { items, provenance, githubStatus: github.status, errors: github.errors };
}

// Plan SC: SC1 — 신규 repo 추가 = config 1곳만 수정
async function collectAll(config, startDate, endDate, options = {}) {
  const groups = {};
  for (const cat of Object.keys(config.categories)) {
    groups[cat] = [];
  }
  const collectionContext = options.collectionContext || {};
  const evidenceRecords = [];
  const evidenceErrors = [];
  const githubStatuses = [];

  for (const [repoName, repoDef] of Object.entries(config.repos)) {
    const groupKey = repoDef.category;
    if (!groupKey || !groups[groupKey]) continue;

    const commitRecords = getGitCommitRecords(repoDef.path, startDate, endDate, config, repoDef)
      .filter(record => record.subject && !isTrivialCommit(record.subject, config));
    const integrated = await integrateRepositoryEvidence(
      config,
      repoName,
      repoDef,
      commitRecords,
      startDate,
      endDate,
      options
    );
    const allCommits = integrated.items.map(line => line.trim()).filter(Boolean);
    evidenceRecords.push(...integrated.provenance.map(record => ({
      ...record,
      category: groupKey,
      templateKey: config.categories[groupKey]?.templateKey || null,
    })));
    evidenceErrors.push(...integrated.errors);
    githubStatuses.push(integrated.githubStatus);

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

  const githubAttempted = githubStatuses.filter(status => status !== "skipped");
  collectionContext.changeEvidence = {
    contractVersion: "v1",
    status: githubAttempted.includes("degraded")
      ? "degraded"
      : githubAttempted.length ? "success" : "skipped",
    records: evidenceRecords,
    errors: evidenceErrors,
  };

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

module.exports = {
  collectAll,
  detectPathSignals,
  extractBodyHighlights,
  getChangelogEntries,
  getGitCommitRecords,
  getGitCommits,
  stripTypePrefix,
  translateLine,
};
