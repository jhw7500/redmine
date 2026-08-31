const MARKED_AS_OF_DATE = String.raw`\[\[fact:[SV]\d{4}\|\d{4}-\d{2}-\d{2}\]\]`;
const RAW_AS_OF_DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const OPEN_STATUS = String.raw`미해결|미완료|미완|보류`;
const MISPLACED_NOTE_PATTERN = new RegExp(
  String.raw`\(\s*미수정\s*,\s*(${MARKED_AS_OF_DATE}|${RAW_AS_OF_DATE})\s*기준\s*(${OPEN_STATUS})\s*\)`,
  "g"
);
const EXACT_AS_OF_PATTERN = new RegExp(
  String.raw`\(\s*(?:${MARKED_AS_OF_DATE}|${RAW_AS_OF_DATE})\s*기준\s*(?:${OPEN_STATUS})\s*\)`,
  "g"
);
const OPEN_STATUS_PATTERN = new RegExp(`(${OPEN_STATUS})`, "g");

function isValidMeetingDateFact(fact) {
  return fact
    && fact.type === "meeting_date"
    && /^S\d{4}$/.test(fact.id)
    && /^\d{4}-\d{2}-\d{2}$/.test(fact.raw);
}

function isInsideSpan(start, end, spans) {
  return spans.some((span) => span.start <= start && span.end >= end);
}

function normalizeOpenStatusAsOfClauses(content, meetingDateFact) {
  const normalized = String(content).replace(
    MISPLACED_NOTE_PATTERN,
    (_match, date, status) => `미수정 (${date} 기준 ${status})`
  );

  if (!isValidMeetingDateFact(meetingDateFact)) return normalized;

  const exactAsOfSpans = Array.from(normalized.matchAll(EXACT_AS_OF_PATTERN), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const replacements = Array.from(normalized.matchAll(OPEN_STATUS_PATTERN))
    .filter((match) => !isInsideSpan(
      match.index,
      match.index + match[0].length,
      exactAsOfSpans
    ))
    .reverse();
  const marker = `[[fact:${meetingDateFact.id}|${meetingDateFact.raw}]]`;

  return replacements.reduce((result, match) => {
    const start = match.index;
    const end = start + match[0].length;
    return `${result.slice(0, start)}(${marker} 기준 ${match[0]})${result.slice(end)}`;
  }, normalized);
}

module.exports = { normalizeOpenStatusAsOfClauses };
