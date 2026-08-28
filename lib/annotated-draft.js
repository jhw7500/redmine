const FACT_MARKER_PREFIX = "[[fact:";
const FACT_ID_PATTERN = /^[TQVS]\d{4}$/;
const DEFAULT_IGNORABLE_CHARACTER = /^\p{Default_Ignorable_Code_Point}$/u;
const WHITESPACE_CHARACTER = /^\s$/u;

function sourceCharacterAt(source, cursor) {
  if (cursor >= source.length) return "";
  return String.fromCodePoint(source.codePointAt(cursor));
}

function nextCharacterCursor(source, cursor) {
  return cursor + sourceCharacterAt(source, cursor).length;
}

function normalizedSyntaxCharacter(source, cursor) {
  return sourceCharacterAt(source, cursor).normalize("NFKC").toLowerCase();
}

function skipCharacters(source, cursor, predicate) {
  let next = cursor;
  while (next < source.length) {
    const character = sourceCharacterAt(source, next);
    if (!predicate(character)) break;
    next += character.length;
  }
  return next;
}

function consumeOptionalEscape(source, cursor) {
  return normalizedSyntaxCharacter(source, cursor) === "\\"
    ? nextCharacterCursor(source, cursor)
    : cursor;
}

function hasFactLikePrefixAt(source, cursor) {
  let next = consumeOptionalEscape(source, cursor);
  if (normalizedSyntaxCharacter(source, next) !== "[") return false;
  next = skipCharacters(source, nextCharacterCursor(source, next), (character) =>
    WHITESPACE_CHARACTER.test(character) || DEFAULT_IGNORABLE_CHARACTER.test(character)
  );
  next = consumeOptionalEscape(source, next);
  if (normalizedSyntaxCharacter(source, next) !== "[") return false;
  next = skipCharacters(source, nextCharacterCursor(source, next), (character) =>
    WHITESPACE_CHARACTER.test(character) || DEFAULT_IGNORABLE_CHARACTER.test(character)
  );
  for (const letter of "fact") {
    if (normalizedSyntaxCharacter(source, next) !== letter) return false;
    next = skipCharacters(
      source,
      nextCharacterCursor(source, next),
      (character) => DEFAULT_IGNORABLE_CHARACTER.test(character)
    );
  }
  next = skipCharacters(source, next, (character) =>
    WHITESPACE_CHARACTER.test(character) || DEFAULT_IGNORABLE_CHARACTER.test(character)
  );
  next = consumeOptionalEscape(source, next);
  return normalizedSyntaxCharacter(source, next) === ":";
}

function advanceLocation(location, text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      location.line += 1;
      location.column = 1;
    } else {
      location.column += 1;
    }
  }
}

function malformedMarker(location, start, end) {
  return {
    code: "malformed_fact_marker",
    line: location.line,
    column: location.column,
    start,
    end,
  };
}

function parseAnnotatedDraft(content) {
  const source = String(content);
  const claims = [];
  const errors = [];
  const clean = [];
  const markedCleanSpans = [];
  let cursor = 0;
  let cleanOffset = 0;
  const sourceLocation = { line: 1, column: 1 };
  const cleanLocation = { line: 1, column: 1 };

  while (cursor < source.length) {
    const exactMarker = source.startsWith(FACT_MARKER_PREFIX, cursor);
    const factLikeMarker = !exactMarker && hasFactLikePrefixAt(source, cursor);
    if (!exactMarker && !factLikeMarker) {
      const character = source[cursor];
      clean.push(character);
      cursor += 1;
      cleanOffset += 1;
      advanceLocation(sourceLocation, character);
      advanceLocation(cleanLocation, character);
      continue;
    }

    const annotatedStart = cursor;
    if (factLikeMarker) {
      const closeStart = source.indexOf("]]", cursor + 2);
      const annotatedEnd = closeStart === -1 ? source.length : closeStart + 2;
      errors.push(malformedMarker(sourceLocation, annotatedStart, annotatedEnd));
      const marker = source.slice(annotatedStart, annotatedEnd);
      clean.push(marker);
      cleanOffset += marker.length;
      advanceLocation(sourceLocation, marker);
      advanceLocation(cleanLocation, marker);
      cursor = annotatedEnd;
      if (closeStart === -1) break;
      continue;
    }

    const bodyStart = cursor + FACT_MARKER_PREFIX.length;
    const closeStart = source.indexOf("]]", bodyStart);
    if (closeStart === -1) {
      errors.push(malformedMarker(sourceLocation, annotatedStart, source.length));
      const remainder = source.slice(annotatedStart);
      clean.push(remainder);
      cleanOffset += remainder.length;
      advanceLocation(sourceLocation, remainder);
      advanceLocation(cleanLocation, remainder);
      break;
    }

    const annotatedEnd = closeStart + 2;
    const body = source.slice(bodyStart, closeStart);
    const separator = body.indexOf("|");
    const factId = separator === -1 ? "" : body.slice(0, separator);
    const surface = separator === -1 ? "" : body.slice(separator + 1);
    const nestedMarker = body.includes("[[");
    const valid = !nestedMarker
      && separator !== -1
      && FACT_ID_PATTERN.test(factId)
      && surface.length > 0;

    if (!valid) {
      errors.push(malformedMarker(sourceLocation, annotatedStart, annotatedEnd));
      const marker = source.slice(annotatedStart, annotatedEnd);
      clean.push(marker);
      cleanOffset += marker.length;
      advanceLocation(sourceLocation, marker);
      advanceLocation(cleanLocation, marker);
      cursor = annotatedEnd;
      continue;
    }

    const cleanStart = cleanOffset;
    const outputLocation = {
      line: cleanLocation.line,
      column: cleanLocation.column,
    };
    clean.push(surface);
    cleanOffset += surface.length;
    advanceLocation(cleanLocation, surface);
    advanceLocation(sourceLocation, source.slice(annotatedStart, annotatedEnd));
    const cleanEnd = cleanOffset;
    const claim = {
      factId,
      surface,
      annotatedStart,
      annotatedEnd,
      cleanStart,
      cleanEnd,
      outputLocation,
    };
    claims.push(claim);
    markedCleanSpans.push({ start: cleanStart, end: cleanEnd });
    cursor = annotatedEnd;
  }

  return { claims, errors, cleanContent: clean.join(""), markedCleanSpans };
}

function renderCleanDraft(content) {
  const parsed = parseAnnotatedDraft(content);
  if (parsed.errors.length > 0) {
    const error = new Error("annotated draft contains malformed fact markers");
    error.code = "MALFORMED_FACT_MARKER";
    error.issues = parsed.errors;
    throw error;
  }
  return parsed.cleanContent;
}

module.exports = { parseAnnotatedDraft, renderCleanDraft };
