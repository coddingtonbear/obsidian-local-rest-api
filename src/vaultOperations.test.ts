import fs from "fs";
import path from "path";
import { App, TFile, _prepareSimpleSearchMock } from "../mocks/obsidian";
import {
  BACKLINKS_INDEX_MAX_AGE_MS,
  METADATA_CACHE_EVENTS,
  VAULT_EVENTS,
  VaultOperations,
} from "./vaultOperations";
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

// ---------------------------------------------------------------------------
// A single-note read must not rescan the whole vault link graph.
//
// buildBacklinksIndex walks every entry of metadataCache.resolvedLinks and every
// target within it -- the entire vault link graph -- to answer "which files link
// here". The bulk search path builds it once and threads it through its loop, but
// every single-note metadata read (GET /vault/<path> as note+json, and the MCP
// vault_read tool) used to pay for a fresh whole-graph scan and then discard all
// but one entry of the result.
//
// Caching it makes correctness the interesting question rather than cost: a
// cached graph that outlives a change to the real one serves stale backlinks.
//
// Two things hold that down, and both are tested here. The cache is dropped on
// every event Obsidian's metadata cache and vault declare -- not the subset that
// looked relevant, so there is no judgement call to get wrong -- and it ages out
// regardless, so an announcement that never arrives costs a bounded window of
// staleness rather than a permanently wrong answer.
// ---------------------------------------------------------------------------

describe("backlinks index caching", () => {
  function backlinksSetup(): {
    app: App;
    ops: VaultOperations;
    file: TFile;
    build: jest.SpyInstance;
    backlinks: () => Promise<string[]>;
  } {
    const app = new App();
    const file = new TFile();
    file.path = "note.md";
    app.vault._getAbstractFileByPath = file;
    app.metadataCache.resolvedLinks = { "a.md": { "note.md": 1 } };

    const ops = new VaultOperations(app, {} as LocalRestApiSettings);
    const build = jest.spyOn(ops, "buildBacklinksIndex");

    return {
      app,
      ops,
      file,
      build,
      backlinks: async () => (await ops.getFileMetadataObject(file)).backlinks,
    };
  }

  test("repeated single-note reads scan the link graph once", async () => {
    const { build, backlinks } = backlinksSetup();

    expect(await backlinks()).toEqual(["a.md"]);
    expect(await backlinks()).toEqual(["a.md"]);
    expect(await backlinks()).toEqual(["a.md"]);

    expect(build).toHaveBeenCalledTimes(1);
  });

  // Every event either emitter declares, whether or not it is one that plausibly
  // moves the link graph. Deciding which ones matter is exactly the judgement
  // this cache should not be resting on, and an invalidation too many only costs
  // a rebuild the uncached code performed on every single read.
  test.each([
    // Fired when a file has been indexed and its cache is available.
    [
      "metadataCache changed",
      (app: App) => app.metadataCache._emit("changed", new TFile(), "", null),
    ],
    // A deleted file drops out of the graph, along with the links it made.
    [
      "metadataCache deleted",
      (app: App) => app.metadataCache._emit("deleted", new TFile(), null),
    ],
    // Fired for each file whose links have been re-resolved.
    [
      "metadataCache resolve",
      (app: App) => app.metadataCache._emit("resolve", new TFile()),
    ],
    // Fired once after a batch of re-resolutions completes.
    [
      "metadataCache resolved",
      (app: App) => app.metadataCache._emit("resolved"),
    ],
    ["vault create", (app: App) => app.vault._emit("create", new TFile())],
    ["vault modify", (app: App) => app.vault._emit("modify", new TFile())],
    ["vault delete", (app: App) => app.vault._emit("delete", new TFile())],
    // resolvedLinks is keyed by path, so a rename re-keys it -- and Obsidian
    // documents that renames deliberately do not fire the cache's own events.
    [
      "vault rename",
      (app: App) => app.vault._emit("rename", new TFile(), "old.md"),
    ],
  ])("%s invalidates the cached index", async (_name, fire) => {
    const { app, build, backlinks } = backlinksSetup();

    expect(await backlinks()).toEqual(["a.md"]);

    app.metadataCache.resolvedLinks = {
      "a.md": { "note.md": 1 },
      "b.md": { "note.md": 1 },
    };
    fire(app);

    expect(await backlinks()).toEqual(["a.md", "b.md"]);
    expect(build).toHaveBeenCalledTimes(2);
  });

  test("the index ages out even when nothing announces the change", async () => {
    // The listener list covers every event Obsidian declares today, but this
    // cache's correctness must not rest on that list still being complete after
    // an Obsidian upgrade. An event nobody here has heard of, or an internal
    // path that rewrites resolvedLinks without announcing anything, would
    // otherwise leave a stale index in place for the lifetime of the plugin.
    // Ageing it out bounds that at BACKLINKS_INDEX_MAX_AGE_MS instead.
    jest.useFakeTimers();
    try {
      const { app, build, backlinks } = backlinksSetup();

      expect(await backlinks()).toEqual(["a.md"]);

      app.metadataCache.resolvedLinks = {
        "a.md": { "note.md": 1 },
        "b.md": { "note.md": 1 },
      };
      // Deliberately no event: this is the case the listeners cannot cover.
      jest.advanceTimersByTime(BACKLINKS_INDEX_MAX_AGE_MS);

      expect(await backlinks()).toEqual(["a.md", "b.md"]);
      expect(build).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the index is still served just under its maximum age", async () => {
    // The other side of the bound: ageing out must not be so eager that the
    // burst of reads this cache exists for stops being a burst.
    jest.useFakeTimers();
    try {
      const { build, backlinks } = backlinksSetup();

      expect(await backlinks()).toEqual(["a.md"]);
      jest.advanceTimersByTime(BACKLINKS_INDEX_MAX_AGE_MS - 1);
      expect(await backlinks()).toEqual(["a.md"]);

      expect(build).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a caller that mutates the backlinks it was handed cannot corrupt the cache", async () => {
    // The cached index outlives the response built from it, so handing out its
    // own arrays would let one client's mutation reach the next client.
    const { ops, file, backlinks } = backlinksSetup();

    const first = (await ops.getFileMetadataObject(file)).backlinks;
    first.push("injected.md");

    expect(await backlinks()).toEqual(["a.md"]);
  });

  test("an explicitly supplied index still wins over the cache", async () => {
    // Bulk callers pass one snapshot through their whole loop deliberately, so
    // that every row of a result set describes the same moment.
    const { ops, file, build } = backlinksSetup();

    const supplied = { "note.md": ["snapshot.md"] };
    const meta = await ops.getFileMetadataObject(file, supplied);

    expect(meta.backlinks).toEqual(["snapshot.md"]);
    expect(build).not.toHaveBeenCalled();
  });

  test("dispose unregisters the invalidation listeners", async () => {
    // VaultOperations lives as long as the plugin, and its listeners must not
    // outlive it: one left behind holds the old instance alive and goes on
    // writing to a cache nobody reads.
    const { app, ops, build, backlinks } = backlinksSetup();

    await backlinks();
    ops.dispose();

    for (const event of METADATA_CACHE_EVENTS) {
      app.metadataCache._emit(event, new TFile(), null);
    }
    for (const event of VAULT_EVENTS) {
      app.vault._emit(event, new TFile(), "old.md");
    }

    await backlinks();
    expect(build).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The listener set is only ever as complete as Obsidian's own event surface.
//
// Subscribing to every declared event answers "did we pick the right subset?",
// but not "what if a later Obsidian release adds one?" -- a hardcoded list would
// silently stop covering the graph the day that happens. These read the event
// names back out of the installed typings, so an upgrade that adds or renames an
// event is a failing test rather than a cache that quietly goes stale.
//
// This only sees what Obsidian declares publicly. An undocumented internal path
// that rewrites resolvedLinks is covered by BACKLINKS_INDEX_MAX_AGE_MS instead.
// ---------------------------------------------------------------------------

describe("Obsidian's declared event surface", () => {
  function declaredEvents(className: string): string[] {
    const typings = fs.readFileSync(
      path.join(__dirname, "..", "node_modules", "obsidian", "obsidian.d.ts"),
      "utf-8",
    );
    const start = typings.indexOf(`export class ${className} extends Events {`);
    expect(start).toBeGreaterThanOrEqual(0);

    const end = typings.indexOf("\nexport ", start + 1);
    const body = typings.slice(start, end === -1 ? undefined : end);

    return [...body.matchAll(/\bon\(name: '([^']+)'/g)]
      .map((match) => match[1])
      .sort();
  }

  test("the cache is invalidated by every metadataCache event", () => {
    expect([...METADATA_CACHE_EVENTS].sort()).toEqual(
      declaredEvents("MetadataCache"),
    );
  });

  test("the cache is invalidated by every vault event", () => {
    expect([...VAULT_EVENTS].sort()).toEqual(declaredEvents("Vault"));
  });
});
