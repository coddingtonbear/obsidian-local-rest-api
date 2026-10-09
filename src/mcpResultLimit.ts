/**
 * An optional ceiling on the size of an MCP tool's text result.
 *
 * Nothing else bounds what a tool hands back. `search_simple` returns every match in
 * every matching file, so a query made of common words over a few hundred notes can
 * come back as megabytes of JSON. Some MCP clients put a tool's result into the model's
 * context verbatim, with no limit of their own, and a single such result is then larger
 * than the model's whole context window: the request is rejected, and because the
 * result is now part of the conversation, every retry is rejected too.
 *
 * The limit is off unless the user sets one. When a result is over it, the text is cut
 * to fit and a second text block says so, giving the original size and how to get the
 * rest, so the model knows it has a partial answer rather than a complete one. An array
 * result is cut between elements, keeping the first ones (searches are sorted by
 * relevance) and leaving valid JSON; anything else is cut at the limit.
 */

/** Characters; 0 means no limit. */
export const DefaultMcpMaxResultCharacters = 0;
export const MaximumMcpMaxResultCharacters = 100_000_000;

/**
 * The stored limit as a whole number of characters in range, or 0 (no limit) when it
 * is unset, not a number, or not positive.
 */
export function clampMcpMaxResultCharacters(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return DefaultMcpMaxResultCharacters;
  }
  return Math.min(MaximumMcpMaxResultCharacters, Math.round(value));
}

export interface LimitedResult {
  /** The serialized result, no longer than the limit. */
  text: string;
  /** Present only when the result was cut: tells the model what it is missing. */
  notice?: string;
}

function serialize(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

/** `text` cut to at most `limit` characters without splitting a surrogate pair. */
function cutText(text: string, limit: number): string {
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** The largest count of leading elements whose serialization fits in `limit`. */
function fittingPrefixLength(items: unknown[], limit: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serialize(items.slice(0, middle)).length <= limit) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Serializes a tool result the way `McpHandler` always has (strings as-is, anything
 * else as indented JSON), cut to `limit` characters when `limit` is positive.
 */
export function limitMcpResult(data: unknown, limit: number): LimitedResult {
  const full = serialize(data);
  if (limit <= 0 || full.length <= limit) return { text: full };

  const advice =
    "Narrow the request to see the rest: for a search, use more specific terms, " +
    "a smaller contextLength, or search_query to filter by path, tag, or frontmatter " +
    "first; for a note, use vault_get_document_map and read the section you need.";
  const setting = `the "Maximum MCP tool result size" setting (${limit} characters)`;

  if (Array.isArray(data)) {
    const kept = fittingPrefixLength(data, limit);
    if (kept > 0) {
      const text = serialize(data.slice(0, kept));
      return {
        text,
        notice:
          `[Result truncated: returned the first ${kept} of ${data.length} items ` +
          `(${text.length} of ${full.length} characters) because the full result ` +
          `exceeds ${setting}. The text above is valid JSON. ${advice}]`,
      };
    }
  }

  const text = cutText(full, limit);
  return {
    text,
    notice:
      `[Result truncated: returned the first ${text.length} of ${full.length} ` +
      `characters because the full result exceeds ${setting}. The text above is ` +
      `cut off mid-way and is not valid JSON. ${advice}]`,
  };
}
