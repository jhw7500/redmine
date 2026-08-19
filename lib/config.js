// Design Ref: §4.1 — 설정 통합 로드 + 환경변수 머지 + regex 컴파일
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// 보고서 상세도 단계 (1=요약, 2=표준, 3=중간, 4=상세). 비정상 값은 경고 후 2로 폴백 (cron 안정성).
function resolveReportDepth(envValue, defaultValue) {
  const raw = envValue !== undefined && envValue !== "" ? envValue : defaultValue;
  if (raw === undefined || raw === null || raw === "") return 2;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    console.warn(`[config] Invalid REPORT_DEPTH=${raw} (1~4 정수만 허용), 2로 폴백`);
    return 2;
  }
  return n;
}

function resolveChoice(value, allowed, fallback, name) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (allowed.includes(normalized)) return normalized;
  console.warn(`[config] Invalid ${name}=${value}; ${fallback} 사용`);
  return fallback;
}

// 설정 파일이 없거나 JSON이 깨지면 cron 로그에는 스택 트레이스만 남아 무엇을 읽다
// 실패했는지 드러나지 않는다. 파일과 사유를 첫 줄에 담아 다시 던진다.
function readJsonFile(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    // err.message 에는 경로가 이미 들어 있다. 그대로 붙이면 한 줄에 경로가 두 번 나온다.
    const reason = err.code === "ENOENT" ? "파일이 없습니다" : (err.code || err.message);
    throw new Error(`${label} 로드 실패: ${filePath} — ${reason}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} JSON 파싱 실패: ${filePath} — ${err.message}`);
  }
}

function loadConfig() {
  // 1. repo-config.json 로드
  const configPath = path.join(ROOT, "repo-config.json");
  const raw = readJsonFile(configPath, "저장소 설정");

  // 2. translation-rules.json 로드 + 컴파일
  const rulesPath = path.join(ROOT, "translation-rules.json");
  const rawRules = readJsonFile(rulesPath, "번역 규칙");
  const translationRules = rawRules.map((r) => ({
    pattern: new RegExp(r.pattern, r.flags || ""),
    replacement: r.replacement,
  }));

  // 3. trivialPatterns 컴파일
  const trivialPatterns = (raw.trivialPatterns || []).map(
    (p) => new RegExp(p, "i")
  );

  // 3-1. pathSignals 컴파일 — 커밋 메시지에 드러나지 않는 변경을 파일 경로로 식별한다.
  const pathSignals = (raw.pathSignals || []).map((sig) => ({
    pattern: new RegExp(sig.pattern, "i"),
    label: sig.label,
    // subject가 이미 그 사실을 말하고 있으면 신호를 덧붙이지 않는다(중복 방지).
    skipIf: sig.skipIf ? new RegExp(sig.skipIf, "i") : null,
  }));

  // 4. commitTypes linePatterns 컴파일
  const commitTypes = {};
  for (const [type, def] of Object.entries(raw.commitTypes || {})) {
    commitTypes[type] = {
      label: def.label,
      conventionalPrefixes: def.conventionalPrefixes || [],
      linePatterns: (def.linePatterns || []).map((p) => new RegExp(p, "i")),
    };
  }

  // 5. repos — .git 존재 확인으로 필터
  const repos = {};
  for (const [name, def] of Object.entries(raw.repos || {})) {
    if (fs.existsSync(path.join(def.path, ".git"))) {
      repos[name] = def;
    }
  }

  // 6. displayNames 추출 (etc 카테고리의 displayName)
  const displayNames = {};
  for (const [name, def] of Object.entries(raw.repos || {})) {
    if (def.displayName) {
      displayNames[name] = def.displayName;
    }
  }

  // 7. 환경변수 오버라이드 적용
  const defaults = raw.defaults || {};
  const env = {
    apiKey: process.env.REDMINE_API_KEY || "",
    githubToken: process.env.GITHUB_TOKEN || "",
    aiSummarize: process.env.AI_SUMMARIZE === "1",
    mode: process.env.MODE || "generate",
    meetingDate: process.env.MEETING_DATE || "",
    autoApprove: process.env.AUTO_APPROVE === "1",
    baseUrl: process.env.REDMINE_BASE_URL || defaults.baseUrl || "http://192.168.10.2:30002",
    projectId: process.env.PROJECT_ID || defaults.projectId || "team-4-weekly-meeting",
    pageSuffix: process.env.PAGE_SUFFIX || defaults.pageSuffix || "개발4팀_주간_회의",
    sectionHeader: process.env.SECTION_HEADER || defaults.sectionHeader || '#### <span style="color:blue">조현우</span>',
    outputDir: path.resolve(ROOT, process.env.OUTPUT_DIR || defaults.outputDir || "out"),
    templatePath: process.env.TEMPLATE_PATH || path.join(ROOT, "templates", "jo-hyunwoo.md"),
    aiEnPath: process.env.AI_EN_PATH || path.join(ROOT, "templates", "ai-en.md"),
    aiKoPath: process.env.AI_KO_PATH || path.join(ROOT, "templates", "ai-ko.md"),
    githubOwner: process.env.GITHUB_OWNER || defaults.githubOwner || "jhw7500",
    claudeCli: process.env.CLAUDE_CLI || defaults.claudeCli || "claude",
    wikiUrl: process.env.WIKI_URL || "",
    authorMatch: process.env.AUTHOR_MATCH || "",
    includeMerges: process.env.INCLUDE_MERGES === "1",
    extraNotesPath: process.env.EXTRA_NOTES_PATH || "",
    outputPath: process.env.OUTPUT_PATH || "",
    reportDepth: resolveReportDepth(process.env.REPORT_DEPTH, defaults.reportDepth),
    snapshotPath: process.env.SNAPSHOT_PATH || "",
    forceCollect: process.env.FORCE_COLLECT === "1",
    allowPartialSnapshot: process.env.ALLOW_PARTIAL_SNAPSHOT === "1",
    validationMode: resolveChoice(
      process.env.VALIDATION_MODE,
      ["warn", "block"],
      "block",
      "VALIDATION_MODE"
    ),
    validationOverride: process.env.VALIDATION_OVERRIDE === "1",
    presentationNoteMode: resolveChoice(
      process.env.PRESENTATION_NOTE_MODE,
      ["off", "tagged", "suggest", "auto"],
      "tagged",
      "PRESENTATION_NOTE_MODE"
    ),
    presentationNoteThreshold: Math.max(
      1,
      Number.parseInt(process.env.PRESENTATION_NOTE_THRESHOLD || "5", 10) || 5
    ),
  };

  // 8. 유효성 검사
  // 라이브러리 함수에서 process.exit 하면 이 모듈을 로드하는 테스트나 스크립트가
  // 진단 기회 없이 그 자리에서 죽는다. 던지고, 종료 여부는 호출자가 정한다.
  // index.js 의 main().catch 가 이 에러를 받아 exitCode 1 로 끝내므로 cron 의
  // 실패 감지(run-report-env.sh 의 status=$?)는 종전과 같이 동작한다.
  if (!env.apiKey && env.mode === "update") {
    throw new Error("REDMINE_API_KEY가 설정되지 않았습니다 — MODE=update 에는 필수입니다.");
  }

  console.log(`GITHUB_TOKEN: ${env.githubToken ? "SET" : "UNSET"}`);

  // Design Ref: §4.1 — sources 설정 로드 (하위 호환: 없으면 git-only)
  const sources = raw.sources || {
    git: { enabled: true },
    notion: { enabled: false },
    session: { enabled: false },
  };

  // reportFilter 로드 + regex 컴파일 (하위 호환: 없으면 빈 규칙)
  const rawFilter = raw.reportFilter || {};

  // 팀장 회의 보고용 중요 항목 강조(밑줄) 옵션.
  // 우선순위: env(LEADER_HIGHLIGHT / LEADER_HIGHLIGHT_MAX) > repo-config > 코드 디폴트.
  // 코드 디폴트(키 미설정 시): enabled=false(미사용), maxLines=0(무제한).
  // repo-config.json은 운영상 enabled=true 적용 중 — 코드 디폴트 off는 키가 없을 때의 fallback.
  // maxLines는 env/config 양쪽 모두 parseInt로 정수화 (소수 입력이 프롬프트에 노출되지 않도록 일관 처리).
  const rawLH = rawFilter.leaderHighlight || {};
  const envLH = process.env.LEADER_HIGHLIGHT;
  const envLHMax = process.env.LEADER_HIGHLIGHT_MAX;
  const leaderHighlight = {
    enabled:
      envLH !== undefined && envLH !== ""
        ? envLH === "1"
        : rawLH.enabled === true,
    maxLines:
      envLHMax !== undefined && envLHMax !== ""
        ? Math.max(0, Number.parseInt(envLHMax, 10) || 0)
        : Math.max(0, Number.parseInt(rawLH.maxLines, 10) || 0),
    guidance: rawLH.guidance || "",
  };

  const reportFilter = {
    excludeNotionTitlePatterns: (rawFilter.excludeNotionTitlePatterns || []).map(
      (p) => new RegExp(p, "i")
    ),
    excludeSubsectionPatterns: (rawFilter.excludeSubsectionPatterns || []).map(
      (p) => new RegExp(p, "i")
    ),
    maxItemsPerSubcategory: rawFilter.maxItemsPerSubcategory || 0,
    maxItemsPerEtcProject: rawFilter.maxItemsPerEtcProject || 0,
    aiGuidance: rawFilter.aiGuidance || {},
    leaderHighlight,
    // 원본 문자열도 보존 (AI 프롬프트에 노출용)
    rawExcludeSubsectionPatterns: rawFilter.excludeSubsectionPatterns || [],
  };

  return {
    repos,
    categories: raw.categories || {},
    commitTypes,
    trivialPatterns,
    pathSignals,
    translationRules,
    displayNames,
    defaults,
    sources,
    reportFilter,
    depthProfiles: raw.depthProfiles || {},
    env,
  };
}

module.exports = { loadConfig, readJsonFile, resolveChoice, resolveReportDepth };
