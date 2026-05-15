import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import express from "express";
import { TFile } from "obsidian";

import { VaultOperations } from "./vaultOperations";
import { PatchFailed, PatchOperation, PatchTargetType } from "markdown-patch";
import openapiYaml from "../docs/openapi.yaml";
import { ERROR_CODE_MESSAGES } from "./constants";
import { LocalRestApiSettings } from "./types";

const PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

export class McpHandler {
  // typed as `any` to avoid TypeScript heap OOM when evaluating the MCP SDK's complex
  // ToolCallback<Args extends ZodRawShape> generics across the 18 tool registrations below
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly mcpServer: any;
  private readonly transports: Map<string, StreamableHTTPServerTransport> = new Map();
  private readonly registeredToolNames = new Set<string>();

  constructor(
    private readonly ops: VaultOperations,
    private readonly settings: LocalRestApiSettings,
  ) {
    this.mcpServer = new McpServer({
      name: "obsidian-local-rest-api",
      version: "1.0.0",
    });
    this.registerResources();
    this.registerTools();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tool(name: string, description: string, schema: any, callback: (args: any) => Promise<any>): any {
    this.registeredToolNames.add(name);
    return this.mcpServer.tool(name, description, schema, async (args: unknown) => {
      try {
        const result = await callback(args);
        if (this.settings.enableVerboseLogging) {
          console.log(`[MCP] ${name} => ok`);
        }
        return result;
      } catch (e) {
        if (this.settings.enableVerboseLogging) {
          console.log(`[MCP] ${name} => error`);
        }
        throw e;
      }
    });
  }

  public registerTool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    callback: (args: Record<string, unknown>) => Promise<unknown>,
  ): () => void {
    if (this.registeredToolNames.has(name)) {
      throw new Error(
        `Cannot register MCP tool "${name}" — a tool with this name is already registered.`,
      );
    }
    const registered = this.tool(name, description, schema, async (args) =>
      this.text(await callback(args)),
    );
    return () => {
      registered.remove();
      this.registeredToolNames.delete(name);
    };
  }

  async handleRequest(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.transports.delete(transport.sessionId);
      };
      await this.mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = this.transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handleRequest(req, res, req.body);
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
    this.mcpServer.resource(
      "openapi-spec",
      "obsidian://local-rest-api/openapi.yaml",
      {
        mimeType: "application/yaml",
        description:
          "Full OpenAPI specification for the Obsidian Local REST API. " +
          "Contains complete request/response schemas, parameter descriptions, " +
          "and usage examples for every endpoint.",
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
      "List files and subdirectories inside a vault directory. " +
        "Returns an array of names; directory entries end with '/'. " +
        "Omit path or pass an empty string to list the vault root.",
      { path: z.string().optional().describe("Directory path relative to vault root (default: root)") },
      async ({ path }: { path?: string }) => {
        const files = await this.ops.listVaultDirectory(path ?? "");
        return this.text({ files });
      },
    );

    this.tool(
      "vault_read",
      "Read a vault file's content and metadata. " +
        "Returns a JSON object with: content (full markdown text), path, " +
        "tags (array of tag strings), frontmatter (parsed YAML front-matter as an object), " +
        "and stat ({ctime, mtime, size}). Throws if the file does not exist.\n\n" +
        "When targetType and target are both provided, returns only the matched section " +
        "as a plain string (markdown) or JSON value (frontmatter) instead of the full object. " +
        "Use vault_get_document_map first to discover available targets.",
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
            "Section to extract. Heading text, block reference ID (without '^'), or frontmatter key. " +
              "Separate nested heading levels with '::' (e.g. 'Heading 1::Subheading').",
          ),
        targetDelimiter: z
          .string()
          .optional()
          .describe("Delimiter for nested heading paths (default: '::')"),
      },
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
      "Create or overwrite a vault file with the given content. " +
        "Creates any missing parent directories automatically. " +
        "Overwrites without warning if the file already exists.",
      {
        path: z.string().describe("File path relative to vault root"),
        content: z.string().describe("Full file content (markdown text)"),
      },
      async ({ path, content }: { path: string; content: string }) => {
        await this.ops.writeFileContent(path, content);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_append",
      "Append content to the end of a vault file. " +
        "Creates the file if it does not already exist.",
      {
        path: z.string().describe("File path relative to vault root"),
        content: z.string().describe("Content to append"),
      },
      async ({ path, content }: { path: string; content: string }) => {
        await this.ops.appendFileContent(path, content);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_patch",
      "Patch a specific section of a vault file by targeting a heading, block reference, or frontmatter field.\n\n" +
        "- targetType: 'heading' targets the content beneath a markdown heading (the heading line itself is not part of the section and must not appear in the supplied content); 'block' targets a block reference (the ID after '^'); 'frontmatter' targets a YAML front-matter key.\n" +
        "- target: the heading text, block ID, or frontmatter key. For nested headings use '::' as delimiter (e.g. 'Heading 1::Subheading'); customise with targetDelimiter.\n" +
        "- operation: 'append' adds content after the section, 'prepend' adds before, 'replace' replaces entirely.\n" +
        "- contentType: 'text/markdown' (default) treats content as markdown. 'application/json' parses it as JSON — useful for setting typed frontmatter values or appending rows to a table (pass a 2-D array of row cells).\n" +
        "- createTargetIfMissing: set to true to create the heading or frontmatter key if it does not exist yet.\n" +
        "- trimTargetWhitespace: strip leading/trailing whitespace from the target section before patching.\n" +
        "- rejectIfContentPreexists: fail the patch if the content string already appears in the target section — use this as an idempotency guard so a retry does not duplicate content.\n" +
        "- targetScope: controls what portion of the target the operation acts on. 'content' (default) patches only the content below the heading or at the block; 'marker' patches only the heading line or block-ID token itself; 'markerAndContent' patches the heading/block-ID together with its content. Only applicable to heading and block targets.\n\n" +
        "To discover valid heading names and block IDs before patching, call vault_get_document_map first.",
      {
        path: z.string().describe("File path relative to vault root"),
        targetType: z
          .enum(["heading", "block", "frontmatter"])
          .describe("Type of target section: 'heading', 'block' reference, or 'frontmatter' key"),
        target: z
          .string()
          .describe(
            "The section to patch. Heading text, block reference ID (without '^'), or frontmatter key. " +
              "Separate nested heading levels with '::' (e.g. 'Heading 1::Subheading').",
          ),
        operation: z
          .enum(["replace", "prepend", "append"])
          .describe("How to apply the content: replace the section, prepend before it, or append after it"),
        content: z.unknown().describe("Content to apply. For contentType 'text/markdown' pass a string. For contentType 'application/json' you may pass a native JSON value (number, boolean, array, object) and it will be serialised automatically."),
        contentType: z
          .string()
          .optional()
          .describe(
            "MIME type of content. 'text/markdown' (default) or 'application/json'. " +
              "Use 'application/json' to set typed frontmatter values or to append/prepend table rows (2-D array).",
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
            "Controls which part of the target the operation acts on. " +
              "'content' (default): patch the content below the heading or at the block. " +
              "'marker': patch only the heading line or block-ID token. " +
              "'markerAndContent': patch the heading/block-ID together with its content. " +
              "Only applicable to heading and block targets.",
          ),
      },
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
        content: unknown;
        contentType?: string;
        createTargetIfMissing?: boolean;
        trimTargetWhitespace?: boolean;
        rejectIfContentPreexists?: boolean;
        targetDelimiter?: string;
        targetScope?: "content" | "marker" | "markerAndContent";
      }) => {
        try {
          await this.ops.patchFileSection(
            path,
            targetType,
            target,
            operation,
            content,
            contentType ?? "text/markdown",
            { createTargetIfMissing, trimTargetWhitespace, rejectIfContentPreexists, targetDelimiter, targetScope },
          );
        } catch (e) {
          if (e instanceof PatchFailed) {
            throw new Error(e.message);
          }
          throw e;
        }
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_delete",
      "Delete a file from the vault. Throws if the file does not exist.",
      { path: z.string().describe("File path relative to vault root") },
      async ({ path }: { path: string }) => {
        await this.ops.deleteVaultFile(path);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "vault_get_document_map",
      "Return the structure of a vault file as a document map: the list of heading paths, " +
        "block reference IDs, and frontmatter field names present in the file. " +
        "Use this before vault_read or vault_patch with targeting to discover what targets are available " +
        "without parsing the full markdown content yourself.",
      { path: z.string().describe("File path relative to vault root") },
      async ({ path }: { path: string }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        const map = await this.ops.getDocumentMapObject(file);
        return this.text(map);
      },
    );

    this.tool(
      "active_file_get_path",
      "Return the vault-relative path of the file currently open in Obsidian. " +
        "Use this path with vault_read, vault_write, vault_append, vault_patch, " +
        "vault_get_document_map, or vault_delete to operate on the active file. " +
        "Throws if no file is active.",
      {},
      async () => {
        const file = this.getActiveFile();
        return this.text({ path: file.path });
      },
    );

    this.tool(
      "periodic_note_get_path",
      "Return the vault-relative path of the current periodic note for the given period " +
        "(daily, weekly, monthly, quarterly, or yearly). " +
        "Creates the note file if it does not already exist, applying any configured template. " +
        "Requires the Periodic Notes or Calendar plugin to be installed and configured. " +
        "Use the returned path with vault_read, vault_write, vault_append, vault_patch, " +
        "or vault_get_document_map to operate on the note.",
      {
        period: z
          .enum(PERIODS)
          .describe("Periodic note period: 'daily', 'weekly', 'monthly', 'quarterly', or 'yearly'"),
      },
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
      "Search vault files using a JsonLogic query evaluated against each note's metadata.\n\n" +
        "The query is a JSON object following the JsonLogic spec (https://jsonlogic.com/operations.html). " +
        "It is evaluated against a NoteJson object for each file; files where the result is truthy are returned.\n\n" +
        "Each NoteJson has: path (string), content (string), tags (string[]), frontmatter (object), stat ({ctime, mtime, size}).\n\n" +
        "Extra operators available beyond standard JsonLogic:\n" +
        "- {\"glob\": [\"*.foo\", {\"var\": \"path\"}]} — glob pattern match\n" +
        "- {\"regexp\": [\"^daily/\", {\"var\": \"path\"}]} — regular expression match\n\n" +
        "Returns an array of {filename, result} objects where result is the truthy value the query produced for that file.\n\n" +
        "Examples:\n" +
        "- Find by tag: {\"in\": [\"myTag\", {\"var\": \"tags\"}]}\n" +
        "- Find by frontmatter field: {\"==\": [{\"var\": \"frontmatter.status\"}, \"done\"]}\n" +
        "- Find by path glob: {\"glob\": [\"journal/*\", {\"var\": \"path\"}]}",
      {
        query: z
          .record(z.unknown())
          .describe("JsonLogic query object to evaluate against each note"),
      },
      async ({ query }: { query: unknown }) => {
        const results = await this.ops.searchJsonLogic(query);
        return this.text(results);
      },
    );

    this.tool(
      "search_simple",
      "Search vault files using Obsidian's built-in simple search. " +
        "Returns an array of {filename, score, matches} objects sorted by relevance score. " +
        "Each match includes the matched text and surrounding context characters (controlled by contextLength).",
      {
        query: z.string().describe("Search query string"),
        contextLength: z
          .number()
          .optional()
          .describe("Number of characters of surrounding context to return per match (default: 100)"),
      },
      async ({ query, contextLength }: { query: string; contextLength?: number }) => {
        const results = await this.ops.simpleSearch(query, contextLength);
        return this.text(results);
      },
    );

    this.tool(
      "tag_list",
      "Return all tags used across the vault, each with a usage count. " +
        "Tag names do not include the leading '#'. " +
        "This tool is read-only. To add a tag to a specific file, use vault_patch with " +
        "targetType 'frontmatter', target 'tags', operation 'append', contentType 'application/json', " +
        "and content [\"tag-name\"] (set createTargetIfMissing to true if the file may have no tags yet). " +
        "To remove a tag, read the current tags list with vault_read, filter client-side, then replace " +
        "the whole field with vault_patch using operation 'replace'. " +
        "For full examples, read the OpenAPI spec resource at obsidian://local-rest-api/openapi.yaml.",
      {},
      async () => {
        return this.text({ tags: this.ops.getAllTags() });
      },
    );

    this.tool(
      "command_list",
      "Return all registered Obsidian commands. " +
        "Each entry has an 'id' and a human-readable 'name'. " +
        "Pass the 'id' to command_execute to run a command.",
      {},
      async () => {
        return this.text({ commands: this.ops.listCommands() });
      },
    );

    this.tool(
      "command_execute",
      "Execute an Obsidian command by its ID. " +
        "Use command_list to discover available command IDs. " +
        "Throws if the command ID does not exist.",
      { commandId: z.string().describe("The command ID to execute (e.g. 'editor:toggle-bold')") },
      async ({ commandId }: { commandId: string }) => {
        this.ops.executeCommand(commandId);
        return this.text({ message: "OK" });
      },
    );

    this.tool(
      "open_file",
      "Open a file in the Obsidian UI. " +
        "If the file does not exist, Obsidian will create a new document at that path. " +
        "Set newLeaf to true to open in a new pane rather than the current one.",
      {
        path: z.string().describe("File path relative to vault root"),
        newLeaf: z.boolean().optional().describe("Open in a new leaf/pane (default: false)"),
      },
      async ({ path, newLeaf }: { path: string; newLeaf?: boolean }) => {
        this.ops.openVaultFile(path, newLeaf);
        return this.text({ message: "OK" });
      },
    );
  }
}
