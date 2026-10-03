import fs from "fs";
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
 *  Trailing dots and spaces are stripped from every component for the same
 *  reason: Win32 removes them before it looks anything up, so ".. " (dot dot
 *  space), ".. ." and "..." are all ".." there, where `posix.resolve` would
 *  see an ordinary child named ".. ". A component that is nothing but dots and
 *  spaces is read as ".." when it holds two or more dots -- stricter than
 *  Win32 for "...", which it drops, but a vault has no file by that name and
 *  the error is in the safe direction. Stripping only ever moves a component
 *  *toward* ".", "..", or empty, so it cannot make an escaping path look
 *  contained; a file legitimately named "notes." on a POSIX system is checked
 *  as "notes", which is still inside.
 *
 *  An absolute path is refused outright rather than resolved, because resolving
 *  one would accept "/vault/notes/a.md" -- a path that is inside the *synthetic*
 *  root by coincidence of spelling and has nothing to do with where the vault
 *  actually lives. A vault-relative path never begins with "/".
 *
 *  A colon anywhere is refused. As the second character it makes a
 *  drive-qualified path: "C:/outside.md" survives the backslash fold, looks
 *  relative to `posix.resolve`, and lands inside the synthetic root as
 *  "/vault/C:/outside.md", while on Windows it is the root of drive C, and
 *  "C:outside.md" is drive-relative, which is no better. Anywhere else it names
 *  an NTFS alternate data stream -- "note.md:evil" is a second body on the
 *  note that the index never sees, and "OBSIDI~1:x" is a stream on the config
 *  directory. Obsidian refuses to create a file with a colon in its name on
 *  every platform, so the only way one ends up in a vault is from outside
 *  Obsidian on Linux or macOS, where the filesystem allows it. Such a file is
 *  unreachable through this API. That is a deliberate limitation, chosen over
 *  a platform-conditional rule: the guard then behaves the same everywhere,
 *  a vault that syncs between a Linux machine and a Windows one is held to
 *  the same rule on both, and the rare file this refuses is one Obsidian
 *  itself would not have made. A NUL byte is refused for the same reason --
 *  it is not a name, and the filesystem would reject it with an error that is
 *  not "missing".
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
  if (candidate.includes("\0") || candidate.includes(":")) return false;
  const normalized = foldForResolution(candidate);
  if (normalized.startsWith("/")) return false;
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

/** Fold a client-supplied path the way the filesystems Obsidian runs on will
 *  before it is resolved: backslashes become "/", and trailing dots and spaces
 *  come off every component, with a component that was nothing but dots and
 *  spaces read as "." (one dot), ".." (two or more), or dropped (none). See
 *  {@link vaultPathIsContained} for why each step is safe. */
function foldForResolution(candidate: string): string {
  return candidate
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => {
      const stripped = stripTrailingDotsAndSpaces(segment);
      if (stripped !== "") return stripped;
      let dots = 0;
      for (const char of segment) if (char === ".") dots++;
      return dots === 0 ? "" : dots === 1 ? "." : "..";
    })
    .join("/");
}

/** The segment without its trailing dots and spaces. A loop rather than
 *  `/[. ]+$/`: that pattern backtracks from every position in a run of dots
 *  and spaces that is followed by anything else, which is quadratic in a
 *  segment the client sizes, and a path segment is exactly that. */
function stripTrailingDotsAndSpaces(segment: string): string {
  let end = segment.length;
  while (end > 0 && (segment[end - 1] === "." || segment[end - 1] === " ")) end--;
  return segment.slice(0, end);
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
    .map((segment) => stripTrailingDotsAndSpaces(segment.normalize("NFC").toLowerCase()))
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
  if (!configDirIsUsable(configDir)) return true;
  if (isInConfigDirBySpelling(candidate, configDir)) return true;
  if (onDisk === undefined) return false;
  try {
    const configOnDisk = onDiskLocation(vaultRelativeSegments(configDir), onDisk);
    const candidateOnDisk = onDiskLocation(vaultRelativeSegments(candidate), onDisk);
    return sameOrBeneath(candidateOnDisk, configOnDisk);
  } catch (error) {
    if (error instanceof UnfinishedWalkError) return true;
    throw error;
  }
}

/** What a {@link configDirMatcher} remembers about a file between calls: the
 *  readlink answer for its literal path, valid while the caller's fingerprint
 *  of the file (its indexed ctime/mtime/size) is unchanged. */
export type LinkMemo = Map<string, { fingerprint: string; target: string | undefined }>;

/** {@link vaultPathIsInConfigDir} for checking many paths in one pass -- a
 *  search over the whole index -- without paying a full on-disk resolution per
 *  file.
 *
 *  Files in the same directory share its resolution: each candidate's *parent*
 *  is resolved on disk once and memoised, and the file name joined back on, so
 *  a vault of ten thousand notes in a few hundred folders costs a few hundred
 *  realpath calls for the directories. The file itself gets one readlink, not a
 *  realpath, because the index names a file by the *link's* extension: a
 *  "notes/key.md" that is a symlink to data.json is indexed as markdown and
 *  would otherwise be read by a search that refuses the same path directly. A
 *  link's target is then located like any other path. When the caller supplies
 *  a `linkMemo` and a per-file fingerprint, the readlink answer is remembered
 *  across matchers while the fingerprint holds, so a repeat search over an
 *  unchanged vault costs the directory lookups alone.
 *
 *  Make one per operation and let it go: the directory memo does not see a
 *  symlink created after it was built. */
export function configDirMatcher(
  configDir: string,
  onDisk?: OnDiskAccess,
  linkMemo?: LinkMemo,
): (candidate: string, fingerprint?: string) => boolean {
  if (!configDirIsUsable(configDir)) return () => true;
  if (onDisk === undefined) {
    return (candidate) => isInConfigDirBySpelling(candidate, configDir);
  }
  const memoised = memoisingOnDisk(onDisk);
  const located = (segments: string[]): string | undefined | UnfinishedWalkError => {
    try {
      return onDiskLocation(segments, memoised);
    } catch (error) {
      if (error instanceof UnfinishedWalkError) return error;
      throw error;
    }
  };
  const readlinkOf = (literal: string, fingerprint: string | undefined): string | undefined => {
    const remembered = fingerprint === undefined ? undefined : linkMemo?.get(literal);
    if (remembered !== undefined && remembered.fingerprint === fingerprint) {
      return remembered.target;
    }
    let target: string | undefined;
    try {
      target = memoised.readlink(literal);
    } catch (error) {
      if (error instanceof UnfinishedWalkError) throw error;
      throw new UnfinishedWalkError(`readlink failed at ${literal}: ${errorCode(error)}`);
    }
    if (fingerprint !== undefined) linkMemo?.set(literal, { fingerprint, target });
    return target;
  };
  const configOnDisk = located(vaultRelativeSegments(configDir));
  return (candidate, fingerprint) => {
    if (isInConfigDirBySpelling(candidate, configDir)) return true;
    if (configOnDisk instanceof UnfinishedWalkError) return true;
    if (configOnDisk === undefined) return false;
    const segments = vaultRelativeSegments(candidate);
    const name = segments.pop();
    const parentOnDisk = located(segments);
    if (parentOnDisk instanceof UnfinishedWalkError) return true;
    if (parentOnDisk === undefined) return false;
    if (name === undefined) return sameOrBeneath(parentOnDisk, configOnDisk);
    try {
      const literal = path.join(memoised.basePath, ...segments, name);
      const target = readlinkOf(literal, fingerprint);
      const candidateOnDisk =
        target === undefined
          ? path.join(parentOnDisk, name)
          : locateAbsolute(path.resolve(path.dirname(literal), target), memoised);
      return sameOrBeneath(candidateOnDisk, configOnDisk);
    } catch (error) {
      if (error instanceof UnfinishedWalkError) return true;
      throw error;
    }
  };
}

/** Whether the running config dir is something the guard can protect: a
 *  folder name inside the vault. Obsidian only ever supplies that, but if
 *  anything else arrived -- "..", an absolute path, the vault root itself --
 *  the guard could not tell what it was protecting, and the one safe answer is
 *  to treat every path as off-limits until it can. */
function configDirIsUsable(configDir: string): boolean {
  return vaultPathIsContained(configDir) && vaultRelativeSegments(configDir).length > 0;
}

function isInConfigDirBySpelling(candidate: string, configDir: string): boolean {
  const root = canonicalNameForm(
    posix.resolve(SYNTHETIC_ROOT, foldForResolution(configDir)),
  );
  const resolved = canonicalNameForm(
    posix.resolve(SYNTHETIC_ROOT, foldForResolution(candidate)),
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
  const answers = new Map<string, string | Error>();
  return {
    basePath: onDisk.basePath,
    readlink: onDisk.readlink,
    realpath: (absolutePath) => {
      const remembered = answers.get(absolutePath);
      if (remembered !== undefined) {
        if (remembered instanceof Error) throw remembered;
        return remembered;
      }
      try {
        const answer = onDisk.realpath(absolutePath);
        answers.set(absolutePath, answer);
        return answer;
      } catch (error) {
        // The error itself is remembered, code and all, so a later caller
        // classifies the failure exactly as the first one did.
        const failure = error instanceof Error ? error : new Error(String(error));
        answers.set(absolutePath, failure);
        throw failure;
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
  /** The target stored in the symlink at `absolutePath`, as readlink reports
   *  it (possibly relative to the link's own directory), or undefined when the
   *  path is not a symlink or is not there. */
  readlink: (absolutePath: string) => string | undefined;
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
    readlink: (absolutePath) => {
      try {
        return fs.readlinkSync(absolutePath);
      } catch (error) {
        // EINVAL: not a link. ENOENT/ENOTDIR: not there. Both mean "nothing to
        // follow". Anything else means the disk did not answer, and the walk
        // must not read that as "nothing there".
        if (isNothingToFollow(error)) return undefined;
        throw new UnfinishedWalkError(`readlink failed at ${absolutePath}: ${errorCode(error)}`);
      }
    },
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

/** Whether a failed realpath or readlink means the path is simply not there
 *  (or ends in a file where a directory was expected), as opposed to the disk
 *  declining to say. Only the first is a "miss" the walk may build on. */
function isNothingToFollow(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR" || code === "EINVAL";
}

/** The vault-relative path with "." and ".." collapsed, as a list of segments:
 *  "" for the root. Assumes the candidate is contained -- an escaping path is
 *  {@link vaultPathIsContained}'s business and is refused before this runs. */
function vaultRelativeSegments(candidate: string): string[] {
  const resolved = posix.resolve(SYNTHETIC_ROOT, foldForResolution(candidate));
  const relative = resolved.slice(SYNTHETIC_ROOT.length + 1);
  return relative === "" ? [] : relative.split("/");
}

/** Where a vault-relative path lands on disk, or undefined when the disk cannot
 *  say. See {@link locate} for the rules; this fixes the start at the vault. */
function onDiskLocation(
  segments: string[],
  onDisk: OnDiskAccess,
): string | undefined {
  return locate(onDisk.basePath, segments, onDisk, 0);
}

/** {@link locate} for an absolute path, split into its root and components. */
function locateAbsolute(
  absolute: string,
  onDisk: OnDiskAccess,
  hops = 0,
): string | undefined {
  const root = path.parse(absolute).root;
  const segments = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((segment) => segment !== "");
  return locate(root, segments, onDisk, hops);
}

/** How many symlinks a single path may pass through before the walk gives up.
 *  Linux refuses a path with more than 40 (ELOOP), so on the platform where a
 *  chain this long could even resolve, the guard and the kernel agree. Nothing
 *  a vault owner meant to work comes near it. */
export const MAX_LINK_HOPS = 40;

/** Thrown when the walk could not finish: it passed {@link MAX_LINK_HOPS}
 *  links without reaching the end of the path, or the disk answered a realpath
 *  or readlink with something other than "not there" -- EACCES, EIO, ELOOP.
 *  Either way the disk could not say where the path lands, and "not the config
 *  dir" would be a guess a write could prove wrong, so callers treat it as a
 *  refusal. Distinct from the undefined a caller gets when the vault root is
 *  simply not there: that is the environment failing, not a property of the
 *  path, and there the textual check is all there is. */
class UnfinishedWalkError extends Error {}

/** Where `root/…segments` lands on disk, or undefined when the disk cannot say.
 *
 *  The path need not exist: a write to "OBSIDI~1/plugins/new/main.js" lands
 *  under the real ".obsidian" even though "new" is not there yet, so the
 *  deepest ancestor that does exist is resolved and the remainder joined on.
 *
 *  The whole path is tried first, so an existing path costs one call. A missing
 *  one is then walked from the root *down*, stopping at the first component
 *  that is not there: the work is bounded by how deep the disk really is, not
 *  by how many components a request names, which is what keeps a long bogus
 *  path from turning synchronous realpath calls into a stall.
 *
 *  A component realpath cannot resolve is not necessarily missing: it may be a
 *  symlink whose *target* is missing, and a write through such a link creates
 *  the target. "notes/upload.bin" linking to a not-yet-existing
 *  ".obsidian/plugins/demo/main.js" is a plugin install. So the component is
 *  asked whether it is a link, and if so its target -- resolved against the
 *  link's directory, as the OS would -- is located the same way, with the
 *  remainder joined on. A chain of links is followed up to
 *  {@link MAX_LINK_HOPS}; past that the walk throws {@link UnfinishedWalkError}
 *  rather than guess. If the root itself cannot be resolved the answer is
 *  undefined and the caller falls back to the textual check. */
function locate(
  root: string,
  segments: string[],
  onDisk: OnDiskAccess,
  hops: number,
): string | undefined {
  const attempt = (prefix: string[]): string | undefined => {
    const where = path.join(root, ...prefix);
    try {
      return onDisk.realpath(where);
    } catch (error) {
      // Only "not there" is a miss. EACCES, EIO, ELOOP or anything else means
      // the disk did not say, and an existing component read as missing would
      // let the fallback below invent a harmless-looking location for a path
      // the adapter may still traverse.
      if (isNothingToFollow(error)) return undefined;
      throw new UnfinishedWalkError(`realpath failed at ${where}: ${errorCode(error)}`);
    }
  };
  const whole = attempt(segments);
  if (whole !== undefined) return whole;
  let resolved = attempt([]);
  if (resolved === undefined) return undefined;
  for (let depth = 1; depth <= segments.length; depth++) {
    const next = attempt(segments.slice(0, depth));
    if (next !== undefined) {
      resolved = next;
      continue;
    }
    const here = path.join(root, ...segments.slice(0, depth));
    const remainder = segments.slice(depth);
    let linkTarget: string | undefined;
    try {
      linkTarget = onDisk.readlink(here);
    } catch (error) {
      if (error instanceof UnfinishedWalkError) throw error;
      throw new UnfinishedWalkError(`readlink failed at ${here}: ${errorCode(error)}`);
    }
    if (linkTarget === undefined) {
      return path.join(resolved, segments[depth - 1], ...remainder);
    }
    if (hops >= MAX_LINK_HOPS) {
      throw new UnfinishedWalkError(`More than ${MAX_LINK_HOPS} links at ${here}`);
    }
    const target = path.resolve(path.dirname(here), linkTarget);
    const landed = locateAbsolute(target, onDisk, hops + 1);
    return landed === undefined ? undefined : path.join(landed, ...remainder);
  }
  return resolved;
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
