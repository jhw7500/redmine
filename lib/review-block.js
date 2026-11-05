"use strict";

const MAX_EXCERPTS_PER_VARIANT = 20;
const MAX_EXCERPT_CHARS = 200;
const VARIANT_LABELS = { summary: "요약본", 2: "depth2", 3: "depth3" };

// Display name of a pair variant; the machine names (summary, 2, 3) stay in receipts and manifests.
function variantLabel(name) {
  return Object.hasOwn(VARIANT_LABELS, String(name)) ? VARIANT_LABELS[String(name)] : String(name);
}

// 인라인 코드 안에 둘 텍스트를 안전하게 만든다. 백틱은 전각 악센트로, <는 전각 ＜로 바꿔
// 인라인 코드를 닫거나 HTML(<span>)·헤더(####)로 해석되는 일이 없게 한다.
function toInlineCode(text, maxChars) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const cut = [...flat].slice(0, maxChars).join("");
  return "`" + cut.replace(/`/g, "ˋ").replace(/</g, "＜") + "`";
}

function countCodes(variant) {
  const counts = new Map();
  if (Array.isArray(variant.issues) && variant.issues.length > 0) {
    for (const issue of variant.issues) {
      if (issue && typeof issue.code === "string") {
        counts.set(issue.code, (counts.get(issue.code) || 0) + 1);
      }
    }
  } else if (variant.issueCounts && typeof variant.issueCounts === "object") {
    for (const [code, n] of Object.entries(variant.issueCounts)) counts.set(code, n);
  }
  return counts;
}

// Report lines of errors first and warnings second. Duplicate lines are shown once; issue messages and
// evidence never reach the block, while countCodes still counts every issue independently.
function issueExcerptLines(issues) {
  const entries = Array.isArray(issues) ? issues : [];
  const seen = new Set();
  const selected = [];
  for (const severity of ["error", "warning"]) {
    for (const issue of entries) {
      if (!issue || issue.severity !== severity || typeof issue.line !== "string" || issue.line.length === 0
        || seen.has(issue.line)) continue;
      seen.add(issue.line);
      selected.push(issue.line);
      if (selected.length === MAX_EXCERPTS_PER_VARIANT) break;
    }
    if (selected.length === MAX_EXCERPTS_PER_VARIANT) break;
  }
  return selected.map((line) => `  - ${toInlineCode(line, MAX_EXCERPT_CHARS)}`);
}

function buildVariantLines(name, variant) {
  const counts = countCodes(variant);
  const primary = variant.primaryIssueCode || [...counts.keys()][0] || "unknown";
  const countText = [...counts.entries()].map(([code, n]) => `${code} ${n}`).join(", ");
  return [`- ${variantLabel(name)}: ${primary}${countText ? ` 외 코드별 개수 ${countText}` : ""}`, ...issueExcerptLines(variant.issues)];
}

function buildSummaryLines(summary) {
  const lines = [`- 요약: ${toInlineCode(summary.status, MAX_EXCERPT_CHARS)} ${toInlineCode(summary.reason ?? "", MAX_EXCERPT_CHARS)}`];
  const blocking = summary.gate && Array.isArray(summary.gate.blocking) ? summary.gate.blocking : [];
  for (const entry of blocking) {
    lines.push(`  - ${toInlineCode(`${entry.code} (line ${entry.line})`, MAX_EXCERPT_CHARS)}`);
  }
  // A summary rejected at validation keeps a validation file; its issue lines follow the same ordering and cap.
  lines.push(...issueExcerptLines(summary.issues));
  return lines;
}

function buildReviewBlock({ published, variants, summary, droppedEvidence, briefingSkipped } = {}) {
  const body = [];
  const publishedFailed = Boolean(published) && published.status === "failed";
  if (publishedFailed) {
    body.push(`- 게시본: ${variantLabel(published.variant)} (검증 실패 그대로 게시)`);
  }

  const variantMap = variants && typeof variants === "object" ? variants : {};
  const failedNames = Object.keys(variantMap).filter((n) => variantMap[n] && variantMap[n].status === "failed");
  for (const name of failedNames) body.push(...buildVariantLines(name, variantMap[name]));

  if (summary && summary.status && summary.status !== "ready") body.push(...buildSummaryLines(summary));

  const dropped = Array.isArray(droppedEvidence) ? droppedEvidence : [];
  for (const d of dropped) body.push(`- 수집 제외: ${d.repo} ${d.ref} (${d.kind})`);

  if (briefingSkipped === true) body.push("- 모바일 브리핑: 생략 (depth3·depth2 원천 선택 기록 없음)");

  if (body.length === 0) return "";
  if (!publishedFailed && published) body.unshift(`- 게시본: ${variantLabel(published.variant)} (통과)`);
  return ["**검토 필요(자동)**", ...body].join("\n");
}

module.exports = { buildReviewBlock, variantLabel };
