import {
  DefaultMcpMaxResultCharacters,
  MaximumMcpMaxResultCharacters,
  clampMcpMaxResultCharacters,
  limitMcpResult,
} from "./mcpResultLimit";

describe("clampMcpMaxResultCharacters", () => {
  test("is no limit when unset, not a number, zero, or negative", () => {
    expect(DefaultMcpMaxResultCharacters).toBe(0);
    expect(clampMcpMaxResultCharacters(undefined)).toBe(0);
    expect(clampMcpMaxResultCharacters(NaN)).toBe(0);
    expect(clampMcpMaxResultCharacters(0)).toBe(0);
    expect(clampMcpMaxResultCharacters(-5)).toBe(0);
  });

  test("rounds and caps a positive limit", () => {
    expect(clampMcpMaxResultCharacters(1234.6)).toBe(1235);
    expect(clampMcpMaxResultCharacters(MaximumMcpMaxResultCharacters * 2)).toBe(
      MaximumMcpMaxResultCharacters,
    );
  });
});

describe("limitMcpResult", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    filename: `note-${i}.md`,
    score: 50 - i,
    matches: [{ match: { start: 0, end: 3 }, context: "x".repeat(200) }],
  }));
  const full = JSON.stringify(items, null, 2);

  test("serializes exactly as before when there is no limit", () => {
    expect(limitMcpResult(items, 0)).toEqual({ text: full });
    expect(limitMcpResult("plain text", 0)).toEqual({ text: "plain text" });
  });

  test("leaves a result that fits untouched, with no notice", () => {
    expect(limitMcpResult(items, full.length)).toEqual({ text: full });
  });

  test("cuts an array between items, keeping the leading ones as valid JSON", () => {
    const limit = Math.floor(full.length / 3);
    const { text, notice } = limitMcpResult(items, limit);

    expect(text.length).toBeLessThanOrEqual(limit);
    const kept = JSON.parse(text);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(items.slice(0, kept.length));
    // As many items as fit: one more would not.
    expect(JSON.stringify(items.slice(0, kept.length + 1), null, 2).length).toBeGreaterThan(limit);

    expect(notice).toContain(`first ${kept.length} of 50 items`);
    expect(notice).toContain(`of ${full.length} characters`);
    expect(notice).toContain("valid JSON");
    expect(notice).toContain("Maximum MCP tool result size");
  });

  test("cuts the text when not even the first array item fits", () => {
    const { text, notice } = limitMcpResult(items, 100);
    expect(text).toBe(full.slice(0, 100));
    expect(notice).toContain(`first 100 of ${full.length} characters`);
    expect(notice).toContain("not valid JSON");
  });

  test("cuts a string or an object at the limit", () => {
    const note = "a".repeat(1000);
    expect(limitMcpResult(note, 400).text).toBe("a".repeat(400));
    expect(limitMcpResult(note, 400).notice).toContain("first 400 of 1000 characters");

    const object = { content: note };
    const { text } = limitMcpResult(object, 400);
    expect(text).toBe(JSON.stringify(object, null, 2).slice(0, 400));
  });

  test("never splits a surrogate pair", () => {
    const text = "ab😀cd"; // the emoji occupies indexes 2 and 3
    expect(limitMcpResult(text, 3).text).toBe("ab");
    expect(limitMcpResult(text, 4).text).toBe("ab😀");
  });
});
