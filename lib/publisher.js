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

function aiSummarize(rawContent, config) {
  if (!config.env.aiSummarize) return null;
  const prompt = `아래는 주간 회의 보고서 초안이다. 이것을 팀 회의용으로 기능 중심 요약해라.

대상 독자: 개발팀 전체 (git을 사용하지 않는 사람 포함)

규칙:
1. 관련 항목들을 **기능 단위로 크게 묶고**, 하위에 세부 내용을 1~2줄로 나열한다.
2. 한글 기본, 기술 용어(영어)는 그대로 사용.
3. 사소한 변경(gitignore, log, chore, 바이너리 업데이트, 서브모듈 업데이트 등)은 제외.
4. **중복 내용은 반드시 하나로 통합**한다. 같은 기능의 반복 항목 금지.
5. 내부 구현 디테일(TLV, EVENT_PORT_RELEASE 등)은 알기 쉽게 풀어쓴다.
6. **PR 번호, issue 번호, 커밋 해시 등 git 참조는 절대 표시하지 않는다.**
7. "코드 리뷰 반영", "리뷰 피드백", "코드 리뷰 추가 수정" 등 내용 없는 항목은 삭제한다.
8. "release: vX.Y.Z" 같은 릴리즈 태그도 삭제한다.
9. 카테고리 계층 구조를 반드시 유지한다:
   - "- PIM" 아래에 "  - Application", "  - Driver" 하위 카테고리 유지
   - "- Wireless Lan" 아래에 "  - NXP" 하위 카테고리 유지
   - "- ETC" 카테고리의 모든 항목을 빠짐없이 포함한다
   - 기능 항목은 하위 카테고리 아래에 들여쓰기로 작성
10. 내용 없는 카테고리는 삭제. 단, 원본에 내용이 있는 카테고리를 임의로 삭제하지 않는다.
11. 마지막 footer(*작성:...* 및 ---)는 생성하지 않는다. 코드에서 자동 추가한다.
12. 조현우 섹션만 출력한다.
13. 원본과 동일한 마크다운 형식 유지 (#### 헤더, - 들여쓰기 구조).

원본:
${rawContent}

요약된 보고서만 출력해라. 설명이나 주석 없이 마크다운 내용만.`;

  console.log("AI 요약 중...");
  const result = spawnSync(config.env.claudeCli, ["-p", prompt, "--output-format", "text"], {
    encoding: "utf8",
    timeout: 300000,
    env: { ...process.env },
  });

  if (result.status !== 0) {
    console.error("AI 요약 실패:", result.stderr || result.error);
    return null;
  }

  let output = result.stdout.trim();
  if (!output) return null;
  // Claude CLI 응답에서 bkit/system 블록 제거
  output = output.replace(/\n*─{3,}[\s\S]*$/m, "").trimEnd();
  if (!output) return null;
  console.log("AI 요약 완료.");
  return output + "\n";
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
  // 이전 수요일 08:00 KST ~ 현재 시각
  const now = new Date();
  const prevWed = new Date(now);
  const day = prevWed.getDay(); // 0=Sun
  // 가장 최근 지난 수요일 계산
  const daysBack = day === 3 ? 7 : ((day - 3 + 7) % 7) || 7;
  prevWed.setDate(prevWed.getDate() - daysBack);
  prevWed.setHours(8, 0, 0, 0);

  return {
    startDate: formatDateTime(prevWed),
    endDate: formatDateTime(now),
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
  const summarized = aiSummarize(rawSection, config);
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
  const summarized = aiSummarize(rawSection, config);
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
