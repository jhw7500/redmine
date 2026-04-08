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

async function aiSummarize(rawContent, config) {
  if (!config.env.aiSummarize) return null;
  const prompt = `주간 회의 보고서 초안을 정리해라.

대상: 개발팀 전체 (git 비사용자 포함)

## 핵심 원칙
- **같은 기능의 여러 커밋은 하나로 통합**. 예: "RTSP disconnect 정리" + "RTSP graceful shutdown" → "RTSP 연결 해제 시 리소스 정리 개선"
- **서로 다른 기능/모듈은 합치지 않는다**. 예: "WiFi 절전 + SPI UART 로그" → 2줄로 분리
- **판단 기준**: 같은 파일/컴포넌트에 대한 변경이면 통합, 다른 파일/컴포넌트면 분리
- **빈 항목 삭제**: 하위 내용이 없는 카테고리/프로젝트명은 출력하지 않는다.
- **구체적으로**: "LED 제어" → "가변저항 IC(MCP4018) 제어 스크립트 추가"처럼 무엇인지 알 수 있게.
- **기술 용어**: 영어 그대로 유지 (RTSP, DMA, SPI UART, rsync 등)
- **카테고리당 항목 수**: 하위 카테고리별로 3~6개가 적절. 10개 이상이면 관련 항목을 묶어서 줄인다.

## 삭제 대상
- 커밋 메시지 정정, 오타 수정, WIP, 코드 리뷰 반영, release 태그
- gitignore, log, chore, 서브모듈 업데이트
- PR/issue 번호, 커밋 해시 등 git 참조
- README 추가/업데이트 (단독 항목일 때만 삭제, 프로젝트 신규 구축 시에는 유지)
- **여러 카테고리에 동일하게 반복되는 항목** (예: "공통 워크플로우 적용")은 전부 삭제하거나 ETC에 한 번만 기재

## 카테고리 규칙
- 원본의 카테고리 계층(PIM > Application/Driver, Wireless Lan > NXP, ETC > 각 프로젝트) 유지
- 내용 없는 카테고리는 삭제
- ETC 하위 프로젝트명(CI/CD 자동화, HiWorks 근태 관리 등)은 반드시 유지
- 타입 그룹(추가/수정/리팩토링 등)이 하나뿐이면 타입 라벨 없이 바로 나열

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
