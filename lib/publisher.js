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
  const start = new Date(meetingDate);
  start.setDate(start.getDate() - 7);
  const replacements = {
    "{{START_DATE}}": formatDate(start),
    "{{END_DATE}}": formatDate(meetingDate),
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

async function aiSummarize(rawContent, config) {
  if (!config.env.aiSummarize) return null;

  const filterGuidance = buildFilterGuidance(config);

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

${filterGuidance}

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

  console.log("AI 요약 중...");
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

function dateRange(meetingDate) {
  // meetingDate 기준 7일 전 08:00 KST ~ meetingDate 23:59:59
  const end = new Date(meetingDate);
  end.setHours(23, 59, 59, 0);

  const start = new Date(meetingDate);
  start.setDate(start.getDate() - 7);
  start.setHours(8, 0, 0, 0);

  return {
    startDate: formatDateTime(start),
    endDate: formatDateTime(end),
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

async function update(config, meetingDate, autoContent) {
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

  // generate 단계에서 이미 파일이 있으면 그것을 사용
  const targetOutputPath = buildOutputPath(meetingDate, config);
  const rawSection = buildContent(meetingDate, autoContent, config);
  const summarized = await aiSummarize(rawSection, config);
  const generatedSection = summarized || rawSection;

  ensureDir(path.dirname(targetOutputPath));
  if (!fs.existsSync(targetOutputPath)) {
    fs.writeFileSync(targetOutputPath, generatedSection, "utf8");
    console.log(`Draft saved: ${targetOutputPath}`);
  }

  let newSection = fs.existsSync(targetOutputPath)
    ? fs.readFileSync(targetOutputPath, "utf8")
    : generatedSection;

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
  const finalUpdated = replaceSection(original, finalSection, config);

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

  await fetchJson(pageUrl, config, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  console.log("Update complete.");
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
};
