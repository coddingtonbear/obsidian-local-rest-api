import { CachedMetadata, HeadingCache } from "obsidian";
import { HeadingBoundary } from "./types";
import path from 'node:path';

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


export async function createDirNotExist(filepath: string) {
  const directory = path.dirname(filepath)
  if (!await this.app.vault.adapter.exists(directory)) await this.app.vault.adapter.mkdir(directory)
}
