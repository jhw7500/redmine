// session-summary.md 파싱 → session-items.json 생성
// 매주 수요일 로테이트되는 세션 요약 파일에서 프로젝트별 작업 항목을 추출한다.
const fs = require("fs");
const path = require("path");

const DEFAULT_SUMMARY_PATH = "/home/jhw/ai/opencode/session-summaries/session-summary.md";

function mapCategory(text, projectMapping) {
  const lower = text.toLowerCase();
  for (const [keyword, category] of Object.entries(projectMapping)) {
    if (lower.includes(keyword.toLowerCase())) {
      return category;
    }
  }
  return null;
}

function parseSummary(content, startDate, endDate) {
  const items = [];
  const start = new Date(startDate.slice(0, 10));
  const end = new Date(endDate.slice(0, 10));

  // ## 날짜 헤더로 섹션 분리
  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    // 날짜 추출: "2026-04-15 (2026-04-14 ~ 2026-04-15)"
    const dateMatch = section.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    const sectionDate = new Date(dateMatch[1]);
    if (sectionDate < start || sectionDate > end) continue;

    // "### 작업 내역" 섹션에서 프로젝트 항목 추출
    const workMatch = section.match(/### 작업 내역\s*\n([\s\S]*?)(?=\n### |$)/);
    if (!workMatch) continue;

    const workBlock = workMatch[1];

    // "- **프로젝트명**: 설명" 패턴 파싱
    const projectPattern = /^- \*\*(.+?)\*\*:\s*(.+)/gm;
    let match;
    while ((match = projectPattern.exec(workBlock)) !== null) {
      const projectName = match[1].replace(/\s*\(.+?\)\s*$/, "").trim();
      const summary = match[2].trim();

      // 하위 항목 수집 (주요 결정, 결과물 등)
      const startIdx = match.index + match[0].length;
      const nextProject = workBlock.indexOf("\n- **", startIdx);
      const endIdx = nextProject === -1 ? workBlock.length : nextProject;
      const subBlock = workBlock.slice(startIdx, endIdx);

      const subItems = [];
      const subPattern = /^\s+- (?:주요 결정|결과물|분석 결과):\s*(.+)/gm;
      let sub;
      while ((sub = subPattern.exec(subBlock)) !== null) {
        subItems.push(sub[1].trim());
      }

      items.push({
        source: "session",
        title: projectName,
        summary,
        items: subItems.length ? [summary, ...subItems] : [summary],
        date: dateMatch[1],
      });
    }
  }

  return items;
}

function collectSessionItems(config, startDate, endDate) {
  const summaryPath = (config.sources && config.sources.session && config.sources.session.summaryPath)
    || DEFAULT_SUMMARY_PATH;

  if (!fs.existsSync(summaryPath)) {
    console.warn(`[session] Summary file not found: ${summaryPath}`);
    return [];
  }

  const content = fs.readFileSync(summaryPath, "utf8");
  const projectMapping = (config.sources && config.sources.notion && config.sources.notion.projectMapping) || {};

  const items = parseSummary(content, startDate, endDate);

  // 카테고리 매핑
  for (const item of items) {
    item.category = mapCategory(item.title + " " + item.summary, projectMapping) || undefined;
  }

  console.log(`[session] Parsed ${items.length} items from ${summaryPath}`);
  return items;
}

function collectAndSave(config, startDate, endDate, outputDir) {
  const items = collectSessionItems(config, startDate, endDate);
  if (!items.length) {
    console.log("[session] No items collected");
    return;
  }

  const outPath = path.join(outputDir, "session-items.json");
  fs.writeFileSync(outPath, JSON.stringify(items, null, 2), "utf8");
  console.log(`[session] Saved ${items.length} items to ${outPath}`);
}

module.exports = { collectSessionItems, collectAndSave };
