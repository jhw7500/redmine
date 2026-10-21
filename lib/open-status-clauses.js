const OPENING_DELIMITERS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

function backtickRunLength(source, cursor) {
  let end = cursor;
  while (source[end] === "`") end += 1;
  return end - cursor;
}

function previousNonEscapeCharacter(source, cursor) {
  let previous = cursor - 1;
  while (source[previous] === "\\") previous -= 1;
  return source[previous] || "";
}

function hasClosingBacktickRun(source, cursor, runLength) {
  const closing = "`".repeat(runLength);
  let next = source.indexOf(closing, cursor + runLength);
  while (next !== -1) {
    let escapes = 0;
    for (let index = next - 1; source[index] === "\\"; index -= 1) escapes += 1;
    if (escapes % 2 === 0) return true;
    next = source.indexOf(closing, next + runLength);
  }
  return false;
}

function hasMatchingClosingDelimiter(source, cursor, opening, closing) {
  let depth = 1;
  let codeFenceLength = 0;
  for (let next = cursor + 1; next < source.length; next += 1) {
    const character = source[next];
    if (character === "\\" && source[next + 1] === "`") {
      next += 1;
      continue;
    }
    if (character === "`") {
      const runLength = backtickRunLength(source, next);
      if (codeFenceLength === 0 && hasClosingBacktickRun(source, next, runLength)) {
        codeFenceLength = runLength;
      } else if (codeFenceLength > 0 && runLength >= codeFenceLength) {
        codeFenceLength = 0;
      }
      next += runLength - 1;
      continue;
    }
    if (codeFenceLength > 0) continue;
    if (character === opening) depth += 1;
    if (character === closing && --depth === 0) return true;
  }
  return false;
}

function isTopLevelSeparator(source, cursor) {
  const character = source[cursor];
  const before = previousNonEscapeCharacter(source, cursor);
  const after = source[cursor + 1] || "";
  if (character === ",") return !(/\d/.test(before) && /\d/.test(after));
  if (character === ";" || character === "|") return true;
  if (character === "/") return /\s/.test(before) && /\s/.test(after);
  if (character === "." || character === "!" || character === "?") {
    return before === ")" || after === "" || /\s/.test(after);
  }
  return false;
}

function splitOpenStatusClauseSpans(line) {
  const source = String(line);
  const clauses = [];
  const closingDelimiters = [];
  let codeFenceLength = 0;
  let clauseStart = 0;

  const appendClause = (end) => {
    const raw = source.slice(clauseStart, end);
    const text = raw.trim();
    if (text) {
      const start = clauseStart + raw.length - raw.trimStart().length;
      clauses.push({ text, start, end: start + text.length });
    }
  };

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\\" && source[cursor + 1] === "`") {
      cursor += 1;
      continue;
    }
    if (character === "`") {
      const runLength = backtickRunLength(source, cursor);
      if (codeFenceLength === 0 && hasClosingBacktickRun(source, cursor, runLength)) {
        codeFenceLength = runLength;
      } else if (codeFenceLength > 0 && runLength >= codeFenceLength) {
        codeFenceLength = 0;
      }
      cursor += runLength - 1;
      continue;
    }
    if (codeFenceLength > 0) continue;

    if (OPENING_DELIMITERS.has(character)) {
      const closing = OPENING_DELIMITERS.get(character);
      if (hasMatchingClosingDelimiter(source, cursor, character, closing)) {
        closingDelimiters.push(closing);
      }
      continue;
    }
    if (closingDelimiters.at(-1) === character) {
      closingDelimiters.pop();
      continue;
    }
    if (closingDelimiters.length > 0 || !isTopLevelSeparator(source, cursor)) continue;

    appendClause(cursor);
    clauseStart = cursor + 1;
  }

  appendClause(source.length);
  return clauses;
}

function splitOpenStatusClauses(line) {
  return splitOpenStatusClauseSpans(line).map(clause => clause.text);
}

function isDescriptiveStatus(term, before, after, contextBefore) {
  // TODO/FIXME remain claims even inside code or descriptions of writing rules.
  if (/^(?:TODO|FIXME)$/i.test(term)) return false;
  if (/^(?:·후속)?\s*(?:표현|문구|용어)\s*(?:규칙|기준|원칙|(?:으로|로)\s*바꾸지\s*않|(?:을|를)\s*만들지\s*않)/.test(after)) return true;
  if (/^\)?\s*상태의\s*임의\s*생성\s*방지[^.!?;\n]*(?:지침|규칙)/.test(after)) return true;
  if (term !== "보류") return false;

  if (/(?:\d+|\[\[fact:[A-Z]\d{4}\|\d+\]\])\s*\($/.test(before)
    && /^\)\s*(?:을|를)?\s*(?:돌려주|반환|리턴)/.test(after)) return true;

  const planned = /향후|추후|예정|계획|해야|하려|내일|내주|내달|내년|다음|차주|차기|차후|이후|후에|나중|앞으로|조만간|머지않아|이따|언젠가|곧|오는|이번\s*(?:주|달|월|분기|해)|할\s*것|겠/.test(before + after);
  if (!planned && !/않|못|아니|아님|아닌|아닐|아닙/.test(after)
    && /^(?:를|을)\s*(?:없앤다|없앴다|제거했다|제거한다)(?=\s|[.(#]|$)/.test(after)) return true;

  const runtimeControl = /재기동\s*직후[^.!?;\n]*?첫\s*(?:녹화\s*)?조각[^.!?;\n]*?(?:전에는|전까지)\s*파일\s*검사를?\s*(?:\([^\n)]*기준\s*)?$/.test(before)
    || /재연결(?:할\s*때|\s*시)[^.!?;\n]*?알림\s*전송을?\s*(?:\([^\n)]*기준\s*)?$/.test(before);
  if (!planned && runtimeControl
    && /^\)?(?:해|하여)\s+[^.!?;\n]*?(?:(?:막는다|방지한다)(?![가-힣])|방지(?=\s*(?:[.!?;,]|$)))/.test(after)) return true;

  // A clipped noun reference is only descriptive when the same visible line
  // already states the complete runtime condition and its result.
  return !planned && /앱이\s*없을\s*때와\s*$/.test(before)
    && /^가(?:…|\.{3})(?=\s*(?:;|$))/.test(after)
    && /첫\s*조각[^.\n]*?없고\s*앱이[^.\n]*?어리면[^.\n]*?판정하지\s*않는다\.\s*앱이\s*없을\s*때와\s*$/.test(contextBefore);
}

function findOpenStatusOccurrences(text) {
  const source = String(text);
  return Array.from(source.matchAll(/미해결|미완료|미완|보류|TODO|FIXME/gi), match => {
    const start = match.index;
    return { term: match[0], start, end: start + match[0].length };
  }).filter(({ term, start, end }) => {
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const nextLine = source.indexOf("\n", end);
    const lineEnd = nextLine === -1 ? source.length : nextLine;
    const contextBefore = source.slice(lineStart, start);
    return !isDescriptiveStatus(term, source.slice(lineStart, start), source.slice(end, lineEnd), contextBefore);
  });
}

module.exports = { splitOpenStatusClauses, splitOpenStatusClauseSpans, findOpenStatusOccurrences };
