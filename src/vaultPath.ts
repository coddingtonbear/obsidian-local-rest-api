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
 *  A path with more than {@link MAX_VAULT_PATH_SEGMENTS} components is refused
 *  too: no vault has one, and the cap keeps per-segment work bounded.
 *
 *  What this does not do is resolve symlinks: a vault-relative path that stays
 *  inside the vault textually can still point outside it through a symlinked
 *  folder. The config-dir check below does consult the disk, but containment
 *  does not: a symlink inside the vault that leads out of it is something the
 *  vault's owner put there. */
export function vaultPathIsContained(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  const resolved = posix.resolve(SYNTHETIC_ROOT, normalized);
  if (resolved !== SYNTHETIC_ROOT && !resolved.startsWith(SYNTHETIC_ROOT + "/")) {
    return false;
  }
  return resolved.split("/").length - 2 <= MAX_VAULT_PATH_SEGMENTS;
}

/** The most path components a vault path may have once "." and ".." are
 *  collapsed. No real vault comes near it -- Windows' MAX_PATH is 260
 *  *characters* -- and the cap means every per-segment piece of work below,
 *  and anything a caller does per segment, is bounded by a constant rather
 *  than by how long a request a client cares to send. An over-long path is
 *  simply not a vault path, so it is refused as uncontained. */
export const MAX_VAULT_PATH_SEGMENTS = 256;

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
  if (isInConfigDirBySpelling(candidate, configDir)) return true;
  if (onDisk === undefined) return false;
  const configOnDisk = onDiskLocation(vaultRelativeSegments(configDir), onDisk);
  const candidateOnDisk = onDiskLocation(vaultRelativeSegments(candidate), onDisk);
  return sameOrBeneath(candidateOnDisk, configOnDisk);
}

/** {@link vaultPathIsInConfigDir} for checking many paths in one pass -- a
 *  search over the whole index -- without paying one on-disk lookup per file.
 *
 *  Files in the same directory share its resolution: each candidate's *parent*
 *  is resolved on disk, memoised, and the file name joined back on, so a vault
 *  of ten thousand notes in a few hundred folders costs a few hundred realpath
 *  calls, not ten thousand. The trade is that a symlink that *is* the file --
 *  "notes/readme.md" linking to a markdown file inside the config dir -- is not
 *  followed here, where it would be by the single-path check; a per-file
 *  lstat would cost what this exists to avoid, and a config-dir *markdown*
 *  file the owner has linked into the vault by name is well short of the
 *  plugin code and data.json the guard is for.
 *
 *  Make one per operation and let it go: the memo does not see a symlink
 *  created after it was built. */
export function configDirMatcher(
  configDir: string,
  onDisk?: OnDiskAccess,
): (candidate: string) => boolean {
  if (onDisk === undefined) {
    return (candidate) => isInConfigDirBySpelling(candidate, configDir);
  }
  const memoised = memoisingOnDisk(onDisk);
  const configOnDisk = onDiskLocation(vaultRelativeSegments(configDir), memoised);
  return (candidate) => {
    if (isInConfigDirBySpelling(candidate, configDir)) return true;
    if (configOnDisk === undefined) return false;
    const segments = vaultRelativeSegments(candidate);
    const name = segments.pop();
    const parentOnDisk = onDiskLocation(segments, memoised);
    if (parentOnDisk === undefined) return false;
    const candidateOnDisk =
      name === undefined ? parentOnDisk : path.join(parentOnDisk, name);
    return sameOrBeneath(candidateOnDisk, configOnDisk);
  };
}

function isInConfigDirBySpelling(candidate: string, configDir: string): boolean {
  const root = canonicalNameForm(
    posix.resolve(SYNTHETIC_ROOT, configDir.replace(/\\/g, "/")),
  );
  const resolved = canonicalNameForm(
    posix.resolve(SYNTHETIC_ROOT, candidate.replace(/\\/g, "/")),
  );
  return resolved === root || resolved.startsWith(root + "/");
}

/** Whether one on-disk location is the other or beneath it, compared in
 *  canonical name form. Undefined -- the disk could not say -- never matches. */
function sameOrBeneath(
  candidateOnDisk: string | undefined,
  rootOnDisk: string | undefined,
): boolean {
  if (candidateOnDisk === undefined || rootOnDisk === undefined) return false;
  const resolved = canonicalNameForm(candidateOnDisk.replace(/\\/g, "/"));
  const root = canonicalNameForm(rootOnDisk.replace(/\\/g, "/"));
  return resolved === root || resolved.startsWith(root + "/");
}

/** An {@link OnDiskAccess} that remembers every answer, misses included, for
 *  as long as it lives. */
function memoisingOnDisk(onDisk: OnDiskAccess): OnDiskAccess {
  const answers = new Map<string, string | undefined>();
  return {
    basePath: onDisk.basePath,
    realpath: (absolutePath) => {
      if (answers.has(absolutePath)) {
        const answer = answers.get(absolutePath);
        if (answer === undefined) throw new Error(`ENOENT: ${absolutePath}`);
        return answer;
      }
      try {
        const answer = onDisk.realpath(absolutePath);
        answers.set(absolutePath, answer);
        return answer;
      } catch (error) {
        answers.set(absolutePath, undefined);
        throw error;
      }
    },
  };
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
 *  lands under the real ".obsidian" even though "new" is not there yet.
 *
 *  The whole path is tried first, so an existing path costs one call. A missing
 *  one is then walked from the vault root *down*, stopping at the first
 *  component that is not there: the work is bounded by how deep the vault
 *  really is, not by how many components a request names, which is what keeps
 *  a long bogus path from turning synchronous realpath calls into a stall.
 *  Nothing above the vault root is consulted; if the root itself cannot be
 *  resolved the caller falls back to the textual check alone. */
function onDiskLocation(
  segments: string[],
  onDisk: OnDiskAccess,
): string | undefined {
  const attempt = (prefix: string[]): string | undefined => {
    try {
      return onDisk.realpath(path.join(onDisk.basePath, ...prefix));
    } catch {
      return undefined;
    }
  };
  const whole = attempt(segments);
  if (whole !== undefined) return whole;
  let resolved = attempt([]);
  if (resolved === undefined) return undefined;
  for (let depth = 1; depth < segments.length; depth++) {
    const next = attempt(segments.slice(0, depth));
    if (next === undefined) {
      return path.join(resolved, ...segments.slice(depth - 1));
    }
    resolved = next;
  }
  return path.join(resolved, ...segments.slice(-1));
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
