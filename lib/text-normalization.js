// Redmine 백엔드 MySQL(utf8mb3)은 4바이트 UTF-8(BMP 밖, 이모지 등)을
// 저장하지 못한다. 검증·해시·게시가 같은 문자열을 사용하도록 공용 정규화한다.
function stripAstralChars(text) {
  return typeof text === "string"
    ? text.replace(/[\u{10000}-\u{10FFFF}]/gu, "")
    : text;
}

module.exports = { stripAstralChars };
