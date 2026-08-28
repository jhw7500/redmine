const { test } = require("node:test");
const assert = require("node:assert");
const { parseAnnotatedDraft, renderCleanDraft } = require("../annotated-draft");

test("parser renders marker surfaces and preserves output locations", () => {
  const input = "#### 조현우\n- 결과 [[fact:T0001|5/8 PASS]]\n";
  const parsed = parseAnnotatedDraft(input);

  assert.deepStrictEqual(parsed.errors, []);
  assert.deepStrictEqual(parsed.claims, [{
    factId: "T0001",
    surface: "5/8 PASS",
    annotatedStart: 14,
    annotatedEnd: 37,
    cleanStart: 14,
    cleanEnd: 22,
    outputLocation: { line: 2, column: 6 },
  }]);
  assert.deepStrictEqual(parsed.markedCleanSpans, [{ start: 14, end: 22 }]);
  assert.strictEqual(parsed.cleanContent, "#### 조현우\n- 결과 5/8 PASS\n");
  assert.strictEqual(renderCleanDraft(input), parsed.cleanContent);
});

test("parser tracks source and clean locations across marker transitions", () => {
  const input = "lead\n[[fact:T0001|5/8 PASS]]\n[[fact:Q0001|3건]]\n";
  const parsed = parseAnnotatedDraft(input);

  assert.deepStrictEqual(parsed.claims.map((claim) => ({
    annotatedStart: claim.annotatedStart,
    cleanStart: claim.cleanStart,
    outputLocation: claim.outputLocation,
  })), [
    { annotatedStart: 5, cleanStart: 5, outputLocation: { line: 2, column: 1 } },
    { annotatedStart: 29, cleanStart: 14, outputLocation: { line: 3, column: 1 } },
  ]);
  assert.strictEqual(parsed.cleanContent, "lead\n5/8 PASS\n3건\n");
});

test("parser reports every malformed marker instead of guessing", () => {
  const parsed = parseAnnotatedDraft("[[fact:|5건]]\n[[fact:Q0001|]]\n[[fact:Q0002|5건");

  assert.deepStrictEqual(parsed.errors.map((error) => error.code), [
    "malformed_fact_marker", "malformed_fact_marker", "malformed_fact_marker",
  ]);
  assert.deepStrictEqual(parsed.errors.map(({ line, column }) => ({ line, column })), [
    { line: 1, column: 1 },
    { line: 2, column: 1 },
    { line: 3, column: 1 },
  ]);
  assert.strictEqual(parsed.claims.length, 0);
  assert.strictEqual(parsed.cleanContent, "[[fact:|5건]]\n[[fact:Q0001|]]\n[[fact:Q0002|5건");
});

test("parser rejects nested, invalid, and unterminated markers while continuing", () => {
  const input = [
    "[[fact:T0001|outer [[fact:Q0001|inner]]]]",
    "after [[fact:X0001|bad]]",
    " then [[fact:V0001|good]]",
  ].join("");
  const parsed = parseAnnotatedDraft(input);

  assert.deepStrictEqual(parsed.errors.map((error) => error.code), [
    "malformed_fact_marker", "malformed_fact_marker",
  ]);
  assert.strictEqual(parsed.claims[0].factId, "V0001");
  assert.strictEqual(parsed.claims[0].surface, "good");
  assert.strictEqual(parsed.cleanContent, input.replace("[[fact:V0001|good]]", "good"));
});

test("parser rejects fact-like markers with altered case or spacing", () => {
  const input = [
    "[[FACT:T0001|5/8 PASS]]",
    "[[fact :Q0001|3건]]",
    "[[fact:V0001|v2]]",
  ].join("\n");
  const parsed = parseAnnotatedDraft(input);

  assert.deepStrictEqual(parsed.errors.map((error) => error.code), [
    "malformed_fact_marker", "malformed_fact_marker",
  ]);
  assert.deepStrictEqual(parsed.errors.map(({ line, column }) => ({ line, column })), [
    { line: 1, column: 1 },
    { line: 2, column: 1 },
  ]);
  assert.deepStrictEqual(parsed.claims.map(({ factId, surface }) => ({ factId, surface })), [
    { factId: "V0001", surface: "v2" },
  ]);
  assert.strictEqual(
    parsed.cleanContent,
    "[[FACT:T0001|5/8 PASS]]\n[[fact :Q0001|3건]]\nv2"
  );
});

test("renderer throws a structured error for malformed marker syntax", () => {
  assert.throws(
    () => renderCleanDraft("ok [[fact:T0001|unterminated"),
    (error) => {
      assert.strictEqual(error.code, "MALFORMED_FACT_MARKER");
      assert.deepStrictEqual(error.issues.map((issue) => issue.code), ["malformed_fact_marker"]);
      return true;
    },
  );
});
