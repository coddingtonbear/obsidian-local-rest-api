import fs from "fs";
import path from "path";

const TYPINGS_PATH = path.join(__dirname, "..", "node_modules", "obsidian", "obsidian.d.ts");

/**
 * The event names an Obsidian class declares, read out of the installed typings.
 *
 * Guard tests compare hand-written event lists against this, so that an Obsidian
 * upgrade that adds an event fails a test instead of being silently missed.
 *
 * Only an `on(name: ...)` at the start of a line counts as a declaration. The
 * typings' JSDoc refers to other classes' events in the same form -- 1.14's note
 * on `MetadataCache`'s `changed` event links to `Vault.on(name: 'rename')` -- and
 * counting those would invent events the class does not have. Anchoring skips
 * them, since JSDoc lines start with `*` and line comments with `//`.
 *
 * Comments are deliberately not stripped first: a regex strip would also eat
 * anything after a `/*` or `//` inside a string type (a glob, a URL), and a
 * declaration lost that way is a new event the guard silently misses. Anchoring
 * can only err the other way -- counting a declaration-shaped line inside an
 * unstarred block comment -- which fails the guard loudly.
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
  const body = typings.slice(start, end === -1 ? undefined : end);

  return [...body.matchAll(/^\s*on\(name: '([^']+)'/gm)].map((match) => match[1]).sort();
}
