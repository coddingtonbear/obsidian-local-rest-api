import fs from "fs";
import path from "path";

const TYPINGS_PATH = path.join(__dirname, "..", "node_modules", "obsidian", "obsidian.d.ts");

/**
 * The event names an Obsidian class declares, read out of the installed typings.
 *
 * Guard tests compare hand-written event lists against this, so that an Obsidian
 * upgrade that adds an event fails a test instead of being silently missed.
 *
 * Comments are stripped before matching: the typings' JSDoc refers to other
 * classes' events in the same `on(name: '...')` form a declaration uses -- 1.14's
 * note on `MetadataCache`'s `changed` event links to `Vault.on(name: 'rename')` --
 * and counting those would invent events the class does not have. Only an
 * `on(name: ...)` at the start of a line is a declaration.
 */
export function declaredEvents(
  className: string,
  typings: string = fs.readFileSync(TYPINGS_PATH, "utf-8"),
): string[] {
  const start = typings.indexOf(`export class ${className} extends Events {`);
  if (start === -1) {
    throw new Error(`obsidian.d.ts declares no class ${className} extending Events`);
  }
  const end = typings.indexOf("\nexport ", start + 1);
  const body = typings
    .slice(start, end === -1 ? undefined : end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  return [...body.matchAll(/^\s*on\(name: '([^']+)'/gm)].map((match) => match[1]).sort();
}
