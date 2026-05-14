// jest.mock calls are hoisted before imports by ts-jest's babel transform.
// Variables prefixed with "mock" are also hoisted, so they can be safely
// referenced inside the factory functions below.

const mockTool = jest.fn();
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
    Promise.resolve().then(() => opts?.onsessioninitialized?.(mockNewSessionId));
    return transport;
  }),
}));

import { McpHandler } from "./mcpHandler";
import { ErrorCode } from "./types";
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
    getDocumentMapObject: jest.fn().mockResolvedValue({
      headings: ["Alpha", "Alpha::Subsection"],
      blocks: ["beta-block"],
      frontmatterFields: ["title", "priority"],
    }),
    readFileSection: jest.fn().mockResolvedValue("section content"),
    writeFileContent: jest.fn().mockResolvedValue(undefined),
    appendFileContent: jest.fn().mockResolvedValue(undefined),
    patchFileSection: jest.fn().mockResolvedValue("patched content"),
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

  test("registers all 15 tools", () => {
    expect(mockTool).toHaveBeenCalledTimes(15);
    const names = mockTool.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        "vault_list",
        "vault_read",
        "vault_write",
        "vault_append",
        "vault_patch",
        "vault_delete",
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

    test("calls readFileSection when targetType and target are provided", async () => {
      const cb = getToolCallback("vault_read");
      const result = await cb({ path: "test.md", targetType: "heading", target: "Alpha" });
      expect(ops.readFileSection).toHaveBeenCalledWith(
        expect.objectContaining({ path: "test.md" }),
        "heading",
        "Alpha",
        undefined,
      );
      expect(ops.getFileMetadataObject).not.toHaveBeenCalled();
      expect(parseText(result)).toBe("section content");
    });

    test("passes targetDelimiter to readFileSection", async () => {
      const cb = getToolCallback("vault_read");
      await cb({ path: "test.md", targetType: "heading", target: "A>B", targetDelimiter: ">" });
      expect(ops.readFileSection).toHaveBeenCalledWith(
        expect.anything(),
        "heading",
        "A>B",
        ">",
      );
    });

    test("falls back to full metadata when target is omitted", async () => {
      const cb = getToolCallback("vault_read");
      await cb({ path: "test.md", targetType: "heading" });
      expect(ops.readFileSection).not.toHaveBeenCalled();
      expect(ops.getFileMetadataObject).toHaveBeenCalled();
    });
  });

  // ---- vault_get_document_map ---------------------------------------------

  describe("vault_get_document_map", () => {
    test("calls getDocumentMapObject and returns the map", async () => {
      const cb = getToolCallback("vault_get_document_map");
      const result = await cb({ path: "test.md" });
      expect(ops.getDocumentMapObject).toHaveBeenCalled();
      const body = parseText(result);
      expect(body.headings).toEqual(["Alpha", "Alpha::Subsection"]);
      expect(body.blocks).toEqual(["beta-block"]);
      expect(body.frontmatterFields).toEqual(["title", "priority"]);
    });

    test("throws when file is not found", async () => {
      ops.app.vault.getAbstractFileByPath.mockReturnValue(null);
      const cb = getToolCallback("vault_get_document_map");
      await expect(cb({ path: "missing.md" })).rejects.toThrow("File not found");
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

  test("vault_patch passes applyIfContentPreexists to patchFileSection", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "heading",
      target: "Introduction",
      operation: "append",
      content: "new text",
      applyIfContentPreexists: true,
    });
    expect(ops.patchFileSection).toHaveBeenCalledWith(
      "out.md",
      "heading",
      "Introduction",
      "append",
      "new text",
      "text/markdown",
      expect.objectContaining({ applyIfContentPreexists: true }),
    );
  });

  // ---- vault_delete -------------------------------------------------------

  test("vault_delete calls deleteVaultFile and returns OK", async () => {
    const cb = getToolCallback("vault_delete");
    const result = await cb({ path: "old.md" });
    expect(ops.deleteVaultFile).toHaveBeenCalledWith("old.md");
    expect(parseText(result).message).toBe("OK");
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

    test("throws when the period is not enabled", async () => {
      ops.periodicGetOrCreateNote.mockResolvedValue([null, ErrorCode.PeriodIsNotEnabled]);
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
    test("returns 404 when session ID is unknown", async () => {
      const mcp = new McpHandler(ops);
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
      const mcp = new McpHandler(ops);

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
      const mcp = new McpHandler(ops);

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
});
