const FACT_MARKER_PREFIX = "[[fact:";
const FACT_ID_PATTERN = /^[TQVS]\d{4}$/;

function locationAt(source, offset) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function malformedMarker(source, start, end) {
  const { line, column } = locationAt(source, start);
  return {
    code: "malformed_fact_marker",
    line,
    column,
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

  while (cursor < source.length) {
    if (!source.startsWith(FACT_MARKER_PREFIX, cursor)) {
      clean.push(source[cursor]);
      cursor += 1;
      cleanOffset += 1;
      continue;
    }

    const annotatedStart = cursor;
    const bodyStart = cursor + FACT_MARKER_PREFIX.length;
    const closeStart = source.indexOf("]]", bodyStart);
    if (closeStart === -1) {
      errors.push(malformedMarker(source, annotatedStart, source.length));
      clean.push(source.slice(annotatedStart));
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
      errors.push(malformedMarker(source, annotatedStart, annotatedEnd));
      clean.push(source.slice(annotatedStart, annotatedEnd));
      cleanOffset += annotatedEnd - annotatedStart;
      cursor = annotatedEnd;
      continue;
    }

    const cleanStart = cleanOffset;
    const outputLocation = locationAt(clean.join(""), cleanStart);
    clean.push(surface);
    cleanOffset += surface.length;
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
