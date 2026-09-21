import { posix } from "path";

/** Thrown when a client-supplied vault path resolves outside the vault root. */
export class PathTraversalError extends Error {}

/** The vault root, as a path the resolver can work with. Nothing is ever read
 *  from or written to this location -- it exists so `posix.resolve` can collapse
 *  "." and ".." segments the way the filesystem would, and the result be
 *  compared against a known prefix. */
const SYNTHETIC_ROOT = "/vault";

/** The message every layer refuses with, so a client sees one wording whether the
 *  refusal came from the REST handler, an MCP tool, or VaultOperations itself. */
export const PATH_ESCAPES_VAULT_MESSAGE =
  "must be relative and must not escape the vault root";

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
 *  What this does not do is resolve symlinks: a vault-relative path that stays
 *  inside the vault textually can still point outside it through a symlinked
 *  folder. Obsidian's API exposes no real-path primitive to check that with, and
 *  a symlink inside the vault is something the vault's owner put there. */
export function vaultPathIsContained(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
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
