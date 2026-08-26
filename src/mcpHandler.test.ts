// jest.mock calls are hoisted before imports by ts-jest's babel transform.

// Prevent ts-jest from compiling vaultOperations.ts (which pulls in json-logic-js
// with a deeply recursive RulesLogic type that OOMs TypeScript 4.7). The real
// VaultOperations is never instantiated in these tests — makeMockOps() provides
// a plain object with the same surface.
jest.mock("./vaultOperations", () => ({
  VaultOperations: jest.fn(),
}));

import express from "express";
import request from "supertest";
import { McpServer } from "@modelcontextprotocol/server";

import { McpHandler } from "./mcpHandler";
import { DEFAULT_SETTINGS, MaximumMcpBinaryBytes } from "./constants";
import { TFile } from "../mocks/obsidian";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-06-18";
// The newest sessionful revision. Held as a literal on purpose — see the note on the same
// constant in mcpEndpoint.test.ts: reading the SDK's `LATEST_PROTOCOL_VERSION` instead
// would make the assertion agree with the SDK by construction.
const NEWEST_SESSIONFUL_VERSION = "2025-11-25";

// The real McpServer is used throughout: the 2026-07-28 serving entries build one per
// request from McpHandler's factory, so there is nothing to substitute. Registrations are
// observed by spying on the prototype and then building a server directly.
let registerTool: jest.SpyInstance;
let registerResource: jest.SpyInstance;


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
    readBinaryFileContent: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
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
  };
}

// Returns the callback registered for the named tool.
function getToolCallback(toolName: string) {
  const call = registerTool.mock.calls.find((c: unknown[]) => c[0] === toolName);
  if (!call) throw new Error(`Tool "${toolName}" was not registered`);
  // registerTool(name, config, callback)
  return call[2] as (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

// Returns the annotations object registered for the named tool.
function getToolAnnotations(toolName: string) {
  const call = registerTool.mock.calls.find((c: unknown[]) => c[0] === toolName);
  if (!call) throw new Error(`Tool "${toolName}" was not registered`);
  return (call[1] as { annotations: Record<string, boolean> }).annotations;
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
// HTTP helpers — the endpoint is exercised through the same express wiring the
// request handler mounts, so the SDK's Streamable HTTP behavior is under test too.
// ---------------------------------------------------------------------------

function makeApp(mcp: McpHandler) {
  const app = express();
  app.use(express.json());
  app.all("/mcp/", (req, res, next) => {
    mcp.handleRequest(req, res).catch(next);
  });
  return app;
}

function sessionlessEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "unit-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
    ...overrides,
  };
}

function sessionlessRequest(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: sessionlessEnvelope(envelopeOverrides) },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpHandler", () => {
   
  let ops: any;

  // Every request builds a fresh McpServer from the handler's specs, so tool and
  // resource registration is observed by building one server directly.
  function buildServer(mcp: McpHandler): void {
    // @ts-ignore: buildServer is private — the test observes what a request would build.
    mcp.buildServer();
  }

  beforeEach(() => {
    registerTool = jest.spyOn(McpServer.prototype, "registerTool");
    registerResource = jest.spyOn(McpServer.prototype, "registerResource");
    ops = makeMockOps();
    // Construction records specs; building a server registers them.
    buildServer(new McpHandler(ops, DEFAULT_SETTINGS));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---- resource registration ----------------------------------------------

  test("registers the openapi-spec resource", () => {
    expect(registerResource).toHaveBeenCalledTimes(1);
    const [name, uri] = registerResource.mock.calls[0] as [string, string];
    expect(name).toBe("openapi-spec");
    expect(uri).toBe("obsidian://local-rest-api/openapi.yaml");
  });

  // ---- tool registration --------------------------------------------------

  test("registers all 18 tools", () => {
    expect(registerTool).toHaveBeenCalledTimes(18);
    const names = registerTool.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        "vault_list",
        "vault_read",
        "vault_read_binary",
        "vault_write",
        "vault_write_binary",
        "vault_append",
        "vault_patch",
        "vault_delete",
        "vault_move",
        "vault_copy",
        "vault_get_document_map",
        "active_file_get_path",
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
        "vault_read_binary",
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
      for (const call of registerTool.mock.calls) {
        const { annotations } = call[1] as { annotations: Record<string, boolean> };
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

    // Some MCP clients don't resolve anyOf parameter schemas and forward the
    // raw JSON text of an array argument as a string (#315). A heading target
    // string that parses to an array of strings is accepted as that array.
    test("accepts a JSON-encoded string heading target", async () => {
      const cb = getToolCallback("vault_read");
      await cb({
        path: "test.md",
        targetType: "heading",
        target: '["Parent", "Child"]',
      });
      expect(ops.readFileSectionMdp2).toHaveBeenCalledWith(
        expect.anything(),
        { targetType: "heading", target: ["Parent", "Child"] },
      );
    });

    test("mentions anyOf client support when a heading target string is not a JSON array", async () => {
      const cb = getToolCallback("vault_read");
      await expect(
        cb({ path: "test.md", targetType: "heading", target: "Alpha" }),
      ).rejects.toThrow(/anyOf/);
      expect(ops.readFileSectionMdp2).not.toHaveBeenCalled();
    });

    test("rejects a JSON-encoded heading target whose elements are not all strings", async () => {
      const cb = getToolCallback("vault_read");
      await expect(
        cb({ path: "test.md", targetType: "heading", target: '["Parent", 2]' }),
      ).rejects.toThrow("must be an array");
      expect(ops.readFileSectionMdp2).not.toHaveBeenCalled();
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

  // ---- vault_read_binary / vault_write_binary ------------------------------

  describe("binary tools", () => {
    // A one-pixel PNG: real bytes, with a 0x89 lead byte that is not valid UTF-8, so a
    // round trip through the text tools could not produce it.
    const PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

    function arrayBufferOf(buffer: Buffer): ArrayBuffer {
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
    }

    test("vault_read_binary returns the bytes base64-encoded with a mime type and size", async () => {
      ops.readBinaryFileContent.mockResolvedValue(arrayBufferOf(PNG_BYTES));
      const cb = getToolCallback("vault_read_binary");
      const result = await cb({ path: "attachments/pixel.png" });
      expect(ops.readBinaryFileContent).toHaveBeenCalledWith("attachments/pixel.png");
      expect(parseText(result)).toEqual({
        path: "attachments/pixel.png",
        mimeType: "image/png",
        size: PNG_BYTES.byteLength,
        encoding: "base64",
        content: PNG_BASE64,
      });
    });

    test("vault_read_binary falls back to application/octet-stream for an unknown extension", async () => {
      ops.readBinaryFileContent.mockResolvedValue(arrayBufferOf(Buffer.from([0, 1, 2])));
      const cb = getToolCallback("vault_read_binary");
      expect(parseText(await cb({ path: "data.zzz" })).mimeType).toBe(
        "application/octet-stream",
      );
    });

    test("vault_read_binary refuses a file over the ceiling instead of returning it", async () => {
      ops.readBinaryFileContent.mockResolvedValue(
        new ArrayBuffer(MaximumMcpBinaryBytes + 1),
      );
      const cb = getToolCallback("vault_read_binary");
      await expect(cb({ path: "big.bin" })).rejects.toThrow(
        /Refusing to read .* GET or PUT \/vault/s,
      );
    });

    test("vault_write_binary decodes base64 and hands writeFileContent a Buffer", async () => {
      const cb = getToolCallback("vault_write_binary");
      const result = await cb({ path: "attachments/pixel.png", content: PNG_BASE64 });
      expect(ops.writeFileContent).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenContent] = ops.writeFileContent.mock.calls[0];
      expect(writtenPath).toBe("attachments/pixel.png");
      expect(Buffer.isBuffer(writtenContent)).toBe(true);
      // The bytes must survive intact — this is the whole point of the tool.
      expect((writtenContent as Buffer).equals(PNG_BYTES)).toBe(true);
      expect(parseText(result)).toEqual({ message: "OK", size: PNG_BYTES.byteLength });
    });

    test("vault_write_binary tolerates whitespace-wrapped base64", async () => {
      const cb = getToolCallback("vault_write_binary");
      const wrapped = PNG_BASE64.replace(/(.{40})/g, "$1\n");
      await cb({ path: "attachments/pixel.png", content: wrapped });
      const [, writtenContent] = ops.writeFileContent.mock.calls[0];
      expect((writtenContent as Buffer).equals(PNG_BYTES)).toBe(true);
    });

    test.each([
      ["a bad length", "iVBOR"],
      ["a character outside the alphabet", "iVBO*w0KGgo="],
      ["base64url input", "-_-_"],
      ["a non-canonical encoding", "QR=="],
    ])(
      "vault_write_binary rejects %s rather than writing mangled bytes",
      async (_label: string, content: string) => {
        const cb = getToolCallback("vault_write_binary");
        await expect(cb({ path: "attachments/pixel.png", content })).rejects.toThrow(
          /must be standard base64/,
        );
        expect(ops.writeFileContent).not.toHaveBeenCalled();
      },
    );

    test("vault_write_binary refuses a payload over the ceiling", async () => {
      const cb = getToolCallback("vault_write_binary");
      const oversized = Buffer.alloc(MaximumMcpBinaryBytes + 3).toString("base64");
      await expect(
        cb({ path: "big.bin", content: oversized }),
      ).rejects.toThrow(/Refusing to write/);
      expect(ops.writeFileContent).not.toHaveBeenCalled();
    });

    test("vault_write_binary writes an empty file for an empty payload", async () => {
      const cb = getToolCallback("vault_write_binary");
      const result = await cb({ path: "empty.bin", content: "" });
      const [, writtenContent] = ops.writeFileContent.mock.calls[0];
      expect((writtenContent as Buffer).byteLength).toBe(0);
      expect(parseText(result).size).toBe(0);
    });
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

  // Same anyOf-client accommodation as vault_read (#315): a heading target
  // arriving as the JSON text of an array is parsed before reaching the engine.
  test("vault_patch accepts a JSON-encoded string heading target", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "heading",
      target: '["Overview", "Details"]',
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

  test("vault_patch accepts the JSON-encoded string 'null' as a heading document-root target", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "heading",
      target: "null",
      operation: "append",
      content: "new text",
    });
    expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
      targetType: "heading",
      target: null,
      operation: "append",
      content: "new text",
    });
  });

  test("vault_patch rejects an unparseable bare-string heading target before calling the engine", async () => {
    const cb = getToolCallback("vault_patch");
    await expect(
      cb({
        path: "out.md",
        targetType: "heading",
        target: "Overview",
        operation: "append",
        content: "new text",
      }),
    ).rejects.toThrow(/anyOf/);
    expect(ops.patchFileSectionMdp2).not.toHaveBeenCalled();
  });

  test("vault_patch does not JSON-parse block or frontmatter string targets", async () => {
    const cb = getToolCallback("vault_patch");
    await cb({
      path: "out.md",
      targetType: "frontmatter",
      target: '["a", "b"]',
      operation: "replace",
      value: 1,
    });
    expect(ops.patchFileSectionMdp2).toHaveBeenCalledWith("out.md", {
      targetType: "frontmatter",
      target: '["a", "b"]',
      operation: "replace",
      value: 1,
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

  describe("handleRequest — sessionless (2026-07-28) path", () => {
    let mcp: McpHandler;
    let app: express.Express;

    beforeEach(() => {
      mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      app = makeApp(mcp);
    });

    afterEach(() => {
      mcp.close();
    });

    test("answers tools/call without any session, and mints no session id", async () => {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "tools/call")
        .set("Mcp-Name", "vault_list")
        .send(sessionlessRequest(1, "tools/call", { name: "vault_list", arguments: { path: "some/dir" } }))
        .expect(200);

      expect(res.headers["mcp-session-id"]).toBeUndefined();
      expect(res.body.error).toBeUndefined();
      expect(res.body.result.resultType).toBe("complete");
      expect(JSON.parse(res.body.result.content[0].text).files).toEqual(["file1.md", "folder/"]);
      expect(ops.listVaultDirectory).toHaveBeenCalledWith("some/dir");
    });

    test("serves consecutive requests independently — no initialize, no session state", async () => {
      const send = (id: number) =>
        request(app)
          .post("/mcp/")
          .set("Accept", "application/json, text/event-stream")
          .set("MCP-Protocol-Version", MODERN_VERSION)
          .set("Mcp-Method", "tools/list")
          .send(sessionlessRequest(id, "tools/list"))
          .expect(200);

      const first = await send(1);
      const second = await send(2);
      expect(first.body.result.tools).toHaveLength(18);
      expect(second.body.result.tools).toHaveLength(18);
      expect(first.headers["mcp-session-id"]).toBeUndefined();
      expect(second.headers["mcp-session-id"]).toBeUndefined();
    });

    test("server/discover advertises the 2026-07-28 revision, capabilities, and server identity", async () => {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "server/discover")
        .send(sessionlessRequest(1, "server/discover"))
        .expect(200);

      expect(res.body.result.supportedVersions).toContain(MODERN_VERSION);
      expect(res.body.result.capabilities.tools).toBeDefined();
      expect(res.body.result.capabilities.resources).toBeDefined();
      expect(res.body.result.resultType).toBe("complete");
      expect(res.body.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
        name: "obsidian-local-rest-api",
        version: "1.0.0",
      });
    });

    test("cacheable results carry the required ttlMs and cacheScope fields", async () => {
      const discover = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "server/discover")
        .send(sessionlessRequest(1, "server/discover"))
        .expect(200);
      expect(discover.body.result.ttlMs).toBe(300_000);
      expect(discover.body.result.cacheScope).toBe("private");

      const tools = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "tools/list")
        .send(sessionlessRequest(2, "tools/list"))
        .expect(200);
      expect(tools.body.result.ttlMs).toBe(60_000);
      expect(tools.body.result.cacheScope).toBe("private");

      const resources = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "resources/list")
        .send(sessionlessRequest(3, "resources/list"))
        .expect(200);
      expect(resources.body.result.ttlMs).toBe(60_000);
      expect(resources.body.result.cacheScope).toBe("private");
    });

    test("reads the openapi-spec resource", async () => {
      const uri = "obsidian://local-rest-api/openapi.yaml";
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "resources/read")
        .set("Mcp-Name", uri)
        .send(sessionlessRequest(1, "resources/read", { uri }))
        .expect(200);

      expect(res.body.result.contents[0].mimeType).toBe("application/yaml");
      expect(res.body.result.ttlMs).toBe(60_000);
    });

    test("rejects a request whose Mcp-Method header disagrees with the body (-32020)", async () => {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "tools/call")
        .send(sessionlessRequest(1, "tools/list"))
        .expect(400);

      expect(res.body.error.code).toBe(-32020);
    });

    test("rejects a request with no Mcp-Method header (-32020)", async () => {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .send(sessionlessRequest(1, "tools/list"))
        .expect(400);

      expect(res.body.error.code).toBe(-32020);
    });

    test("rejects an unsupported protocol version with -32022 and names what it serves", async () => {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", "2027-01-01")
        .set("Mcp-Method", "tools/list")
        .send(
          sessionlessRequest(1, "tools/list", {}, {
            "io.modelcontextprotocol/protocolVersion": "2027-01-01",
          }),
        )
        .expect(400);

      expect(res.body.error.code).toBe(-32022);
      expect(res.body.error.data.supported).toContain(MODERN_VERSION);
    });

    test("rejects a malformed _meta envelope with -32602", async () => {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "tools/list")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION },
          },
        })
        .expect(400);

      expect(res.body.error.code).toBe(-32602);
    });

    test("ignores a stale Mcp-Session-Id header rather than routing on it", async () => {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "tools/list")
        .set("Mcp-Session-Id", "a-session-that-never-existed")
        .send(sessionlessRequest(1, "tools/list"))
        .expect(200);

      expect(res.body.result.tools).toHaveLength(18);
      expect(res.headers["mcp-session-id"]).toBeUndefined();
    });

    test("tools registered after construction are served on the next request", async () => {
      mcp.registerTool("extension_tool", "From an extension", {}, async () => "hi");
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "tools/list")
        .send(sessionlessRequest(1, "tools/list"))
        .expect(200);

      const names = (res.body.result.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain("extension_tool");
    });
  });

  describe("handleRequest — sessionful (2024-10-07 … 2025-11-25) path", () => {
    let mcp: McpHandler;
    let app: express.Express;

    beforeEach(() => {
      mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      app = makeApp(mcp);
    });

    afterEach(() => {
      mcp.close();
    });

    // The sessionful leg answers on an SSE stream, so responses are read out of the
    // `event: message` frames rather than from a JSON body.
    function sseResult(text: string) {
      const line = text.split("\n").find((l) => l.startsWith("data: "));
      if (!line) throw new Error(`No SSE data frame in response: ${text}`);
      return JSON.parse(line.slice("data: ".length));
    }

    async function initializeAt(
      version: string,
    ): Promise<{ sessionId: string; result: any }> {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: version,
            capabilities: {},
            clientInfo: { name: "sessionful-client", version: "1.0.0" },
          },
        })
        .expect(200);
      return { sessionId: res.headers["mcp-session-id"], result: sseResult(res.text).result };
    }

    async function initialize(): Promise<{ sessionId: string; result: any }> {
      return initializeAt(LEGACY_VERSION);
    }

    test("answers the initialize handshake for sessionful clients", async () => {
      const { result } = await initialize();
      expect(result.protocolVersion).toBe(LEGACY_VERSION);
      expect(result.serverInfo.name).toBe("obsidian-local-rest-api");
      // Sessionful-leg results carry none of the 2026-07-28 wire fields.
      expect(result.resultType).toBeUndefined();
      expect(result.ttlMs).toBeUndefined();
    });

    test("initialize opens a session and hands back its id", async () => {
      const { sessionId } = await initialize();
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);
    });

    test("negotiates the newest sessionful revision unchanged rather than downgrading", async () => {
      // The upper end of this describe's stated range. A client asking for a revision the
      // handler cannot serve is answered with an older one it can, so a silent downgrade —
      // not an error — is how losing 2025-11-25 would present. Asserting the echo is what
      // separates the two.
      const { sessionId, result } = await initializeAt(NEWEST_SESSIONFUL_VERSION);
      expect(result.protocolVersion).toBe(NEWEST_SESSIONFUL_VERSION);
      expect(result.serverInfo.name).toBe("obsidian-local-rest-api");
      expect(typeof sessionId).toBe("string");
    });

    test("advertises listChanged capabilities it can actually honour", async () => {
      // The sessionful leg keeps sessions precisely so that this advertisement stays true: a
      // client told `listChanged: true` waits for notifications instead of re-polling.
      const { result } = await initialize();
      expect(result.capabilities.tools.listChanged).toBe(true);
      expect(result.capabilities.resources.listChanged).toBe(true);
    });

    test("serves tools/call on an established session", async () => {
      const { sessionId } = await initialize();
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "vault_list", arguments: { path: "some/dir" } },
        })
        .expect(200);

      const message = sseResult(res.text);
      expect(JSON.parse(message.result.content[0].text).files).toEqual(["file1.md", "folder/"]);
    });

    test("advertises the same tool list as the sessionless leg", async () => {
      const { sessionId } = await initialize();
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
        .expect(200);

      const message = sseResult(res.text);
      expect(message.result.tools).toHaveLength(18);
      const vaultList = (message.result.tools as { name: string; inputSchema: unknown }[]).find(
        (t) => t.name === "vault_list",
      );
      expect(vaultList?.inputSchema).toMatchObject({
        type: "object",
        properties: { path: { type: "string" } },
      });
    });

    test("a tool registered after the handshake is visible to the live session", async () => {
      const { sessionId } = await initialize();
      mcp.registerTool("extension_tool", "From an extension", {}, async () => "hi");

      const listed = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })
        .expect(200);

      const names = (sseResult(listed.text).result.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain("extension_tool");

      const called = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "extension_tool", arguments: {} },
        })
        .expect(200);
      expect(sseResult(called.text).result.content[0].text).toBe("hi");
    });

    test("registering a tool notifies live sessions", async () => {
      const { sessionId } = await initialize();
      const session = [...(mcp as unknown as {
        sessions: Map<string, { server: { sendToolListChanged: () => void } }>;
      }).sessions.values()][0];
      const sendToolListChanged = jest.spyOn(session.server, "sendToolListChanged");

      mcp.registerTool("notifying_tool", "From an extension", {}, async () => "hi");

      expect(sendToolListChanged).toHaveBeenCalled();
      expect(sessionId).toBeTruthy();
    });

    test("a tool removed after the handshake disappears from the live session", async () => {
      const { sessionId } = await initialize();
      const cleanup = mcp.registerTool("temporary_tool", "Goes away", {}, async () => "hi");
      cleanup();

      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} })
        .expect(200);

      const names = (sseResult(res.text).result.tools as { name: string }[]).map((t) => t.name);
      expect(names).not.toContain("temporary_tool");
    });

    test("an unknown session id is rejected with 404", async () => {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", "a-session-that-never-existed")
        .send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} })
        .expect(404);

      expect(res.body.error).toMatch(/Session not found/);
    });

    test("DELETE terminates the session, and later requests on it are 404ed", async () => {
      const { sessionId } = await initialize();
      await request(app).delete("/mcp/").set("Mcp-Session-Id", sessionId).expect(200);

      await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} })
        .expect(404);
    });

    test("close() drops every open session", async () => {
      const { sessionId } = await initialize();
      mcp.close();

      await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })
        .expect(404);
    });
  });

  // ---- registerTool -------------------------------------------------------

  describe("registerTool", () => {
    test("registers a tool and returns a cleanup function", () => {
      const mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      const cleanup = mcp.registerTool("my_tool", "Does something", {}, async () => "result");
      registerTool.mockClear();
      buildServer(mcp);
      expect(registerTool).toHaveBeenCalledWith(
        "my_tool",
        expect.objectContaining({ description: "Does something", annotations: {} }),
        expect.any(Function),
      );
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

    test("cleanup removes the tool and frees the name for re-registration", () => {
      const mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      const cleanup = mcp.registerTool("removable_tool", "Desc", {}, async () => "");
      cleanup();
      // Name is freed for re-registration...
      expect(() =>
        mcp.registerTool("removable_tool", "Desc", {}, async () => ""),
      ).not.toThrow();
      // ...and the cleaned-up spec is not double-registered on a fresh server.
      registerTool.mockClear();
      buildServer(mcp);
      const removableCalls = registerTool.mock.calls.filter((c: unknown[]) => c[0] === "removable_tool");
      expect(removableCalls).toHaveLength(1);
    });
  });
});
