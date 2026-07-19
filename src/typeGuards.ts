import { ContentType, PatchOperation, PatchTargetScope, PatchTargetType } from "markdown-patch";
import type {
  Operation as V2Operation,
  Scope as V2Scope,
  TargetType as V2TargetType,
} from "markdown-patch-2";

export function isPatchOperation(value: unknown): value is PatchOperation {
  return value === "replace" || value === "prepend" || value === "append";
}

export function isPatchTargetType(value: unknown): value is PatchTargetType {
  return (
    value === "heading" || value === "block" || value === "frontmatter"
  );
}

export function isContentType(value: unknown): value is ContentType {
  return (Object.values(ContentType) as unknown[]).includes(value);
}

export function isPatchTargetScope(value: unknown): value is PatchTargetScope {
  return value === "content" || value === "marker" || value === "markerAndContent";
}

// --- markdown-patch 2.0 guards -------------------------------------------
// The 2.0 algebra widens `operation` to include `delete` and `scope` to include
// `parent`, so it needs its own discriminant guards distinct from the 1.x ones.

export function isV2Operation(value: unknown): value is V2Operation {
  return (
    value === "replace" ||
    value === "prepend" ||
    value === "append" ||
    value === "delete"
  );
}

export function isV2TargetType(value: unknown): value is V2TargetType {
  return value === "heading" || value === "block" || value === "frontmatter";
}

export function isV2Scope(value: unknown): value is V2Scope {
  return (
    value === "content" ||
    value === "marker" ||
    value === "markerAndContent" ||
    value === "parent"
  );
}
