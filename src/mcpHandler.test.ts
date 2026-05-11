// jest.mock calls are hoisted before imports by ts-jest's babel transform.
// Variables prefixed with "mock" are also hoisted, so they can be safely
// referenced inside the factory functions below.

const mockTool = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockHandlePostMessage = jest.fn().mockResolvedValue(undefined);
const mockSseSessionId = "test-session-id";

const mockResource = jest.fn();

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    tool: mockTool,
    resource: mockResource,
    connect: mockConnect,
  })),
}));

jest.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
  SSEServerTransport: jest.fn().mockImplementation(() => ({
    sessionId: mockSseSessionId,
    handlePostMessage: mockHandlePostMessage,
    start: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { McpHandler } from "./mcpHandler";
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
    }),
    writeFileContent: jest.fn().mockResolvedValue(undefined),
    appendFileContent: jest.fn().mockResolvedValue(undefined),
    patchFileSection: jest.fn().mockResolvedValue("patched content"),
    deleteVaultFile: jest.fn().mockResolvedValue(undefined),
    simpleSearch: jest
      .fn()
      .mockResolvedValue([{ filename: "a.md", score: 1, matches: [] }]),
    getAllTags: jest.fn().mockReturnValue([{ name: "todo", count: 3 }]),
    listCommands: jest
      .fn()
      .mockReturnValue([{ id: "cmd-id", name: "Command Name" }]),
    executeCommand: jest.fn(),
    openVaultFile: jest.fn(),
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
  // tool(name, description, schema, callback) — callback is always last
  return call[call.length - 1] as (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ops: any;

  beforeEach(() => {
    jest.clearAllMocks();
    ops = makeMockOps();
    // Construction registers all tools via registerTools()
    new McpHandler(ops);
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
        "active_file_read",
        "active_file_write",
        "active_file_append",
        "periodic_note_read",
        "periodic_note_write",
        "periodic_note_append",
        "search_simple",
        "tags_list",
        "commands_list",
        "command_execute",
        "open_file",
      ]),
    );
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

  test("vault_patch calls patchFileSection with correct args", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "heading",
      target: "Introduction",
      operation: "append",
      content: "new text",
      contentType: "text/markdown",
    });
    expect(ops.patchFileSection).toHaveBeenCalledWith(
      "out.md",
      "heading",
      "Introduction",
      "append",
      "new text",
      "text/markdown",
      expect.objectContaining({}),
    );
  });

  // ---- vault_delete -------------------------------------------------------

  test("vault_delete calls deleteVaultFile and returns OK", async () => {
    const cb = getToolCallback("vault_delete");
    const result = await cb({ path: "old.md" });
    expect(ops.deleteVaultFile).toHaveBeenCalledWith("old.md");
    expect(parseText(result).message).toBe("OK");
  });

  // ---- active_file_read ---------------------------------------------------

  test("active_file_read returns metadata for the active file", async () => {
    const cb = getToolCallback("active_file_read");
    const result = await cb({});
    expect(ops.app.workspace.getActiveFile).toHaveBeenCalled();
    expect(ops.getFileMetadataObject).toHaveBeenCalled();
    expect(parseText(result).path).toBe("test.md");
  });

  test("active_file_read throws when no file is active", async () => {
    ops.app.workspace.getActiveFile.mockReturnValue(null);
    const cb = getToolCallback("active_file_read");
    await expect(cb({})).rejects.toThrow("No active file");
  });

  // ---- active_file_write --------------------------------------------------

  test("active_file_write writes to the active file", async () => {
    const cb = getToolCallback("active_file_write");
    await cb({ content: "new content" });
    expect(ops.writeFileContent).toHaveBeenCalledWith("test.md", "new content");
  });

  // ---- active_file_append -------------------------------------------------

  test("active_file_append appends to the active file", async () => {
    const cb = getToolCallback("active_file_append");
    await cb({ content: "\nextra" });
    expect(ops.appendFileContent).toHaveBeenCalledWith("test.md", "\nextra");
  });

  // ---- periodic_note_read -------------------------------------------------

  test("periodic_note_read returns daily note metadata", async () => {
    const cb = getToolCallback("periodic_note_read");
    const result = await cb({ period: "daily" });
    expect(ops.periodicGetNote).toHaveBeenCalledWith("daily", expect.any(Number));
    expect(parseText(result).path).toBe("test.md");
  });

  test("periodic_note_read throws when note does not exist", async () => {
    ops.periodicGetNote.mockReturnValue([null, "PeriodicNoteDoesNotExist"]);
    const cb = getToolCallback("periodic_note_read");
    await expect(cb({ period: "daily" })).rejects.toThrow();
  });

  // ---- periodic_note_write ------------------------------------------------

  test("periodic_note_write creates and writes note", async () => {
    const cb = getToolCallback("periodic_note_write");
    await cb({ period: "weekly", content: "week content" });
    expect(ops.periodicGetOrCreateNote).toHaveBeenCalledWith(
      "weekly",
      expect.any(Number),
    );
    expect(ops.writeFileContent).toHaveBeenCalledWith("test.md", "week content");
  });

  // ---- periodic_note_append -----------------------------------------------

  test("periodic_note_append appends to periodic note", async () => {
    const cb = getToolCallback("periodic_note_append");
    await cb({ period: "monthly", content: "- item" });
    expect(ops.appendFileContent).toHaveBeenCalledWith("test.md", "- item");
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

  // ---- tags_list ----------------------------------------------------------

  test("tags_list returns all tags with counts", async () => {
    const cb = getToolCallback("tags_list");
    const result = await cb({});
    expect(ops.getAllTags).toHaveBeenCalled();
    expect(parseText(result).tags).toEqual([{ name: "todo", count: 3 }]);
  });

  // ---- commands_list ------------------------------------------------------

  test("commands_list returns all commands", async () => {
    const cb = getToolCallback("commands_list");
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

  // ---- handlePost ---------------------------------------------------------

  describe("handlePost", () => {
    test("returns 404 when session is not found", async () => {
      const mcp = new McpHandler(ops);
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      // @ts-ignore: using partial mock
      await mcp.handlePost(
        { query: { sessionId: "unknown" } },
        mockRes,
      );
      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    test("delegates to transport when session exists", async () => {
      const { SSEServerTransport } = jest.requireMock(
        "@modelcontextprotocol/sdk/server/sse.js",
      );
      const mcp = new McpHandler(ops);

      // Simulate an established SSE session
      const mockReqSse = {
        on: jest.fn(),
      };
      const mockResSse = {
        writeHead: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        setHeader: jest.fn(),
        getHeader: jest.fn(),
        on: jest.fn(),
      };
      // @ts-ignore
      await mcp.handleSse(mockReqSse, mockResSse);

      const transport = SSEServerTransport.mock.results[0].value;

      const mockReqPost = { query: { sessionId: mockSseSessionId } };
      const mockResPost = {};
      // @ts-ignore
      await mcp.handlePost(mockReqPost, mockResPost);

      expect(transport.handlePostMessage).toHaveBeenCalledWith(
        mockReqPost,
        mockResPost,
      );
    });
  });
});
