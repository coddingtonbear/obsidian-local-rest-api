import { ContentType, PatchOperation, PatchTargetScope, PatchTargetType } from "markdown-patch";

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
