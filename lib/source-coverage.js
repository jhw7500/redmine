const { hashObject } = require("./report-artifact");
const { hasMarkerLikePrefixAt, parseAnnotatedDraft } = require("./annotated-draft");

const SOURCE_MARKER = /\[\[source:([CN]\d{4})\]\]/g;

function samePath(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function uniquePaths(paths) {
  return paths.reduce((result, path) => (
    result.some((knownPath) => samePath(knownPath, path)) ? result : [...result, path]
  ), []);
}

function requiredPathForCategory(category) {
  return category.label ? [category.parent, category.label] : [category.parent];
}

function autoContentIsPopulated(value) {
  const bullets = String(value || "")
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*+]\s+)?/, ""))
    .filter(Boolean);
  return bullets.length > 0 && !bullets.every((bullet) => bullet === "(변경 없음)");
}

function markdownBullet(line) {
  const structuralLine = parseAnnotatedDraft(String(line)).cleanContent;
  const match = structuralLine
    .replace(SOURCE_MARKER, "")
    .trimEnd()
    .match(/^(\s*)(?:[-*+]\s+)(.*?)\s*$/);
  if (!match) return null;
  return { indent: match[1].length, text: match[2] };
}

function offsetAtLine(lines, lineIndex) {
  return lines.slice(0, lineIndex).reduce((offset, line) => offset + line.length + 1, 0);
}

function locationAt(content, offset) {
  const source = String(content);
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return {
    line: source.slice(0, offset).split("\n").length,
    column: offset - lineStart + 1,
  };
}

function pathHeadingAt(lines, lineIndex, path) {
  const leaf = markdownBullet(lines[lineIndex]);
  if (!leaf || leaf.text !== path[path.length - 1]) return null;

  const headings = [leaf];
  let childIndent = leaf.indent;
  let cursor = lineIndex - 1;
  for (let pathIndex = path.length - 2; pathIndex >= 0; pathIndex -= 1) {
    let parent = null;
    while (cursor >= 0) {
      const candidate = markdownBullet(lines[cursor]);
      cursor -= 1;
      if (candidate && candidate.indent < childIndent) {
        parent = candidate;
        break;
      }
    }
    if (!parent || parent.text !== path[pathIndex]) return null;
    headings.push(parent);
    childIndent = parent.indent;
  }
  return {
    ...leaf,
    pathIndents: headings.reverse().map((heading) => heading.indent),
  };
}

function sourceIndentsForPath(path, pathBindings) {
  const binding = (pathBindings || []).find((entry) => samePath(entry.requiredPath, path));
  return binding?.sourcePathIndents || null;
}

function pathHeadingMatchesBinding(heading, path, pathBindings) {
  const sourceIndents = sourceIndentsForPath(path, pathBindings);
  return !sourceIndents || samePath(heading.pathIndents, sourceIndents);
}

function activePathAtLine(lines, lineIndex, knownPaths, pathBindings) {
  for (let candidateLine = lineIndex; candidateLine >= 0; candidateLine -= 1) {
    for (const path of knownPaths) {
      const heading = pathHeadingAt(lines, candidateLine, path);
      if (!heading || !pathHeadingMatchesBinding(heading, path, pathBindings)) continue;
      let terminated = false;
      for (let followingLine = candidateLine + 1; followingLine <= lineIndex; followingLine += 1) {
        const following = markdownBullet(lines[followingLine]);
        if (following && following.indent <= heading.indent) {
          terminated = true;
          break;
        }
      }
      if (!terminated) return { path, headingLine: candidateLine, headingIndent: heading.indent };
    }
  }
  return null;
}

function sourceSectionPathAt(content, offset, knownPaths) {
  const source = String(content);
  const lineIndex = source.slice(0, offset).split("\n").length - 1;
  return activePathAtLine(source.split("\n"), lineIndex, knownPaths || [])?.path || null;
}

function sourceLocationForPath(rawContent, requiredPath) {
  const lines = String(rawContent).split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const heading = pathHeadingAt(lines, lineIndex, requiredPath);
    if (!heading) continue;
    const lineOffset = offsetAtLine(lines, lineIndex);
    const textOffset = lines[lineIndex].indexOf(heading.text);
    return {
      line: lineIndex + 1,
      column: textOffset + 1,
      start: lineOffset + textOffset,
      end: lineOffset + textOffset + heading.text.length,
      sourceExcerpt: heading.text,
      sourcePathIndents: heading.pathIndents,
    };
  }
  return null;
}

function populatedCategories(autoContent, categories, rawContent) {
  let counter = 0;
  return Object.entries(categories || {})
    .filter(([, category]) => autoContentIsPopulated(autoContent?.[`{{${category.templateKey}}}`]))
    .map(([categoryKey, category]) => {
      const requiredPath = requiredPathForCategory(category);
      const location = sourceLocationForPath(rawContent, requiredPath);
      return {
        id: `C${String(++counter).padStart(4, "0")}`,
        kind: "section",
        categoryKey,
        requiredPath,
        sourceLocation: location && {
          line: location.line,
          column: location.column,
        },
        sourceExcerpt: location && location.sourceExcerpt,
        sourcePathIndents: location && location.sourcePathIndents,
      };
    });
}

function notionEntries(rawContent, knownPaths) {
  const source = String(rawContent);
  const lines = source.split("\n");
  let counter = 0;
  return lines.reduce((items, line, lineIndex) => {
    const bullet = markdownBullet(line);
    if (!bullet || !bullet.text.startsWith("[Notion]")) return items;
    const lineOffset = offsetAtLine(lines, lineIndex);
    const textOffset = line.indexOf(bullet.text);
    const requiredPath = sourceSectionPathAt(source, lineOffset + textOffset, knownPaths);
    if (!requiredPath) {
      const error = new Error(`Notion item has no configured source path at line ${lineIndex + 1}`);
      error.code = "SOURCE_COVERAGE_PATH_MISSING";
      throw error;
    }
    return [...items, {
      id: `N${String(++counter).padStart(4, "0")}`,
      kind: "notion_item",
      requiredPath,
      sourceLocation: {
        line: lineIndex + 1,
        column: textOffset + 1,
      },
      sourceExcerpt: bullet.text,
    }];
  }, []);
}

function buildSourceCoverageCatalog(snapshot, categories) {
  const sections = populatedCategories(snapshot.autoContent, categories, snapshot.rawContent);
  const knownPaths = uniquePaths(sections.map((entry) => entry.requiredPath));
  const items = notionEntries(snapshot.rawContent, knownPaths);
  const payload = { schemaVersion: 1, sections, items, knownPaths };
  return { ...payload, coverageCatalogHash: hashObject(payload) };
}

function indexMarkersBySourceLine(catalog) {
  const markersByLine = new Map();
  for (const entry of [...catalog.sections, ...catalog.items]) {
    if (!entry.sourceLocation) {
      const error = new Error(`source marker ${entry.id} has no source location`);
      error.code = "SOURCE_COVERAGE_LOCATION_MISSING";
      throw error;
    }
    const markers = markersByLine.get(entry.sourceLocation.line) || [];
    markers.push(`[[source:${entry.id}]]`);
    markersByLine.set(entry.sourceLocation.line, markers);
  }
  return markersByLine;
}

function annotateSourceCoverageReferences(content, catalog) {
  const markersByLine = indexMarkersBySourceLine(catalog);
  return String(content).split("\n").map((line, index) => {
    const markers = markersByLine.get(index + 1) || [];
    return markers.length ? `${line} ${markers.join(" ")}` : line;
  }).join("\n");
}

function outputLocation(content, offset) {
  const location = locationAt(content, offset);
  const lineStart = String(content).lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = String(content).indexOf("\n", offset);
  return {
    ...location,
    excerpt: String(content).slice(lineStart, lineEnd === -1 ? undefined : lineEnd),
  };
}

function sourceIssue(code, options = {}) {
  return {
    code,
    ...(options.id ? { id: options.id } : {}),
    ...(options.entry ? {
      requiredPath: options.entry.requiredPath,
      sourceLocation: options.entry.sourceLocation,
      sourceExcerpt: options.entry.sourceExcerpt,
    } : {}),
    ...(options.actualPath ? { actualPath: options.actualPath } : {}),
    ...(options.offset === undefined ? {} : { outputLocation: outputLocation(options.content, options.offset) }),
    ...(options.outputOffsets ? {
      outputLocations: options.outputOffsets.map((offset) => outputLocation(options.content, offset)),
    } : {}),
    ...(options.occurrenceCount === undefined ? {} : {
      occurrenceCount: options.occurrenceCount,
    }),
  };
}

function markerOccurrences(content) {
  const source = String(content);
  const occurrences = [];
  for (const match of source.matchAll(SOURCE_MARKER)) {
    occurrences.push({ id: match[1], start: match.index, end: match.index + match[0].length });
  }
  const validByStart = new Map(occurrences.map((occurrence) => [occurrence.start, occurrence]));
  const malformedStarts = [];
  let cursor = 0;
  while (cursor < source.length) {
    const valid = validByStart.get(cursor);
    if (valid) {
      cursor = valid.end;
      continue;
    }
    if (hasMarkerLikePrefixAt(source, cursor, "source")) {
      malformedStarts.push(cursor);
      const closeStart = source.indexOf("]]", cursor + 2);
      cursor = closeStart === -1 ? source.length : closeStart + 2;
      continue;
    }
    const codePoint = source.codePointAt(cursor);
    cursor += codePoint > 0xFFFF ? 2 : 1;
  }
  return { occurrences, malformedStarts };
}

function activePathAtOffset(content, offset, knownPaths, pathBindings) {
  const source = String(content);
  const lineIndex = source.slice(0, offset).split("\n").length - 1;
  return activePathAtLine(source.split("\n"), lineIndex, knownPaths || [], pathBindings);
}

function markerIsOnRequiredHeading(content, occurrence, entry) {
  const source = String(content);
  const lineIndex = source.slice(0, occurrence.start).split("\n").length - 1;
  const lines = source.split("\n");
  const heading = pathHeadingAt(lines, lineIndex, entry.requiredPath);
  return Boolean(
    heading
    && samePath(heading.pathIndents, entry.sourcePathIndents)
  );
}

function markerIsUnderRequiredPath(content, occurrence, entry, knownPaths, pathBindings) {
  const source = String(content);
  const lineIndex = source.slice(0, occurrence.start).split("\n").length - 1;
  const lines = source.split("\n");
  const bullet = markdownBullet(lines[lineIndex]);
  const active = activePathAtLine(lines, lineIndex, knownPaths, pathBindings);
  return Boolean(
    bullet
    && active
    && active.headingLine < lineIndex
    && bullet.indent > active.headingIndent
    && samePath(active.path, entry.requiredPath)
  );
}

function canonicalHeadingOccurrences(content, entry) {
  const lines = String(content).split("\n");
  return lines.reduce((offsets, _line, lineIndex) => {
    const heading = pathHeadingAt(lines, lineIndex, entry.requiredPath);
    if (heading && samePath(heading.pathIndents, entry.sourcePathIndents)) {
      offsets.push(offsetAtLine(lines, lineIndex));
    }
    return offsets;
  }, []);
}

function canonicalHeadingLineIndexes(lines, requiredPath, pathBindings) {
  return lines.reduce((indexes, _line, lineIndex) => {
    const heading = pathHeadingAt(lines, lineIndex, requiredPath);
    if (heading && pathHeadingMatchesBinding(heading, requiredPath, pathBindings)) {
      indexes.push(lineIndex);
    }
    return indexes;
  }, []);
}

function annotatedSourceBullet(annotatedSource, entry) {
  const line = String(annotatedSource).split("\n")[entry.sourceLocation.line - 1];
  if (!line) return null;
  const marker = `[[source:${entry.id}]]`;
  if (line.split(marker).length !== 2) return null;
  const match = line.match(/^\s*[-*+]\s+(.*?)\s*$/);
  return match ? match[1] : null;
}

function sectionInsertionIndex(lines, headingLine, headingIndent) {
  let end = lines.length;
  for (let lineIndex = headingLine + 1; lineIndex < lines.length; lineIndex += 1) {
    const bullet = markdownBullet(lines[lineIndex]);
    if (bullet && bullet.indent <= headingIndent) {
      end = lineIndex;
      break;
    }
    if (/^\*작성:/.test(lines[lineIndex])) {
      end = lineIndex;
      break;
    }
  }
  while (end > headingLine + 1 && lines[end - 1].trim() === "") end -= 1;
  return end;
}

function reconcileMissingSourceCoverage(annotatedContent, annotatedSource, catalog) {
  const content = String(annotatedContent);
  const initial = validateSourceCoverage(content, catalog);
  if (initial.issues.some((issue) => issue.code !== "missing_source_id")) {
    return { content, addedSectionIds: [], addedItemIds: [] };
  }
  const missingIds = new Set(initial.issues.map((issue) => issue.id));
  const lines = content.split("\n");
  const addedSectionIds = [];

  for (const entry of catalog.sections) {
    if (!missingIds.has(entry.id)) continue;
    const headingLines = canonicalHeadingLineIndexes(
      lines,
      entry.requiredPath,
      catalog.sections
    );
    if (headingLines.length !== 1) continue;
    const headingLine = headingLines[0];
    const trailingWhitespace = lines[headingLine].match(/[ \t]*$/)[0];
    const headingText = trailingWhitespace
      ? lines[headingLine].slice(0, -trailingWhitespace.length)
      : lines[headingLine];
    lines[headingLine] = `${headingText} [[source:${entry.id}]]${trailingWhitespace}`;
    addedSectionIds.push(entry.id);
  }

  const groups = [];
  for (const entry of catalog.items) {
    if (!missingIds.has(entry.id)) continue;
    let group = groups.find((candidate) => samePath(candidate.requiredPath, entry.requiredPath));
    if (!group) {
      group = { requiredPath: entry.requiredPath, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }

  const insertions = groups.flatMap((group) => {
    const headingLines = canonicalHeadingLineIndexes(
      lines,
      group.requiredPath,
      catalog.sections
    );
    if (headingLines.length !== 1) return [];
    const headingLine = headingLines[0];
    const heading = pathHeadingAt(lines, headingLine, group.requiredPath);
    const entries = group.entries.flatMap((entry) => {
      const bullet = annotatedSourceBullet(annotatedSource, entry);
      return bullet ? [{ entry, bullet }] : [];
    });
    if (entries.length === 0) return [];
    return [{ headingLine, headingIndent: heading.indent, entries }];
  }).sort((left, right) => right.headingLine - left.headingLine);

  const addedItemIds = [];
  for (const insertion of insertions) {
    const at = sectionInsertionIndex(lines, insertion.headingLine, insertion.headingIndent);
    const itemIndent = " ".repeat(insertion.headingIndent + 2);
    lines.splice(at, 0, ...insertion.entries.map(({ entry, bullet }) => {
      addedItemIds.push(entry.id);
      return `${itemIndent}- ${bullet}`;
    }));
  }

  return { content: lines.join("\n"), addedSectionIds, addedItemIds };
}

function validateSourceCoverage(annotatedContent, catalog) {
  const content = String(annotatedContent);
  const entries = [...catalog.sections, ...catalog.items];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const { occurrences, malformedStarts } = markerOccurrences(content);
  const occurrencesById = new Map();
  const issues = malformedStarts.map((offset) => sourceIssue("malformed_source_marker", {
    content,
    offset,
  }));

  for (const occurrence of occurrences) {
    const matches = occurrencesById.get(occurrence.id) || [];
    matches.push(occurrence);
    occurrencesById.set(occurrence.id, matches);
    const entry = entriesById.get(occurrence.id);
    if (!entry) {
      issues.push(sourceIssue("unknown_source_id", {
        id: occurrence.id,
        content,
        offset: occurrence.start,
      }));
      continue;
    }

    const active = activePathAtOffset(
      content,
      occurrence.start,
      catalog.knownPaths,
      catalog.sections
    );
    if (entry.kind === "section") {
      if (!markerIsOnRequiredHeading(content, occurrence, entry)) {
        issues.push(sourceIssue("source_section_heading_mismatch", {
          id: entry.id,
          entry,
          actualPath: active?.path || null,
          content,
          offset: occurrence.start,
        }));
      }
    } else if (!markerIsUnderRequiredPath(
      content,
      occurrence,
      entry,
      catalog.knownPaths,
      catalog.sections
    )) {
      issues.push(sourceIssue("source_section_mismatch", {
        id: entry.id,
        entry,
        actualPath: active?.path || null,
        content,
        offset: occurrence.start,
      }));
    }
  }

  for (const [id, matches] of occurrencesById) {
    if (matches.length > 1) {
      for (const occurrence of matches.slice(1)) {
        issues.push(sourceIssue("duplicate_source_id", {
          id,
          entry: entriesById.get(id),
          content,
          offset: occurrence.start,
        }));
      }
    }
  }

  for (const entry of catalog.sections) {
    const headingOffsets = canonicalHeadingOccurrences(content, entry);
    if (headingOffsets.length > 1) {
      issues.push(sourceIssue("duplicate_source_section_heading", {
        id: entry.id,
        entry,
        content,
        outputOffsets: headingOffsets,
        occurrenceCount: headingOffsets.length,
      }));
    }
  }

  for (const entry of entries) {
    if (!occurrencesById.has(entry.id)) {
      issues.push(sourceIssue("missing_source_id", { id: entry.id, entry }));
    }
  }

  const observed = entries.reduce((counts, entry) => {
    const seen = occurrencesById.has(entry.id) ? 1 : 0;
    counts.total += seen;
    counts[entry.kind === "section" ? "sections" : "items"] += seen;
    return counts;
  }, { sections: 0, items: 0, total: 0 });
  const required = {
    sections: catalog.sections.length,
    items: catalog.items.length,
    total: entries.length,
  };

  return {
    cleanContent: content.replace(/[ \t]?\[\[source:[CN]\d{4}\]\]/g, ""),
    issues,
    coverage: {
      required,
      observed,
      complete: issues.length === 0,
    },
  };
}

module.exports = {
  annotateSourceCoverageReferences,
  buildSourceCoverageCatalog,
  reconcileMissingSourceCoverage,
  sourceSectionPathAt,
  validateSourceCoverage,
};
