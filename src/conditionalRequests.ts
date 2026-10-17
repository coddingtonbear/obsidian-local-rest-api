/**
 * HTTP conditional writes (RFC 9110 §13.1): `If-Match` and `If-None-Match` on the
 * vault's write operations, so a client can say "write this only if the file is
 * still the version I read" or "create this only if nothing is there yet".
 *
 * The entity tag for a file is markdown-patch's `versionOf` over the file's bytes --
 * the same token as the document map's `version` and a PATCH instruction's
 * `ifMatch`, so all three are interchangeable.
 *
 * This module is pure: parsing a header and deciding whether a precondition holds
 * against a file's current state. Reading that state and refusing the write are
 * {@link VaultOperations}'s job, so REST and MCP share one implementation.
 */

import { PreconditionFailedError } from "markdown-patch-2";

/** One entity tag from an `If-Match`/`If-None-Match` list. */
export interface EntityTag {
  /** The tag's value with its quotes (and any `W/` prefix) removed. */
  opaque: string;
  /** A `W/`-prefixed tag. Weak tags never satisfy `If-Match`, which compares strongly. */
  weak: boolean;
}

/** `*` (any current version) or a non-empty list of entity tags. */
export type EntityTagCondition = "*" | EntityTag[];

/** The preconditions a write may carry. Both absent means an unconditional write. */
export interface WritePreconditions {
  /** Proceed only if the file exists (`*`) or is currently at one of these versions. */
  ifMatch?: EntityTagCondition;
  /** Proceed only if the file does not exist (`*`) or is at none of these versions. */
  ifNoneMatch?: EntityTagCondition;
}

/** What a precondition is evaluated against. */
export interface CurrentFileState {
  exists: boolean;
  /** The file's version token; null when nothing exists there or the path is a folder. */
  version: string | null;
}

/**
 * Thrown when a write's precondition does not hold; nothing has been written. This
 * is markdown-patch's own class, re-exported, so a failed header precondition and a
 * failed PATCH instruction `ifMatch` are one error to catch and map to 412.
 */
export { PreconditionFailedError };

/**
 * Format a version token as a strong entity tag for an `ETag` response header.
 */
export function formatEntityTag(version: string): string {
  return `"${version}"`;
}

/** Optional whitespace and list separators, per RFC 9110 §5.6.1. */
function isSeparator(char: string): boolean {
  return char === "," || char === " " || char === "\t";
}

/**
 * Parse an `If-Match`/`If-None-Match` value. Returns null when the value is not a
 * well-formed `*` or entity-tag list, so the caller can refuse the request rather
 * than guess at what it meant.
 *
 * Empty list elements (`"a", , "b"`) are skipped, as RFC 9110 §5.6.1 requires of a
 * recipient. A `W/` prefix must be followed by a quoted tag, and `*` is only valid
 * as the whole value. Bare unquoted tokens are accepted for compatibility with
 * raw-content PATCH, which has always taken the version token unquoted.
 *
 * A single left-to-right scan rather than a regular expression: the value comes
 * straight from a client, and a scan is linear by construction.
 */
export function parseEntityTagCondition(raw: string): EntityTagCondition | null {
  const value = raw.trim();
  if (value === "*") return "*";

  const tags: EntityTag[] = [];
  let i = 0;
  while (i < value.length) {
    if (isSeparator(value[i])) {
      i++;
      continue;
    }

    const weak = value.startsWith("W/", i);
    if (weak) i += 2;

    let opaque: string;
    if (value[i] === '"') {
      const close = value.indexOf('"', i + 1);
      if (close === -1) return null;
      opaque = value.slice(i + 1, close);
      i = close + 1;
    } else {
      if (weak) return null;
      const begin = i;
      while (i < value.length && !isSeparator(value[i]) && value[i] !== '"') i++;
      opaque = value.slice(begin, i);
      // `*` stands alone (RFC 9110 §13.1.1); inside a list it is not a tag.
      if (opaque === "*" || value[i] === '"') return null;
    }

    // A tag must be followed by optional whitespace, then a comma or the end.
    while (value[i] === " " || value[i] === "\t") i++;
    if (i < value.length && value[i] !== ",") return null;

    tags.push({ opaque, weak });
  }
  return tags.length > 0 ? tags : null;
}

/** Whether a preconditions object asks for anything at all. */
export function hasPreconditions(preconditions: WritePreconditions | undefined): boolean {
  return (
    preconditions !== undefined &&
    (preconditions.ifMatch !== undefined || preconditions.ifNoneMatch !== undefined)
  );
}

function describeTags(tags: EntityTag[]): string {
  return tags.map((t) => (t.weak ? `W/"${t.opaque}"` : `"${t.opaque}"`)).join(", ");
}

/**
 * Evaluate `preconditions` against a file's current state, in RFC 9110 §13.2.2
 * order (`If-Match` first, then `If-None-Match`). Returns null when the write may
 * proceed, or a message explaining which precondition failed and why.
 */
export function preconditionFailure(
  current: CurrentFileState,
  preconditions: WritePreconditions,
): string | null {
  const { ifMatch, ifNoneMatch } = preconditions;

  if (ifMatch !== undefined) {
    if (ifMatch === "*") {
      if (!current.exists) {
        return "If-Match: * requires the file to exist, and it does not.";
      }
    } else {
      // Strong comparison: a weak tag never matches, and neither does anything
      // when there is no file (or only a folder) to compare against.
      const matched =
        current.version !== null &&
        ifMatch.some((tag) => !tag.weak && tag.opaque === current.version);
      if (!matched) {
        const named = describeTags(ifMatch);
        if (current.version === null) {
          return current.exists
            ? `If-Match named ${named}, but the path is not a file.`
            : `If-Match named ${named}, but the file does not exist.`;
        }
        const weakNote = ifMatch.some((tag) => tag.weak)
          ? " Weak entity tags never satisfy If-Match; use the strong ETag from a GET of the file, or the document map's version."
          : "";
        return `If-Match named ${named}, but the file is now at version "${current.version}".${weakNote}`;
      }
    }
  }

  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch === "*") {
      if (current.exists) {
        return "If-None-Match: * requires that nothing exist at the path, and something does.";
      }
    } else if (
      // Weak comparison: the W/ prefix is ignored.
      current.version !== null &&
      ifNoneMatch.some((tag) => tag.opaque === current.version)
    ) {
      return `If-None-Match named the file's current version "${current.version}".`;
    }
  }

  return null;
}
