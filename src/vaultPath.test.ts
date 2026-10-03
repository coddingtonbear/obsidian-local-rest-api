import {
  PathTraversalError,
  ConfigDirAccessError,
  assertVaultPathIsContained,
  assertConfigDirAccessAllowed,
  vaultPathIsContained,
  vaultPathIsInConfigDir,
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
