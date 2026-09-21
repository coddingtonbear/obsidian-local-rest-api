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
import { UrlSigner } from "./signedUrls";
import { ImageScaler, MaximumImageEdge } from "./imageScaling";
import { LocalRestApiSettings } from "./types";
import { TFile } from "../mocks/obsidian";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-06-18";
// The newest sessionful revision. Held as a literal on purpose — see the note on the same
// constant in mcpEndpoint.test.ts: reading the SDK's `LATEST_PROTOCOL_VERSION` instead
// would make the assertion agree with the SDK by construction.
const NEWEST_SESSIONFUL_VERSION = "2025-11-25";

// What the mock vault holds at `test.md`. `vault_read` reads a file's raw bytes and
// decodes them itself, so this is what every read of that path hands on to the ops layer.
const NOTE_TEXT = "# Alpha\n\nsection content\n";

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

function arrayBufferOf(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function bytesOf(text: string): ArrayBuffer {
  return arrayBufferOf(Buffer.from(text, "utf-8"));
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
    readBinaryFileContent: jest.fn().mockResolvedValue(bytesOf(NOTE_TEXT)),
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

  test("registers all 19 tools (the two signed-URL tools are there because that setting is on by default)", () => {
    expect(registerTool).toHaveBeenCalledTimes(19);
    const names = registerTool.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        "vault_get_download_url",
        "vault_get_upload_url",
        "vault_list",
        "vault_read",
        "vault_read_binary",
        "vault_write",
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
        NOTE_TEXT,
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
        NOTE_TEXT,
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
        NOTE_TEXT,
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
        NOTE_TEXT,
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
        NOTE_TEXT,
      );
    });

    test("passes a duplicate-block marker suffix through a block target unchanged", async () => {
      const cb = getToolCallback("vault_read");
      const disambiguated = "beta-block\u{FC750}\u{F6440}";
      await cb({ path: "test.md", targetType: "block", target: disambiguated });
      expect(ops.readFileSectionMdp2).toHaveBeenCalledWith(
        expect.anything(),
        { targetType: "block", target: disambiguated },
        NOTE_TEXT,
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

    // A file that is not text decodes anyway, with U+FFFD standing in for every byte
    // sequence UTF-8 could not represent — so the danger is that the read looks like it
    // worked. These cover both sides of that: bytes that were genuinely mangled, and text
    // that merely contains the same character.
    describe("non-text files", () => {
      // A one-pixel PNG: real bytes, whose 0x89 lead byte is not valid UTF-8.
      const PNG_BYTES = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );

      test("refuses a file whose bytes are not valid UTF-8, naming vault_read_binary", async () => {
        ops.readBinaryFileContent.mockResolvedValue(arrayBufferOf(PNG_BYTES));
        const cb = getToolCallback("vault_read");
        await expect(cb({ path: "attachments/pixel.png" })).rejects.toThrow(
          /not valid UTF-8.*vault_read_binary/s,
        );
        expect(ops.getFileMetadataObject).not.toHaveBeenCalled();
      });

      // The replacement character is not the test: a note that contains one is still a
      // note, because its own bytes are perfectly good UTF-8. Refusing it would be a
      // regression for its author.
      test("reads a text file that contains a literal replacement character", async () => {
        const text = `# Notes\n\nA pasted glyph survived as � here.\n`;
        ops.readBinaryFileContent.mockResolvedValue(bytesOf(text));
        const cb = getToolCallback("vault_read");
        await cb({ path: "notes.md" });
        expect(ops.getFileMetadataObject).toHaveBeenCalledWith(
          expect.anything(),
          undefined,
          true,
          text,
        );
      });

      // The whole point of decoding the bytes here rather than checking the text Obsidian
      // decoded: the file is read once, and the ops layer is handed what that read
      // produced instead of reading it again behind `cachedRead`.
      test("reads the file once and hands the decoded text to the metadata read", async () => {
        const cb = getToolCallback("vault_read");
        await cb({ path: "test.md" });
        expect(ops.readBinaryFileContent).toHaveBeenCalledTimes(1);
        expect(ops.readBinaryFileContent).toHaveBeenCalledWith("test.md");
        expect(ops.getFileMetadataObject).toHaveBeenCalledWith(
          expect.anything(),
          undefined,
          true,
          NOTE_TEXT,
        );
      });

      // A byte order mark is content: keeping it is what makes the string a caller reads
      // the same bytes a write of it would put back.
      test("keeps a leading byte order mark", async () => {
        // Spelled by code point: a literal BOM is invisible in an editor and would read
        // as an ordinary heading line.
        const text = `${String.fromCodePoint(0xfeff)}# Notes\n`;
        ops.readBinaryFileContent.mockResolvedValue(bytesOf(text));
        const cb = getToolCallback("vault_read");
        await cb({ path: "notes.md" });
        expect(ops.getFileMetadataObject).toHaveBeenCalledWith(
          expect.anything(),
          undefined,
          true,
          text,
        );
      });

      test("refuses a targeted read of a file whose bytes are not valid UTF-8", async () => {
        ops.readBinaryFileContent.mockResolvedValue(arrayBufferOf(PNG_BYTES));
        const cb = getToolCallback("vault_read");
        await expect(
          cb({ path: "attachments/pixel.png", targetType: "heading", target: ["Alpha"] }),
        ).rejects.toThrow(/not valid UTF-8/);
        expect(ops.readFileSectionMdp2).not.toHaveBeenCalled();
      });

      // A frontmatter read can return a number, an array, an object — anything YAML
      // parses to. The guard is on the file's bytes rather than on what was extracted
      // from them, so a non-string value passes through untouched.
      test("returns a non-string frontmatter value untouched", async () => {
        ops.readFileSectionMdp2.mockResolvedValue({ kind: "frontmatter", value: 3 });
        const cb = getToolCallback("vault_read");
        const result = await cb({
          path: "test.md",
          targetType: "frontmatter",
          target: "priority",
        });
        expect(parseText(result)).toBe(3);
      });

      test("does not read the file when the arguments are malformed", async () => {
        const cb = getToolCallback("vault_read");
        await expect(cb({ path: "test.md", targetType: "heading" })).rejects.toThrow(
          "targetType and target must be provided together",
        );
        expect(ops.readBinaryFileContent).not.toHaveBeenCalled();
      });
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

  // ---- vault_read_binary and the signed-URL tools --------------------------

  describe("binary files and signed URLs", () => {
    // A one-pixel PNG: real bytes, with a 0x89 lead byte that is not valid UTF-8, so a
    // round trip through the text tools could not produce it.
    const PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
    const PNG_PATH = "attachments/pixel.png";

    function arrayBufferOf(buffer: Buffer): ArrayBuffer {
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
    }

    // A scaler standing in for the renderer's canvas: records the request, answers with
    // a fixed payload so the test can tell scaled bytes from the originals.
    function fakeScaler() {
      return {
        scale: jest.fn(async () => ({
          data: Buffer.from("scaled-bytes"),
          mimeType: "image/png",
          width: 10,
          height: 5,
          transformed: true,
        })),
      };
    }

    // Build a handler (recording its registrations afresh), optionally with signed URLs on.
    function build(
      settings: LocalRestApiSettings = DEFAULT_SETTINGS,
      options: { signer?: UrlSigner; imageScaler?: ImageScaler | null } = {},
    ): McpHandler {
      registerTool.mockClear();
      const mcp = new McpHandler(ops, settings, { imageScaler: null, ...options });
      buildServer(mcp);
      return mcp;
    }

    // Signed URLs are on in DEFAULT_SETTINGS; these name the two states explicitly.
    const SIGNED: LocalRestApiSettings = { ...DEFAULT_SETTINGS, enableSignedUrls: true };
    const UNSIGNED: LocalRestApiSettings = { ...DEFAULT_SETTINGS, enableSignedUrls: false };

    // Run a callback as though its tool call had arrived on an HTTP request: the
    // signed-URL tools read the request's scheme and Host to build their links.
    function overHttp<T>(
      mcp: McpHandler,
      fn: () => Promise<T>,
      request: { headers?: Record<string, string>; encrypted?: boolean } = {},
    ): Promise<T> {
      const headers: Record<string, string> = { host: "127.0.0.1:27123", ...request.headers };
      const req = {
        get: (name: string) => headers[name.toLowerCase()],
        socket: { encrypted: request.encrypted ?? false },
      } as unknown as express.Request;
      // @ts-ignore: requestContext is private — the test stands in for handleRequest.
      return mcp.requestContext.run(req, fn);
    }

    function registeredNames(): string[] {
      return registerTool.mock.calls.map((c: unknown[]) => c[0] as string);
    }

    beforeEach(() => {
      const png = makeMockFile(PNG_PATH);
      png.stat.size = PNG_BYTES.byteLength;
      ops.app.vault.getAbstractFileByPath.mockImplementation((path: string) =>
        path === PNG_PATH || path === "data.bin" ? png : null,
      );
      ops.readBinaryFileContent.mockResolvedValue(arrayBufferOf(PNG_BYTES));
    });

    // ---- registration ------------------------------------------------------

    test("the signed-URL tools are registered only while the setting is on, which it is by default", () => {
      build(UNSIGNED);
      expect(registeredNames()).not.toContain("vault_get_download_url");
      expect(registeredNames()).not.toContain("vault_get_upload_url");
      expect(registerTool).toHaveBeenCalledTimes(17);
      build();
      expect(registeredNames()).toEqual(
        expect.arrayContaining(["vault_get_download_url", "vault_get_upload_url"]),
      );
      expect(registerTool).toHaveBeenCalledTimes(19);
    });

    test("setSignedUrlsEnabled adds and removes the tools without rebuilding the handler", () => {
      const mcp = build(UNSIGNED);
      mcp.setSignedUrlsEnabled(true);
      registerTool.mockClear();
      buildServer(mcp);
      expect(registeredNames()).toContain("vault_get_upload_url");
      mcp.setSignedUrlsEnabled(false);
      registerTool.mockClear();
      buildServer(mcp);
      expect(registeredNames()).not.toContain("vault_get_upload_url");
      // Idempotent in both directions.
      mcp.setSignedUrlsEnabled(false);
      mcp.setSignedUrlsEnabled(true);
      mcp.setSignedUrlsEnabled(true);
      registerTool.mockClear();
      buildServer(mcp);
      expect(registeredNames().filter((n) => n === "vault_get_upload_url")).toHaveLength(1);
    });

    // ---- vault_read_binary: images ------------------------------------------

    test("returns an image as a downscaled image block plus a text block describing it", async () => {
      const scaler = fakeScaler();
      build(DEFAULT_SETTINGS, { imageScaler: scaler });
      const result = await getToolCallback("vault_read_binary")({ path: PNG_PATH });
      expect(scaler.scale).toHaveBeenCalledTimes(1);
      const [bytes, mimeType, maxEdge] = scaler.scale.mock.calls[0] as unknown as [ArrayBuffer, string, number];
      expect(Buffer.from(bytes).equals(PNG_BYTES)).toBe(true);
      expect(mimeType).toBe("image/png");
      expect(maxEdge).toBe(MaximumImageEdge);
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({
        type: "image",
        data: Buffer.from("scaled-bytes").toString("base64"),
        mimeType: "image/png",
        annotations: { audience: ["user", "assistant"] },
      });
      expect(result.content[1].type).toBe("text");
      expect(JSON.parse(result.content[1].text)).toEqual({
        path: PNG_PATH,
        mimeType: "image/png",
        size: PNG_BYTES.byteLength,
        width: 10,
        height: 5,
      });
    });

    test("with no scaler in the runtime, a small model-readable image goes through as-is without dimensions", async () => {
      build(DEFAULT_SETTINGS, { imageScaler: null });
      const result = await getToolCallback("vault_read_binary")({ path: PNG_PATH });
      expect(result.content[0]).toMatchObject({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
      expect(JSON.parse(result.content[1].text)).toEqual({
        path: PNG_PATH,
        mimeType: "image/png",
        size: PNG_BYTES.byteLength,
      });
    });

    test("an image the renderer cannot decode falls through to the non-image path", async () => {
      const scaler = { scale: jest.fn().mockRejectedValue(new Error("not an image")) };
      build(UNSIGNED, { imageScaler: scaler });
      const result = await getToolCallback("vault_read_binary")({ path: PNG_PATH });
      expect(result.content[0].type).toBe("resource");
    });

    test("as: 'bytes' embeds an image's raw bytes without scaling", async () => {
      const scaler = fakeScaler();
      build(DEFAULT_SETTINGS, { imageScaler: scaler });
      const result = await getToolCallback("vault_read_binary")({ path: PNG_PATH, as: "bytes" });
      expect(scaler.scale).not.toHaveBeenCalled();
      expect(result.content).toEqual([
        {
          type: "resource",
          resource: {
            uri: "obsidian://local-rest-api/vault/attachments/pixel.png",
            mimeType: "image/png",
            blob: PNG_BASE64,
          },
        },
      ]);
    });

    // ---- vault_read_binary: SVG -----------------------------------------------

    const SVG_PATH = "diagrams/flow.svg";
    const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

    test("an SVG goes through unchanged as its source text, and never touches the scaler", async () => {
      const scaler = fakeScaler();
      build(DEFAULT_SETTINGS, { imageScaler: scaler });
      ops.readBinaryFileContent.mockResolvedValue(arrayBufferOf(Buffer.from(SVG_SOURCE, "utf-8")));
      const result = await getToolCallback("vault_read_binary")({ path: SVG_PATH });
      expect(scaler.scale).not.toHaveBeenCalled();
      expect(result.content).toEqual([
        {
          type: "resource",
          resource: {
            uri: "obsidian://local-rest-api/vault/diagrams/flow.svg",
            mimeType: "image/svg+xml",
            text: SVG_SOURCE,
          },
        },
        {
          type: "text",
          text: JSON.stringify({
            path: SVG_PATH,
            mimeType: "image/svg+xml",
            size: Buffer.byteLength(SVG_SOURCE, "utf-8"),
          }),
        },
      ]);
    });

    test("an SVG over the embedding ceiling falls through to the non-image path", async () => {
      const mcp = build(SIGNED);
      const svg = makeMockFile(SVG_PATH);
      ops.app.vault.getAbstractFileByPath.mockImplementation((path: string) => (path === SVG_PATH ? svg : null));
      ops.readBinaryFileContent.mockResolvedValue(new ArrayBuffer(MaximumMcpBinaryBytes + 1));
      const result = await overHttp(mcp, () => getToolCallback("vault_read_binary")({ path: SVG_PATH }));
      expect(result.content[0]).toMatchObject({ type: "resource_link", mimeType: "image/svg+xml" });
    });

    test("an SVG whose bytes are not UTF-8 falls through to the non-image path", async () => {
      build(UNSIGNED);
      ops.readBinaryFileContent.mockResolvedValue(arrayBufferOf(Buffer.from([0xff, 0xfe, 0x00])));
      const result = await getToolCallback("vault_read_binary")({ path: SVG_PATH });
      expect(result.content[0]).toMatchObject({
        type: "resource",
        resource: { mimeType: "image/svg+xml", blob: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") },
      });
    });

    // ---- vault_read_binary: everything else ----------------------------------

    test("embeds a small non-image file as a resource block when signed URLs are off", async () => {
      build(UNSIGNED);
      ops.readBinaryFileContent.mockResolvedValue(arrayBufferOf(Buffer.from([0, 1, 2])));
      const result = await getToolCallback("vault_read_binary")({ path: "data.bin" });
      expect(result.content).toEqual([
        {
          type: "resource",
          resource: {
            uri: "obsidian://local-rest-api/vault/data.bin",
            mimeType: "application/octet-stream",
            blob: Buffer.from([0, 1, 2]).toString("base64"),
          },
        },
      ]);
    });

    test("refuses to embed a file over the ceiling, pointing at REST and the setting when signed URLs are off", async () => {
      build(UNSIGNED);
      ops.readBinaryFileContent.mockResolvedValue(new ArrayBuffer(MaximumMcpBinaryBytes + 1));
      await expect(getToolCallback("vault_read_binary")({ path: "data.bin" })).rejects.toThrow(
        /limit is .* GET \/vault\/<path>.*Enable signed URLs/s,
      );
    });

    test("returns a signed link for a non-image file when signed URLs are on, whatever its size", async () => {
      const mcp = build(SIGNED);
      ops.readBinaryFileContent.mockResolvedValue(new ArrayBuffer(MaximumMcpBinaryBytes + 1));
      const result = await overHttp(mcp, () => getToolCallback("vault_read_binary")({ path: "data.bin" }));
      expect(result.content[0]).toMatchObject({
        type: "resource_link",
        name: "data.bin",
        mimeType: "application/octet-stream",
        size: PNG_BYTES.byteLength,
        annotations: { audience: ["user"] },
      });
      expect((result.content[0] as { uri: string }).uri).toMatch(
        /^http:\/\/127\.0\.0\.1:27123\/vault\/data\.bin\?sig=[0-9a-f]{64}&exp=\d+$/,
      );
      expect(result.content[1].type).toBe("text");
      expect(result.content[1].text).toContain("[data.bin](http://127.0.0.1:27123/vault/data.bin?sig=");
    });

    test("as: 'link' returns a signed link even for an image, and never reads the file", async () => {
      const scaler = fakeScaler();
      const mcp = build(SIGNED, { imageScaler: scaler });
      const result = await overHttp(mcp, () =>
        getToolCallback("vault_read_binary")({ path: PNG_PATH, as: "link" }),
      );
      expect(result.content[0].type).toBe("resource_link");
      expect(scaler.scale).not.toHaveBeenCalled();
      expect(ops.readBinaryFileContent).not.toHaveBeenCalled();
    });

    test("as: 'link' with signed URLs off fails naming the setting", async () => {
      build(UNSIGNED);
      await expect(
        getToolCallback("vault_read_binary")({ path: PNG_PATH, as: "link" }),
      ).rejects.toThrow(/Enable signed URLs/);
    });

    test("as: 'bytes' over the ceiling suggests a link when signed URLs are on", async () => {
      const mcp = build(SIGNED);
      ops.readBinaryFileContent.mockResolvedValue(new ArrayBuffer(MaximumMcpBinaryBytes + 1));
      await expect(
        overHttp(mcp, () => getToolCallback("vault_read_binary")({ path: "data.bin", as: "bytes" })),
      ).rejects.toThrow(/as: "link"/);
    });

    test("normalizes the path before reading, so a traversal-shaped path names the same file", async () => {
      build();
      await getToolCallback("vault_read_binary")({ path: "notes/../attachments/pixel.png" });
      expect(ops.readBinaryFileContent).toHaveBeenCalledWith(PNG_PATH);
      await expect(getToolCallback("vault_read_binary")({ path: "../outside.png" })).rejects.toThrow(
        /Not a file path inside the vault/,
      );
    });

    // ---- vault_get_download_url ---------------------------------------------

    test("vault_get_download_url builds the link from the request's scheme and host", async () => {
      const mcp = build(SIGNED);
      const cb = getToolCallback("vault_get_download_url");
      const plain = await overHttp(mcp, () => cb({ path: PNG_PATH }));
      expect((plain.content[0] as { uri: string }).uri).toMatch(
        /^http:\/\/127\.0\.0\.1:27123\/vault\/attachments\/pixel\.png\?sig=/,
      );
      const tls = await overHttp(mcp, () => cb({ path: PNG_PATH }), {
        encrypted: true,
        headers: { host: "vault.example.com:27124" },
      });
      expect((tls.content[0] as { uri: string }).uri).toMatch(
        /^https:\/\/vault\.example\.com:27124\/vault\//,
      );
      const proxied = await overHttp(mcp, () => cb({ path: PNG_PATH }), {
        headers: { "x-forwarded-proto": "https, http" },
      });
      expect((proxied.content[0] as { uri: string }).uri).toMatch(/^https:\/\/127\.0\.0\.1:27123\//);
    });

    test("the minted link verifies against the signer the REST side shares", async () => {
      const signer = new UrlSigner();
      const mcp = build(SIGNED, { signer });
      const result = await overHttp(mcp, () => getToolCallback("vault_get_download_url")({ path: PNG_PATH }));
      const url = new URL((result.content[0] as { uri: string }).uri);
      expect(
        signer.verify("GET", PNG_PATH, url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? ""),
      ).toBe("ok");
      expect(
        signer.verify("PUT", PNG_PATH, url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? ""),
      ).toBe("invalid");
    });

    test("vault_get_download_url refuses a file that does not exist", async () => {
      const mcp = build(SIGNED);
      await expect(
        overHttp(mcp, () => getToolCallback("vault_get_download_url")({ path: "missing.png" })),
      ).rejects.toThrow(/File not found/);
    });

    test("the signed-URL tools fail clearly when called outside an HTTP request", async () => {
      build(SIGNED);
      await expect(getToolCallback("vault_get_download_url")({ path: PNG_PATH })).rejects.toThrow(
        /did not arrive over HTTP/,
      );
    });

    // ---- vault_get_upload_url -----------------------------------------------

    test("vault_get_upload_url returns a single-use PUT link with a ready-to-run curl command", async () => {
      const signer = new UrlSigner();
      const mcp = build(SIGNED, { signer });
      const result = await overHttp(mcp, () =>
        getToolCallback("vault_get_upload_url")({ path: "attachments/new photo.jpg" }),
      );
      const body = parseText(result);
      expect(body).toMatchObject({
        method: "PUT",
        path: "attachments/new photo.jpg",
        contentType: "image/jpeg",
        singleUse: true,
      });
      expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:27123\/vault\/attachments\/new%20photo\.jpg\?sig=/);
      expect(body.command).toBe(
        `curl -X PUT -H "Content-Type: image/jpeg" --data-binary @"new photo.jpg" "${body.url}"`,
      );
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const url = new URL(body.url);
      expect(
        signer.verify("PUT", "attachments/new photo.jpg", url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? ""),
      ).toBe("ok");
    });

    test("vault_get_upload_url honours the configured lifetime", async () => {
      const mcp = build({ ...SIGNED, signedUrlTtlSeconds: 60 });
      const before = Date.now();
      const body = parseText(
        await overHttp(mcp, () => getToolCallback("vault_get_upload_url")({ path: "a.bin" })),
      );
      const expiresIn = (new Date(body.expiresAt).getTime() - before) / 1000;
      expect(expiresIn).toBeGreaterThan(55);
      expect(expiresIn).toBeLessThanOrEqual(61);
    });

    // ---- the text tools refuse binary targets ---------------------------------

    test.each([
      ["a PNG path", "attachments/pixel.png", "hello", /image\/png.*vault_get_upload_url/s],
      ["a PDF path", "docs/paper.pdf", "hello", /application\/pdf/],
      ["content with a NUL byte", "notes/odd.md", "text\0more", /NUL byte/],
    ])("vault_write and vault_append refuse %s", async (_label, path, content, pattern) => {
      build();
      await expect(getToolCallback("vault_write")({ path, content })).rejects.toThrow(pattern);
      await expect(getToolCallback("vault_append")({ path, content })).rejects.toThrow(pattern);
      expect(ops.writeFileContent).not.toHaveBeenCalled();
      expect(ops.appendFileContent).not.toHaveBeenCalled();
    });

    test("vault_write still writes text types, unknown extensions, and SVG (an image type that is text)", async () => {
      build();
      await getToolCallback("vault_write")({ path: "notes/a.md", content: "# hi" });
      await getToolCallback("vault_write")({ path: "data/config.json", content: "{}" });
      await getToolCallback("vault_write")({ path: "no-extension", content: "x" });
      await getToolCallback("vault_write")({ path: "diagrams/flow.svg", content: "<svg/>" });
      expect(ops.writeFileContent).toHaveBeenCalledTimes(4);
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
      expect(first.body.result.tools).toHaveLength(19);
      expect(second.body.result.tools).toHaveLength(19);
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

      expect(res.body.result.tools).toHaveLength(19);
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
      expect(message.result.tools).toHaveLength(19);
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

  // ---- signed-URL tools over HTTP ------------------------------------------
  //
  // The signed-URL tools build their links from the request they arrived on, which they
  // reach through async context rather than anything the SDK passes them. That context
  // has to survive the SDK's own request handling on both legs, so each is exercised
  // end to end here: a link comes back carrying the Host header supertest sent.

  describe("signed-URL tools over HTTP", () => {
    let mcp: McpHandler;
    let app: express.Express;

    function sseResult(text: string) {
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      if (!line) throw new Error(`No SSE data line in:\n${text}`);
      return JSON.parse(line.slice("data:".length));
    }

    beforeEach(() => {
      const png = makeMockFile("attachments/pixel.png");
      png.stat.size = 70;
      ops.app.vault.getAbstractFileByPath.mockReturnValue(png);
      mcp = new McpHandler(ops, { ...DEFAULT_SETTINGS, enableSignedUrls: true }, { imageScaler: null });
      app = makeApp(mcp);
    });

    afterEach(() => {
      mcp.close();
    });

    test("the sessionless leg hands the tool the request it arrived on", async () => {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("Host", "vault.local:27123")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "tools/call")
        .set("Mcp-Name", "vault_get_download_url")
        .send(
          sessionlessRequest(1, "tools/call", {
            name: "vault_get_download_url",
            arguments: { path: "attachments/pixel.png" },
          }),
        )
        .expect(200);

      expect(res.body.error).toBeUndefined();
      const link = res.body.result.content[0];
      expect(link.type).toBe("resource_link");
      expect(link.uri).toMatch(/^http:\/\/vault\.local:27123\/vault\/attachments\/pixel\.png\?sig=/);
    });

    test("the sessionful leg hands the tool the request it arrived on, not the handshake's", async () => {
      const init = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("Host", "handshake.local:1")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LEGACY_VERSION,
            capabilities: {},
            clientInfo: { name: "sessionful-client", version: "1.0.0" },
          },
        })
        .expect(200);
      const sessionId = init.headers["mcp-session-id"];

      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("Host", "later.local:2")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "vault_get_upload_url", arguments: { path: "attachments/new.png" } },
        })
        .expect(200);

      const body = JSON.parse(sseResult(res.text).result.content[0].text);
      expect(body.url).toMatch(/^http:\/\/later\.local:2\/vault\/attachments\/new\.png\?sig=/);
    });
  });
});
