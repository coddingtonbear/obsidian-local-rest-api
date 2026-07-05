import { VaultOperations, FileNotFoundError } from "./vaultOperations";
import { App } from "../mocks/obsidian";
import { PatchFailed, PatchFailureReason } from "markdown-patch";

describe("VaultOperations.patchFileSection", () => {
  let app: App;
  let ops: VaultOperations;

  const FIXTURE = ["---", "tags:", "  - theme/orig", "---", "", "Body text.", ""].join("\n");

  beforeEach(() => {
    app = new App();
    app.vault._read = FIXTURE;
    // @ts-ignore: mock App doesn't perfectly match the real Obsidian App interface
    ops = new VaultOperations(app);
  });

  test("appending a type-mismatched scalar to a list frontmatter field throws PatchFailed(ContentNotMergeable), not a raw Error", async () => {
    // Regression test for coddingtonbear/obsidian-local-rest-api#282: this used
    // to escape markdown-patch's own applyPatch() as a bare
    // `Error("Cannot merge objects of different types or unsupported types: object and string")`,
    // which callers couldn't distinguish from a genuine server fault and which
    // surfaced as an HTTP 500 / MCP error with no actionable message.
    await expect(
      ops.patchFileSection(
        "somefile.md",
        "frontmatter",
        "tags",
        "append",
        "theme/added",
        "application/json",
      ),
    ).rejects.toMatchObject({
      constructor: PatchFailed,
      reason: PatchFailureReason.ContentNotMergeable,
    });
  });

  test("the PatchFailed thrown for a type mismatch preserves the original markdown-patch error as `cause`", async () => {
    await expect(
      ops.patchFileSection(
        "somefile.md",
        "frontmatter",
        "tags",
        "append",
        "theme/added",
        "application/json",
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Cannot merge objects"),
      }),
    });
  });

  test("appending a compatible array to a list frontmatter field still succeeds", async () => {
    const patched = await ops.patchFileSection(
      "somefile.md",
      "frontmatter",
      "tags",
      "append",
      ["theme/added"],
      "application/json",
    );
    expect(patched).toContain("theme/orig");
    expect(patched).toContain("theme/added");
  });

  test("patching a missing file still throws FileNotFoundError", async () => {
    app.vault._getAbstractFileByPath = null;
    await expect(
      ops.patchFileSection(
        "nope.md",
        "frontmatter",
        "tags",
        "append",
        ["x"],
        "application/json",
      ),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });
});
