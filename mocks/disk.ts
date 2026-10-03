/** A stand-in for `fs.realpathSync.native` over an imaginary disk.
 *
 *  `aliases` maps an absolute path to where the filesystem would really send it
 *  -- a Windows 8.3 short name ("/vault/OBSIDI~1") or a symlink -- and applies
 *  to anything beneath that path too. `existing` lists the real paths that are
 *  present. Anything else throws ENOENT, the way the real call does, so the
 *  guard's walk up to the deepest existing ancestor is exercised. Backslashes
 *  are folded so the same fixtures hold if the test host joins with "\\". */
export function fakeRealpath(
  aliases: Record<string, string>,
  existing: string[],
): (absolutePath: string) => string {
  const present = new Set(existing);
  return (absolutePath: string): string => {
    let resolved = absolutePath.replace(/\\/g, "/");
    for (const [alias, target] of Object.entries(aliases)) {
      if (resolved === alias) resolved = target;
      else if (resolved.startsWith(alias + "/"))
        resolved = target + resolved.slice(alias.length);
    }
    if (!present.has(resolved)) {
      const error = new Error(`ENOENT: no such file or directory, realpath '${absolutePath}'`);
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    }
    return resolved;
  };
}

/** A stand-in for `fs.readlinkSync` over the same imaginary disk: `links` maps
 *  an absolute path that is a symlink to the target string stored in it, which
 *  may be relative to the link's directory, exactly as readlink reports it.
 *  Anything else is "not a symlink" (undefined), which is also what the guard
 *  makes of a missing entry. A dangling link is one listed here but absent
 *  from `fakeRealpath`'s `existing`, so realpath fails on it the way the real
 *  call does. */
export function fakeReadlink(
  links: Record<string, string>,
): (absolutePath: string) => string | undefined {
  return (absolutePath: string): string | undefined =>
    links[absolutePath.replace(/\\/g, "/")];
}
