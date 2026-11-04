"use strict";

const MAX_EXCERPTS_PER_VARIANT = 20;
const MAX_EXCERPT_CHARS = 200;

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

function buildVariantLines(name, variant) {
  const counts = countCodes(variant);
  const primary = variant.primaryIssueCode || [...counts.keys()][0] || "unknown";
  const countText = [...counts.entries()].map(([code, n]) => `${code} ${n}`).join(", ");
  const lines = [`- ${name}: ${primary}${countText ? ` 외 코드별 개수 ${countText}` : ""}`];
  const errors = (Array.isArray(variant.issues) ? variant.issues : [])
    .filter((i) => i && i.severity === "error" && typeof i.line === "string" && i.line.length > 0)
    .slice(0, MAX_EXCERPTS_PER_VARIANT);
  for (const issue of errors) lines.push(`  - ${toInlineCode(issue.line, MAX_EXCERPT_CHARS)}`);
  return lines;
}

function buildSummaryLines(summary) {
  const lines = [`- 요약: ${toInlineCode(summary.status, MAX_EXCERPT_CHARS)} ${toInlineCode(summary.reason ?? "", MAX_EXCERPT_CHARS)}`];
  const blocking = summary.gate && Array.isArray(summary.gate.blocking) ? summary.gate.blocking : [];
  for (const entry of blocking) {
    lines.push(`  - ${toInlineCode(`${entry.code} (line ${entry.line})`, MAX_EXCERPT_CHARS)}`);
  }
  return lines;
}

function buildReviewBlock({ published, variants, summary, droppedEvidence, briefingSkipped } = {}) {
  const body = [];
  const publishedFailed = Boolean(published) && published.status === "failed";
  if (publishedFailed) {
    body.push(`- 게시본: ${published.variant} (검증 실패 그대로 게시)`);
  }

  const variantMap = variants && typeof variants === "object" ? variants : {};
  const failedNames = Object.keys(variantMap).filter((n) => variantMap[n] && variantMap[n].status === "failed");
  for (const name of failedNames) body.push(...buildVariantLines(name, variantMap[name]));

  if (summary && summary.status && summary.status !== "ready") body.push(...buildSummaryLines(summary));

  const dropped = Array.isArray(droppedEvidence) ? droppedEvidence : [];
  for (const d of dropped) body.push(`- 수집 제외: ${d.repo} ${d.ref} (${d.kind})`);

  if (briefingSkipped === true) body.push("- 모바일 브리핑: 생략 (depth3·depth2 원천 선택 기록 없음)");

  if (body.length === 0) return "";
  if (!publishedFailed && published) body.unshift(`- 게시본: ${published.variant} (통과)`);
  return ["**검토 필요(자동)**", ...body].join("\n");
}

module.exports = { buildReviewBlock };
