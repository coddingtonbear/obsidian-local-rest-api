// jest.mock calls are hoisted before imports by ts-jest's babel transform.

// Prevent ts-jest from compiling vaultOperations.ts (which pulls in json-logic-js
// with a deeply recursive RulesLogic type that OOMs TypeScript 4.7). The real
// VaultOperations is never instantiated in these tests — makeMockOps() provides
// a plain object with the same surface.
jest.mock("./vaultOperations", () => ({
  VaultOperations: jest.fn(),
}));

import { execFileSync } from "child_process";
import { existsSync } from "fs";

import express from "express";
import request from "supertest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { McpHandler, markdownLink } from "./mcpHandler";
import { DEFAULT_SETTINGS, MaximumMcpBinaryBytes } from "./constants";
import { UrlSigner } from "./signedUrls";
import type { EventStreams } from "./events";
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

describe("markdownLink", () => {
  test.each([
    // The label is a vault filename, and the tool descriptions ask an agent to repeat
    // this link in its reply -- so an unescaped `]` would choose where a reader is sent.
    ["report](https://example.invalid/).pdf", "[report\\](https://example.invalid/).pdf]"],
    ["a[b].png", "[a\\[b\\].png]"],
    ["*bold*_it_`code`.png", "[\\*bold\\*\\_it\\_\\`code\\`.png]"],
    ["<tag>.png", "[\\<tag\\>.png]"],
    ["plain.png", "[plain.png]"],
  ])("escapes %s in the label", (label, expectedPrefix) => {
    expect(markdownLink(label, "http://h/v/x")).toBe(`${expectedPrefix}(http://h/v/x)`);
  });

  test("encodes parentheses in the destination, which would otherwise end it early", () => {
    expect(markdownLink("a.png", "http://h/v/a(1).png?sig=x")).toBe(
      "[a.png](http://h/v/a%281%29.png?sig=x)",
    );
  });

  test("folds newlines, since a label cannot span lines", () => {
    expect(markdownLink("two\nlines.png", "http://h")).toBe("[two lines.png](http://h)");
  });
});

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
      options: { signer?: UrlSigner; imageScaler?: ImageScaler | null; events?: EventStreams } = {},
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
        annotations: { audience: ["user", "assistant"], priority: 0.9 },
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

    // A scaler that mirrors CanvasImageScaler's early return: an image already inside
    // `MaximumImageEdge` is handed straight back, original bytes and all, with nothing
    // resized or re-encoded.
    function passthroughScaler() {
      return {
        scale: jest.fn(async (bytes: ArrayBuffer, mimeType: string) => ({
          data: Buffer.from(bytes),
          mimeType,
          width: 1536,
          height: 864,
          transformed: false,
        })),
      };
    }

    test("an image too large to inline comes back as a link rather than an image block", async () => {
      // The regression this guards: a large-but-not-wide image (1536x864, well inside
      // MaximumImageEdge) is never resized, so the scaler returns its original bytes and
      // the result used to carry the whole file as base64 -- which killed Obsidian's
      // renderer outright. It has to degrade to a link instead.
      const scaler = passthroughScaler();
      const mcp = build(SIGNED, { imageScaler: scaler });
      ops.readBinaryFileContent.mockResolvedValue(new ArrayBuffer(MaximumMcpBinaryBytes + 1));
      const result = await overHttp(mcp, () => getToolCallback("vault_read_binary")({ path: PNG_PATH }));
      expect(scaler.scale).toHaveBeenCalledTimes(1);
      expect(result.content[0].type).toBe("resource_link");
      expect(result.content.some((c: { type: string }) => c.type === "image")).toBe(false);
    });

    test("an image still over the ceiling after downscaling comes back as a link", async () => {
      const scaler = {
        scale: jest.fn(async () => ({
          data: Buffer.alloc(MaximumMcpBinaryBytes + 1),
          mimeType: "image/png",
          width: MaximumImageEdge,
          height: MaximumImageEdge,
          transformed: true,
        })),
      };
      const mcp = build(SIGNED, { imageScaler: scaler });
      const result = await overHttp(mcp, () => getToolCallback("vault_read_binary")({ path: PNG_PATH }));
      expect(result.content[0].type).toBe("resource_link");
    });

    test("an oversized image with signed URLs off refuses rather than inlining it", async () => {
      const scaler = passthroughScaler();
      build(UNSIGNED, { imageScaler: scaler });
      ops.readBinaryFileContent.mockResolvedValue(new ArrayBuffer(MaximumMcpBinaryBytes + 1));
      await expect(getToolCallback("vault_read_binary")({ path: PNG_PATH })).rejects.toThrow(
        /limit is .* GET \/vault\/<path>/s,
      );
    });

    test("an image exactly at the ceiling is still inlined", async () => {
      const scaler = {
        scale: jest.fn(async () => ({
          data: Buffer.alloc(MaximumMcpBinaryBytes),
          mimeType: "image/png",
          width: 10,
          height: 5,
          transformed: true,
        })),
      };
      build(SIGNED, { imageScaler: scaler });
      const result = await getToolCallback("vault_read_binary")({ path: PNG_PATH });
      expect(result.content[0].type).toBe("image");
    });

    test("an oversized file is refused from its stat, without being read", async () => {
      build(UNSIGNED, { imageScaler: null });
      const big = makeMockFile("attachments/huge.bin");
      big.stat = { ctime: 0, mtime: 0, size: MaximumMcpBinaryBytes + 1 };
      ops.app.vault.getAbstractFileByPath.mockReturnValue(big);
      ops.readBinaryFileContent.mockClear();
      await expect(
        getToolCallback("vault_read_binary")({ path: "attachments/huge.bin", as: "bytes" }),
      ).rejects.toThrow(/Refusing to embed/);
      // The point of the fix: the refusal comes from the stat, so a multi-gigabyte file
      // is never pulled into the renderer only to be rejected afterwards.
      expect(ops.readBinaryFileContent).not.toHaveBeenCalled();
    });

    test.each([
      ["diagrams/flow.svg", null],
      ["diagrams/flow.SVG", null],
      ["diagrams/flow.svgz", "image/svg+xml"],
      ["diagrams/flow.SVGZ", "image/svg+xml"],
    ])("vault_write treats %s correctly", async (path, refusedAs) => {
      build(DEFAULT_SETTINGS, { imageScaler: null });
      const call = getToolCallback("vault_write")({ path, content: "<svg/>" });
      if (refusedAs === null) {
        await expect(call).resolves.toBeDefined();
      } else {
        // `mime-types` maps .svgz to image/svg+xml as well, but it is a gzip stream --
        // exempting by MIME type alone let a text write destroy the attachment.
        await expect(call).rejects.toThrow(/Refusing to write .* as text/);
      }
    });

    test.each([
      "archives/a.bz2",
      "archives/a.xz",
      "archives/a.7z",
      "archives/a.rar",
      "archives/a.tar",
      "archives/a.epub",
      "archives/a.cab",
      "archives/a.iso",
      "archives/a.zip",
      "archives/a.gz",
    ])("vault_write refuses %s as text", async (path) => {
      build(DEFAULT_SETTINGS, { imageScaler: null });
      // The explicit list missed .bz2 and .xz outright; matching +zip/+gzip and
      // -compressed by shape covers the vendor containers mime-db knows about too.
      await expect(getToolCallback("vault_write")({ path, content: "x" })).rejects.toThrow(
        /Refusing to write .* as text/,
      );
    });

    test.each(["notes/a.md", "notes/a.txt", "data/a.json", "diagrams/a.svg"])(
      "vault_write still accepts %s",
      async (path) => {
        build(DEFAULT_SETTINGS, { imageScaler: null });
        await expect(getToolCallback("vault_write")({ path, content: "x" })).resolves.toBeDefined();
      },
    );

    // ---- vault_read_binary: SVG -----------------------------------------------

    const SVG_PATH = "diagrams/flow.svg";
    const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

    // An SVG is never reduced, so its size is now decided from the stat before any read
    // -- which means these tests need the file to exist in the mock vault, not just in
    // `readBinaryFileContent`.
    function svgFileExists(size = SVG_SOURCE.length): void {
      const f = makeMockFile(SVG_PATH);
      f.stat = { ctime: 0, mtime: 0, size };
      ops.app.vault.getAbstractFileByPath.mockReturnValue(f);
    }

    test("an SVG goes through unchanged as its source text, and never touches the scaler", async () => {
      const scaler = fakeScaler();
      build(DEFAULT_SETTINGS, { imageScaler: scaler });
      svgFileExists();
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
      svgFileExists(3);
      ops.readBinaryFileContent.mockResolvedValue(arrayBufferOf(Buffer.from([0xff, 0xfe, 0x00])));
      const result = await getToolCallback("vault_read_binary")({ path: SVG_PATH });
      expect(result.content[0]).toMatchObject({
        type: "resource",
        resource: { mimeType: "image/svg+xml", blob: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") },
      });
    });

    test("an oversized SVG is decided from its stat, without being read", async () => {
      const mcp = build(SIGNED, { imageScaler: null });
      svgFileExists(MaximumMcpBinaryBytes + 1);
      ops.readBinaryFileContent.mockClear();
      const result = await overHttp(mcp, () => getToolCallback("vault_read_binary")({ path: SVG_PATH }));
      // An SVG is returned as its own source and is never reduced, so the stat decides.
      // Previously it was read in full, `svgTextResult` returned null at the cap, and the
      // bytes were discarded in favour of exactly this link.
      expect(result.content[0].type).toBe("resource_link");
      expect(ops.readBinaryFileContent).not.toHaveBeenCalled();
    });

    test("an oversized image with no scaler in the runtime is also decided from its stat", async () => {
      const mcp = build(SIGNED, { imageScaler: null });
      const f = makeMockFile(PNG_PATH);
      f.stat = { ctime: 0, mtime: 0, size: MaximumMcpBinaryBytes + 1 };
      ops.app.vault.getAbstractFileByPath.mockReturnValue(f);
      ops.readBinaryFileContent.mockClear();
      const result = await overHttp(mcp, () => getToolCallback("vault_read_binary")({ path: PNG_PATH }));
      // Nothing can shrink it without a scaler, so there is no reason to read it first.
      expect(result.content[0].type).toBe("resource_link");
      expect(ops.readBinaryFileContent).not.toHaveBeenCalled();
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
        annotations: {
          audience: ["user", "assistant"],
          priority: 0.9,
          lastModified: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      });
      // The prose fallback restates the link, so it is ranked below it: a client with
      // room for only one block should keep the structured link.
      expect(result.content[1]).toMatchObject({
        type: "text",
        annotations: { audience: ["user", "assistant"], priority: 0.3 },
      });
      expect((result.content[0] as { uri: string }).uri).toMatch(
        /^http:\/\/127\.0\.0\.1:27123\/vault\/data\.bin\?sig=[0-9a-f]{64}&exp=\d+&n=[A-Za-z0-9_-]+$/,
      );
      expect(result.content[1].type).toBe("text");
      expect(result.content[1].text).toContain("[data.bin](http://127.0.0.1:27123/vault/data.bin?sig=");
      // Deliberately thin: mimeType and size are structured fields on the resource_link
      // block above, so the text block carries only the pasteable link and the expiry.
      expect(result.content[1].text).toContain("link valid until");
      expect(result.content[1].text).not.toContain("application/octet-stream");
      expect(result.content[1].text).not.toMatch(/\d+ bytes/);
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
        signer.verify("GET", PNG_PATH, url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? "", url.searchParams.get("n") ?? ""),
      ).toBe("ok");
      expect(
        signer.verify("PUT", PNG_PATH, url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? "", url.searchParams.get("n") ?? ""),
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

    // ---- events_get_listener_url --------------------------------------------

    // The subscription and URL machinery is exercised end to end in events.test.ts; here
    // it is a stand-in, so these check only what the tool itself decides.
    function fakeEvents() {
      const createListener = jest.fn(
        (emitter: string, event: string, _filter: unknown, _ttl: number, baseUrl: string) => ({
          id: "sub1",
          emitter,
          event,
          url: `${baseUrl}/events/${emitter}/${event}/sub1/?sig=s&exp=1&n=n`,
          signed: true,
          expiresAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      return { events: { createListener } as unknown as EventStreams, createListener };
    }

    test("events_get_listener_url is registered only with signed URLs on and an event source", () => {
      const { events } = fakeEvents();
      build(UNSIGNED, { events });
      expect(registeredNames()).not.toContain("events_get_listener_url");
      build(SIGNED);
      expect(registeredNames()).not.toContain("events_get_listener_url");
      build(SIGNED, { events });
      expect(registeredNames()).toContain("events_get_listener_url");
    });

    test("events_get_listener_url registers a subscription and returns its URL and a curl command", async () => {
      const { events, createListener } = fakeEvents();
      const signer = new UrlSigner();
      const mcp = build({ ...SIGNED, signedUrlTtlSeconds: 120 }, { events, signer });
      const filter = { glob: ["notes/*", { var: "path" }] };
      const result = await overHttp(mcp, () =>
        getToolCallback("events_get_listener_url")({ emitter: "vault", event: "modify", filter }),
      );
      expect(createListener).toHaveBeenCalledWith(
        "vault",
        "modify",
        filter,
        120,
        "http://127.0.0.1:27123",
        signer,
      );
      const body = JSON.parse((result.content[0] as { text: string }).text) as Record<string, string>;
      expect(body.url).toBe("http://127.0.0.1:27123/events/vault/modify/sub1/?sig=s&exp=1&n=n");
      expect(body.command).toBe(`curl -N '${body.url}'`);
      expect(body.expiresAt).toBe("2026-01-01T00:00:00.000Z");
    });

    test("events_get_listener_url treats an empty filter as no filter", async () => {
      const { events, createListener } = fakeEvents();
      const mcp = build(SIGNED, { events });
      await overHttp(mcp, () =>
        getToolCallback("events_get_listener_url")({ emitter: "workspace", event: "file-open", filter: {} }),
      );
      expect(createListener.mock.calls[0][2]).toBeNull();
    });

    test("events_get_listener_url refuses an event that is not streamable", async () => {
      const { events, createListener } = fakeEvents();
      const mcp = build(SIGNED, { events });
      await expect(
        overHttp(mcp, () =>
          getToolCallback("events_get_listener_url")({ emitter: "workspace", event: "quick-preview" }),
        ),
      ).rejects.toThrow(/not a streamable workspace event.*file-open/);
      expect(createListener).not.toHaveBeenCalled();
    });

    // ---- vault_get_upload_url -----------------------------------------------

    test.each([
      ["$(echo PWNED).png", "'$(echo PWNED).png'"],
      ["`id`.png", "'`id`.png'"],
      ["a b;rm -rf x.png", "'a b;rm -rf x.png'"],
      ["it's.png", "'it'\\''s.png'"],
      ["$HOME.png", "'$HOME.png'"],
    ])("the advertised curl command quotes %s so a shell cannot expand it", async (name, quoted) => {
      const mcp = build(SIGNED, { signer: new UrlSigner() });
      const result = await overHttp(mcp, () =>
        getToolCallback("vault_get_upload_url")({ path: `attachments/${name}` }),
      );
      // JSON.stringify would double-quote these, and a shell expands $, ` and $() inside
      // double quotes -- so the ready-to-run command became code execution on paste.
      expect(parseText(result).command).toContain(`--data-binary @${quoted} `);
      expect(parseText(result).command).not.toContain(`--data-binary @"`);
    });

    test("a hostile Host header cannot break out of the advertised command", async () => {
      const mcp = build(SIGNED, { signer: new UrlSigner() });
      const result = await overHttp(
        mcp,
        () => getToolCallback("vault_get_upload_url")({ path: "attachments/a.png" }),
        { headers: { host: '127.0.0.1:27123"; touch /tmp/pwned; echo "' } },
      );
      const { command, url } = parseText(result) as { command: string; url: string };
      // The URL is built from the request's Host, so it is attacker-influenced. Quoting
      // the filename alone left this half of the command exposed. Double quotes may still
      // appear -- inside the single-quoted URL, where they are inert -- so the assertion
      // that matters is what a shell actually parses the command into.
      const argv = execFileSync(
        "/bin/sh",
        ["-c", `printf '%s\\n' ${command.replace(/^curl /, "")}`],
        { encoding: "utf-8" },
      )
        .split("\n")
        .filter(Boolean);
      expect(argv).toContain(url);
      expect(argv).toContain("Content-Type: image/png");
      expect(argv.some((a) => a.includes("touch /tmp/pwned"))).toBe(true);
      expect(existsSync("/tmp/pwned")).toBe(false);
    });

    test("vault_get_upload_url returns a single-use PUT link with a ready-to-run curl command", async () => {
      const signer = new UrlSigner();
      const mcp = build(SIGNED, { signer });
      const result = await overHttp(mcp, () =>
        getToolCallback("vault_get_upload_url")({ path: "attachments/new photo.jpg" }),
      );
      const body = parseText(result);
      // `path` is the normalized target, not an echo: this tool overwrites without
      // warning, so what the argument resolved to is worth stating.
      expect(body).toMatchObject({
        path: "attachments/new photo.jpg",
        contentType: "image/jpeg",
      });
      // `method` and `singleUse` are constants the tool description already states, so
      // they are deliberately absent rather than restated on every call.
      expect(body).not.toHaveProperty("method");
      expect(body).not.toHaveProperty("singleUse");
      expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:27123\/vault\/attachments\/new%20photo\.jpg\?sig=/);
      expect(body.command).toBe(
        `curl -X PUT -H 'Content-Type: image/jpeg' --data-binary @'new photo.jpg' '${body.url}'`,
      );
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const url = new URL(body.url);
      expect(
        signer.verify("PUT", "attachments/new photo.jpg", url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? "", url.searchParams.get("n") ?? ""),
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

  // ---- extension tool definitions, resources, and prompts ------------------
  //
  // The richer registrations behind the extension API's object-form `addMcpTool`,
  // `addMcpResource`, `addMcpResourceTemplate`, and `addMcpPrompt`, exercised end to end
  // so that what reaches the client is what the extension returned.

  describe("extension registrations over HTTP", () => {
    let mcp: McpHandler;
    let app: express.Express;

    beforeEach(() => {
      mcp = new McpHandler(ops, DEFAULT_SETTINGS);
      app = makeApp(mcp);
    });

    afterEach(() => {
      mcp.close();
    });

    async function send(method: string, params: Record<string, unknown> = {}, name?: string) {
      let req = request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", method);
      if (name !== undefined) req = req.set("Mcp-Name", name);
      const res = await req.send(sessionlessRequest(1, method, params)).expect(200);
      return res.body;
    }

    function sseResult(text: string) {
      const line = text.split("\n").find((l) => l.startsWith("data: "));
      if (!line) throw new Error(`No SSE data frame in response: ${text}`);
      return JSON.parse(line.slice("data: ".length));
    }

    async function openSession(): Promise<string> {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
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
      return res.headers["mcp-session-id"];
    }

    async function sendOnSession(sessionId: string, method: string, params: Record<string, unknown> = {}) {
      const res = await request(app)
        .post("/mcp/")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({ jsonrpc: "2.0", id: 2, method, params })
        .expect(200);
      return sseResult(res.text);
    }

    describe("tool definitions", () => {
      test("passes the callback's result through unchanged", async () => {
        const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;
        mcp.registerToolDefinition({
          name: "picture_tool",
          description: "Returns a picture",
          callback: async () => ({ content: [{ type: "text", text: "caption" }, image] }),
        });

        const body = await send("tools/call", { name: "picture_tool", arguments: {} }, "picture_tool");
        expect(body.result.content).toEqual([{ type: "text", text: "caption" }, image]);
        expect(body.result.isError).toBeUndefined();
      });

      test("passes content annotations through unchanged", async () => {
        const text = {
          type: "text",
          text: "For the reader",
          annotations: { audience: ["user"], priority: 0.9, lastModified: "2026-09-25T14:00:00Z" },
        } as const;
        const link = {
          type: "resource_link",
          uri: "tandem://index",
          name: "tandem-index",
          annotations: { audience: ["assistant"] },
        } as const;
        mcp.registerToolDefinition({
          name: "annotated_tool",
          description: "Returns annotated content",
          callback: async () => ({ content: [text, link] }),
        });

        const body = await send("tools/call", { name: "annotated_tool", arguments: {} }, "annotated_tool");
        expect(body.result.content).toEqual([text, link]);
      });

      test("keeps a deliberate isError result rather than treating it as a failure", async () => {
        mcp.registerToolDefinition({
          name: "failing_tool",
          description: "Reports an error",
          callback: async () => ({ content: [{ type: "text", text: "No such note" }], isError: true }),
        });

        const body = await send("tools/call", { name: "failing_tool", arguments: {} }, "failing_tool");
        expect(body.error).toBeUndefined();
        expect(body.result.isError).toBe(true);
        expect(body.result.content).toEqual([{ type: "text", text: "No such note" }]);
      });

      test("hands the callback its validated arguments", async () => {
        const callback = jest.fn(async (args: Record<string, unknown>) => ({
          content: [{ type: "text" as const, text: JSON.stringify(args) }],
        }));
        mcp.registerToolDefinition({
          name: "args_tool",
          description: "Echoes",
          inputSchema: { path: z.string() },
          callback,
        });

        const body = await send(
          "tools/call",
          { name: "args_tool", arguments: { path: "a.md" } },
          "args_tool",
        );
        expect(callback).toHaveBeenCalledWith({ path: "a.md" });
        expect(JSON.parse(body.result.content[0].text)).toEqual({ path: "a.md" });
      });

      test("advertises title and outputSchema, and returns structuredContent", async () => {
        mcp.registerToolDefinition({
          name: "structured_tool",
          title: "Structured tool",
          description: "Counts",
          outputSchema: { count: z.number() },
          callback: async () => ({
            content: [{ type: "text", text: '{"count":3}' }],
            structuredContent: { count: 3 },
          }),
        });

        const listed = await send("tools/list");
        const tool = (listed.result.tools as { name: string }[]).find((t) => t.name === "structured_tool");
        expect(tool).toMatchObject({
          title: "Structured tool",
          outputSchema: { type: "object", properties: { count: { type: "number" } } },
        });

        const called = await send("tools/call", { name: "structured_tool", arguments: {} }, "structured_tool");
        expect(called.result.structuredContent).toEqual({ count: 3 });
      });

      test("rejects structuredContent that does not match the outputSchema", async () => {
        mcp.registerToolDefinition({
          name: "lying_tool",
          description: "Claims a number, returns a string",
          outputSchema: { count: z.number() },
          callback: async () => ({
            content: [{ type: "text", text: "oops" }],
            structuredContent: { count: "three" },
          }),
        });

        const body = await send("tools/call", { name: "lying_tool", arguments: {} }, "lying_tool");
        const failed = body.error !== undefined || body.result?.isError === true;
        expect(failed).toBe(true);
      });

      test("shares the tool namespace with the positional form", () => {
        mcp.registerTool("shared_name", "Positional", {}, async () => "");
        expect(() =>
          mcp.registerToolDefinition({
            name: "shared_name",
            description: "Object form",
            callback: async () => ({ content: [] }),
          }),
        ).toThrow(/already registered/);
        expect(() =>
          mcp.registerToolDefinition({
            name: "vault_list",
            description: "Shadowing a built-in",
            callback: async () => ({ content: [] }),
          }),
        ).toThrow(/already registered/);
      });
    });

    describe("resources", () => {
      test("lists and reads a fixed-URI resource", async () => {
        mcp.registerResource({
          name: "tandem-index",
          uri: "tandem://index",
          description: "Every note with comments",
          mimeType: "application/json",
          read: async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: "[]" }] }),
        });

        const listed = await send("resources/list");
        expect(listed.result.resources).toContainEqual(
          expect.objectContaining({
            uri: "tandem://index",
            name: "tandem-index",
            description: "Every note with comments",
            mimeType: "application/json",
          }),
        );
        // The built-in resource is still there alongside it.
        expect((listed.result.resources as { uri: string }[]).map((r) => r.uri)).toContain(
          "obsidian://local-rest-api/openapi.yaml",
        );

        const read = await send("resources/read", { uri: "tandem://index" }, "tandem://index");
        expect(read.result.contents).toEqual([
          { uri: "tandem://index", mimeType: "application/json", text: "[]" },
        ]);
      });

      test("passes a read result's _meta through", async () => {
        mcp.registerResource({
          name: "meta-resource",
          uri: "tandem://meta",
          read: async (uri) => ({
            contents: [{ uri: uri.href, text: "{}" }],
            _meta: { "tandem/revision": 7 },
          }),
        });

        const read = await send("resources/read", { uri: "tandem://meta" }, "tandem://meta");
        expect(read.result._meta).toMatchObject({ "tandem/revision": 7 });
      });

      test("refuses a URI that is already registered, including a built-in one", () => {
        const read = async (uri: URL) => ({ contents: [{ uri: uri.href, text: "" }] });
        mcp.registerResource({ name: "one", uri: "tandem://index", read });
        expect(() => mcp.registerResource({ name: "two", uri: "tandem://index", read })).toThrow(
          /already registered/,
        );
        expect(() =>
          mcp.registerResource({ name: "spec", uri: "obsidian://local-rest-api/openapi.yaml", read }),
        ).toThrow(/already registered/);
      });

      test("removal takes the resource off the list and frees its URI", async () => {
        const read = async (uri: URL) => ({ contents: [{ uri: uri.href, text: "" }] });
        const cleanup = mcp.registerResource({ name: "temp", uri: "tandem://temp", read });
        cleanup();

        const listed = await send("resources/list");
        expect((listed.result.resources as { uri: string }[]).map((r) => r.uri)).not.toContain(
          "tandem://temp",
        );
        expect(() => mcp.registerResource({ name: "temp", uri: "tandem://temp", read })).not.toThrow();
      });
    });

    describe("resource templates", () => {
      test("advertises the template, lists its resources, and reads with matched variables", async () => {
        const read = jest.fn(async (uri: URL, variables: Record<string, string | string[]>) => ({
          contents: [{ uri: uri.href, text: `comments on ${String(variables.path)}` }],
        }));
        mcp.registerResourceTemplate({
          name: "tandem-comments",
          uriTemplate: "tandem://comments/{path}",
          description: "Comments on one note",
          mimeType: "text/plain",
          list: async () => [{ uri: "tandem://comments/draft.md", name: "draft.md" }],
          read,
        });

        const templates = await send("resources/templates/list");
        expect(templates.result.resourceTemplates).toContainEqual(
          expect.objectContaining({
            name: "tandem-comments",
            uriTemplate: "tandem://comments/{path}",
            description: "Comments on one note",
          }),
        );

        const listed = await send("resources/list");
        expect(listed.result.resources).toContainEqual(
          expect.objectContaining({ uri: "tandem://comments/draft.md", name: "draft.md" }),
        );

        const uri = "tandem://comments/draft.md";
        const body = await send("resources/read", { uri }, uri);
        expect(body.result.contents[0].text).toBe("comments on draft.md");
        expect(read).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ path: "draft.md" }));
      });

      test("a template without a list callback is still readable", async () => {
        mcp.registerResourceTemplate({
          name: "unlisted",
          uriTemplate: "tandem://unlisted/{id}",
          read: async (uri, variables) => ({ contents: [{ uri: uri.href, text: String(variables.id) }] }),
        });

        const uri = "tandem://unlisted/a1f3";
        const body = await send("resources/read", { uri }, uri);
        expect(body.result.contents[0].text).toBe("a1f3");
      });

      test("refuses a duplicate template name", () => {
        const definition = {
          name: "dup",
          uriTemplate: "tandem://dup/{id}",
          read: async (uri: URL) => ({ contents: [{ uri: uri.href, text: "" }] }),
        };
        mcp.registerResourceTemplate(definition);
        expect(() => mcp.registerResourceTemplate(definition)).toThrow(/already registered/);
      });
    });

    describe("prompts", () => {
      test("advertises the prompts capability even with no prompt registered", async () => {
        const discover = await send("server/discover");
        expect(discover.result.capabilities.prompts).toBeDefined();

        const listed = await send("prompts/list");
        expect(listed.result.prompts).toEqual([]);
      });

      test("lists a prompt with its arguments and renders it", async () => {
        mcp.registerPrompt({
          name: "summarize_note",
          title: "Summarize a note",
          description: "Asks for a summary of one note",
          argsSchema: { path: z.string().describe("Note to summarize") },
          callback: async ({ path }) => ({
            messages: [{ role: "user", content: { type: "text", text: `Summarize ${path}` } }],
          }),
        });

        const listed = await send("prompts/list");
        expect(listed.result.prompts).toEqual([
          expect.objectContaining({
            name: "summarize_note",
            title: "Summarize a note",
            description: "Asks for a summary of one note",
            arguments: [expect.objectContaining({ name: "path", required: true })],
          }),
        ]);

        const got = await send(
          "prompts/get",
          { name: "summarize_note", arguments: { path: "draft.md" } },
          "summarize_note",
        );
        expect(got.result.messages).toEqual([
          { role: "user", content: { type: "text", text: "Summarize draft.md" } },
        ]);
      });

      test("a prompt without arguments is called with an empty object", async () => {
        const callback = jest.fn(async () => ({
          messages: [{ role: "user" as const, content: { type: "text" as const, text: "Hello" } }],
        }));
        mcp.registerPrompt({ name: "greeting", callback });

        const got = await send("prompts/get", { name: "greeting" }, "greeting");
        expect(callback).toHaveBeenCalledWith({});
        expect(got.result.messages[0].content.text).toBe("Hello");
      });

      test("an omitted optional argument is absent from the callback's arguments", async () => {
        const callback = jest.fn(async (args: Record<string, string | undefined>) => ({
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text: `Tone: ${args.tone ?? "neutral"}` },
            },
          ],
          _meta: { "tandem/rendered": true },
        }));
        mcp.registerPrompt({
          name: "toned_prompt",
          argsSchema: { path: z.string(), tone: z.string().optional() },
          callback,
        });

        const got = await send(
          "prompts/get",
          { name: "toned_prompt", arguments: { path: "a.md" } },
          "toned_prompt",
        );
        expect(callback).toHaveBeenCalledWith({ path: "a.md" });
        expect(got.result.messages[0].content.text).toBe("Tone: neutral");
        expect(got.result._meta).toMatchObject({ "tandem/rendered": true });
      });

      test("refuses a duplicate prompt name, and removal frees it", () => {
        const definition = {
          name: "dup_prompt",
          callback: async () => ({ messages: [] }),
        };
        const cleanup = mcp.registerPrompt(definition);
        expect(() => mcp.registerPrompt(definition)).toThrow(/already registered/);
        cleanup();
        expect(() => mcp.registerPrompt(definition)).not.toThrow();
      });
    });

    describe("on a live sessionful connection", () => {
      test("a prompt registered after the handshake is listed and served", async () => {
        const sessionId = await openSession();
        mcp.registerPrompt({
          name: "late_prompt",
          callback: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "late" } }],
          }),
        });

        const listed = await sendOnSession(sessionId, "prompts/list");
        expect((listed.result.prompts as { name: string }[]).map((p) => p.name)).toContain("late_prompt");

        const got = await sendOnSession(sessionId, "prompts/get", { name: "late_prompt" });
        expect(got.result.messages[0].content.text).toBe("late");
      });

      test("resources and templates registered after the handshake are listed, and removal notifies", async () => {
        const sessionId = await openSession();
        const session = [...(mcp as unknown as {
          sessions: Map<string, { server: { sendResourceListChanged: () => void } }>;
        }).sessions.values()][0];
        const sendResourceListChanged = jest.spyOn(session.server, "sendResourceListChanged");

        const read = async (uri: URL) => ({ contents: [{ uri: uri.href, text: "x" }] });
        const removeResource = mcp.registerResource({ name: "late", uri: "tandem://late", read });
        mcp.registerResourceTemplate({ name: "late-template", uriTemplate: "tandem://late/{id}", read });
        expect(sendResourceListChanged).toHaveBeenCalled();

        const listed = await sendOnSession(sessionId, "resources/list");
        expect((listed.result.resources as { uri: string }[]).map((r) => r.uri)).toContain("tandem://late");
        const templates = await sendOnSession(sessionId, "resources/templates/list");
        expect((templates.result.resourceTemplates as { name: string }[]).map((t) => t.name)).toContain(
          "late-template",
        );

        sendResourceListChanged.mockClear();
        removeResource();
        expect(sendResourceListChanged).toHaveBeenCalled();
        const after = await sendOnSession(sessionId, "resources/list");
        expect((after.result.resources as { uri: string }[]).map((r) => r.uri)).not.toContain("tandem://late");
      });
    });

    test("a stale cleanup does not remove a later registration under the same name", async () => {
      const first = mcp.registerPrompt({ name: "reused", callback: async () => ({ messages: [] }) });
      first();
      mcp.registerPrompt({ name: "reused", callback: async () => ({ messages: [] }) });
      first();

      const listed = await send("prompts/list");
      expect((listed.result.prompts as { name: string }[]).map((p) => p.name)).toContain("reused");
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

// ---------------------------------------------------------------------------
// Path traversal: every tool that takes a vault path.
//
// Obsidian's Vault API is not a sandbox. `getAbstractFileByPath` only ever matches
// files Obsidian has indexed, so a path holding `../` simply misses and the caller
// gets "File not found" — which made most of these tools look safe by accident. The
// write paths do not go through that lookup: `Vault.create`, `Vault.adapter.write*`
// and `Vault.adapter.remove` hand the path straight to the filesystem, relative to
// the vault directory, so a `../` there lands outside the vault. Reported against
// 5.1.0 for vault_write; vault_append and a permanent vault_delete share the hole.
//
// The containment check therefore belongs on every vault path a client supplies,
// not only on vault_move/vault_copy destinations.
// ---------------------------------------------------------------------------

describe("MCP vault path containment", () => {
   
  let ops: any;

  beforeEach(() => {
    registerTool = jest.spyOn(McpServer.prototype, "registerTool");
    registerResource = jest.spyOn(McpServer.prototype, "registerResource");
    ops = makeMockOps();
    // @ts-ignore: buildServer is private — the test observes what a request would build.
    new McpHandler(ops, DEFAULT_SETTINGS).buildServer();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // [tool, extra args needed to reach the path check, the ops method that must not run]
  const pathTools: Array<[string, Record<string, unknown>, string]> = [
    ["vault_read", {}, "getFileMetadataObject"],
    ["vault_write", { content: "pwned" }, "writeFileContent"],
    ["vault_append", { content: "pwned" }, "appendFileContent"],
    [
      "vault_patch",
      { targetType: "heading", target: ["Hi"], operation: "replace", content: "x" },
      "patchFileSectionMdp2",
    ],
    ["vault_delete", { permanent: true }, "deleteVaultFile"],
    ["vault_delete", {}, "deleteVaultFile"],
    ["vault_get_document_map", {}, "getDocumentMapV2Object"],
    ["vault_list", {}, "listVaultDirectory"],
    ["open_file", {}, "openVaultFile"],
    ["vault_move", { destination: "ok.md" }, "moveVaultFile"],
    ["vault_copy", { destination: "ok.md" }, "copyVaultFile"],
  ];

  const escapingPaths = [
    ["relative traversal", "../../Ausserhalb.md"],
    ["deep relative traversal", "../../../../some/other/writable/path/file.md"],
    ["absolute path", "/etc/passwd"],
    ["traversal in the middle", "notes/../../outside.md"],
    ["windows-style traversal", "..\\..\\outside.md"],
  ];

  for (const [tool, extraArgs, opsMethod] of pathTools) {
    describe(`${tool}${extraArgs.permanent ? " (permanent)" : ""}`, () => {
      for (const [label, escaping] of escapingPaths) {
        test(`rejects ${label} in path`, async () => {
          const cb = getToolCallback(tool);
          await expect(cb({ path: escaping, ...extraArgs })).rejects.toThrow(
            "must not escape the vault root",
          );
          expect(ops[opsMethod]).not.toHaveBeenCalled();
        });
      }

      test("allows an ordinary vault path", async () => {
        const cb = getToolCallback(tool);
        await expect(cb({ path: "folder/note.md", ...extraArgs })).resolves.toBeDefined();
      });

      test("allows '..' as a filename substring rather than a segment", async () => {
        const cb = getToolCallback(tool);
        await expect(cb({ path: "folder/notes..md", ...extraArgs })).resolves.toBeDefined();
      });
    });
  }

  test("vault_move rejects a traversing source even with a safe destination", async () => {
    const cb = getToolCallback("vault_move");
    await expect(cb({ path: "../outside.md", destination: "inside.md" })).rejects.toThrow(
      "must not escape the vault root",
    );
    expect(ops.moveVaultFile).not.toHaveBeenCalled();
  });

  test("vault_copy rejects a traversing source even with a safe destination", async () => {
    const cb = getToolCallback("vault_copy");
    await expect(cb({ path: "../outside.md", destination: "inside.md" })).rejects.toThrow(
      "must not escape the vault root",
    );
    expect(ops.copyVaultFile).not.toHaveBeenCalled();
  });

  // The binary and signed-URL tools refuse through normalizeVaultFilePath, which is a
  // canonicaliser rather than a validator: it has to produce the one spelling that
  // signing and verification both agree on, so it also refuses a directory or an empty
  // path, and says so in its own words. It now shares this module's containment rule,
  // and what matters is that the two agree on the part the advisory was about -- neither
  // lets a path out of the vault.
  //
  // The absolute-path case is deliberately absent. A leading slash is refused everywhere
  // else and stripped here, because a signature minted for "a/b.png" has to verify a
  // request for "/a//b.png" -- a sloppy spelling of the same file, not an escape. See
  // signedUrls.test.ts, which pins that on both sides.
  describe("the binary and signed-URL tools refuse the same traversals", () => {
    const traversals = escapingPaths.filter(([label]) => label !== "absolute path");

    for (const tool of ["vault_read_binary", "vault_get_download_url", "vault_get_upload_url"]) {
      for (const [label, escaping] of traversals) {
        test(`${tool} rejects ${label} in path`, async () => {
          const cb = getToolCallback(tool);
          await expect(cb({ path: escaping })).rejects.toThrow(
            "Not a file path inside the vault",
          );
          expect(ops.readBinaryFileContent).not.toHaveBeenCalled();
        });
      }
    }
  });

  test("vault_list still lists the vault root when path is omitted", async () => {
    const cb = getToolCallback("vault_list");
    await expect(cb({})).resolves.toBeDefined();
    expect(ops.listVaultDirectory).toHaveBeenCalledWith("");
  });
});
