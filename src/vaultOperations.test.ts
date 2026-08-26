import { App, TFile, _prepareSimpleSearchMock } from "../mocks/obsidian";
import { VaultOperations } from "./vaultOperations";
import { LocalRestApiSettings } from "./types";

// ---------------------------------------------------------------------------
// Writes must go through the Vault API, not the adapter.
//
// Vault.adapter.write puts bytes on disk behind Obsidian's back, leaving metadataCache
// describing the previous revision until the file watcher catches up. Since
// getFileMetadataObject serves frontmatter and tags from that cache, a client that
// wrote and immediately read back could be handed pre-write metadata. Vault.modify
// keeps Obsidian's bookkeeping in step with the write instead.
// ---------------------------------------------------------------------------

const MD_PATH = "note.md";

function setup(existingContent: string, fileExists = true): {
  app: App;
  ops: VaultOperations;
} {
  const app = new App();
  if (fileExists) {
    const file = new TFile();
    file.path = MD_PATH;
    app.vault._getAbstractFileByPath = file;
  } else {
    app.vault._getAbstractFileByPath = null;
  }
  app.vault._read = existingContent;
  app.vault.adapter._read = existingContent;
  const ops = new VaultOperations(app, {} as LocalRestApiSettings);
  return { app, ops };
}

describe("writes go through the Vault API", () => {
  test("patchFileSectionMdp2 modifies through the vault", async () => {
    const { app, ops } = setup("---\ntitle: Probe\n---\n\n# Hi\n");

    await ops.patchFileSectionMdp2(MD_PATH, {
      targetType: "frontmatter",
      target: "related",
      operation: "replace",
      value: ["alpha", "beta"],
      createTargetIfMissing: true,
    });

    expect(app.vault._modify?.[0]).toBe(MD_PATH);
    expect(app.vault._modify?.[1]).toContain("related");
  });

  test("appendFileContent modifies an existing file through the vault", async () => {
    const { app, ops } = setup("original\n");
    await ops.appendFileContent(MD_PATH, "appended\n");
    expect(app.vault._modify).toEqual([MD_PATH, "original\nappended\n"]);
  });

  test("appendFileContent creates a missing file through the vault", async () => {
    const { app, ops } = setup("", false);
    await ops.appendFileContent(MD_PATH, "appended\n");
    expect(app.vault._create).toEqual([MD_PATH, "appended\n"]);
  });

  test("writeFileContent modifies an existing file through the vault", async () => {
    const { app, ops } = setup("original\n");
    await ops.writeFileContent(MD_PATH, "replacement\n");
    expect(app.vault._modify).toEqual([MD_PATH, "replacement\n"]);
  });

  test("writeFileContent creates a missing file through the vault", async () => {
    const { app, ops } = setup("", false);
    await ops.writeFileContent(MD_PATH, "brand new\n");
    expect(app.vault._create).toEqual([MD_PATH, "brand new\n"]);
  });

  test("binary writes still go through the adapter", async () => {
    // Vault.modify is text-only, so binary uploads keep using writeBinary.
    const { app, ops } = setup("");
    await ops.writeFileContent("image.png", Buffer.from([1, 2, 3]));
    expect(app.vault.adapter._writeBinary?.[0]).toBe("image.png");
  });
});

describe("readBinaryFileContent", () => {
  test("returns the adapter's bytes rather than a decoded string", async () => {
    const { app, ops } = setup("");
    // 0x89 leads a PNG and is not valid UTF-8, so a decoded read could not produce it.
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    app.vault.adapter._readBinary = bytes.buffer;

    const read = await ops.readBinaryFileContent(MD_PATH);

    expect(new Uint8Array(read)).toEqual(bytes);
  });

  test("throws for a path that is not a file, matching the text read", async () => {
    const { ops } = setup("", false);
    await expect(ops.readBinaryFileContent(MD_PATH)).rejects.toThrow(
      `File not found: ${MD_PATH}`,
    );
  });
});

// ---------------------------------------------------------------------------
// simpleSearch context slicing must not split UTF-16 surrogate pairs.
//
// Obsidian's prepareSimpleSearch reports matches as UTF-16 code-unit offsets,
// and the context window is produced with String.prototype.slice, which also
// works in code units. When a contextLength boundary lands between the two
// halves of a surrogate pair (e.g. the emoji 🔌 = U+D83D U+DD0C), the returned
// context can contain an unpaired surrogate. See
// https://github.com/coddingtonbear/obsidian-local-rest-api/issues/330.
// ---------------------------------------------------------------------------

describe("simpleSearch surrogate handling", () => {
  function searchSetup(content: string, contextLength: number): {
    ops: VaultOperations;
    results: () => Promise<{ context: string }[]>;
  } {
    const query = "needle";
    const file = new TFile();
    file.basename = "note";
    file.path = "note.md";

    const app = new App();
    app.vault._markdownFiles = [file];
    app.vault._cachedRead = content;
    // "note\n\n" is prepended as the filename prefix, so the first 6 code units
    // are the prefix; the content starts at offset 6.
    _prepareSimpleSearchMock.behavior = (query: string) => {
      const queryLength = query.length;
      return (text: string) => {
        const index = text.indexOf(query, 6);
        if (index === -1) return null;
        return {
          score: 1,
          matches: [[index, index + queryLength]],
        };
      };
    };

    const ops = new VaultOperations(app, {} as LocalRestApiSettings);
    return {
      ops,
      results: async () =>
        (await ops.simpleSearch(query, contextLength)).flatMap((r) =>
          r.matches.map((m) => ({ context: m.context })),
        ),
    };
  }

  afterEach(() => {
    _prepareSimpleSearchMock.behavior = null;
  });

  test("start boundary splits a surrogate pair (issue #330 repro)", async () => {
    // 🔌 (U+D83D U+DD0C) precedes the match; a contextLength of 2 slices from
    // code-unit 1, between the two surrogate halves.
    const { results } = searchSetup("🔌xneedle", 2);
    expect(await results()).toEqual([{ context: "🔌xneedle" }]);
  });

  test("end boundary splits a surrogate pair", async () => {
    // The match ends at code-unit 7; a contextLength of 1 slices up to code-unit
    // 8, which sits between the surrogate halves of the trailing 🔌.
    const { results } = searchSetup("xneedle🔌", 1);
    expect(await results()).toEqual([{ context: "xneedle🔌" }]);
  });
});
