import { McpServer, createMcpHandler, isLegacyRequest, legacyStatelessFallback } from "@modelcontextprotocol/server";
import type {
  CacheHint,
  CallToolResult,
  McpHttpHandler,
  ReadResourceResult,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import type { NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import { posix } from "path";
import { z } from "zod";
import express from "express";
import { TFile } from "obsidian";
import { dedent } from "ts-dedent";

import { VaultOperations } from "./vaultOperations";
import type { InstructionInput, ReadTarget } from "markdown-patch-2";
import { InstructionInputObjectSchema } from "markdown-patch-2";
import openapiYaml from "../docs/openapi.yaml";
import { toStandardSchema } from "./mcpSchema";
import { LocalRestApiSettings } from "./types";

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

interface ResourceSpec {
  name: string;
  uri: string;
  meta: { mimeType?: string; description?: string };
  handler: (uri: URL) => Promise<ReadResourceResult>;
}

export class McpHandler {
  // The tool and resource registries are this handler's application state: the 2026-07-28
  // revision has no protocol-level session to hang anything off, so everything a request
  // needs must be reachable from the handler itself. `buildServer()` replays them onto a
  // fresh server for every request.
  private readonly toolSpecs: Map<string, ToolSpec> = new Map();
  private readonly resourceSpecs: ResourceSpec[] = [];

  // The modern (2026-07-28) leg. `legacy: "reject"` keeps it strictly modern: every
  // request is answered on its own, with no session id and no cross-request state, and
  // 2025-era traffic is handed to the separate legacy leg below by `handleRequest`.
  private readonly modernHandler: McpHttpHandler;
  private readonly modernNodeHandler: NodeMcpRequestHandler;
  // The legacy (2024-10-07 … 2025-11-25) leg, kept deliberately separate from the modern
  // one so that older clients — which still open with an `initialize` handshake — keep
  // working unchanged. It is the SDK's own stateless 2025-era serving, so it too holds no
  // per-session state; the `Mcp-Session-Id` routing this handler used to do is gone.
  private readonly legacyNodeHandler: NodeMcpRequestHandler;

  constructor(
    private readonly ops: VaultOperations,
    private readonly settings: LocalRestApiSettings,
  ) {
    const factory = () => this.buildServer();
    const onerror = (error: Error) => this.logHandlerError(error);
    this.modernHandler = createMcpHandler(factory, { legacy: "reject", onerror });
    this.modernNodeHandler = toNodeHandler(this.modernHandler, { onerror });
    this.legacyNodeHandler = toNodeHandler(
      { fetch: legacyStatelessFallback(factory, onerror) },
      { onerror },
    );
    this.registerResources();
    this.registerTools();
  }

  // Build a fresh McpServer for a single request. Both legs are per-request by
  // construction, so a server instance is never shared between two exchanges.
  private buildServer(): McpServer {
    const server = new McpServer(SERVER_INFO, {
      capabilities: { tools: {}, resources: {} },
      cacheHints: CACHE_HINTS,
    });
    for (const spec of this.resourceSpecs) {
      server.registerResource(spec.name, spec.uri, spec.meta, spec.handler);
    }
    for (const spec of this.toolSpecs.values()) {
      server.registerTool(
        spec.name,
        {
          description: spec.description,
          inputSchema: spec.inputSchema,
          annotations: spec.annotations,
        },
        spec.callback,
      );
    }
    return server;
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
    this.modernHandler.notify.toolsChanged();
    return {
      remove: () => {
        if (this.toolSpecs.delete(spec.name)) {
          this.modernHandler.notify.toolsChanged();
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
   * Serve one request on the MCP endpoint.
   *
   * Classification is the SDK's own — `isLegacyRequest` runs exactly the code
   * `createMcpHandler` runs — so the two legs can never disagree about who owns a
   * request. Anything carrying the 2026-07-28 `_meta` envelope claim (including a claim
   * naming a revision we do not serve, or a malformed one) belongs to the modern leg,
   * which owns those error answers; everything else is 2025-era traffic.
   */
  async handleRequest(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    // `req.body` is already parsed by the router's express.json(), so it is handed over
    // explicitly: the Node stream is drained by then and cannot be read a second time.
    const classifiable = await toWebRequest(req, req.body);
    if (await isLegacyRequest(classifiable)) {
      await this.legacyNodeHandler(req, res, req.body);
      return;
    }
    await this.modernNodeHandler(req, res, req.body);
  }

  /** Tears down the modern leg's in-flight exchanges. Called when the plugin unloads. */
  public close(): void {
    void this.modernHandler.close().catch((e: unknown) => {
      if (this.settings.enableVerboseLogging) {
        console.debug(`[MCP] shutdown failed: ${e instanceof Error ? e.message : "unknown error"}`);
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

  private registerTools(): void {
    this.tool(
      "vault_list",
      dedent`List files and subdirectories inside a vault directory. Returns an array of names; directory entries end with '/'. Omit path or pass an empty string to list the vault root.`,
      { path: z.string().optional().describe("Directory path relative to vault root (default: root)") },
      READ_ONLY_ANNOTATIONS,
      async ({ path }: { path?: string }) => {
        const files = await this.ops.listVaultDirectory(path ?? "");
        return this.text({ files });
      },
    );

    this.tool(
      "vault_read",
      dedent`
        Read a vault file's content and metadata. Returns a JSON object with: content (full markdown text), path, tags (array of tag strings), frontmatter (parsed YAML front-matter as an object), stat ({ctime, mtime, size}), links (array of vault-relative paths this file links to), backlinks (array of vault-relative paths of files that link here), and unresolvedLinks (array of link text in this file that does not resolve to an existing vault file). Throws if the file does not exist.

        When targetType and target are both provided, returns only the matched section as a plain string (markdown) or JSON value (frontmatter) instead of the full object. To save context, call vault_get_document_map first to identify headings, block IDs, or frontmatter keys, and prefer targeted reads over full reads for anything but short files.
      `,
      {
        path: z.string().describe("File path relative to vault root"),
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
        const file = this.ops.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        if ((targetType == null) !== (target == null)) {
          throw new Error("targetType and target must be provided together");
        }
        if (scope !== undefined && (targetType == null || target == null)) {
          throw new Error("scope requires targetType and target");
        }
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
          const result = await this.ops.readFileSectionMdp2(file, address);
          return this.text(result.kind === "frontmatter" ? result.value : result.content);
        }
        const meta = await this.ops.getFileMetadataObject(file);
        return this.text(meta);
      },
    );

    this.tool(
      "vault_write",
      dedent`Create or overwrite a vault file with the given content. Creates any missing parent directories automatically. Overwrites without warning if the file already exists.`,
      {
        path: z.string().describe("File path relative to vault root"),
        content: z.string().describe("Full file content (markdown text)"),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async ({ path, content }: { path: string; content: string }) => {
        await this.ops.writeFileContent(path, content);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_append",
      dedent`Append content to the end of a vault file. Creates the file if it does not already exist.`,
      {
        path: z.string().describe("File path relative to vault root"),
        content: z.string().describe("Content to append"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async ({ path, content }: { path: string; content: string }) => {
        await this.ops.appendFileContent(path, content);
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
        path: z.string().describe("File path relative to vault root"),
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
            path,
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
        path: z.string().describe("File path relative to vault root"),
        permanent: z
          .boolean()
          .optional()
          .describe(
            "If true, permanently deletes the file instead of moving it to trash (default: false).",
          ),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({ path, permanent }: { path: string; permanent?: boolean }) => {
        await this.ops.deleteVaultFile(path, permanent ?? false);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_move",
      dedent`Move (rename) a vault file to a new path. Creates any missing parent directories at the destination automatically. Preserves file history and updates internal Obsidian links. Throws if the source file does not exist.`,
      {
        path: z.string().describe("Source file path relative to vault root"),
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
        const normalized = destination
          .trim()
          .replace(/\\/g, "/")
          .replace(/\/+/g, "/");

        if (normalized.startsWith("/")) {
          throw new Error(
            "Destination path must be relative and must not escape the vault root.",
          );
        }

        const syntheticRoot = "/vault";
        const resolved = posix.resolve(syntheticRoot, normalized);
        if (resolved !== syntheticRoot && !resolved.startsWith(syntheticRoot + "/")) {
          throw new Error(
            "Destination path must be relative and must not escape the vault root.",
          );
        }

        const sourceFilename = path.includes("/")
          ? path.slice(path.lastIndexOf("/") + 1)
          : path;

        const resolvedDestination = !normalized || normalized.endsWith("/")
          ? normalized + sourceFilename
          : normalized;

        const actualPath = await this.ops.moveVaultFile(path, resolvedDestination, allowOverwrite ?? false);
        return this.text({ message: "OK", oldPath: path, newPath: actualPath });
      },
    );

    this.tool(
      "vault_copy",
      dedent`Copy a vault file to a new path. Creates any missing parent directories at the destination automatically. Throws if the source file does not exist.`,
      {
        path: z.string().describe("Source file path relative to vault root"),
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
        const normalized = destination
          .trim()
          .replace(/\\/g, "/")
          .replace(/\/+/g, "/");

        if (normalized.startsWith("/")) {
          throw new Error(
            "Destination path must be relative and must not escape the vault root.",
          );
        }

        const syntheticRoot = "/vault";
        const resolved = posix.resolve(syntheticRoot, normalized);
        if (resolved !== syntheticRoot && !resolved.startsWith(syntheticRoot + "/")) {
          throw new Error(
            "Destination path must be relative and must not escape the vault root.",
          );
        }

        const sourceFilename = path.includes("/")
          ? path.slice(path.lastIndexOf("/") + 1)
          : path;

        const resolvedDestination = !normalized || normalized.endsWith("/")
          ? normalized + sourceFilename
          : normalized;

        const actualPath = await this.ops.copyVaultFile(path, resolvedDestination, allowOverwrite ?? false);
        return this.text({ message: "OK", sourcePath: path, newPath: actualPath });
      },
    );

    this.tool(
      "vault_get_document_map",
      dedent`
        Return the structure of a vault file as a document map: its heading tree, block reference IDs, and frontmatter field names, plus a version token. Use this before vault_read or vault_patch with targeting to discover what targets are available without parsing the full markdown content yourself.

        headings is a nested object mirroring the document's heading nesting: each heading's text maps to an object of its child headings, and a leaf heading maps to {} (e.g. {"Overview": {"Details": {}}}). To target a heading, use the path of keys from the top level down to it (e.g. ['Overview', 'Details']) as a vault_patch or vault_read heading target. Every occurrence of a heading gets its own key, even a duplicate: the first occurrence keeps its plain text, and each later occurrence's key has an opaque, non-printable marker suffix appended by the server — given '## Log' twice, the tree is {"Log": {}, "Log<marker>": {}}, and both are separately addressable. Always copy such a key verbatim from this response into a vault_read/vault_patch target array; never retype or reconstruct one yourself. blocks are bare reference IDs (no '^'), one entry per block in document order; a duplicate block id gets the same disambiguation treatment as a heading — the first occurrence's entry is the plain id, and each later occurrence's entry carries the same kind of marker suffix, again to be copied verbatim. frontmatterFields are top-level key names. version is a content hash of the file — pass it back as vault_patch's ifMatch to make an edit conditional on the file being unchanged.
      `,
      { path: z.string().describe("File path relative to vault root") },
      READ_ONLY_ANNOTATIONS,
      async ({ path }: { path: string }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(path);
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
        path: z.string().describe("File path relative to vault root"),
        newLeaf: z.boolean().optional().describe("Open in a new leaf/pane (default: false)"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async ({ path, newLeaf }: { path: string; newLeaf?: boolean }) => {
        this.ops.openVaultFile(path, newLeaf);
        return this.text({ message: "OK" });
      },
    );
  }
}
