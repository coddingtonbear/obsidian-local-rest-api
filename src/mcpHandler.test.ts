// jest.mock calls are hoisted before imports by ts-jest's babel transform.
// Variables prefixed with "mock" are also hoisted, so they can be safely
// referenced inside the factory functions below.

const mockRemove = jest.fn();
const mockTool = jest.fn().mockReturnValue({ remove: mockRemove });
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockTransportHandleRequest = jest.fn().mockResolvedValue(undefined);
const mockNewSessionId = "new-session-id";

const mockResource = jest.fn();

// Prevent ts-jest from compiling vaultOperations.ts (which pulls in json-logic-js
// with a deeply recursive RulesLogic type that OOMs TypeScript 4.7). The real
// VaultOperations is never instantiated in these tests — makeMockOps() provides
// a plain object with the same surface.
jest.mock("./vaultOperations", () => ({
  VaultOperations: jest.fn(),
}));

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    tool: mockTool,
    resource: mockResource,
    connect: mockConnect,
  })),
}));

jest.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation((opts: { onsessioninitialized?: (id: string) => void }) => {
    const transport = {
      sessionId: mockNewSessionId,
      handleRequest: mockTransportHandleRequest,
      onclose: undefined as (() => void) | undefined,
    };
    // Defer so the outer `const transport = new ...` assignment completes first,
    // matching the real SDK which only calls this after processing the initialize message.
    void Promise.resolve().then(() => opts?.onsessioninitialized?.(mockNewSessionId));
    return transport;
  }),
}));

import { McpHandler } from "./mcpHandler";
import { ErrorCode } from "./types";
import { DEFAULT_SETTINGS } from "./constants";
import { TFile } from "../mocks/obsidian";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockFile(path = "test.md"): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.replace(/\.md$/, "");
  return f;
}

function makeMockOps() {
  const mockFile = makeMockFile();
  return {
    app: {
      vault: {
        getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
      },
      workspace: {
        getActiveFile: jest.fn().mockReturnValue(mockFile),
      },
    },
    listVaultDirectory: jest.fn().mockResolvedValue(["file1.md", "folder/"]),
    getFileMetadataObject: jest.fn().mockResolvedValue({
      content: "hello",
      tags: [],
      frontmatter: {},
      stat: { ctime: 0, mtime: 0, size: 0 },
      path: mockFile.path,
      links: [],
      backlinks: [],
      unresolvedLinks: [],
    }),
    getDocumentMapObject: jest.fn().mockResolvedValue({
      headings: ["Alpha", "Alpha::Subsection"],
      blocks: ["beta-block"],
      frontmatterFields: ["title", "priority"],
    }),
    getDocumentMapV2Object: jest.fn().mockResolvedValue({
      version: "abc123",
      headings: { Alpha: { Subsection: {} } },
      blocks: ["beta-block"],
      frontmatterFields: ["title", "priority"],
    }),
    readFileSection: jest.fn().mockResolvedValue("section content"),
    readFileSectionMdp2: jest
      .fn()
      .mockResolvedValue({ kind: "heading", content: "section content" }),
    writeFileContent: jest.fn().mockResolvedValue(undefined),
    appendFileContent: jest.fn().mockResolvedValue(undefined),
    patchFileSection: jest.fn().mockResolvedValue("patched content"),
    patchFileSectionMdp2: jest
      .fn()
      .mockResolvedValue({ document: "patched content", warnings: [] }),
    deleteVaultFile: jest.fn().mockResolvedValue(undefined),
    searchJsonLogic: jest
      .fn()
      .mockResolvedValue([{ filename: "a.md", result: true }]),
    simpleSearch: jest
      .fn()
      .mockResolvedValue([{ filename: "a.md", score: 1, matches: [] }]),
    getAllTags: jest.fn().mockReturnValue([{ name: "todo", count: 3 }]),
    listCommands: jest
      .fn()
      .mockReturnValue([{ id: "cmd-id", name: "Command Name" }]),
    executeCommand: jest.fn(),
    openVaultFile: jest.fn(),
    moveVaultFile: jest.fn().mockResolvedValue(""),
    copyVaultFile: jest.fn().mockResolvedValue(""),
    periodicGetNote: jest.fn().mockReturnValue([mockFile, null]),
    periodicGetOrCreateNote: jest.fn().mockResolvedValue([mockFile, null]),
  };
}

// Returns the callback registered for the named tool.
function getToolCallback(toolName: string) {
  const call = mockTool.mock.calls.find(
    (c: unknown[]) => c[0] === toolName,
  );
  if (!call) throw new Error(`Tool "${toolName}" was not registered`);
  // tool(name, description, schema, annotations, callback) — callback is always last
  return call[call.length - 1] as (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

// Returns the annotations object registered for the named tool.
function getToolAnnotations(toolName: string) {
  const call = mockTool.mock.calls.find(
    (c: unknown[]) => c[0] === toolName,
  );
  if (!call) throw new Error(`Tool "${toolName}" was not registered`);
  // tool(name, description, schema, annotations, callback) — annotations is second-to-last
  return call[call.length - 2] as Record<string, boolean>;
}

function parseText(result: { content: Array<{ type: string; text: string }> }) {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result.content[0].text;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpHandler", () => {
   
  let ops: any;

  // Each session now gets its own McpServer, so tool/resource registration runs when
  // a session is built (not at construction). Trigger one build so the McpServer mock
  // captures the registrations that getToolCallback() reads.
  async function buildSession(mcp: McpHandler): Promise<void> {
    // @ts-ignore: partial mock
    await mcp.handleRequest(
      { headers: {}, body: { jsonrpc: "2.0", id: 0, method: "initialize" } },
      { status: jest.fn().mockReturnThis(), json: jest.fn() },
    );
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    ops = makeMockOps();
    // Construction records specs; building a session registers them on a server.
    await buildSession(new McpHandler(ops, DEFAULT_SETTINGS));
  });

  // ---- resource registration ----------------------------------------------

  test("registers the openapi-spec resource", () => {
    expect(mockResource).toHaveBeenCalledTimes(1);
    const [name, uri] = mockResource.mock.calls[0] as [string, string];
    expect(name).toBe("openapi-spec");
    expect(uri).toBe("obsidian://local-rest-api/openapi.yaml");
  });

  // ---- tool registration --------------------------------------------------

  test("registers all 17 tools", () => {
    expect(mockTool).toHaveBeenCalledTimes(17);
    const names = mockTool.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        "vault_list",
        "vault_read",
        "vault_write",
        "vault_append",
        "vault_patch",
        "vault_delete",
        "vault_move",
        "vault_copy",
        "vault_get_document_map",
        "active_file_get_path",
        "periodic_note_get_path",
        "search_query",
        "search_simple",
        "tag_list",
        "command_list",
        "command_execute",
        "open_file",
      ]),
    );
  });

  // ---- tool annotations -----------------------------------------------------

  describe("tool annotations", () => {
    test("read-only tools are annotated readOnlyHint/idempotentHint true, destructiveHint false", () => {
      for (const name of [
        "vault_list",
        "vault_read",
        "vault_get_document_map",
        "active_file_get_path",
        "search_query",
        "search_simple",
        "tag_list",
        "command_list",
      ]) {
        expect(getToolAnnotations(name)).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
    });

    test("vault_patch, vault_delete, vault_move, vault_copy, and command_execute are annotated as destructive", () => {
      for (const name of ["vault_patch", "vault_delete", "vault_move", "vault_copy", "command_execute"]) {
        const annotations = getToolAnnotations(name);
        expect(annotations.readOnlyHint).toBe(false);
        expect(annotations.destructiveHint).toBe(true);
      }
    });

    test("no tool is annotated openWorldHint true", () => {
      for (const call of mockTool.mock.calls) {
        const annotations = call[call.length - 2] as Record<string, boolean>;
        expect(annotations.openWorldHint).toBe(false);
      }
    });
  });

  // ---- vault_list ---------------------------------------------------------

  describe("vault_list", () => {
    test("calls listVaultDirectory and returns files array", async () => {
      const cb = getToolCallback("vault_list");
      const result = await cb({ path: "some/dir" });
      expect(ops.listVaultDirectory).toHaveBeenCalledWith("some/dir");
      expect(parseText(result).files).toEqual(["file1.md", "folder/"]);
    });

    test("defaults to root when path is omitted", async () => {
      const cb = getToolCallback("vault_list");
      await cb({});
      expect(ops.listVaultDirectory).toHaveBeenCalledWith("");
    });
  });

  // ---- vault_read ---------------------------------------------------------

  describe("vault_read", () => {
    test("calls getFileMetadataObject and returns metadata", async () => {
      const cb = getToolCallback("vault_read");
      const result = await cb({ path: "test.md" });
      expect(ops.app.vault.getAbstractFileByPath).toHaveBeenCalledWith(
        "test.md",
      );
      expect(ops.getFileMetadataObject).toHaveBeenCalled();
      expect(parseText(result).path).toBe("test.md");
    });

    test("throws when file is not found", async () => {
      ops.app.vault.getAbstractFileByPath.mockReturnValue(null);
      const cb = getToolCallback("vault_read");
      await expect(cb({ path: "missing.md" })).rejects.toThrow(
        "File not found",
      );
    });

    test("calls readFileSectionMdp2 with an array heading address", async () => {
      const cb = getToolCallback("vault_read");
      const result = await cb({
        path: "test.md",
        targetType: "heading",
        target: ["Alpha", "Subsection"],
      });
      expect(ops.readFileSectionMdp2).toHaveBeenCalledWith(
        expect.objectContaining({ path: "test.md" }),
        { targetType: "heading", target: ["Alpha", "Subsection"] },
      );
      expect(ops.getFileMetadataObject).not.toHaveBeenCalled();
      expect(parseText(result)).toBe("section content");
    });

    test("passes scope through to the read address", async () => {
      const cb = getToolCallback("vault_read");
      await cb({
        path: "test.md",
        targetType: "heading",
        target: ["Alpha"],
        scope: "markerAndContent",
      });
      expect(ops.readFileSectionMdp2).toHaveBeenCalledWith(
        expect.anything(),
        {
          targetType: "heading",
          target: ["Alpha"],
          scope: "markerAndContent",
        },
      );
    });

    test("rejects scope without a target", async () => {
      const cb = getToolCallback("vault_read");
      await expect(
        cb({ path: "test.md", scope: "marker" }),
      ).rejects.toThrow("scope requires targetType and target");
    });

    test("passes a duplicate-heading marker suffix through a target segment unchanged", async () => {
      const cb = getToolCallback("vault_read");
      const disambiguated = "Alpha\u{FC750}\u{F6440}";
      await cb({
        path: "test.md",
        targetType: "heading",
        target: [disambiguated],
      });
      expect(ops.readFileSectionMdp2).toHaveBeenCalledWith(
        expect.anything(),
        { targetType: "heading", target: [disambiguated] },
      );
    });

    test("rejects a bare string heading target", async () => {
      const cb = getToolCallback("vault_read");
      await expect(
        cb({ path: "test.md", targetType: "heading", target: "Alpha" }),
      ).rejects.toThrow("must be an array");
    });

    test("passes a block target through as a string", async () => {
      const cb = getToolCallback("vault_read");
      await cb({ path: "test.md", targetType: "block", target: "beta-block" });
      expect(ops.readFileSectionMdp2).toHaveBeenCalledWith(
        expect.anything(),
        { targetType: "block", target: "beta-block" },
      );
    });

    test("passes a duplicate-block marker suffix through a block target unchanged", async () => {
      const cb = getToolCallback("vault_read");
      const disambiguated = "beta-block\u{FC750}\u{F6440}";
      await cb({ path: "test.md", targetType: "block", target: disambiguated });
      expect(ops.readFileSectionMdp2).toHaveBeenCalledWith(
        expect.anything(),
        { targetType: "block", target: disambiguated },
      );
    });

    test("returns a frontmatter value from readFileSectionMdp2", async () => {
      ops.readFileSectionMdp2.mockResolvedValueOnce({ kind: "frontmatter", value: 3 });
      const cb = getToolCallback("vault_read");
      const result = await cb({ path: "test.md", targetType: "frontmatter", target: "priority" });
      expect(parseText(result)).toBe(3);
    });

    test("rejects an array target for a non-heading targetType", async () => {
      const cb = getToolCallback("vault_read");
      await expect(
        cb({ path: "test.md", targetType: "block", target: ["a", "b"] }),
      ).rejects.toThrow("must be a string, not an array");
    });

    test("throws when targetType is provided without target", async () => {
      const cb = getToolCallback("vault_read");
      await expect(cb({ path: "test.md", targetType: "heading" })).rejects.toThrow(
        "targetType and target must be provided together",
      );
    });

    test("throws when target is provided without targetType", async () => {
      const cb = getToolCallback("vault_read");
      await expect(cb({ path: "test.md", target: "Some Heading" })).rejects.toThrow(
        "targetType and target must be provided together",
      );
    });
  });

  // ---- vault_get_document_map ---------------------------------------------

  describe("vault_get_document_map", () => {
    test("calls getDocumentMapV2Object and returns the 2.0 heading tree and version", async () => {
      const cb = getToolCallback("vault_get_document_map");
      const result = await cb({ path: "test.md" });
      expect(ops.getDocumentMapV2Object).toHaveBeenCalled();
      const body = parseText(result);
      expect(body.version).toBe("abc123");
      expect(body.headings).toEqual({ Alpha: { Subsection: {} } });
      expect(body.blocks).toEqual(["beta-block"]);
      expect(body.frontmatterFields).toEqual(["title", "priority"]);
    });

    test("throws when file is not found", async () => {
      ops.app.vault.getAbstractFileByPath.mockReturnValue(null);
      const cb = getToolCallback("vault_get_document_map");
      await expect(cb({ path: "missing.md" })).rejects.toThrow("File not found");
    });

    test("returns a duplicate heading's marker-suffixed key unmodified", async () => {
      const disambiguated = "Alpha\u{FC750}\u{F6440}";
      ops.getDocumentMapV2Object.mockResolvedValueOnce({
        version: "abc123",
        headings: { Alpha: {}, [disambiguated]: {} },
        blocks: [],
        frontmatterFields: [],
      });
      const cb = getToolCallback("vault_get_document_map");
      const result = await cb({ path: "test.md" });
      const body = parseText(result);
      expect(Object.keys(body.headings)).toEqual(["Alpha", disambiguated]);
    });

    test("returns a duplicate block's marker-suffixed entry unmodified", async () => {
      const disambiguated = "dup\u{FC750}\u{F6440}";
      ops.getDocumentMapV2Object.mockResolvedValueOnce({
        version: "abc123",
        headings: {},
        blocks: ["dup", disambiguated],
        frontmatterFields: [],
      });
      const cb = getToolCallback("vault_get_document_map");
      const result = await cb({ path: "test.md" });
      const body = parseText(result);
      expect(body.blocks).toEqual(["dup", disambiguated]);
    });
  });

  // ---- vault_write --------------------------------------------------------

  test("vault_write calls writeFileContent and returns OK", async () => {
    const cb = getToolCallback("vault_write");
    const result = await cb({ path: "out.md", content: "hello" });
    expect(ops.writeFileContent).toHaveBeenCalledWith("out.md", "hello");
    expect(parseText(result).message).toBe("OK");
  });

  // ---- vault_append -------------------------------------------------------

  test("vault_append calls appendFileContent and returns OK", async () => {
    const cb = getToolCallback("vault_append");
    const result = await cb({ path: "out.md", content: "\nmore" });
    expect(ops.appendFileContent).toHaveBeenCalledWith("out.md", "\nmore");
    expect(parseText(result).message).toBe("OK");
  });

  // ---- vault_patch --------------------------------------------------------

  test("vault_patch builds a heading content instruction and calls patchFileSectionMdp2", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "heading",
      target: ["Overview", "Details"],
      operation: "append",
      content: "new text",
    });
    expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
      targetType: "heading",
      target: ["Overview", "Details"],
      operation: "append",
      content: "new text",
    });
  });

  test("vault_patch passes a duplicate-heading marker suffix through a target segment unchanged", async () => {
    const cb = getToolCallback("vault_patch");
    const disambiguated = "Overview\u{FC750}\u{F6440}";
    await cb({
      path: "out.md",
      targetType: "heading",
      target: [disambiguated],
      operation: "append",
      content: "new text",
    });
    expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
      targetType: "heading",
      target: [disambiguated],
      operation: "append",
      content: "new text",
    });
  });

  test("vault_patch passes a duplicate-block marker suffix through a block target unchanged", async () => {
    const cb = getToolCallback("vault_patch");
    const disambiguated = "dup\u{FC750}\u{F6440}";
    await cb({
      path: "out.md",
      targetType: "block",
      target: disambiguated,
      operation: "replace",
      content: "new text",
    });
    expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
      targetType: "block",
      target: disambiguated,
      operation: "replace",
      content: "new text",
    });
  });

  test("vault_patch omits absent optional fields from the instruction", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "heading",
      target: ["A"],
      operation: "replace",
      content: "x",
    });
    const instruction = ops.patchFileSectionMdp2.mock.calls[0][1];
    expect(instruction).not.toHaveProperty("scope");
    expect(instruction).not.toHaveProperty("value");
    expect(instruction).not.toHaveProperty("destination");
    expect(instruction).not.toHaveProperty("ifMatch");
    expect(instruction).not.toHaveProperty("within");
  });

  test("vault_patch passes within through to the instruction, including 0 and negatives", async () => {
    const cb = getToolCallback("vault_patch");
    for (const within of [0, -1]) {
      await cb({
        path: "out.md",
        targetType: "heading",
        target: ["Log"],
        within,
        operation: "append",
        content: "\n- item",
      });
      expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
        targetType: "heading",
        target: ["Log"],
        within,
        operation: "append",
        content: "\n- item",
      });
    }
  });

  test("vault_patch passes a frontmatter value as native JSON (not a string)", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "frontmatter",
      target: "related",
      operation: "replace",
      value: ["alpha", "beta"],
    });
    expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
      targetType: "frontmatter",
      target: "related",
      operation: "replace",
      value: ["alpha", "beta"],
    });
  });

  test("vault_patch passes a block table-row value as native JSON (not a string)", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "block",
      target: "2c7cfa",
      operation: "append",
      value: [["Chicago, IL", "16"]],
    });
    expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
      targetType: "block",
      target: "2c7cfa",
      operation: "append",
      value: [["Chicago, IL", "16"]],
    });
  });

  test("vault_patch forwards scope, ifMatch, and creation flags", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "heading",
      target: ["A"],
      operation: "replace",
      scope: "marker",
      content: "Renamed",
      ifMatch: "v1",
      createTargetIfMissing: true,
      rejectIfContentPreexists: true,
    });
    expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
      targetType: "heading",
      target: ["A"],
      operation: "replace",
      scope: "marker",
      content: "Renamed",
      ifMatch: "v1",
      createTargetIfMissing: true,
      rejectIfContentPreexists: true,
    });
  });

  test("vault_patch forwards a move destination", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "heading",
      target: ["Overview", "Details"],
      operation: "replace",
      scope: "parent",
      destination: { parent: ["Appendix"], place: "last" },
    });
    expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
      targetType: "heading",
      target: ["Overview", "Details"],
      operation: "replace",
      scope: "parent",
      destination: { parent: ["Appendix"], place: "last" },
    });
  });

  test("vault_patch reports OK on success", async () => {
    const cb = getToolCallback("vault_patch");
    const result = await cb({
      path: "out.md",
      targetType: "heading",
      target: ["A"],
      operation: "replace",
      content: "x",
    });
    expect(parseText(result).message).toBe("OK");
  });

  test("vault_patch surfaces engine warnings in the result", async () => {
    ops.patchFileSectionMdp2.mockResolvedValueOnce({
      document: "patched",
      warnings: [{ code: "heading-depth-overflow", message: "too deep" }],
    });
    const cb = getToolCallback("vault_patch");
    const result = await cb({
      path: "out.md",
      targetType: "heading",
      target: ["A"],
      operation: "replace",
      content: "####### x",
    });
    const payload = parseText(result);
    expect(payload.message).toBe("OK");
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0].code).toBe("heading-depth-overflow");
  });

  test("vault_patch surfaces engine error messages", async () => {
    const cb = getToolCallback("vault_patch");
    ops.patchFileSectionMdp2.mockRejectedValueOnce(
      new Error("could not resolve heading target"),
    );
    await expect(
      cb({ path: "out.md", targetType: "heading", target: ["NoSuch"], operation: "replace", content: "x" }),
    ).rejects.toThrow("could not resolve heading target");
  });

  // ---- vault_delete -------------------------------------------------------

  test("vault_delete calls deleteVaultFile and returns OK, defaulting to trash", async () => {
    const cb = getToolCallback("vault_delete");
    const result = await cb({ path: "old.md" });
    expect(ops.deleteVaultFile).toHaveBeenCalledWith("old.md", false);
    expect(parseText(result).message).toBe("OK");
  });

  test("vault_delete passes permanent flag through", async () => {
    const cb = getToolCallback("vault_delete");
    await cb({ path: "old.md", permanent: true });
    expect(ops.deleteVaultFile).toHaveBeenCalledWith("old.md", true);
  });

  // ---- vault_move ---------------------------------------------------------

  describe("vault_move", () => {
    test("moves file and returns old and new paths", async () => {
      ops.moveVaultFile.mockResolvedValue("archive/file.md");
      const cb = getToolCallback("vault_move");
      const result = await cb({ path: "folder/file.md", destination: "archive/file.md" });
      expect(ops.moveVaultFile).toHaveBeenCalledWith("folder/file.md", "archive/file.md", false);
      const parsed = parseText(result);
      expect(parsed.message).toBe("OK");
      expect(parsed.oldPath).toBe("folder/file.md");
      expect(parsed.newPath).toBe("archive/file.md");
    });

    test("trailing-slash destination uses source filename", async () => {
      ops.moveVaultFile.mockResolvedValue("archive/todo.md");
      const cb = getToolCallback("vault_move");
      const result = await cb({ path: "notes/todo.md", destination: "archive/" });
      expect(ops.moveVaultFile).toHaveBeenCalledWith("notes/todo.md", "archive/todo.md", false);
      expect(parseText(result).newPath).toBe("archive/todo.md");
    });

    test("passes allowOverwrite flag", async () => {
      const cb = getToolCallback("vault_move");
      await cb({ path: "a.md", destination: "b.md", allowOverwrite: true });
      expect(ops.moveVaultFile).toHaveBeenCalledWith("a.md", "b.md", true);
    });

    test("empty destination moves to vault root preserving source filename", async () => {
      ops.moveVaultFile.mockResolvedValue("todo.md");
      const cb = getToolCallback("vault_move");
      const result = await cb({ path: "notes/todo.md", destination: "" });
      expect(ops.moveVaultFile).toHaveBeenCalledWith("notes/todo.md", "todo.md", false);
      expect(parseText(result).newPath).toBe("todo.md");
    });

    test("whitespace-only destination moves to vault root preserving source filename", async () => {
      ops.moveVaultFile.mockResolvedValue("todo.md");
      const cb = getToolCallback("vault_move");
      await cb({ path: "notes/todo.md", destination: "   " });
      expect(ops.moveVaultFile).toHaveBeenCalledWith("notes/todo.md", "todo.md", false);
    });

    test("rejects path traversal in destination", async () => {
      const cb = getToolCallback("vault_move");
      await expect(cb({ path: "a.md", destination: "../../../etc/passwd" })).rejects.toThrow(
        "must not escape the vault root",
      );
      expect(ops.moveVaultFile).not.toHaveBeenCalled();
    });

    test("rejects absolute destination", async () => {
      const cb = getToolCallback("vault_move");
      await expect(cb({ path: "a.md", destination: "/etc/passwd" })).rejects.toThrow(
        "must not escape the vault root",
      );
      expect(ops.moveVaultFile).not.toHaveBeenCalled();
    });

    test("rejects destination starting with /vault/", async () => {
      const cb = getToolCallback("vault_move");
      await expect(cb({ path: "a.md", destination: "/vault/notes/file.md" })).rejects.toThrow(
        "must not escape the vault root",
      );
      expect(ops.moveVaultFile).not.toHaveBeenCalled();
    });

    test("allows destination with '..' as a substring (not a segment)", async () => {
      ops.moveVaultFile.mockResolvedValue("archive/notes..md");
      const cb = getToolCallback("vault_move");
      const result = await cb({ path: "a.md", destination: "archive/notes..md" });
      expect(ops.moveVaultFile).toHaveBeenCalledWith("a.md", "archive/notes..md", false);
      expect(parseText(result).newPath).toBe("archive/notes..md");
    });

    test("propagates FileNotFoundError from moveVaultFile", async () => {
      ops.moveVaultFile.mockRejectedValue(new Error("File not found: missing.md"));
      const cb = getToolCallback("vault_move");
      await expect(cb({ path: "missing.md", destination: "dest.md" })).rejects.toThrow(
        "File not found",
      );
    });
  });

  // ---- vault_copy -----------------------------------------------------------

  describe("vault_copy", () => {
    test("copies file and returns source and new paths", async () => {
      ops.copyVaultFile.mockResolvedValue("archive/file.md");
      const cb = getToolCallback("vault_copy");
      const result = await cb({ path: "folder/file.md", destination: "archive/file.md" });
      expect(ops.copyVaultFile).toHaveBeenCalledWith("folder/file.md", "archive/file.md", false);
      const parsed = parseText(result);
      expect(parsed.message).toBe("OK");
      expect(parsed.sourcePath).toBe("folder/file.md");
      expect(parsed.newPath).toBe("archive/file.md");
    });

    test("trailing-slash destination uses source filename", async () => {
      ops.copyVaultFile.mockResolvedValue("archive/todo.md");
      const cb = getToolCallback("vault_copy");
      const result = await cb({ path: "notes/todo.md", destination: "archive/" });
      expect(ops.copyVaultFile).toHaveBeenCalledWith("notes/todo.md", "archive/todo.md", false);
      expect(parseText(result).newPath).toBe("archive/todo.md");
    });

    test("passes allowOverwrite flag", async () => {
      const cb = getToolCallback("vault_copy");
      await cb({ path: "a.md", destination: "b.md", allowOverwrite: true });
      expect(ops.copyVaultFile).toHaveBeenCalledWith("a.md", "b.md", true);
    });

    test("empty destination copies to vault root preserving source filename", async () => {
      ops.copyVaultFile.mockResolvedValue("todo.md");
      const cb = getToolCallback("vault_copy");
      const result = await cb({ path: "notes/todo.md", destination: "" });
      expect(ops.copyVaultFile).toHaveBeenCalledWith("notes/todo.md", "todo.md", false);
      expect(parseText(result).newPath).toBe("todo.md");
    });

    test("rejects path traversal in destination", async () => {
      const cb = getToolCallback("vault_copy");
      await expect(cb({ path: "a.md", destination: "../../../etc/passwd" })).rejects.toThrow(
        "must not escape the vault root",
      );
      expect(ops.copyVaultFile).not.toHaveBeenCalled();
    });

    test("rejects absolute destination", async () => {
      const cb = getToolCallback("vault_copy");
      await expect(cb({ path: "a.md", destination: "/etc/passwd" })).rejects.toThrow(
        "must not escape the vault root",
      );
      expect(ops.copyVaultFile).not.toHaveBeenCalled();
    });

    test("allows destination with '..' as a substring (not a segment)", async () => {
      ops.copyVaultFile.mockResolvedValue("archive/notes..md");
      const cb = getToolCallback("vault_copy");
      const result = await cb({ path: "a.md", destination: "archive/notes..md" });
      expect(ops.copyVaultFile).toHaveBeenCalledWith("a.md", "archive/notes..md", false);
      expect(parseText(result).newPath).toBe("archive/notes..md");
    });

    test("propagates FileNotFoundError from copyVaultFile", async () => {
      ops.copyVaultFile.mockRejectedValue(new Error("File not found: missing.md"));
      const cb = getToolCallback("vault_copy");
      await expect(cb({ path: "missing.md", destination: "dest.md" })).rejects.toThrow(
        "File not found",
      );
    });
  });

  // ---- active_file_get_path -----------------------------------------------

  describe("active_file_get_path", () => {
    test("returns path of the active file", async () => {
      const cb = getToolCallback("active_file_get_path");
      const result = await cb({});
      expect(ops.app.workspace.getActiveFile).toHaveBeenCalled();
      expect(parseText(result).path).toBe("test.md");
    });

    test("throws when no file is active", async () => {
      ops.app.workspace.getActiveFile.mockReturnValue(null);
      const cb = getToolCallback("active_file_get_path");
      await expect(cb({})).rejects.toThrow("No active file");
    });
  });

  // ---- periodic_note_get_path ---------------------------------------------

  describe("periodic_note_get_path", () => {
    test("returns path of the current periodic note (creates if needed)", async () => {
      const cb = getToolCallback("periodic_note_get_path");
      const result = await cb({ period: "daily" });
      expect(ops.periodicGetOrCreateNote).toHaveBeenCalledWith(
        "daily",
        expect.any(Number),
      );
      expect(parseText(result).path).toBe("test.md");
    });

    test("throws when the periodic note cannot be resolved", async () => {
      ops.periodicGetOrCreateNote.mockResolvedValue([null, ErrorCode.PeriodDoesNotExist]);
      const cb = getToolCallback("periodic_note_get_path");
      await expect(cb({ period: "weekly" })).rejects.toThrow(
        "Could not get or create periodic note",
      );
    });
  });

  // ---- search_query -------------------------------------------------------

  test("search_query calls searchJsonLogic and returns results", async () => {
    const cb = getToolCallback("search_query");
    const query = { in: ["myTag", { var: "tags" }] };
    const result = await cb({ query });
    expect(ops.searchJsonLogic).toHaveBeenCalledWith(query);
    expect(parseText(result)).toEqual(
      expect.arrayContaining([expect.objectContaining({ filename: "a.md" })]),
    );
  });

  // ---- search_simple ------------------------------------------------------

  test("search_simple calls simpleSearch and returns results", async () => {
    const cb = getToolCallback("search_simple");
    const result = await cb({ query: "hello", contextLength: 50 });
    expect(ops.simpleSearch).toHaveBeenCalledWith("hello", 50);
    expect(parseText(result)).toEqual(
      expect.arrayContaining([expect.objectContaining({ filename: "a.md" })]),
    );
  });

  // ---- tag_list ----------------------------------------------------------

  test("tag_list returns all tags with counts", async () => {
    const cb = getToolCallback("tag_list");
    const result = await cb({});
    expect(ops.getAllTags).toHaveBeenCalled();
    expect(parseText(result).tags).toEqual([{ name: "todo", count: 3 }]);
  });

  // ---- command_list -------------------------------------------------------

  test("command_list returns all commands", async () => {
    const cb = getToolCallback("command_list");
    const result = await cb({});
    expect(ops.listCommands).toHaveBeenCalled();
    expect(parseText(result).commands).toEqual([
      { id: "cmd-id", name: "Command Name" },
    ]);
  });

  // ---- command_execute ----------------------------------------------------

  test("command_execute calls executeCommand and returns OK", async () => {
    const cb = getToolCallback("command_execute");
    const result = await cb({ commandId: "cmd-id" });
    expect(ops.executeCommand).toHaveBeenCalledWith("cmd-id");
    expect(parseText(result).message).toBe("OK");
  });

  test("command_execute propagates error when command not found", async () => {
    ops.executeCommand.mockImplementation(() => {
      throw new Error("Command not found: bad-id");
    });
    const cb = getToolCallback("command_execute");
    await expect(cb({ commandId: "bad-id" })).rejects.toThrow(
      "Command not found",
    );
  });

  // ---- open_file ----------------------------------------------------------

  test("open_file calls openVaultFile and returns OK", async () => {
    const cb = getToolCallback("open_file");
    const result = await cb({ path: "notes/foo.md", newLeaf: true });
    expect(ops.openVaultFile).toHaveBeenCalledWith("notes/foo.md", true);
    expect(parseText(result).message).toBe("OK");
  });

  // ---- handleRequest ------------------------------------------------------

  describe("handleRequest", () => {
    // Reset mock counts polluted by the outer beforeEach session build.
    beforeEach(() => jest.clearAllMocks());

    test("returns 404 when session ID is unknown", async () => {
      const mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      // @ts-ignore: using partial mock
      await mcp.handleRequest(
        { headers: { "mcp-session-id": "unknown" } },
        mockRes,
      );
      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    test("creates new transport and delegates when no session ID header", async () => {
      const { StreamableHTTPServerTransport } = jest.requireMock(
        "@modelcontextprotocol/sdk/server/streamableHttp.js",
      );
      const mcp = new McpHandler(ops, DEFAULT_SETTINGS);

      const mockReq = { headers: {}, body: { jsonrpc: "2.0", method: "initialize" } };
      const mockRes = {};
      // @ts-ignore
      await mcp.handleRequest(mockReq, mockRes);

      expect(StreamableHTTPServerTransport).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      const transport = StreamableHTTPServerTransport.mock.results[0].value;
      expect(transport.handleRequest).toHaveBeenCalledWith(mockReq, mockRes, mockReq.body);
    });

    test("delegates to existing transport when session ID matches", async () => {
      const { StreamableHTTPServerTransport } = jest.requireMock(
        "@modelcontextprotocol/sdk/server/streamableHttp.js",
      );
      const mcp = new McpHandler(ops, DEFAULT_SETTINGS);

      // Initialize: POST without session ID registers the transport via onsessioninitialized
      const initReq = { headers: {}, body: undefined };
      const initRes = {};
      // @ts-ignore
      await mcp.handleRequest(initReq, initRes);

      // Subsequent request with the assigned session ID
      const mockReq2 = { headers: { "mcp-session-id": mockNewSessionId } };
      const mockRes2 = {};
      // @ts-ignore
      await mcp.handleRequest(mockReq2, mockRes2);

      const transport = StreamableHTTPServerTransport.mock.results[0].value;
      expect(transport.handleRequest).toHaveBeenCalledTimes(2);
      expect(transport.handleRequest).toHaveBeenLastCalledWith(mockReq2, mockRes2, undefined);
    });
  });

  // ---- registerTool -------------------------------------------------------

  describe("registerTool", () => {
    test("registers a tool and returns a cleanup function", async () => {
      const mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      const cleanup = mcp.registerTool("my_tool", "Does something", {}, async () => "result");
      await buildSession(mcp);
      expect(mockTool).toHaveBeenCalledWith("my_tool", "Does something", {}, {}, expect.any(Function));
      expect(typeof cleanup).toBe("function");
    });

    test("throws when name collides with a built-in tool", () => {
      const mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      expect(() =>
        mcp.registerTool("vault_list", "Override", {}, async () => ""),
      ).toThrow(/already registered/);
    });

    test("throws when name collides with a previously registered plugin tool", () => {
      const mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      mcp.registerTool("custom_tool", "First", {}, async () => "");
      expect(() =>
        mcp.registerTool("custom_tool", "Second", {}, async () => ""),
      ).toThrow(/already registered/);
    });

    test("cleanup removes the tool and frees the name for re-registration", async () => {
      const mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      const cleanup = mcp.registerTool("removable_tool", "Desc", {}, async () => "");
      cleanup();
      // Name is freed for re-registration...
      expect(() =>
        mcp.registerTool("removable_tool", "Desc", {}, async () => ""),
      ).not.toThrow();
      // ...and the cleaned-up spec is not double-registered on a fresh server.
      jest.clearAllMocks();
      await buildSession(mcp);
      const removableCalls = mockTool.mock.calls.filter((c: unknown[]) => c[0] === "removable_tool");
      expect(removableCalls).toHaveLength(1);
    });
  });
});
