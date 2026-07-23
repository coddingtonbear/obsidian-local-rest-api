import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { posix } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import express from "express";
import { TFile } from "obsidian";
import { dedent } from "ts-dedent";

import { VaultOperations } from "./vaultOperations";
import type { InstructionInput, ReadTarget } from "markdown-patch-2";
import { InstructionInputObjectSchema } from "markdown-patch-2";
import openapiYaml from "../docs/openapi.yaml";
import { ERROR_CODE_MESSAGES } from "./constants";
import { LocalRestApiSettings } from "./types";

const PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

// Minimal structural type for McpServer — typed as a plain interface rather than the SDK's
// McpServer class to avoid TypeScript heap OOM from evaluating ToolCallback<ZodRawShape>.
interface MinimalMcpServer {
  tool(name: string, description: string, schema: unknown, annotations: ToolAnnotations, callback: (args: unknown) => Promise<CallToolResult>): { remove: () => void };
  connect(transport: StreamableHTTPServerTransport): Promise<void>;
  resource(name: string, uri: string, meta: unknown, handler: (uri: URL) => Promise<unknown>): void;
}

interface ToolSpec {
  name: string;
  description: string;
  schema: unknown;
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

interface ResourceSpec {
  name: string;
  uri: string;
  meta: unknown;
  handler: (uri: URL) => Promise<unknown>;
}

interface SessionEntry {
  server: MinimalMcpServer;
  transport: StreamableHTTPServerTransport;
  toolHandles: Map<string, { remove: () => void }>;
}

export class McpHandler {
  private readonly sessions: Map<string, SessionEntry> = new Map();
  private readonly toolSpecs: Map<string, ToolSpec> = new Map();
  private readonly resourceSpecs: ResourceSpec[] = [];

  constructor(
    private readonly ops: VaultOperations,
    private readonly settings: LocalRestApiSettings,
  ) {
    this.registerResources();
    this.registerTools();
  }

  // Build a fresh McpServer for a single session/transport. Each transport MUST own
  // its own server: the SDK's Server.connect() binds a single _transport, so sharing
  // one server across multiple connected transports routes every response to the
  // most-recently-connected transport, hanging all older sessions.
  private buildServer(): { server: MinimalMcpServer; toolHandles: Map<string, { remove: () => void }> } {
    const server: MinimalMcpServer = new McpServer({
      name: "obsidian-local-rest-api",
      version: "1.0.0",
    });
    const toolHandles = new Map<string, { remove: () => void }>();
    for (const spec of this.resourceSpecs) {
      server.resource(spec.name, spec.uri, spec.meta, spec.handler);
    }
    for (const spec of this.toolSpecs.values()) {
      toolHandles.set(spec.name, server.tool(spec.name, spec.description, spec.schema, spec.annotations, spec.callback));
    }
    return { server, toolHandles };
  }

  private addResourceSpec(name: string, uri: string, meta: unknown, handler: (uri: URL) => Promise<unknown>): void {
    this.resourceSpecs.push({ name, uri, meta, handler });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tool(name: string, description: string, schema: any, annotations: ToolAnnotations, callback: (args: any) => Promise<CallToolResult>): { remove: () => void } {
    const spec: ToolSpec = {
      name,
      description,
      schema,
      annotations,
      callback: async (args: unknown) => {
        try {
          const result = await callback(args);
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
    for (const session of this.sessions.values()) {
      session.toolHandles.set(spec.name, session.server.tool(spec.name, spec.description, spec.schema, spec.annotations, spec.callback));
    }
    return {
      remove: () => {
        this.toolSpecs.delete(spec.name);
        for (const session of this.sessions.values()) {
          const handle = session.toolHandles.get(spec.name);
          if (handle) {
            handle.remove();
            session.toolHandles.delete(spec.name);
          }
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

  async handleRequest(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      const { server, toolHandles } = this.buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { server, transport, toolHandles });
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
      },
      READ_ONLY_ANNOTATIONS,
      async ({
        path,
        targetType,
        target,
      }: {
        path: string;
        targetType?: "heading" | "block" | "frontmatter";
        target?: string[] | string;
      }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        if ((targetType == null) !== (target == null)) {
          throw new Error("targetType and target must be provided together");
        }
        if (targetType && target != null) {
          let address: ReadTarget;
          if (targetType === "heading") {
            if (!Array.isArray(target)) {
              throw new Error("A heading target must be an array of heading texts, not a bare string");
            }
            address = { targetType: "heading", target };
          } else {
            if (Array.isArray(target)) {
              throw new Error(`A ${targetType} target must be a string, not an array`);
            }
            address = { targetType, target };
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
        operation: "replace" | "prepend" | "append" | "delete";
        scope?: "content" | "marker" | "markerAndContent" | "parent";
        content?: string;
        value?: unknown;
        destination?: unknown;
        ifMatch?: string;
        createTargetIfMissing?: boolean;
        rejectIfContentPreexists?: boolean;
      }) => {
        // Assemble the instruction with exactly the fields that were supplied,
        // so the engine sees the discriminated-union shape it expects. It
        // validates the operation×scope×targetType combination and the carrier.
        const instruction: Record<string, unknown> = {
          targetType,
          target,
          operation,
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
      "periodic_note_get_path",
      dedent`Return the vault-relative path of the current periodic note for the given period (daily, weekly, monthly, quarterly, or yearly). Creates the note file if it does not already exist, applying any configured template. Requires the Periodic Notes or Calendar plugin to be installed and configured. Use the returned path with vault_read, vault_write, vault_append, vault_patch, or vault_get_document_map to operate on the note.`,
      {
        period: z
          .enum(PERIODS)
          .describe("Periodic note period: 'daily', 'weekly', 'monthly', 'quarterly', or 'yearly'"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async ({ period }: { period: typeof PERIODS[number] }) => {
        const [file, err] = await this.ops.periodicGetOrCreateNote(period, Date.now());
        if (err || !file)
          throw new Error(
            `Could not get or create periodic note: ${err != null ? ERROR_CODE_MESSAGES[err] : "unknown error"}`,
          );
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
