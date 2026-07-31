import { App, TFile } from "../mocks/obsidian";
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
