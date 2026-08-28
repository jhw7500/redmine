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

function splitOpenStatusClauses(line) {
  const source = String(line);
  const clauses = [];
  const closingDelimiters = [];
  let codeFenceLength = 0;
  let clauseStart = 0;

  const appendClause = (end) => {
    const clause = source.slice(clauseStart, end).trim();
    if (clause) clauses.push(clause);
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

module.exports = { splitOpenStatusClauses };
