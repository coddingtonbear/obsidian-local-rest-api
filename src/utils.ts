import { CachedMetadata, HeadingCache } from "obsidian";
import { HeadingBoundary } from "./types";

export function findHeadingBoundary(
  fileCache: CachedMetadata,
  headingPath: string[]
): HeadingBoundary | null {
  const reversedHeadingPath = [...headingPath].reverse();
  const cursorHeadingPath: HeadingCache[] = [];

  for (const [headingIdx, heading] of fileCache.headings.entries()) {
    cursorHeadingPath[heading.level] = heading;
    cursorHeadingPath.splice(heading.level + 1);

    const reversedCurrentCursor = [
      ...cursorHeadingPath.map((h) => h.heading),
    ].reverse();
    let matchesRequestedHeading = true;
    for (const [idx, element] of reversedHeadingPath.entries()) {
      if (reversedCurrentCursor[idx] != element) {
        matchesRequestedHeading = false;
        break;
      }
    }

    if (matchesRequestedHeading) {
      const start = heading.position.end;
      const endHeading = fileCache.headings
        .slice(headingIdx + 1)
        .find((endHeading) => endHeading.level <= heading.level);
      const end = endHeading?.position.start;

      return {
        start,
        end,
      };
    }
  }

  return null;
}

export function getSplicePosition(
  fileLines: string[],
  heading: HeadingBoundary,
  insert: boolean,
  ignoreNewLines: boolean
): number {
  let splicePosition =
    insert === false
      ? heading.end?.line ?? fileLines.length
      : heading.start.line + 1;

  if (!ignoreNewLines || insert) {
    return splicePosition;
  }

  while (fileLines[splicePosition - 1] === "") {
    splicePosition--;
  }
  return splicePosition;
}
