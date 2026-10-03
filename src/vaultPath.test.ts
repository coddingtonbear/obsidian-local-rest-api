import fs from "fs";
import { DataAdapter, FileSystemAdapter } from "../mocks/obsidian";
import { fakeReadlink, fakeRealpath } from "../mocks/disk";
import {
  PathTraversalError,
  ConfigDirAccessError,
  assertVaultPathIsContained,
  assertConfigDirAccessAllowed,
  configDirMatcher,
  MAX_LINK_HOPS,
  MAX_VAULT_PATH_SEGMENTS,
  onDiskAccessFor,
  vaultPathIsContained,
  vaultPathIsInConfigDir,
  type OnDiskAccess,
} from "./vaultPath";

describe("vaultPathIsContained", () => {
  const contained = [
    ["the vault root", ""],
    ["a dot", "."],
    ["a top-level file", "note.md"],
    ["a nested file", "folder/sub/note.md"],
    ["an explicit ./ prefix", "./note.md"],
    ["a trailing slash", "folder/"],
    ["'..' as a filename substring", "folder/notes..md"],
    ["a filename ending in '..'", "folder/notes.."],
    ["a descent that comes back but stays inside", "folder/../other/note.md"],
    ["a backslash in a filename", "folder/a\\b.md"],
    ["a name that merely starts with '..'", "..hidden.md"],
    ["a colon below the top level", "notes/C:not-a-drive.md"],
    ["a colon that is not a drive letter", "CC:notes.md"],
    // Stripping trailing dots and spaces only ever moves a component toward
    // "..": a name that merely ends in them stays an ordinary name.
    ["a name with a trailing space", "notes /a.md"],
    ["a name with a trailing dot and space", "notes. /a.md"],
    ["a single dot with a trailing space", ". /a.md"],
    ["a '..' with a trailing space that comes back but stays inside", "notes/.. /a.md"],
  ] as const;

  const escaping = [
    ["a single level up", "../note.md"],
    ["two levels up", "../../Ausserhalb.md"],
    ["many levels up", "../../../../some/other/writable/path/file.md"],
    ["a traversal after a descent", "notes/../../outside.md"],
    ["a bare '..'", ".."],
    ["an absolute path", "/etc/passwd"],
    ["an absolute path that mimics the synthetic root", "/vault/notes/a.md"],
    ["a windows-style traversal", "..\\..\\outside.md"],
    ["a mixed-separator traversal", "notes\\../../outside.md"],
    ["a UNC-style absolute path", "\\\\server\\share\\file.md"],
    // Win32 strips trailing dots and spaces from every path component before
    // it looks anything up, so each of these is ".." there.
    ["a '..' with a trailing space", ".. /outside.md"],
    ["a '..' with trailing spaces", "..  /outside.md"],
    ["a '..' with a trailing space and dot", ".. ./outside.md"],
    ["a '..' with a trailing dot", "../outside.md".replace("..", "...")],
    ["nested '..'s with trailing spaces", "notes/.. /.. /outside.md"],
    ["'..'s with trailing spaces and backslashes", "notes\\.. \\.. \\outside.md"],
    ["a drive-qualified path", "C:/outside.md"],
    ["a drive-qualified path with backslashes", "C:\\outside.md"],
    ["a lowercase drive letter", "c:/outside.md"],
    ["a drive-relative path", "C:outside.md"],
  ] as const;

  for (const [label, candidate] of contained) {
    test(`accepts ${label}`, () => {
      expect(vaultPathIsContained(candidate)).toBe(true);
    });
  }

  for (const [label, candidate] of escaping) {
    test(`rejects ${label}`, () => {
      expect(vaultPathIsContained(candidate)).toBe(false);
    });
  }
});

describe("assertVaultPathIsContained", () => {
  test("returns quietly for a contained path", () => {
    expect(() => assertVaultPathIsContained("folder/note.md")).not.toThrow();
  });

  test("throws PathTraversalError for an escaping path", () => {
    expect(() => assertVaultPathIsContained("../outside.md")).toThrow(
      PathTraversalError,
    );
  });

  test("names the field so a caller passing two paths knows which was refused", () => {
    expect(() =>
      assertVaultPathIsContained("../outside.md", "Destination path"),
    ).toThrow(
      "Destination path must be relative and must not escape the vault root.",
    );
  });

  test("defaults the label to 'Path'", () => {
    expect(() => assertVaultPathIsContained("../outside.md")).toThrow(
      "Path must be relative and must not escape the vault root.",
    );
  });
});

describe("vaultPathIsInConfigDir", () => {
  const configDir = ".obsidian";

  const inside = [
    ["the config dir itself", ".obsidian"],
    ["the config dir with a trailing slash", ".obsidian/"],
    ["a file directly inside", ".obsidian/app.json"],
    ["a plugin file", ".obsidian/plugins/foo/main.js"],
    ["community-plugins.json", ".obsidian/community-plugins.json"],
    ["a ./ prefix", "./.obsidian/app.json"],
    ["a descent that resolves back in", ".obsidian/../.obsidian/app.json"],
    ["a backslash separator", ".obsidian\\plugins\\foo\\main.js"],
    // Case-insensitive filesystems (macOS APFS by default, Windows NTFS) resolve
    // these to the real config dir, so the guard must too.
    ["an upper-cased spelling", ".OBSIDIAN/plugins/foo/main.js"],
    ["a mixed-case spelling", ".Obsidian/plugins/foo/main.js"],
    // Windows strips trailing dots and spaces from each path component.
    ["a trailing dot on the config segment", ".obsidian./plugins/foo/main.js"],
    ["a trailing space on the config segment", ".obsidian /plugins/foo/main.js"],
    ["several trailing dots and spaces", ".obsidian. . /plugins/foo/main.js"],
  ] as const;

  const outside = [
    ["a sibling sharing the prefix", ".obsidian-backup/note.md"],
    ["a sibling file sharing the prefix", ".obsidianrc"],
    ["an ordinary note", "notes/a.md"],
    ["the vault root", ""],
    ["a differently named config subpath", "obsidian/app.json"],
  ] as const;

  for (const [label, candidate] of inside) {
    test(`matches ${label}`, () => {
      expect(vaultPathIsInConfigDir(candidate, configDir)).toBe(true);
    });
  }

  for (const [label, candidate] of outside) {
    test(`does not match ${label}`, () => {
      expect(vaultPathIsInConfigDir(candidate, configDir)).toBe(false);
    });
  }

  test("honors a non-default config directory", () => {
    expect(vaultPathIsInConfigDir(".config-obsidian/app.json", ".config-obsidian")).toBe(true);
    expect(vaultPathIsInConfigDir(".obsidian/app.json", ".config-obsidian")).toBe(false);
  });

  test("a non-ASCII config dir matches across Unicode normalization forms", () => {
    // macOS may hand back a decomposed (NFD) spelling of a name stored composed (NFC).
    const nfc = "éconfig"; // "éconfig", precomposed
    const nfd = "éconfig"; // "éconfig", decomposed
    expect(vaultPathIsInConfigDir(`${nfd}/app.json`, nfc)).toBe(true);
  });

  test("still does not match a sibling once case and trailing-dot folding apply", () => {
    expect(vaultPathIsInConfigDir(".OBSIDIAN-backup/note.md", ".obsidian")).toBe(false);
    expect(vaultPathIsInConfigDir(".obsidian.bak/note.md", ".obsidian")).toBe(false);
  });
});

describe("assertConfigDirAccessAllowed", () => {
  const configDir = ".obsidian";

  test("throws ConfigDirAccessError for a config path when not allowed", () => {
    expect(() =>
      assertConfigDirAccessAllowed(".obsidian/app.json", configDir, false),
    ).toThrow(ConfigDirAccessError);
  });

  test("is a no-op for a config path when allowed", () => {
    expect(() =>
      assertConfigDirAccessAllowed(".obsidian/app.json", configDir, true),
    ).not.toThrow();
  });

  test("is a no-op for a non-config path", () => {
    expect(() =>
      assertConfigDirAccessAllowed("notes/a.md", configDir, false),
    ).not.toThrow();
  });

  test("names the field in the message", () => {
    expect(() =>
      assertConfigDirAccessAllowed(".obsidian/x", configDir, false, "Destination path"),
    ).toThrow(/^Destination path is inside the Obsidian configuration directory/);
  });
});

describe("vaultPathIsInConfigDir with on-disk resolution", () => {
  // The textual check above cannot see spellings only the filesystem resolves:
  // NTFS hands out an 8.3 short name for every long name on a volume that has
  // them enabled (".obsidian" becomes "OBSIDI~1", predictably), and a symlink
  // goes wherever its target does. With a way to ask the disk where a path
  // really lands, the guard compares real locations instead.
  const configDir = ".obsidian";

  function disk(
    aliases: Record<string, string>,
    existing: string[],
  ): OnDiskAccess {
    return {
      basePath: "/vault",
      realpath: fakeRealpath(aliases, existing),
      readlink: fakeReadlink({}),
    };
  }

  const vaultWithConfig = ["/vault", "/vault/.obsidian", "/vault/.obsidian/plugins"];

  test("matches a Windows 8.3 short name for the config dir", () => {
    const access = disk({ "/vault/OBSIDI~1": "/vault/.obsidian" }, vaultWithConfig);
    expect(vaultPathIsInConfigDir("OBSIDI~1/plugins/foo/main.js", configDir, access)).toBe(true);
    expect(vaultPathIsInConfigDir("OBSIDI~1", configDir, access)).toBe(true);
  });

  test("matches a short name whose tail does not exist yet", () => {
    // The plugin folder the attacker wants to create is not on disk; the alias
    // above it is, and that is enough to know where the write would land.
    const access = disk({ "/vault/OBSIDI~1": "/vault/.obsidian" }, vaultWithConfig);
    expect(vaultPathIsInConfigDir("OBSIDI~1/plugins/new/main.js", configDir, access)).toBe(true);
  });

  test("matches a symlink inside the vault that points at the config dir", () => {
    const access = disk(
      { "/vault/notes/cfg": "/vault/.obsidian" },
      [...vaultWithConfig, "/vault/notes"],
    );
    expect(vaultPathIsInConfigDir("notes/cfg/app.json", configDir, access)).toBe(true);
  });

  test("follows the config dir itself when it is a symlink", () => {
    // A config dir shared between vaults via symlink: a second link to the same
    // target is still the config dir.
    const access = disk(
      {
        "/vault/.obsidian": "/home/u/shared-config",
        "/vault/shortcut": "/home/u/shared-config",
      },
      ["/vault", "/home/u/shared-config"],
    );
    expect(vaultPathIsInConfigDir("shortcut/app.json", configDir, access)).toBe(true);
  });

  test("does not match an ordinary existing note", () => {
    const access = disk({}, [...vaultWithConfig, "/vault/notes", "/vault/notes/a.md"]);
    expect(vaultPathIsInConfigDir("notes/a.md", configDir, access)).toBe(false);
  });

  test("does not match a path that does not exist yet", () => {
    const access = disk({}, vaultWithConfig);
    expect(vaultPathIsInConfigDir("new/deep/note.md", configDir, access)).toBe(false);
  });

  test("does not match a short name for a sibling that shares the prefix", () => {
    const access = disk(
      { "/vault/OBSIDI~2": "/vault/.obsidian-backup" },
      [...vaultWithConfig, "/vault/.obsidian-backup"],
    );
    expect(vaultPathIsInConfigDir("OBSIDI~2/note.md", configDir, access)).toBe(false);
  });

  test("does not match the vault root", () => {
    const access = disk({}, vaultWithConfig);
    expect(vaultPathIsInConfigDir("", configDir, access)).toBe(false);
  });

  test("still matches textually when the disk cannot be consulted", () => {
    const unusable = disk({}, []);
    expect(vaultPathIsInConfigDir(".obsidian/app.json", configDir, unusable)).toBe(true);
    expect(vaultPathIsInConfigDir("notes/a.md", configDir, unusable)).toBe(false);
  });

  test("compares on-disk locations by canonical name form", () => {
    // realpath on a case-insensitive volume may report the on-disk casing; two
    // spellings of the same directory must still compare equal.
    const access = disk(
      { "/vault/OBSIDI~1": "/vault/.Obsidian" },
      ["/vault", "/vault/.Obsidian", "/vault/.obsidian"],
    );
    expect(vaultPathIsInConfigDir("OBSIDI~1/app.json", configDir, access)).toBe(true);
  });
});

describe("assertConfigDirAccessAllowed with on-disk resolution", () => {
  const access: OnDiskAccess = {
    basePath: "/vault",
    realpath: fakeRealpath({ "/vault/OBSIDI~1": "/vault/.obsidian" }, [
      "/vault",
      "/vault/.obsidian",
    ]),
    readlink: fakeReadlink({}),
  };

  test("throws ConfigDirAccessError for an aliased config path when not allowed", () => {
    expect(() =>
      assertConfigDirAccessAllowed("OBSIDI~1/app.json", ".obsidian", false, "Path", access),
    ).toThrow(ConfigDirAccessError);
  });

  test("is a no-op for an aliased config path when allowed", () => {
    expect(() =>
      assertConfigDirAccessAllowed("OBSIDI~1/app.json", ".obsidian", true, "Path", access),
    ).not.toThrow();
  });
});

describe("onDiskAccessFor", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("reads the vault's base path from a FileSystemAdapter and resolves through fs", () => {
    const realpath = jest
      .spyOn(fs.realpathSync, "native")
      .mockImplementation(fakeRealpath({}, ["/disk/vault"]));
    const readlink = jest
      .spyOn(fs, "readlinkSync")
      .mockImplementation((p) => {
        if (p === "/disk/vault/link") return "target";
        throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      });
    const access = onDiskAccessFor(new FileSystemAdapter("/disk/vault"));
    expect(access?.basePath).toBe("/disk/vault");
    expect(access?.realpath("/disk/vault")).toBe("/disk/vault");
    expect(realpath).toHaveBeenCalledWith("/disk/vault");
    expect(access?.readlink("/disk/vault/link")).toBe("target");
    expect(access?.readlink("/disk/vault/plain")).toBeUndefined();
    expect(readlink).toHaveBeenCalledWith("/disk/vault/plain");
  });

  test("is undefined for an adapter with no base path", () => {
    expect(onDiskAccessFor(new DataAdapter())).toBeUndefined();
  });
});

describe("vaultPathIsContained bounds path depth", () => {
  test("a path at the segment limit is contained", () => {
    const atLimit = Array(MAX_VAULT_PATH_SEGMENTS).fill("d").join("/");
    expect(vaultPathIsContained(atLimit)).toBe(true);
  });

  test("a path over the segment limit is not", () => {
    const overLimit = Array(MAX_VAULT_PATH_SEGMENTS + 1).fill("d").join("/");
    expect(vaultPathIsContained(overLimit)).toBe(false);
    expect(() => assertVaultPathIsContained(overLimit)).toThrow(PathTraversalError);
  });

  test("empty segments do not count toward the limit", () => {
    // "a//b" and "a/./b" both resolve to two segments.
    const padded = Array(MAX_VAULT_PATH_SEGMENTS).fill("d").join("//") + "/./";
    expect(vaultPathIsContained(padded)).toBe(true);
  });
});

describe("the on-disk walk is bounded by what exists, not by the request", () => {
  // A request can name thousands of components that are not there. Resolving
  // from the top and stopping at the first missing one keeps the work
  // proportional to the on-disk depth, so a long bogus path cannot stall
  // Obsidian with one synchronous realpath per component.
  test("a deep missing path costs a handful of realpath calls", () => {
    const realpath = jest.fn(fakeRealpath({}, ["/vault", "/vault/notes"]));
    const access: OnDiskAccess = { basePath: "/vault", realpath, readlink: fakeReadlink({}) };
    const deep = "notes/" + Array(200).fill("missing").join("/");
    expect(vaultPathIsInConfigDir(deep, ".obsidian", access)).toBe(false);
    expect(realpath.mock.calls.length).toBeLessThan(10);
  });

  test("an existing path still resolves in one call", () => {
    const realpath = jest.fn(
      fakeRealpath({}, ["/vault", "/vault/notes", "/vault/notes/a.md", "/vault/.obsidian"]),
    );
    const access: OnDiskAccess = { basePath: "/vault", realpath, readlink: fakeReadlink({}) };
    expect(vaultPathIsInConfigDir("notes/a.md", ".obsidian", access)).toBe(false);
    // Candidate once, config dir once.
    expect(realpath).toHaveBeenCalledTimes(2);
  });
});

describe("configDirMatcher", () => {
  // Built once per bulk operation -- a search over the whole index -- so that
  // files sharing a directory share one on-disk lookup.
  const configDir = ".obsidian";

  test("matches by spelling without on-disk access", () => {
    const matches = configDirMatcher(configDir);
    expect(matches(".obsidian/app.json")).toBe(true);
    expect(matches("notes/a.md")).toBe(false);
  });

  test("matches a file reached through a symlinked directory", () => {
    const matches = configDirMatcher(configDir, {
      basePath: "/vault",
      realpath: fakeRealpath({ "/vault/notes/cfg": "/vault/.obsidian" }, [
        "/vault",
        "/vault/.obsidian",
        "/vault/notes",
      ]),
      readlink: fakeReadlink({}),
    });
    expect(matches("notes/cfg/README.md")).toBe(true);
    expect(matches("notes/cfg/plugins/x/README.md")).toBe(true);
    expect(matches("notes/a.md")).toBe(false);
    expect(matches("")).toBe(false);
  });

  test("resolves each directory on disk once, however many files it holds", () => {
    const realpath = jest.fn(
      fakeRealpath({}, ["/vault", "/vault/.obsidian", "/vault/notes", "/vault/other"]),
    );
    const matches = configDirMatcher(configDir, {
      basePath: "/vault",
      realpath,
      readlink: fakeReadlink({}),
    });
    for (let i = 0; i < 50; i++) {
      matches(`notes/n${i}.md`);
      matches(`other/o${i}.md`);
    }
    // The config dir, "notes", and "other": three lookups, not a hundred.
    expect(realpath).toHaveBeenCalledTimes(3);
  });
});

describe("a dangling symlink is followed to where a write would land", () => {
  // realpath fails on a symlink whose target does not exist yet, and the
  // "deepest existing ancestor" fallback would then report the link's own
  // location -- an ordinary vault path. But a write through the link creates
  // the target: "notes/upload.bin" linking to a missing
  // ".obsidian/plugins/demo/main.js" is a plugin install. So a component that
  // realpath cannot resolve is asked whether it is a link, and if so its
  // target is resolved the same way.
  const configDir = ".obsidian";
  // A link target is resolved from the filesystem root down, so the fake disk
  // has to know the root exists, as a real one always does.
  const existing = [
    "/",
    "/vault",
    "/vault/notes",
    "/vault/.obsidian",
    "/vault/.obsidian/plugins",
    "/vault/.obsidian/plugins/demo",
  ];

  function disk(links: Record<string, string>, aliases: Record<string, string> = {}): OnDiskAccess {
    return {
      basePath: "/vault",
      realpath: fakeRealpath(aliases, existing),
      readlink: fakeReadlink(links),
    };
  }

  test("a relative link target into the config dir", () => {
    const access = disk({ "/vault/notes/upload.bin": "../.obsidian/plugins/demo/main.js" });
    expect(vaultPathIsInConfigDir("notes/upload.bin", configDir, access)).toBe(true);
  });

  test("an absolute link target into the config dir", () => {
    const access = disk({ "/vault/notes/upload.bin": "/vault/.obsidian/plugins/demo/main.js" });
    expect(vaultPathIsInConfigDir("notes/upload.bin", configDir, access)).toBe(true);
  });

  test("a dangling link whose target's own ancestor is a short name", () => {
    const access = disk(
      { "/vault/notes/upload.bin": "../OBSIDI~1/plugins/demo/main.js" },
      { "/vault/OBSIDI~1": "/vault/.obsidian" },
    );
    expect(vaultPathIsInConfigDir("notes/upload.bin", configDir, access)).toBe(true);
  });

  test("a dangling link part-way along the path", () => {
    const access = disk({ "/vault/notes/plugins": "../.obsidian/plugins/missing" });
    expect(vaultPathIsInConfigDir("notes/plugins/demo/main.js", configDir, access)).toBe(true);
  });

  test("a dangling link to somewhere harmless", () => {
    const access = disk({ "/vault/notes/upload.bin": "../attachments/missing.bin" });
    expect(vaultPathIsInConfigDir("notes/upload.bin", configDir, access)).toBe(false);
  });

  test("a link loop does not hang and is refused rather than guessed about", () => {
    // The walk cannot say where this lands. Saying "not the config dir" would
    // be a guess the write could prove wrong, so the answer is a refusal.
    const access = disk({
      "/vault/notes/a": "b",
      "/vault/notes/b": "a",
    });
    expect(vaultPathIsInConfigDir("notes/a/x.md", configDir, access)).toBe(true);
    expect(configDirMatcher(configDir, access)("notes/a/x.md")).toBe(true);
  });

  test("a chain of links longer than the hop limit is refused, a shorter one followed", () => {
    const chain = (length: number): Record<string, string> => {
      const links: Record<string, string> = {};
      for (let i = 0; i < length; i++) links[`/vault/notes/l${i}`] = `l${i + 1}`;
      links[`/vault/notes/l${length}`] = "../attachments/missing.bin";
      return links;
    };
    const within = disk(chain(MAX_LINK_HOPS - 1));
    expect(vaultPathIsInConfigDir("notes/l0", configDir, within)).toBe(false);
    const beyond = disk(chain(MAX_LINK_HOPS + 1));
    expect(vaultPathIsInConfigDir("notes/l0", configDir, beyond)).toBe(true);
  });

  test("an unresolvable vault root still falls back to the textual check", () => {
    // Distinct from a chain the walk cannot finish: here the disk could not be
    // consulted at all, and the textual check is all there is.
    const access: OnDiskAccess = {
      basePath: "/vault",
      realpath: fakeRealpath({}, []),
      readlink: fakeReadlink({}),
    };
    expect(vaultPathIsInConfigDir("notes/a.md", configDir, access)).toBe(false);
    expect(vaultPathIsInConfigDir(".obsidian/a.md", configDir, access)).toBe(true);
  });

  test("a plain missing entry is still just missing", () => {
    const access = disk({});
    expect(vaultPathIsInConfigDir("notes/new.md", configDir, access)).toBe(false);
  });
});

describe("a disk error that is not 'missing' is a refusal, not a miss", () => {
  // The walk reads ENOENT (and ENOTDIR) as "not there, so the write would create
  // it here". EACCES, EIO or anything else means the disk did not answer, and
  // an existing component rewritten as missing would let the fallback invent a
  // harmless-looking location for a path the adapter may still traverse.
  const configDir = ".obsidian";
  const existing = ["/vault", "/vault/notes", "/vault/.obsidian"];

  test.each(["EACCES", "EPERM", "EIO", "ELOOP"])("realpath failing with %s refuses", (code) => {
    const access: OnDiskAccess = {
      basePath: "/vault",
      realpath: fakeRealpath({}, existing, { "/vault/notes/private": code }),
      readlink: fakeReadlink({}),
    };
    expect(vaultPathIsInConfigDir("notes/private/x.md", configDir, access)).toBe(true);
    expect(configDirMatcher(configDir, access)("notes/private/x.md")).toBe(true);
  });

  test("ENOTDIR is still a miss: a component that is a file, not a directory", () => {
    const access: OnDiskAccess = {
      basePath: "/vault",
      realpath: fakeRealpath({}, [...existing, "/vault/notes/a.md"], {
        "/vault/notes/a.md/comments": "ENOTDIR",
      }),
      readlink: fakeReadlink({}),
    };
    expect(vaultPathIsInConfigDir("notes/a.md/comments", configDir, access)).toBe(false);
  });

  test("readlink failing with something other than 'not a link' refuses", () => {
    const access: OnDiskAccess = {
      basePath: "/vault",
      realpath: fakeRealpath({}, existing),
      readlink: (absolutePath) => {
        if (absolutePath === "/vault/notes/odd") {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        }
        return undefined;
      },
    };
    expect(vaultPathIsInConfigDir("notes/odd/x.md", configDir, access)).toBe(true);
  });

  test("the vault root failing with something other than 'missing' also refuses", () => {
    // Unlike a root that is simply not there, a root the disk refuses to
    // describe is not a case the textual check should be trusted alone with.
    const access: OnDiskAccess = {
      basePath: "/vault",
      realpath: fakeRealpath({}, [], { "/vault": "EACCES" }),
      readlink: fakeReadlink({}),
    };
    expect(vaultPathIsInConfigDir("notes/a.md", configDir, access)).toBe(true);
  });
});

describe("onDiskAccessFor's readlink", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(["EINVAL", "ENOENT", "ENOTDIR"])("%s means 'nothing to follow'", (code) => {
    jest.spyOn(fs, "readlinkSync").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    const access = onDiskAccessFor(new FileSystemAdapter("/disk/vault"));
    expect(access?.readlink("/disk/vault/x")).toBeUndefined();
  });

  test("any other failure is thrown, so the walk refuses", () => {
    jest.spyOn(fs, "readlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    const access = onDiskAccessFor(new FileSystemAdapter("/disk/vault"));
    expect(() => access?.readlink("/disk/vault/x")).toThrow();
  });
});
