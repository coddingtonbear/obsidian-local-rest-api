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
import { ContentType, FrontmatterParseError, PatchFailed, PatchOperation, PatchTargetType } from "markdown-patch";
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
        Read a vault file's content and metadata. Returns a JSON object with: content (full markdown text), path, tags (array of tag strings), frontmatter (parsed YAML front-matter as an object), stat ({ctime, mtime, size}), links (array of vault-relative paths this file links to), and backlinks (array of vault-relative paths of files that link here). Throws if the file does not exist.

        When targetType and target are both provided, returns only the matched section as a plain string (markdown) or JSON value (frontmatter) instead of the full object. To save context, call vault_get_document_map first to identify headings, block IDs, or frontmatter keys, and prefer targeted reads over full reads for anything but short files.
      `,
      {
        path: z.string().describe("File path relative to vault root"),
        targetType: z
          .enum(["heading", "block", "frontmatter"])
          .optional()
          .describe("Type of section to extract: 'heading', 'block' reference, or 'frontmatter' key"),
        target: z
          .string()
          .optional()
          .describe(
            dedent`Section to extract. Heading text, block reference ID (without '^'), or frontmatter key. Separate nested heading levels with '::' (e.g. 'Heading 1::Subheading').`,
          ),
        targetDelimiter: z
          .string()
          .optional()
          .describe("Delimiter for nested heading paths (default: '::')"),
      },
      READ_ONLY_ANNOTATIONS,
      async ({
        path,
        targetType,
        target,
        targetDelimiter,
      }: {
        path: string;
        targetType?: "heading" | "block" | "frontmatter";
        target?: string;
        targetDelimiter?: string;
      }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        if ((targetType == null) !== (target == null)) {
          throw new Error("targetType and target must be provided together");
        }
        if (targetType && target) {
          const section = await this.ops.readFileSection(file, targetType, target, targetDelimiter);
          return this.text(section);
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
        Patch a specific section of a vault file by targeting a heading, block reference, or frontmatter field.

        To discover valid heading names and block IDs before patching, call vault_get_document_map first.
      `,
      {
        path: z.string().describe("File path relative to vault root"),
        targetType: z
          .enum(["heading", "block", "frontmatter"])
          .describe("Type of target section: 'heading', 'block' reference, or 'frontmatter' key"),
        target: z
          .string()
          .describe(
            dedent`The section to patch. Heading text, block reference ID (without '^'), or frontmatter key. Separate nested heading levels with '::' (e.g. 'Heading 1::Subheading').`,
          ),
        operation: z
          .enum(["replace", "prepend", "append"])
          .describe("How to apply the content: replace the section, prepend before it, or append after it"),
        content: z
          .string()
          .describe(
            dedent`Content to apply. For contentType 'text/markdown' pass markdown text. For contentType 'application/json' pass a JSON-encoded string (e.g. '["row","cells"]' for a table row, or '42' for a number). No blank line is added automatically between your content and whatever sits next to it — only a blank line that was already there gets kept. If you want one, add '\\n\\n' yourself: at the end of content for append, replace, or createTargetIfMissing; at the start of content for prepend.`,
          ),
        contentType: z
          .nativeEnum(ContentType)
          .optional()
          .describe(
            dedent`MIME type of content. 'text/markdown' (default) or 'application/json'. Use 'application/json' to set typed frontmatter values or to append/prepend table rows (2-D array).`,
          ),
        createTargetIfMissing: z
          .boolean()
          .optional()
          .describe("Create the heading or frontmatter key if it does not already exist (default: false)"),
        trimTargetWhitespace: z
          .boolean()
          .optional()
          .describe("Trim whitespace from the target section before applying the operation (default: false)"),
        rejectIfContentPreexists: z
          .boolean()
          .optional()
          .describe("If true, fail the patch when the content already appears in the target section (default: false). Use to make append/prepend operations idempotent on retry."),
        targetDelimiter: z
          .string()
          .optional()
          .describe("Delimiter for nested heading paths (default: '::')"),
        targetScope: z
          .enum(["content", "marker", "markerAndContent"])
          .optional()
          .describe(
            dedent`Controls which part of the target the operation acts on. 'content' (default): the section content only. 'marker': just the heading line or block-ID token. 'markerAndContent': both together. Only applies to heading and block targets. IMPORTANT — a marker spans more than its visible label: for a heading, the leading '#' characters through the end of the line, including the newline; for a block reference, '^' (plus any preceding whitespace if inline) through the id, including the newline. Replacing 'marker' or 'markerAndContent' replaces that whole span, so match it: the same number of leading '#' as the original (count = targetDelimiter-separated segments in target, e.g. 'Heading 1::Subheading' → '##') or the heading is demoted to plain text; and a trailing newline, or the next line gets glued onto yours.`,
          ),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({
        path,
        targetType,
        target,
        operation,
        content,
        contentType,
        createTargetIfMissing,
        trimTargetWhitespace,
        rejectIfContentPreexists,
        targetDelimiter,
        targetScope,
      }: {
        path: string;
        targetType: PatchTargetType;
        target: string;
        operation: PatchOperation;
        content: string;
        contentType?: ContentType;
        createTargetIfMissing?: boolean;
        trimTargetWhitespace?: boolean;
        rejectIfContentPreexists?: boolean;
        targetDelimiter?: string;
        targetScope?: "content" | "marker" | "markerAndContent";
      }) => {
        try {
          // MCP transport delivers all parameters as strings; parse JSON content
          // here so downstream code receives a native value, not a serialized string.
          const resolvedContentType = contentType ?? ContentType.text;
          let parsedContent: unknown = content;
          if (resolvedContentType === ContentType.json) {
            try {
              parsedContent = JSON.parse(content);
            } catch (err) {
              throw new Error(
                `Invalid application/json content: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          await this.ops.patchFileSection(
            path,
            targetType,
            target,
            operation,
            parsedContent,
            resolvedContentType,
            { createTargetIfMissing, trimTargetWhitespace, rejectIfContentPreexists, targetDelimiter, targetScope },
          );
        } catch (e) {
          if (e instanceof PatchFailed) {
            throw new Error(e.message);
          }
          if (e instanceof FrontmatterParseError) {
            throw new Error(e.message);
          }
          throw e;
        }
        return this.text({ message: "OK" });
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
      dedent`Return the structure of a vault file as a document map: the list of heading paths, block reference IDs, and frontmatter field names present in the file. Use this before vault_read or vault_patch with targeting to discover what targets are available without parsing the full markdown content yourself.`,
      { path: z.string().describe("File path relative to vault root") },
      READ_ONLY_ANNOTATIONS,
      async ({ path }: { path: string }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        const map = await this.ops.getDocumentMapObject(file);
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
          "backlinks": ["index.md"]
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
      dedent`Return all tags used across the vault, each with a usage count. Tag names do not include the leading '#'. This tool is read-only. To add a tag to a specific file, use vault_patch with targetType 'frontmatter', target 'tags', operation 'append', contentType 'application/json', and content ["tag-name"] (set createTargetIfMissing to true if the file may have no tags yet). To remove a tag, read the current tags list with vault_read, filter client-side, then replace the whole field with vault_patch using operation 'replace'. For full examples, read the OpenAPI spec resource at obsidian://local-rest-api/openapi.yaml.`,
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
