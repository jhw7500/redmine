// Design Ref: §4.3 — 템플릿 렌더링 + AI 요약 + Redmine Wiki API
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

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
  const filename = `jo-hyunwoo-${formatDate(meetingDate)}.md`;
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

function buildFilterGuidance(config) {
  const rf = config.reportFilter || {};
  const guidance = rf.aiGuidance || {};
  const excludeSubsections = rf.rawExcludeSubsectionPatterns || [];
  const maxPerSub = rf.maxItemsPerSubcategory || 5;
  const maxPerEtc = rf.maxItemsPerEtcProject || 4;

  const excludeList = excludeSubsections.length
    ? excludeSubsections.map((s) => `  - ${s.replace(/^\^/, "").replace(/\\s\*/g, " ")}`).join("\n")
    : "  - (없음)";

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
- 테스트 프로젝트의 버그 검출 결과는 상한 제외`;
}

// 상세도(depth) 프로파일 → 프롬프트 블록. depth=3(빈 guidance)이면 "" 반환 = 기존 프롬프트 불변.
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

async function aiSummarize(rawContent, config) {
  if (!config.env.aiSummarize) return null;

  const filterGuidance = buildFilterGuidance(config);
  const depthGuidance = buildDepthGuidance(config);

  const prompt = `주간 회의 보고서 초안을 정리해라.

대상: 개발팀 전체 (git 비사용자 포함)

## 핵심 원칙
- **같은 기능의 여러 커밋은 하나로 통합**. 예: "RTSP disconnect 정리" + "RTSP graceful shutdown" → "RTSP 연결 해제 시 리소스 정리 개선"
- **서로 다른 기능/모듈은 합치지 않는다**. 예: "WiFi 절전 + SPI UART 로그" → 2줄로 분리
- **판단 기준**: 같은 파일/컴포넌트에 대한 변경이면 통합, 다른 파일/컴포넌트면 분리
- **빈 항목 삭제**: 하위 내용이 없는 카테고리/프로젝트명은 출력하지 않는다.
- **구체적으로**: "LED 제어" → "가변저항 IC(MCP4018) 제어 스크립트 추가"처럼 무엇인지 알 수 있게.
- **기술 용어**: 영어 그대로 유지 (RTSP, DMA, SPI UART, rsync 등)
- **계층 그룹핑 우선**: 한 프로젝트에서 3개 이상의 유사 항목은 반드시 상위-하위로 재구성.

${depthGuidance}${filterGuidance}

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

  const depthLabel = ((config.depthProfiles || {})[String(config.env.reportDepth)] || {}).label || "";
  console.log(`AI 요약 중... (depth=${config.env.reportDepth}${depthLabel ? " " + depthLabel : ""})`);
  const { spawn } = require("child_process");
  const AI_TIMEOUT = 600000; // 10분

  return new Promise((resolve) => {
    const child = spawn(config.env.claudeCli, ["-p", prompt, "--output-format", "text"], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      console.error("AI 요약 타임아웃 (10분 초과)");
      resolve(null);
    }, AI_TIMEOUT);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error("AI 요약 실패:", stderr || `exit code ${code}`);
        resolve(null);
        return;
      }
      let output = stdout.trim();
      if (!output) { resolve(null); return; }
      // Claude CLI 응답에서 bkit/system 블록 제거
      output = output.replace(/\n*─{3,}[\s\S]*$/m, "").trimEnd();
      if (!output) { resolve(null); return; }
      console.log("AI 요약 완료.");
      resolve(output + "\n");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      console.error("AI 요약 실패:", err.message);
      resolve(null);
    });
  });
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

// START_DATE / END_DATE 환경변수 입력 파싱.
// 형식: 'YYYY-MM-DD' (시간 자동 보정) 또는 'YYYY-MM-DDTHH:MM:SS' (그대로).
// kind: 'start' → 시간 생략 시 08:00:00, 'end' → 시간 생략 시 07:59:59
function parseEnvDate(input, kind) {
  const trimmed = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const suffix = kind === "start" ? "T08:00:00" : "T07:59:59.999";
    const d = new Date(trimmed + suffix);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ${kind === "start" ? "START_DATE" : "END_DATE"}: ${input}`);
    }
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+\-]\d{2}:?\d{2})?$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ${kind === "start" ? "START_DATE" : "END_DATE"}: ${input}`);
    }
    return d;
  }
  throw new Error(
    `Invalid ${kind === "start" ? "START_DATE" : "END_DATE"} format: ${input}. ` +
    `Use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS`
  );
}

function dateRange(meetingDate) {
  // 매주 수요일 08:00 KST(=주간 회의 시작 시각)을 경계로 보고 범위를 분리.
  // start: (meetingDate - 7일) 08:00 / end: meetingDate 08:00 직전 (=07:59:59)
  // 미팅 당일 08:00 이후 commit은 다음 주 보고서로 이월된다 (양쪽 보고서 겹침 방지).
  //
  // 환경변수 START_DATE / END_DATE 가 둘 다 지정되면 자동 계산을 override 한다.
  // 한 쪽만 지정되면 경고 후 자동 계산 사용.
  const envStart = process.env.START_DATE;
  const envEnd = process.env.END_DATE;
  let start, end;
  let overridden = false;
  if (envStart && envEnd) {
    start = parseEnvDate(envStart, "start");
    end = parseEnvDate(envEnd, "end");
    overridden = true;
  } else {
    if (envStart || envEnd) {
      console.warn(
        "[dateRange] START_DATE / END_DATE 는 둘 다 지정해야 적용됩니다. 자동 계산을 사용합니다."
      );
    }
    end = new Date(meetingDate);
    end.setHours(7, 59, 59, 999);
    start = new Date(meetingDate);
    start.setDate(start.getDate() - 7);
    start.setHours(8, 0, 0, 0);
  }
  if (overridden) {
    console.log(`[dateRange] override by env: ${formatDateTime(start)} ~ ${formatDateTime(end)}`);
  }
  return {
    startDate: formatDateTime(start),
    endDate: formatDateTime(end),
    start,
    end,
  };
}

function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
}

async function generate(config, meetingDate, autoContent) {
  const rawSection = buildContent(meetingDate, autoContent, config);
  const summarized = await aiSummarize(rawSection, config);
  const generatedSection = summarized || rawSection;

  const targetOutputPath = buildOutputPath(meetingDate, config);
  ensureDir(path.dirname(targetOutputPath));

  if (fs.existsSync(targetOutputPath)) {
    const backupPath = targetOutputPath.replace(/\.md$/, ".bak.md");
    fs.copyFileSync(targetOutputPath, backupPath);
    console.log(`Backup saved: ${backupPath}`);
  }
  fs.writeFileSync(targetOutputPath, generatedSection, "utf8");
  console.log(`Draft saved: ${targetOutputPath}`);
  return targetOutputPath;
}

async function update(config, meetingDate) {
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
  const pageData = await fetchJson(pageUrl, config);

  if (!pageData || !pageData.wiki_page || !pageData.wiki_page.text) {
    console.error("Unexpected response: missing wiki_page.text");
    process.exit(1);
  }

  const original = pageData.wiki_page.text;

  // [publish 순수화] update(올리기)는 AI를 재호출하지 않는다. generate가 만들어 둔 초안
  // 파일만 읽어 그대로 올린다 — 올리는 내용 = 파일(재현 가능, 사람이 검토·수정 가능).
  const targetOutputPath = buildOutputPath(meetingDate, config);
  if (!fs.existsSync(targetOutputPath)) {
    console.error(`초안 파일이 없습니다: ${targetOutputPath}`);
    console.error("먼저 MODE=generate 로 초안을 생성한 뒤 다시 실행하세요.");
    process.exit(1);
  }
  let newSection = fs.readFileSync(targetOutputPath, "utf8");
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
    if (original.trim() === updated.trim()) {
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

  const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16);
  const footerLine = approver === "auto"
    ? `*작성: Claude Code ${now} | 승인: 없음*`
    : `*작성: Claude Code ${now} | 승인: ${approver} ${now}*`;
  const finalSection = sectionStripped + `\n\n${footerLine}\n\n---`;

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
      await fetchJson(pageUrl, config, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      console.log("Update complete.");
      return;
    } catch (err) {
      if (/HTTP 409/.test(err.message) && attempt < MAX_PUT_RETRIES) {
        console.warn(`PUT 409 Conflict (attempt ${attempt}/${MAX_PUT_RETRIES}) — 최신 버전 재취득 후 재시도`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
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
  buildDepthGuidance,
  buildOutputPath,
};
