const { hasMarkerLikePrefixAt } = require("./annotated-draft");

// Redmine 백엔드 MySQL(utf8mb3)은 4바이트 UTF-8(BMP 밖, 이모지 등)을
// 저장하지 못한다. 검증·해시·게시가 같은 문자열을 사용하도록 공용 정규화한다.
function stripAstralChars(text) {
  return typeof text === "string"
    ? text.replace(/[\u{10000}-\u{10FFFF}]/gu, "")
    : text;
}

// U+27E6 is one UTF-16 unit and stays itself under NFKC, so the parser never reads it as "[".
const NEUTRAL_MARKER_BRACKET = "⟦";

// The source view the fact catalog, annotation and validator share. Marker syntax quoted in the source (e.g. a
// commit body citing `\[[fact:Q0072]]`) would otherwise become a broken marker once its values are annotated, so the
// opening "[" of every position the parser reads as a fact/source marker becomes U+27E6. Length and line breaks are
// unchanged, so catalog offsets still point at the same characters. Never apply this to AI output.
function normalizeFactSource(text) {
  const source = stripAstralChars(String(text));
  const characters = source.split("");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index].normalize("NFKC") !== "[") continue;
    if (hasMarkerLikePrefixAt(source, index, "fact") || hasMarkerLikePrefixAt(source, index, "source")) {
      characters[index] = NEUTRAL_MARKER_BRACKET;
    }
  }
  return characters.join("");
}

module.exports = { normalizeFactSource, stripAstralChars };
