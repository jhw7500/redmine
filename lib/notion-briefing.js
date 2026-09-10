function cleanLine(value) {
  return String(value || "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactDetail(value, maxLength = 220) {
  const text = cleanLine(value);
  if (text.length <= maxLength) return text;
  const window = text.slice(0, maxLength + 1);
  let sentenceEnd = -1;
  for (const match of window.matchAll(/[.!?](?=\s|$)/g)) sentenceEnd = match.index;
  if (sentenceEnd >= Math.floor(maxLength * 0.45)) return window.slice(0, sentenceEnd + 1);
  const wordEnd = window.lastIndexOf(" ");
  return `${window.slice(0, wordEnd > 0 ? wordEnd : maxLength).trimEnd()}…`;
}

function tableCells(line) {
  if (!/^\s*\|.*\|\s*$/.test(line || "")) return [];
  return line.trim().slice(1, -1).split("|").map(cell => cell.trim());
}

function isTableSeparator(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function firstCause(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:>|#|[-*+]\s|\||```)/.test(trimmed)) continue;
    if (/^(?:실기\s*)?검증(?:\s|[:：(]|$)/.test(trimmed)) continue;
    return compactDetail(trimmed);
  }
  return "";
}

function pairedExposureCause(summary) {
  const text = cleanLine(summary);
  if (!/\bexp_time\b/i.test(text) || !/\bae_on\b/i.test(text)) return "";

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const select = pattern => sentences.find(sentence => pattern.test(sentence));
  const details = [
    select(/같은\s+exp_time\s*으로|같은\s+노출/i),
    select(/\bae_on\b/i),
    select(/합성.*(?:깨|실패)|CSI2/i),
  ].filter(Boolean);

  if (details.length < 3) return "";
  return compactDetail([...new Set(details)].join(" "));
}

function fixDetails(lines) {
  const heading = lines.findIndex(line => /^#{1,6}\s+.*(?:수정|해결|조치)/.test(line.trim()));
  if (heading < 0) return "";
  const details = [];
  let fenced = false;
  for (let index = heading + 1; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (/^```/.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,6}\s+/.test(trimmed) || /^(?:실기\s*)?검증(?:\s|[:：(]|$)/.test(trimmed)) break;
    if (!trimmed || /^\|/.test(trimmed)) continue;
    const detail = cleanLine(trimmed);
    if (detail) {
      const combined = [...details, detail].join(" ");
      if (details.length && combined.length > 220) break;
      details.push(detail);
    }
    if (details.length >= 4) break;
  }
  return compactDetail(details.join(" ")).replace(/[:：]\s*$/, "");
}

function verificationDetails(lines) {
  let markerFound = false;
  let fence = "";
  let header = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const boundary = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (boundary && boundary[1][0] === fence[0]
        && boundary[1].length >= fence.length && !boundary[2].trim()) fence = "";
      continue;
    }
    if (boundary && (boundary[1][0] !== "`" || !boundary[2].includes("`"))) {
      fence = boundary[1];
      continue;
    }
    if (!markerFound) {
      markerFound = /^(?:#{1,6}\s+)?(?:실기\s*)?검증(?:\s|[:：(]|$)/.test(trimmed);
      continue;
    }
    const label = trimmed.replace(/[*_`]/g, "").trim();
    if (/^(?:실기\s*)?검증\s*[:：]?$/.test(label)) continue;
    if (/^#{1,6}\s+/.test(trimmed)) break;
    const cells = tableCells(trimmed);
    if (cells.length) {
      if (!header.length) {
        header = cells;
        continue;
      }
      if (isTableSeparator(trimmed)) continue;
      if (cells.length >= 3 && header.length >= 3) {
        return compactDetail(`${cells[0]}: ${header[1]} ${cells[1]} → ${header[2]} ${cells[2]}`);
      }
    }
    if (trimmed && !/^```/.test(trimmed)) return compactDetail(trimmed);
  }
  return "";
}

function buildNotionBriefing(markdown, context = {}) {
  const lines = String(markdown || "").split("\n");
  const briefing = {
    cause: pairedExposureCause(context.summary) || firstCause(lines),
    fix: fixDetails(lines),
    verification: verificationDetails(lines),
  };
  return Object.fromEntries(Object.entries(briefing).filter(([, value]) => value));
}

module.exports = { buildNotionBriefing };
