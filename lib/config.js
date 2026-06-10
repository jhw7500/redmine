// Design Ref: §4.1 — 설정 통합 로드 + 환경변수 머지 + regex 컴파일
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// 보고서 상세도 단계 (1=요약, 2=표준, 3=상세). 비정상 값은 경고 후 2로 폴백 (cron 안정성).
function resolveReportDepth(envValue, defaultValue) {
  const raw = envValue !== undefined && envValue !== "" ? envValue : defaultValue;
  if (raw === undefined || raw === null || raw === "") return 2;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3) {
    console.warn(`[config] Invalid REPORT_DEPTH=${raw} (1~3 정수만 허용), 2로 폴백`);
    return 2;
  }
  return n;
}

function loadConfig() {
  // 1. repo-config.json 로드
  const configPath = path.join(ROOT, "repo-config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));

  // 2. translation-rules.json 로드 + 컴파일
  const rulesPath = path.join(ROOT, "translation-rules.json");
  const rawRules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
  const translationRules = rawRules.map((r) => ({
    pattern: new RegExp(r.pattern, r.flags || ""),
    replacement: r.replacement,
  }));

  // 3. trivialPatterns 컴파일
  const trivialPatterns = (raw.trivialPatterns || []).map(
    (p) => new RegExp(p, "i")
  );

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
  };

  // 8. 유효성 검사
  if (!env.apiKey) {
    console.error("Missing REDMINE_API_KEY.");
    process.exit(1);
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
    // 원본 문자열도 보존 (AI 프롬프트에 노출용)
    rawExcludeSubsectionPatterns: rawFilter.excludeSubsectionPatterns || [],
  };

  return {
    repos,
    categories: raw.categories || {},
    commitTypes,
    trivialPatterns,
    translationRules,
    displayNames,
    defaults,
    sources,
    reportFilter,
    depthProfiles: raw.depthProfiles || {},
    env,
  };
}

module.exports = { loadConfig };
