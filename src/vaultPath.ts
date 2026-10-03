import * as fs from "fs";
import path, { posix } from "path";
import { FileSystemAdapter, type DataAdapter } from "obsidian";

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

/** Canonicalize a resolved path for *name identity*, the way the filesystems
 *  Obsidian runs on actually treat names, so that two spellings the OS would
 *  send to the same directory compare equal here.
 *
 *  Per segment: Unicode NFC (macOS may hand back a decomposed form of a name
 *  stored composed), lower-case (APFS and NTFS are case-insensitive by default,
 *  so ".OBSIDIAN" *is* ".obsidian" there), and trailing dots and spaces stripped
 *  (Win32 removes them from every component, so ".obsidian." opens ".obsidian").
 *
 *  Every step only merges spellings together, never splits them apart, so this
 *  can only make a path *more* likely to be seen as the config dir. On a
 *  case-sensitive Linux vault that means a folder literally named ".Obsidian" is
 *  also refused -- an acceptable false positive for a guard whose failure mode
 *  the other way is code execution, and one the opt-in setting lifts anyway. */
function canonicalNameForm(resolvedPath: string): string {
  return resolvedPath
    .split("/")
    .map((segment) => segment.normalize("NFC").toLowerCase().replace(/[. ]+$/, ""))
    .join("/");
}

/** Whether a vault-relative path is the configuration directory or lives inside it.
 *
 *  `configDir` is Obsidian's own `app.vault.configDir` -- normally ".obsidian",
 *  but a user may set it to something else, and the running value is the one that
 *  matters. Both the candidate and the config dir are folded and resolved against
 *  the same synthetic root as {@link vaultPathIsContained}, so the comparison is
 *  between canonical paths rather than raw spellings: ".obsidian/../.obsidian" and
 *  ".obsidian" are seen as the same place. They are then put through
 *  {@link canonicalNameForm}, because a string comparison that is stricter than
 *  the filesystem's is a bypass: ".OBSIDIAN/plugins/x/main.js" is a different
 *  string but, on macOS or Windows, the same directory.
 *
 *  The match is the directory itself or a path beneath it, never a sibling that
 *  merely shares the name as a prefix: ".obsidian-backup" resolves to
 *  "/vault/.obsidian-backup", which is neither equal to nor prefixed by
 *  "/vault/.obsidian/", so it is not treated as config. A candidate that escapes
 *  the vault is not this function's concern -- {@link vaultPathIsContained} rejects
 *  it first -- and such a path simply returns false here.
 *
 *  Spelling is not the whole story. NTFS generates an 8.3 short name for every
 *  long name on a volume that has them enabled (the default for the system
 *  drive, where most vaults live), and the one for ".obsidian" is predictable:
 *  "OBSIDI~1". A symlink inside the vault goes wherever it points. Neither
 *  spelling contains the config dir's name, so when `onDisk` is given -- see
 *  {@link onDiskAccessFor} -- the candidate is also resolved to where it really
 *  lands on disk and compared against where the config dir really lands. The
 *  textual check stays first because it needs no filesystem and catches the
 *  common case; the on-disk check is what makes the guard match the filesystem
 *  rather than approximate it. */
export function vaultPathIsInConfigDir(
  candidate: string,
  configDir: string,
  onDisk?: OnDiskAccess,
): boolean {
  const root = canonicalNameForm(
    posix.resolve(SYNTHETIC_ROOT, configDir.replace(/\\/g, "/")),
  );
  const resolved = canonicalNameForm(
    posix.resolve(SYNTHETIC_ROOT, candidate.replace(/\\/g, "/")),
  );
  if (resolved === root || resolved.startsWith(root + "/")) return true;
  return onDisk !== undefined && isInConfigDirOnDisk(candidate, configDir, onDisk);
}

/** How the guard asks the filesystem where a vault-relative path really lands.
 *
 *  `basePath` is the vault's absolute location on disk; `realpath` is
 *  `fs.realpathSync.native` or a stand-in, and must throw when the path does not
 *  exist. The *native* variant matters: on Windows it goes through
 *  GetFinalPathNameByHandle, which expands 8.3 short names, where the JavaScript
 *  implementation only follows symlinks. */
export interface OnDiskAccess {
  basePath: string;
  realpath: (absolutePath: string) => string;
}

/** The on-disk access the running adapter affords, or undefined when it affords
 *  none. Only the desktop `FileSystemAdapter` knows where the vault lives; this
 *  plugin is desktop-only, so that is the adapter in practice, and the undefined
 *  branch exists for a test's bare adapter and for safety should that change. */
export function onDiskAccessFor(adapter: DataAdapter): OnDiskAccess | undefined {
  if (!(adapter instanceof FileSystemAdapter)) return undefined;
  return {
    basePath: adapter.getBasePath(),
    realpath: (absolutePath) => fs.realpathSync.native(absolutePath),
  };
}

/** The vault-relative path with "." and ".." collapsed, as a list of segments:
 *  "" for the root. Assumes the candidate is contained -- an escaping path is
 *  {@link vaultPathIsContained}'s business and is refused before this runs. */
function vaultRelativeSegments(candidate: string): string[] {
  const resolved = posix.resolve(SYNTHETIC_ROOT, candidate.replace(/\\/g, "/"));
  const relative = resolved.slice(SYNTHETIC_ROOT.length + 1);
  return relative === "" ? [] : relative.split("/");
}

/** Where a vault-relative path lands on disk, or undefined when the disk cannot
 *  say. The path need not exist: the deepest ancestor that does is resolved and
 *  the remainder joined back on, since a write to "OBSIDI~1/plugins/new/main.js"
 *  lands under the real ".obsidian" even though "new" is not there yet. Nothing
 *  below the vault root is consulted; if the root itself cannot be resolved the
 *  caller falls back to the textual check alone. */
function onDiskLocation(
  segments: string[],
  onDisk: OnDiskAccess,
): string | undefined {
  const pending = [...segments];
  const tail: string[] = [];
  for (;;) {
    const current = path.join(onDisk.basePath, ...pending);
    try {
      return path.join(onDisk.realpath(current), ...tail);
    } catch {
      const last = pending.pop();
      if (last === undefined) return undefined;
      tail.unshift(last);
    }
  }
}

function isInConfigDirOnDisk(
  candidate: string,
  configDir: string,
  onDisk: OnDiskAccess,
): boolean {
  const candidateOnDisk = onDiskLocation(vaultRelativeSegments(candidate), onDisk);
  const configOnDisk = onDiskLocation(vaultRelativeSegments(configDir), onDisk);
  if (candidateOnDisk === undefined || configOnDisk === undefined) return false;
  const resolved = canonicalNameForm(candidateOnDisk.replace(/\\/g, "/"));
  const root = canonicalNameForm(configOnDisk.replace(/\\/g, "/"));
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
  onDisk?: OnDiskAccess,
): void {
  if (!allowed && vaultPathIsInConfigDir(candidate, configDir, onDisk)) {
    throw new ConfigDirAccessError(`${label} ${CONFIG_DIR_ACCESS_MESSAGE}.`);
  }
}
