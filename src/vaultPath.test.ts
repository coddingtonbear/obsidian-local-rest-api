import {
  PathTraversalError,
  assertVaultPathIsContained,
  vaultPathIsContained,
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
