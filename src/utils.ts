import { CachedMetadata, HeadingCache } from "obsidian";
import { HeadingBoundary } from "./types";

export function findHeadingBoundary(fileCache: CachedMetadata, headingPath: string[]): HeadingBoundary | null {
  const reversedHeadingPath = [...headingPath].reverse()
  const cursorHeadingPath: HeadingCache[] = []

  for(const [headingIdx, heading] of fileCache.headings.entries()) {
    console.log("Testing heading", heading)
    cursorHeadingPath[heading.level] = heading
    cursorHeadingPath.splice(heading.level + 1)

    const reversedCurrentCursor = [...cursorHeadingPath.map((h) => h.heading)].reverse()
    let matchesRequestedHeading = true
    for(const [idx, element] of reversedHeadingPath.entries()) {
      console.log(reversedCurrentCursor[idx], element)
      if (reversedCurrentCursor[idx] != element) {
        matchesRequestedHeading = false
        break
      }
    }

    if(matchesRequestedHeading) {
      const start = heading.position.end
      const end = fileCache.headings[headingIdx + 1]?.position.start

      return {
        start, end
      }
    }
  }

  return null
}
