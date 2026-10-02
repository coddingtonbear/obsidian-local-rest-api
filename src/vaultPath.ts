import { posix } from "path";

/** Thrown when a client-supplied vault path resolves outside the vault root. */
export class PathTraversalError extends Error {}

/** Thrown when a client-supplied path resolves inside Obsidian's configuration
 *  directory and that access has not been explicitly enabled. */
export class ConfigDirAccessError extends Error {}

/** The vault root, as a path the resolver can work with. Nothing is ever read
 *  from or written to this location -- it exists so `posix.resolve` can collapse
 *  "." and ".." segments the way the filesystem would, and the result be
 *  compared against a known prefix. */
const SYNTHETIC_ROOT = "/vault";

/** The message every layer refuses with, so a client sees one wording whether the
 *  refusal came from the REST handler, an MCP tool, or VaultOperations itself. */
export const PATH_ESCAPES_VAULT_MESSAGE =
  "must be relative and must not escape the vault root";

/** The message every layer refuses a configuration-directory path with. */
export const CONFIG_DIR_ACCESS_MESSAGE =
  "is inside the Obsidian configuration directory, which this API is not permitted to access";

/** Whether a vault-relative path stays inside the vault.
 *
 *  Obsidian's Vault API is not a sandbox, and the two halves of it disagree about
 *  what an out-of-vault path means. `getAbstractFileByPath` consults the index of
 *  files Obsidian knows about, so "../secrets.md" simply misses and the caller is
 *  told the file does not exist. `Vault.create`, `Vault.adapter.write`,
 *  `Vault.adapter.writeBinary` and `Vault.adapter.remove` do no such lookup: they
 *  join the path onto the vault directory and hand it to the filesystem, where
 *  ".." means what it always means. A path that reaches one of those from a client
 *  has to be checked first.
 *
 *  Backslashes are folded to "/" before resolving because Obsidian's own
 *  `normalizePath` does the same, and on Windows the adapter would treat "..\\" as
 *  a separator that `posix.resolve` would not. Folding only ever makes a path
 *  *more* likely to be seen as contained -- a file legitimately named "a\\b.md" on
 *  a POSIX system is checked as "a/b.md", which is still inside -- so this cannot
 *  reject anything that was safe.
 *
 *  An absolute path is refused outright rather than resolved, because resolving
 *  one would accept "/vault/notes/a.md" -- a path that is inside the *synthetic*
 *  root by coincidence of spelling and has nothing to do with where the vault
 *  actually lives. A vault-relative path never begins with "/".
 *
 *  A drive-qualified path is refused for the same reason, and needs saying
 *  separately because it does not begin with "/": "C:/outside.md" survives the
 *  backslash fold, looks relative to `posix.resolve`, and lands inside the
 *  synthetic root as "/vault/C:/outside.md". On Windows it is absolute --
 *  `path.win32.resolve` reads it as the root of drive C -- and "C:outside.md"
 *  is drive-relative, which is no better. Neither is a name a vault file can
 *  have anyway, since Windows does not allow ":" in one.
 *
 *  What this does not do is resolve symlinks: a vault-relative path that stays
 *  inside the vault textually can still point outside it through a symlinked
 *  folder. Obsidian's API exposes no real-path primitive to check that with, and
 *  a symlink inside the vault is something the vault's owner put there. */
export function vaultPathIsContained(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  const resolved = posix.resolve(SYNTHETIC_ROOT, normalized);
  return resolved === SYNTHETIC_ROOT || resolved.startsWith(SYNTHETIC_ROOT + "/");
}

/** Throw {@link PathTraversalError} unless the path stays inside the vault.
 *
 *  `label` names the offending field in the message ("Path", "Destination path"),
 *  so a caller passing two paths learns which one was refused. */
export function assertVaultPathIsContained(
  candidate: string,
  label = "Path",
): void {
  if (!vaultPathIsContained(candidate)) {
    throw new PathTraversalError(`${label} ${PATH_ESCAPES_VAULT_MESSAGE}.`);
  }
}

/** Whether a vault-relative path is the configuration directory or lives inside it.
 *
 *  `configDir` is Obsidian's own `app.vault.configDir` -- normally ".obsidian",
 *  but a user may set it to something else, and the running value is the one that
 *  matters. Both the candidate and the config dir are folded and resolved against
 *  the same synthetic root as {@link vaultPathIsContained}, so the comparison is
 *  between canonical paths rather than raw spellings: ".obsidian/../.obsidian" and
 *  ".obsidian" are seen as the same place.
 *
 *  The match is the directory itself or a path beneath it, never a sibling that
 *  merely shares the name as a prefix: ".obsidian-backup" resolves to
 *  "/vault/.obsidian-backup", which is neither equal to nor prefixed by
 *  "/vault/.obsidian/", so it is not treated as config. A candidate that escapes
 *  the vault is not this function's concern -- {@link vaultPathIsContained} rejects
 *  it first -- and such a path simply returns false here. */
export function vaultPathIsInConfigDir(
  candidate: string,
  configDir: string,
): boolean {
  const root = posix.resolve(SYNTHETIC_ROOT, configDir.replace(/\\/g, "/"));
  const resolved = posix.resolve(SYNTHETIC_ROOT, candidate.replace(/\\/g, "/"));
  return resolved === root || resolved.startsWith(root + "/");
}

/** Throw {@link ConfigDirAccessError} when `candidate` is inside the configuration
 *  directory and `allowed` is false. A no-op when access is permitted.
 *
 *  `label` names the offending field in the message, matching
 *  {@link assertVaultPathIsContained}. */
export function assertConfigDirAccessAllowed(
  candidate: string,
  configDir: string,
  allowed: boolean,
  label = "Path",
): void {
  if (!allowed && vaultPathIsInConfigDir(candidate, configDir)) {
    throw new ConfigDirAccessError(`${label} ${CONFIG_DIR_ACCESS_MESSAGE}.`);
  }
}
