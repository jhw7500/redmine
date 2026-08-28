// Design Ref: §4.3 — 템플릿 렌더링 + AI 요약 + Redmine Wiki API
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { renderNotesBlock } = require("./notion-issue-publisher");
const { dateRange } = require("./report-range");
const { formatFactCatalogForPrompt } = require("./fact-catalog");
const { formatSystemFactReferences } = require("./fact-references");
const { sha256 } = require("./report-artifact");

// --- 날짜 유틸 ---

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function targetWednesday(fromDate) {
  const day = fromDate.getDay();
  const target = 3;
  const d = new Date(fromDate);
  if (day <= target) {
    d.setDate(d.getDate() + (target - day));
  } else {
    d.setDate(d.getDate() + (7 - (day - target)));
  }
  return d;
}

// --- URL/경로 유틸 ---

function buildWikiUrl(meetingDate, config) {
  const title = `${formatDate(meetingDate)}_${config.env.pageSuffix}`;
  return `${config.env.baseUrl}/projects/${config.env.projectId}/wiki/${encodeURIComponent(title)}`;
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

function parseMeetingDateFromTitle(title) {
  const match = title.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  return new Date(`${match[1]}T00:00:00`);
}

function buildOutputPath(meetingDate, config) {
  const filename = `jo-hyunwoo-${formatDate(meetingDate)}.depth${config.env.reportDepth}.md`;
  return config.env.outputPath || path.join(config.env.outputDir, filename);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// --- 프롬프트 ---

function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// --- 템플릿 ---

function formatBulletsFromFile(filePath, indent, emptyLabel) {
  if (!filePath || !fs.existsSync(filePath)) return `${indent}${emptyLabel}`;
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("-") ? l.slice(1).trim() : l))
    .filter((l) => l.toLowerCase() !== "ai");
  if (!lines.length) return `${indent}${emptyLabel}`;
  return lines.map((l) => `${indent}${l}`).join("\n");
}

function buildContent(meetingDate, autoContent, config) {
  // dateRange()와 동일 로직(env override 포함) — 헤더 표기도 수집 범위와 일치시킨다.
  const range = dateRange(meetingDate);
  const replacements = {
    "{{START_DATE}}": formatDate(range.start),
    "{{END_DATE}}": formatDate(range.end),
  };

  let content = fs.readFileSync(config.env.templatePath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(key).join(value);
  }
  for (const [key, value] of Object.entries(autoContent)) {
    content = content.split(key).join(value);
  }
  return content.trimEnd() + "\n";
}

// --- AI 요약 ---

// 팀장 회의 보고용 중요 항목 강조(밑줄) 규칙 블록.
// 옵션 OFF(디폴트)면 빈 문자열을 반환 → 프롬프트에 주입되지 않아 AI가 밑줄을 전혀 넣지 않는다.
// maxLines>0이면 밑줄 개수 상한을 프롬프트로 지시(기존 maxItemsPerSubcategory와 동일한 방식).
function buildLeaderHighlightGuidance(config) {
  const lh = (config.reportFilter || {}).leaderHighlight || {};
  if (!lh.enabled) return "";

  const limitText =
    lh.maxLines > 0
      ? `- **개수 상한**: 전체 보고에서 밑줄은 최대 ${lh.maxLines}줄. 초과하면 가장 중요한 ${lh.maxLines}개만 남기고 나머지는 밑줄 없이 둔다.`
      : "- **개수 상한 없음**: 단, 정말 팀장 회의에서 보고할 핵심만 표시한다. 대부분의 줄은 밑줄 없이 둔다.";

  const body =
    typeof lh.guidance === "string" && lh.guidance.trim()
      ? lh.guidance.trim()
      : `팀장이 팀장 회의에서 별도로 보고할 만한 **중요 항목**을 밑줄로 표시한다.
- **대상**: (성과) 완료한 주요 작업·달성한 마일스톤·출시 등 + (이슈) 장애·중대 버그·일정 리스크·의사결정 필요 사항. 둘 다 대상이다.
- **마크업**: 해당 항목의 내용 텍스트를 \`<u>\`와 \`</u>\`로 감싼다. 불릿 마커('- ')와 들여쓰기는 그대로 두고 **내용 텍스트만** 감싼다. 예: \`    - <u>moal_bridge 연결 끊김 복구로 장시간 운용 안정성 확보</u>\`
- **위치**: 그 항목을 대표하는 **한 줄**(보통 상위 테마 줄, 또는 단일 핵심 항목 줄)에만 적용한다. 같은 그룹의 하위 세부 줄 여러 개에 중복으로 밑줄 치지 않는다.
- **절제**: 모든 항목에 밑줄을 치면 강조 효과가 사라진다. 정말 보고 가치가 있는 것만 표시한다.`;

  return `\n\n## 팀장 회의 보고용 중요 항목 표시 (밑줄) — 최우선 출력 규칙
${body}
${limitText}`;
}

function buildFilterGuidance(config) {
  const rf = config.reportFilter || {};
  const guidance = rf.aiGuidance || {};
  const excludeSubsections = rf.rawExcludeSubsectionPatterns || [];
  const maxPerSub = rf.maxItemsPerSubcategory || 5;
  const maxPerEtc = rf.maxItemsPerEtcProject || 4;

  const excludeList = excludeSubsections.length
    ? excludeSubsections.map((s) => `  - ${s.replace(/^\^/, "").replace(/\\s\*/g, " ")}`).join("\n")
    : "  - (없음)";

  const highlightBlock = buildLeaderHighlightGuidance(config);

  return `## 팀 보고 제외 대상 서브섹션 (존재해도 출력하지 마라)
${excludeList}

## 계층 그룹핑 규칙 (중요)
${guidance.hierarchicalGrouping || "3개 이상 유사 항목은 상위 포괄 + 하위 구별 축으로 묶는다."}

예시:
나쁜 예 (나열):
\`\`\`
- pim-check
  - smart runner 완성 (9 combos × 2해상도)
  - AWB per-channel 16 케이스 자동생성
  - ISP 레지스터 기반 vflip/hflip/ae 검증
  - i2c 레지스터 4채널 검증 + dynamic fallback
  - schema 6개 신규 축 + 70 케이스
  - 추론형 에이전트 도입
  - QA 에이전트 도입
  - /api/run duration 파라미터
  - edgeconf 백업 디렉토리 이동
\`\`\`

좋은 예 (상위 포괄 + 하위 축):
\`\`\`
- pim-check
  - 멀티축 자동화 테스트 커버리지 확장 (수십→96+ 시나리오)
    - AWB per-channel, ISP 레지스터, i2c 4채널 동적 fallback 등 신규 검증 축 추가
    - 추론형/QA 에이전트로 케이스 자동 생성·갭분석 도입
  - /api/run duration 파라미터 지원 및 edgeconf 백업 디렉토리 분리
\`\`\`

## 내부 작업 ID 제거
${guidance.stripInternalIds || "B1~B7, D8 같은 내부 ID는 제거. 한 줄 포괄 요약으로 대체."}

## 팀 관련성 필터
${guidance.teamRelevance || "개인 생산성 도구는 제외."}

## 버그 검출 결과 보존 (테스트 프로젝트 한정)
${guidance.preserveBugDetection || "pim-check 등 테스트 프로젝트의 필드 버그 발견은 별도 라인으로 보존."}

## Wireless Lan 공격적 축약
${guidance.aggressiveWirelessLanSummary || "Wireless Lan은 줄 수가 많아지기 쉬우므로 축 단위로 뭉쳐 축약."}

## Commit 타입 라벨 금지 (중요)
${guidance.noCommitTypeLabels || "구현/수정/리팩토링/문서 같은 라벨을 출력에 쓰지 말 것."}

## 간결함 우선
${guidance.preferBrevity || "브리비티 우선. 버그 검출 외에는 v1 수준 줄 수 유지."}

## 섹션 누락 금지 (중요)
${guidance.mandatorySections || "입력에 내용이 있는 서브카테고리는 절대 삭제하지 말 것. iMX93 BSP 등 특히 주의."}

## 기능 항목 verbose 억제
${guidance.avoidFeatureVerbosity || "버그 섹션 외에는 숫자/파일명/내부 ID를 생략하고 결과 중심으로."}

## 엄격한 카테고리 매핑
${guidance.strictCategoryMapping || "pcap-analyzer는 WLAN Test/Analysis, cts-ta-mcp-server/HiWorks는 ETC."}

## 섹션 헤더 재사용 금지
${guidance.headerReuseBan || "moal_bridge 하드닝은 Driver 전용. Application에 재사용 금지."}

## 테마 기반 그룹핑 (비전문가 친화)
${guidance.themeBasedGrouping || "서브카테고리 아래 flat 나열 대신 비전문가도 이해 가능한 상위 테마로 묶고 하위에 구체 변경 배치."}

## 카테고리당 항목 수 상한
- 서브카테고리당 최대 ${maxPerSub}개 (초과 시 상위-하위 계층 그룹핑 또는 문장 통합으로 축소)
- ETC 프로젝트당 최대 ${maxPerEtc}개
- 테스트 프로젝트의 버그 검출 결과는 상한 제외${highlightBlock}`;
}

// 상세도(depth) 프로파일 → 프롬프트 블록. depth=4(빈 guidance)이면 "" 반환 = 기존 프롬프트 불변.
function buildDepthGuidance(config) {
  const depth = config.env.reportDepth;
  const profile = (config.depthProfiles || {})[String(depth)] || {};
  const guidance = (profile.promptGuidance || "").trim();
  if (!guidance) return "";
  const label = profile.label ? `: ${profile.label}` : "";
  return `## 상세도 규칙 (depth=${depth}${label}) — 최우선
이 섹션은 아래의 다른 모든 규칙(계층 그룹핑, 테마 그룹핑, 섹션 누락 금지, 항목 수 상한, 버그 검출 보존 등)과 충돌하면 우선한다.
${guidance}

`;
}

class AiSummaryError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "AiSummaryError";
    this.code = code;
  }
}

function classifyAiExit(stderr) {
  if (/max-budget-usd|maximum\s+budget|budget\s+(exhausted|reached|limit)/i.test(stderr)) {
    return "AI_BUDGET";
  }
  const quotaPattern =
    /weekly\s+(usage\s+)?limit|usage\s+limit|hit\s+(your|the)\s+limit|quota|rate.?limit/i;
  if (quotaPattern.test(stderr)) {
    return "AI_QUOTA";
  }
  if (/unauthorized|authentication|not logged in|login required/i.test(stderr)) {
    return "AI_AUTH";
  }
  return "AI_EXIT";
}

function signalProcessTree(child, signal) {
  if (!child || !child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function buildFactContractGuidance(catalog, options = {}) {
  if (!catalog) return "";
  if (options.factInputMode === "inline_refs") {
    const systemFacts = formatSystemFactReferences(catalog);
    return `## 보호 사실 — 원문에 삽입된 불투명 reference를 그대로 복사
- 원본의 보호 숫자·버전·날짜·PASS/FAIL은 \`[[fact:ID]]\` reference로 치환되어 있다.
- 해당 사실이 필요한 문장을 유지하면 reference 전체를 그대로 복사한다.
- reference의 ID를 바꾸거나 reference를 풀어서 숫자·단위·조수사를 직접 쓰지 않는다.
- reference 앞뒤에 개·건·회, 물리 단위, PASS/FAIL을 새로 붙이지 않는다.
- 여러 reference를 합산·차감·집계하거나 환산·평균·반올림하지 않는다.
- 사용하지 않는 사실은 문장과 reference를 함께 생략할 수 있다.
${systemFacts ? `\n시스템 사실 reference:\n${systemFacts}` : ""}`;
  }
  return `## 허용 사실 — marker 전체를 원문 그대로 복사
- 수치·버전·날짜·PASS/FAIL 결과가 필요하면 아래 catalog marker 전체를 그대로 복사한다.
- marker surface의 숫자, 표기 순서, 단위, 조수사를 바꾸지 않는다.
- PASS N/M, N/M PASS, N건 PASS·실패 M건 사이를 변환하지 않는다.
- 개·건·회, 물리 단위, 버전 접두를 임의 변경하지 않는다.
- 여러 근거를 합산·차감·집계하지 않는다.
- 환산·비율 계산·평균·반올림·범위 축약을 하지 않는다.
- catalog에 없는 숫자가 필요하면 숫자를 생략하며, 쓰지 않는 사실은 marker를 출력하지 않는다.
${formatFactCatalogForPrompt(catalog)}`;
}

function buildAiPrompt(rawContent, config, meetingDate, options = {}) {
  const filterGuidance = buildFilterGuidance(config);
  const depthGuidance = buildDepthGuidance(config);
  // 원본에 기준일이 없는 미해결 항목은 "이번 수집 시점에도 여전히 열려 있다"가 사실이므로
  // 회의 날짜를 기준일로 쓴다. 날짜를 모르면 규칙만 남기고 예시는 생략한다.
  const meetingDateFact = options.factInputMode === "inline_refs" && options.factCatalog
    ? options.factCatalog.facts.find((fact) => fact.type === "meeting_date")
    : null;
  const asOfFallback = meetingDateFact
    ? `\n  - 원본에 기준일이 없으면 시스템 사실 \`[[fact:${meetingDateFact.id}]]\`를 기준일로 쓴다.`
    : meetingDate
      ? `\n  - 원본에 기준일이 없으면 이번 회의 날짜 \`${formatDate(meetingDate)}\`를 기준일로 쓴다.`
      : "";

  return `주간 회의 보고서 초안을 정리해라.

대상: 개발팀 전체 (git 비사용자 포함)

## 핵심 원칙
- **같은 기능의 여러 커밋은 하나로 통합**. 예: "RTSP disconnect 정리" + "RTSP graceful shutdown" → "RTSP 연결 해제 시 리소스 정리 개선"
- **서로 다른 기능/모듈은 합치지 않는다**. 예: "WiFi 절전 + SPI UART 로그" → 2줄로 분리
- **판단 기준**: 같은 파일/컴포넌트에 대한 변경이면 통합, 다른 파일/컴포넌트면 분리
- **빈 항목 삭제**: 하위 내용이 없는 카테고리/프로젝트명은 출력하지 않는다.
- **구체적으로**: "LED 제어" → "가변저항 IC(MCP4018) 제어 스크립트 추가"처럼 무엇인지 알 수 있게.
- **기술 용어**: 영어 그대로 유지 (RTSP, DMA, SPI UART, rsync 등)
- **계층 그룹핑 우선**: 한 프로젝트에서 3개 이상의 유사 항목은 반드시 상위-하위로 재구성.
- **사실 보존**: 원본에 없는 숫자·버전·날짜·PASS/FAIL 건수를 만들거나 변경하지 않는다.
- **미해결 상태**: 미해결·미완료·보류·TODO를 쓰려면 반드시 \`(YYYY-MM-DD 기준 미해결)\`처럼 **괄호 하나 안에 날짜와 상태를 함께** 넣는다. 괄호 안에 날짜만 있거나 상태만 있으면 게시가 차단된다.
  - 원본 \`출하 기본화는 보류 (2026-08-10)\` → 보고서 \`출하 기본화 (2026-08-10 기준 보류)\`
  - 원본 \`PR #10 머지 보류\` → 보고서 \`PR #10 머지 (YYYY-MM-DD 기준 보류)\`${asOfFallback}
- **본문 구분선 금지**: 조현우 섹션 안에 \`---\`, \`—\`, 긴 가로선 구분자를 출력하지 않는다.

${depthGuidance}${filterGuidance}${options.factCatalog ? `\n\n${buildFactContractGuidance(options.factCatalog, options)}` : ""}

## 삭제 대상
- 커밋 메시지 정정, 오타 수정, WIP, 코드 리뷰 반영, release 태그
- gitignore, log, chore, 서브모듈 업데이트
- PR/issue 번호, 커밋 해시 등 git 참조
- README 추가/업데이트 (단독 항목일 때만 삭제, 프로젝트 신규 구축 시에는 유지)
- **여러 카테고리에 동일하게 반복되는 항목** (예: "공통 워크플로우 적용")은 전부 삭제하거나 ETC에 한 번만 기재
- **개인 개발 도구/인프라 항목**: Claude Code, OMC, HUD, cclog, 세션 요약 자동화, Notion 스키마 변경 등은 팀 보고에 제외 (단, 주간 보고서 자동화 개선은 "Redmine 주간 보고 자동화"에 1~2줄로 유지)
- **Notion KB 개인 기술 메모**: 지식 기록 섹션 전체는 제외 (팀에 공유가 필요하면 해당 프로젝트 항목에 녹여라)

## 카테고리 규칙
- 원본의 카테고리 계층(PIM > Application/Camera Driver/SPI-to-UART Driver/Test/Analysis, Wireless Lan > iMX93 BSP/Application/Driver/Test/Analysis, ETC > 각 프로젝트) 유지
- 내용 없는 카테고리는 삭제
- ETC 하위 프로젝트명(CI/CD 자동화, HiWorks 근태 관리 등)은 반드시 유지
- **같은 프로젝트가 여러 섹션으로 중복되면 한 섹션으로 병합**. 특히 ETC에서 동일 displayName(예: "HiWorks 근태 관리")이 git 그룹과 [Notion] 라인에 별도로 나타나면 하나의 블록 아래로 통합하라. 'cts-ta-mcp-server' = 'HiWorks 근태 관리' 같은 repo명과 displayName은 동일 프로젝트다.
- 타입 라벨(구현/수정/리팩토링/문서/기타) **절대 출력 금지** — 위 "Commit 타입 라벨 금지" 섹션 우선
- Test/Analysis 카테고리 안에 독립 프로젝트(pim-check 등)가 있으면 프로젝트명을 하위 섹션으로 분리

## 정리 예시

나쁜 예 (합치기 과도):
\`\`\`
- WiFi power_save 비활성화 안정화 및 SPI UART 디버깅 로그 추가
\`\`\`

좋은 예 (기능별 분리):
\`\`\`
- WiFi 절전 모드 해제 안정화
...
- SC16IS752 SPI UART 드라이버 디버깅 로그 추가
\`\`\`

나쁜 예 (의미없는 항목):
\`\`\`
- 커밋 메시지 정정 — 대상 커널 5.10으로 수정
\`\`\`
→ 삭제

나쁜 예 (추상적):
\`\`\`
- LED 제어 스크립트 추가
\`\`\`

좋은 예 (구체적):
\`\`\`
- 카메라 센서 DMA 리셋 및 가변저항 IC 제어 스크립트 추가
\`\`\`

## 형식
- #### 헤더 + - 들여쓰기 마크다운 (원본과 동일)
- footer(*작성:...* 및 ---) 생성하지 않음
- 조현우 섹션만 출력

원본:
${rawContent}

정리된 보고서만 출력. 설명/주석 없이 마크다운만.`;
}

async function aiSummarize(rawContent, config, meetingDate, options = {}) {
  if (!config.env.aiSummarize) return null;

  const prompt = options.prompt || buildAiPrompt(rawContent, config, meetingDate, options);

  const depthLabel = ((config.depthProfiles || {})[String(config.env.reportDepth)] || {}).label || "";
  const promptChars = prompt.length;
  if (promptChars > config.env.aiMaxInputChars) {
    throw new AiSummaryError(
      "AI_INPUT_LIMIT",
      `prompt ${promptChars}자가 상한 ${config.env.aiMaxInputChars}자를 초과했습니다.`
    );
  }

  const args = [
    "--safe-mode",
    "--tools",
    "",
    "--no-session-persistence",
    "--model",
    config.env.aiModel,
    "--effort",
    config.env.aiEffort,
  ];
  if (config.env.aiMaxBudgetUsd !== null) {
    args.push("--max-budget-usd", String(config.env.aiMaxBudgetUsd));
  }
  args.push("-p", prompt, "--output-format", "text");

  console.log(
    `[ai] start model=${config.env.aiModel} effort=${config.env.aiEffort} ` +
    `depth=${config.env.reportDepth}${depthLabel ? `(${depthLabel})` : ""} ` +
    `inputChars=${promptChars}/${config.env.aiMaxInputChars} calls=1/1 ` +
    `timeoutMs=${config.env.aiTimeoutMs}`
  );
  const { spawn } = require("child_process");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let killTimer;
    let child;
    let timeoutError;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      console.error(`[ai] failed code=${error.code} calls=1/1`);
      reject(error);
    };

    try {
      child = spawn(config.env.claudeCli, args, {
        detached: process.platform !== "win32",
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      fail(new AiSummaryError("AI_SPAWN", err.message));
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    timer = setTimeout(() => {
      timeoutError = new AiSummaryError(
        "AI_TIMEOUT",
        `${config.env.aiTimeoutMs}ms를 초과했습니다.`
      );
      signalProcessTree(child, "SIGTERM");
      const killGraceMs = config.env.aiKillGraceMs ?? 1000;
      killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), killGraceMs);
    }, config.env.aiTimeoutMs);

    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timeoutError) {
        fail(timeoutError);
        return;
      }
      if (code !== 0) {
        const errorCode = classifyAiExit(stderr);
        fail(new AiSummaryError(errorCode, `Claude CLI가 exit ${code}로 종료했습니다.`));
        return;
      }
      let output = stdout.trim();
      if (!output) {
        fail(new AiSummaryError("AI_EMPTY_OUTPUT", "Claude CLI 응답이 비어 있습니다."));
        return;
      }
      // Claude CLI 응답에서 bkit/system 블록 제거
      output = output.replace(/\n*─{3,}[\s\S]*$/m, "").trimEnd();
      if (!output) {
        fail(new AiSummaryError("AI_EMPTY_OUTPUT", "정제 후 Claude CLI 응답이 비어 있습니다."));
        return;
      }
      settled = true;
      console.log(`[ai] complete model=${config.env.aiModel} calls=1/1 outputChars=${output.length}`);
      resolve(output + "\n");
    });

    child.on("error", (err) => {
      fail(timeoutError || new AiSummaryError("AI_SPAWN", err.message));
    });
  });
}

function sanitizeAiSection(output, config) {
  const text = String(output || "").trim();
  const header = config.env.sectionHeader;
  const headerIndex = text.indexOf(header);
  if (headerIndex === -1) return text ? text + "\n" : "";

  const lines = text.slice(headerIndex).split("\n");
  const kept = [];
  for (const line of lines) {
    if (kept.length > 0 && /^\s*(?:—|---|─{3,})\s*$/.test(line)) break;
    if (kept.length > 0
      && line.trim().startsWith('#### <span style="color:blue">')
      && line.trim() !== header) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").trimEnd() + "\n";
}

// --- 섹션 교체 ---

function replaceSection(body, newSection, config) {
  const header = config.env.sectionHeader;
  const lines = body.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === header);
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('#### <span style="color:blue">')) {
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

function extractSection(body, config) {
  const header = config.env.sectionHeader;
  const lines = body.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === header);
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('#### <span style="color:blue">')) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join("\n").trimEnd() + "\n";
}

// Redmine 백엔드 MySQL(utf8mb3)은 4바이트 UTF-8(BMP 밖, 이모지 등)을 저장하지 못해
// 위키 PUT 시 "Incorrect string value" → HTTP 500 을 유발한다. PUT 직전 해당 문자를 제거한다.
function stripAstralChars(text) {
  return text.replace(/[\u{10000}-\u{10FFFF}]/gu, "");
}

// --- Redmine API ---

async function fetchJson(url, config, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Redmine-API-Key": config.env.apiKey,
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

// --- 공개 API ---

function resolveMeetingDate(config) {
  if (config.env.meetingDate) {
    return new Date(`${config.env.meetingDate}T00:00:00`);
  }
  return null;
}

function stripNotesBlock(section) {
  return String(section)
    .replace(/\n{1,2}\*\*발표노트\(상세\)\*\*\n(?:- [^\n]*\n?)*/g, "\n")
    .trimEnd();
}

function appendNotesBlock(section, noteRefs) {
  const base = stripNotesBlock(section);
  const notesBlock = renderNotesBlock(noteRefs);
  return notesBlock ? `${base}\n\n${notesBlock}` : base;
}

async function generateContent(config, meetingDate, rawContent, options = {}) {
  const prompt = options.prompt || buildAiPrompt(rawContent, config, meetingDate, options);
  const summarized = await aiSummarize(rawContent, config, meetingDate, { ...options, prompt });
  if (summarized !== null && typeof options.onRawAiOutput === "function") {
    await options.onRawAiOutput(summarized);
  }
  return {
    usedAi: summarized !== null,
    rawAiOutput: summarized,
    content: summarized === null ? rawContent : sanitizeAiSection(summarized, config),
    prompt,
    promptHash: sha256(prompt),
  };
}

async function generate(config, meetingDate, autoContent, noteRefs = [], options = {}) {
  const rawSection = options.rawContent || buildContent(meetingDate, autoContent, config);
  const generation = await generateContent(config, meetingDate, rawSection, options);
  const generatedSection = generation.content;

  // 발표노트 이슈 링크 블록(#id)을 조현우 섹션 말미에 삽입(AI 요약 이후).
  // update()는 footer(*작성:...*)만 strip하므로 이 블록은 보존된다.
  let sectionWithNotes = generatedSection;
  if (noteRefs.length) {
    // AI 요약 OFF 등으로 raw 템플릿이 이미 *작성:* footer(+---)로 끝나면 블록을 footer 앞에 삽입.
    if (/\n\*작성:/.test(generatedSection)) {
      sectionWithNotes = generatedSection.replace(
        /(\n\*작성:[\s\S]*)$/,
        (_, footer) => `${appendNotesBlock(generatedSection.slice(0, -footer.length), noteRefs)}${footer}`
      );
    } else {
      sectionWithNotes = appendNotesBlock(generatedSection, noteRefs) + "\n";
    }
  }

  // <u> 태그 균형 검사 — leaderHighlight가 켜져 AI가 밑줄을 삽입하는 경우에만 수행한다.
  // 짝(열림/닫힘)이 안 맞으면 Redmine 위키/마크다운 렌더가 깨질 수 있어 경고만 남긴다(초안은 사람이 검토·수정 가능).
  const lhEnabled = config.reportFilter && config.reportFilter.leaderHighlight && config.reportFilter.leaderHighlight.enabled;
  if (lhEnabled) {
    const uOpen = (generatedSection.match(/<u>/g) || []).length;
    const uClose = (generatedSection.match(/<\/u>/g) || []).length;
    if (uOpen !== uClose) {
      console.warn(`[leaderHighlight] <u> 태그 불균형: open=${uOpen}, close=${uClose} — 초안 검토 필요`);
    }
  }

  const targetOutputPath = buildOutputPath(meetingDate, config);
  ensureDir(path.dirname(targetOutputPath));

  if (fs.existsSync(targetOutputPath)) {
    const backupPath = targetOutputPath.replace(/\.md$/, ".bak.md");
    fs.copyFileSync(targetOutputPath, backupPath);
    console.log(`Backup saved: ${backupPath}`);
  }
  fs.writeFileSync(targetOutputPath, sectionWithNotes, "utf8");
  console.log(`Draft saved: ${targetOutputPath}`);
  return targetOutputPath;
}

async function update(config, meetingDate, options = {}) {
  let wikiUrl = config.env.wikiUrl;
  if (!wikiUrl) {
    wikiUrl = buildWikiUrl(meetingDate, config);
  }

  const title = extractTitleFromUrl(wikiUrl);
  const projectId = extractProjectIdFromUrl(wikiUrl) || config.env.projectId;

  if (!title || !projectId) {
    console.error("Failed to parse project/title from WIKI_URL.");
    process.exit(1);
  }

  const pageUrl = `${config.env.baseUrl}/projects/${projectId}/wiki/${encodeURIComponent(title)}.json`;
  if (options.assertReady) await options.assertReady();
  const pageData = await fetchJson(pageUrl, config);

  if (!pageData || !pageData.wiki_page || !pageData.wiki_page.text) {
    console.error("Unexpected response: missing wiki_page.text");
    process.exit(1);
  }

  const original = pageData.wiki_page.text;

  // runUpdate가 검증한 문자열을 그대로 사용한다. 파일을 여기서 다시 읽으면 검증과 PUT
  // 사이에 다른 generate가 파일을 교체해 미검증 내용을 게시할 수 있다.
  const targetOutputPath = buildOutputPath(meetingDate, config);
  const hasDraftContent = Object.prototype.hasOwnProperty.call(options, "draftContent");
  if (!hasDraftContent && !fs.existsSync(targetOutputPath)) {
    console.error(`초안 파일이 없습니다: ${targetOutputPath}`);
    console.error("먼저 MODE=generate 로 초안을 생성한 뒤 다시 실행하세요.");
    process.exit(1);
  }
  let newSection = hasDraftContent
    ? String(options.draftContent)
    : fs.readFileSync(targetOutputPath, "utf8");
  console.log(`Draft loaded: ${targetOutputPath}`);

  // AI 요약이 섹션 헤더 앞에 머리말/설명("요청하신 규칙대로…")을 붙이는 경우가 있다.
  // 그대로 PUT하면 헤더 앞 텍스트가 직전 사람 섹션에 흡수되므로, 헤더부터만 사용한다.
  const headerIdx = newSection.indexOf(config.env.sectionHeader);
  if (headerIdx > 0) {
    console.warn("[sanitize] 섹션 헤더 앞 머리말 제거 (AI 출력 정제)");
    newSection = newSection.slice(headerIdx);
  }

  const currentSection = extractSection(original, config);
  if (!currentSection) {
    console.error("Could not find the target section to replace.");
    process.exit(1);
  }

  const sectionStripped = newSection.replace(/\n*\*작성:.*?\*\n*---\s*$/, "").trimEnd();

  let approver;
  if (config.env.autoApprove) {
    approver = "auto";
  } else {
    console.log("--- current section ---\n" + currentSection);
    console.log("--- updated section ---\n" + sectionStripped);

    const updated = replaceSection(original, sectionStripped + "\n", config);
    if (!options.loadNoteRefs && original.trim() === updated.trim()) {
      console.log("No changes detected; skipping update.");
      return;
    }

    const ok = await promptYesNo("Apply update? (y/N) ");
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
    approver = "hwjo";
  }

  let publishSection = sectionStripped;
  if (options.loadNoteRefs) {
    if (options.assertReady) await options.assertReady();
    const noteRefs = await options.loadNoteRefs();
    publishSection = appendNotesBlock(publishSection, noteRefs);
  }

  const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16);
  const footerLine = approver === "auto"
    ? `*작성: Claude Code ${now} | 승인: 없음*`
    : `*작성: Claude Code ${now} | 승인: ${approver} ${now}*`;
  const finalSection = publishSection + `\n\n${footerLine}\n\n---`;

  // 반영 직전 구조 검증 게이트 — 내가 넣는 섹션에는 팀원 헤더(파란색)가 정확히 1개여야 한다.
  // 머리말 혼입·타인 섹션 침범 등 깨진 출력이면 위키에 올리지 않고 중단한다(cron 로그에 에러로 남김).
  const headerCount = finalSection.split(config.env.sectionHeader).length - 1;
  if (headerCount !== 1) {
    console.error(`섹션 구조 이상: 설정된 헤더가 ${headerCount}개 존재합니다 (1개 기대) — 위키 반영 중단`);
    process.exit(1);
  }
  if (config.env.sectionHeader.includes("color:blue")) {
    const blueHeaderCount = (finalSection.match(/#### <span style="color:blue">/g) || []).length;
    if (blueHeaderCount !== 1) {
      console.error(`섹션 구조 이상: 파란색 헤더 ${blueHeaderCount}개 (1개 기대) — 위키 반영 중단`);
      process.exit(1);
    }
  }

  console.log("--- current section ---\n" + currentSection);
  console.log("--- updated section ---\n" + finalSection);

  // [동시편집 대비] Redmine 위키 API에는 섹션 단위 PUT이 없어, 조현우 섹션만 바꿔도 페이지
  // 전체를 통째로 PUT해야 한다(페이지 전체에 단일 version 잠금). 다른 사람이 다른 섹션을
  // 편집 중이면 version이 올라가 409가 난다. PUT 직전 최신 페이지를 다시 받아 조현우 섹션만
  // 교체 후 즉시 PUT하고, 409면 최신 version으로 재시도한다. 타인 섹션은 replaceSection이 보존.
  const MAX_PUT_RETRIES = 4;
  for (let attempt = 1; ; attempt += 1) {
    if (options.assertReady) await options.assertReady();
    const fresh = await fetchJson(pageUrl, config);
    if (!fresh || !fresh.wiki_page || typeof fresh.wiki_page.text !== "string") {
      console.error("Unexpected response: missing wiki_page.text during retry");
      process.exit(1);
    }
    const freshUpdated = replaceSection(fresh.wiki_page.text, finalSection, config);

    if (!freshUpdated) {
      console.error("Could not find the target section to replace.");
      process.exit(1);
    }

    if (fresh.wiki_page.text.trim() === freshUpdated.trim()) {
      console.log("No changes detected; skipping update.");
      return;
    }

    const payload = {
      wiki_page: {
        text: stripAstralChars(freshUpdated),
        comments: approver === "auto" ? "자동 업데이트 (cron)" : "자동 업데이트 (승인: hwjo)",
        version: fresh.wiki_page.version,
      },
    };

    try {
      if (options.assertReady) await options.assertReady();
      await fetchJson(pageUrl, config, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (options.publishedPath) {
        ensureDir(path.dirname(options.publishedPath));
        fs.writeFileSync(options.publishedPath, finalSection + "\n", "utf8");
        console.log(`Published section saved: ${options.publishedPath}`);
      }
      console.log("Update complete.");
      return { finalSection, publishedPath: options.publishedPath || null };
    } catch (err) {
      if (/HTTP 409/.test(err.message) && attempt < MAX_PUT_RETRIES) {
        console.warn(`PUT 409 Conflict (attempt ${attempt}/${MAX_PUT_RETRIES}) — 최신 버전 재취득 후 재시도`);
        if (options.waitBeforeRetry) {
          await options.waitBeforeRetry(attempt);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
        continue;
      }
      throw err;
    }
  }
}

module.exports = {
  generate,
  update,
  resolveMeetingDate,
  dateRange,
  targetWednesday,
  formatDate,
  buildWikiUrl,
  extractTitleFromUrl,
  parseMeetingDateFromTitle,
  buildContent,
  aiSummarize,
  buildAiPrompt,
  buildFactContractGuidance,
  buildDepthGuidance,
  buildFilterGuidance,
  buildLeaderHighlightGuidance,
  buildOutputPath,
  appendNotesBlock,
  AiSummaryError,
  generateContent,
  sanitizeAiSection,
  stripNotesBlock,
};
