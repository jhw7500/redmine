const MARKED_AS_OF_DATE = String.raw`\[\[fact:S\d{4}\|\d{4}-\d{2}-\d{2}\]\]`;
const RAW_AS_OF_DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const MISPLACED_NOTE_PATTERN = new RegExp(
  String.raw`\(\s*미수정\s*,\s*(${MARKED_AS_OF_DATE}|${RAW_AS_OF_DATE})\s*기준\s*(미해결|미완료|미완|보류)\s*\)`,
  "g"
);

function normalizeOpenStatusAsOfClauses(content) {
  return String(content).replace(
    MISPLACED_NOTE_PATTERN,
    (_match, date, status) => `미수정 (${date} 기준 ${status})`
  );
}

module.exports = { normalizeOpenStatusAsOfClauses };
