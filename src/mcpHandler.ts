import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import express from "express";
import { TFile } from "obsidian";

import { VaultOperations } from "./vaultOperations";
import { PatchOperation, PatchTargetType } from "markdown-patch";
import openapiYaml from "../docs/openapi.yaml";

const PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

export class McpHandler {
  // typed as `any` to avoid TypeScript heap OOM when evaluating the MCP SDK's complex
  // ToolCallback<Args extends ZodRawShape> generics across the 16 tool registrations below
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly mcpServer: any;
  private readonly transports: Map<string, StreamableHTTPServerTransport> = new Map();

  constructor(private readonly ops: VaultOperations) {
    this.mcpServer = new McpServer({
      name: "obsidian-local-rest-api",
      version: "1.0.0",
    });
    this.registerResources();
    this.registerTools();
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
    this.mcpServer.tool(
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

    this.mcpServer.tool(
      "vault_read",
      "Read a vault file's content and metadata. " +
        "Returns a JSON object with: content (full markdown text), path, " +
        "tags (array of tag strings), frontmatter (parsed YAML front-matter as an object), " +
        "and stat ({ctime, mtime, size}). Throws if the file does not exist.",
      { path: z.string().describe("File path relative to vault root") },
      async ({ path }: { path: string }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        const meta = await this.ops.getFileMetadataObject(file);
        return this.text(meta);
      },
    );

    this.mcpServer.tool(
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

    this.mcpServer.tool(
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

    this.mcpServer.tool(
      "vault_patch",
      "Patch a specific section of a vault file by targeting a heading, block reference, or frontmatter field.\n\n" +
        "- targetType: 'heading' targets a markdown heading section; 'block' targets a block reference (the ID after '^'); 'frontmatter' targets a YAML front-matter key.\n" +
        "- target: the heading text, block ID, or frontmatter key. For nested headings use '::' as delimiter (e.g. 'Heading 1::Subheading'); customise with targetDelimiter.\n" +
        "- operation: 'append' adds content after the section, 'prepend' adds before, 'replace' replaces entirely.\n" +
        "- contentType: 'text/markdown' (default) treats content as markdown. 'application/json' parses it as JSON — useful for setting typed frontmatter values or appending rows to a table (pass a 2-D array of row cells).\n" +
        "- createTargetIfMissing: set to true to create the heading or frontmatter key if it does not exist yet.\n" +
        "- trimTargetWhitespace: strip leading/trailing whitespace from the target section before patching.",
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
        targetDelimiter: z
          .string()
          .optional()
          .describe("Delimiter for nested heading paths (default: '::')"),
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
        targetDelimiter,
      }: {
        path: string;
        targetType: PatchTargetType;
        target: string;
        operation: PatchOperation;
        content: unknown;
        contentType?: string;
        createTargetIfMissing?: boolean;
        trimTargetWhitespace?: boolean;
        targetDelimiter?: string;
      }) => {
        const contentStr =
          typeof content === "string" ? content : JSON.stringify(content);
        await this.ops.patchFileSection(
          path,
          targetType,
          target,
          operation,
          contentStr,
          contentType ?? "text/markdown",
          { createTargetIfMissing, trimTargetWhitespace, targetDelimiter },
        );
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "vault_delete",
      "Delete a file from the vault. Throws if the file does not exist.",
      { path: z.string().describe("File path relative to vault root") },
      async ({ path }: { path: string }) => {
        await this.ops.deleteVaultFile(path);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "active_file_read",
      "Read the content and metadata of the file currently open in Obsidian. " +
        "Returns the same JSON shape as vault_read: content, path, tags, frontmatter, stat. " +
        "Throws if no file is active.",
      {},
      async () => {
        const file = this.getActiveFile();
        const meta = await this.ops.getFileMetadataObject(file);
        return this.text(meta);
      },
    );

    this.mcpServer.tool(
      "active_file_write",
      "Overwrite the content of the file currently open in Obsidian. Throws if no file is active.",
      { content: z.string().describe("New full file content (markdown text)") },
      async ({ content }: { content: string }) => {
        const file = this.getActiveFile();
        await this.ops.writeFileContent(file.path, content);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "active_file_append",
      "Append content to the end of the file currently open in Obsidian. Throws if no file is active.",
      { content: z.string().describe("Content to append") },
      async ({ content }: { content: string }) => {
        const file = this.getActiveFile();
        await this.ops.appendFileContent(file.path, content);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "periodic_note_read",
      "Read the content and metadata of the current periodic note for the given period " +
        "(daily, weekly, monthly, quarterly, or yearly). " +
        "Requires the Periodic Notes or Calendar plugin to be installed and configured. " +
        "Throws if the note for the current period does not exist yet.",
      {
        period: z
          .enum(PERIODS)
          .describe("Periodic note period: 'daily', 'weekly', 'monthly', 'quarterly', or 'yearly'"),
      },
      async ({ period }: { period: typeof PERIODS[number] }) => {
        const [file, err] = this.ops.periodicGetNote(period, Date.now());
        if (err || !file) throw new Error(`Periodic note not found: ${err}`);
        const meta = await this.ops.getFileMetadataObject(file);
        return this.text(meta);
      },
    );

    this.mcpServer.tool(
      "periodic_note_write",
      "Write (or create) the current periodic note for the given period. " +
        "Creates the note file if it does not already exist.",
      {
        period: z.enum(PERIODS).describe("Periodic note period: 'daily', 'weekly', 'monthly', 'quarterly', or 'yearly'"),
        content: z.string().describe("New full file content (markdown text)"),
      },
      async ({ period, content }: { period: typeof PERIODS[number]; content: string }) => {
        const [file, err] = await this.ops.periodicGetOrCreateNote(
          period,
          Date.now(),
        );
        if (err || !file) throw new Error(`Could not get or create periodic note: ${err}`);
        await this.ops.writeFileContent(file.path, content);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "periodic_note_append",
      "Append content to the current periodic note for the given period. " +
        "Creates the note file if it does not already exist.",
      {
        period: z.enum(PERIODS).describe("Periodic note period: 'daily', 'weekly', 'monthly', 'quarterly', or 'yearly'"),
        content: z.string().describe("Content to append"),
      },
      async ({ period, content }: { period: typeof PERIODS[number]; content: string }) => {
        const [file, err] = await this.ops.periodicGetOrCreateNote(
          period,
          Date.now(),
        );
        if (err || !file) throw new Error(`Could not get or create periodic note: ${err}`);
        await this.ops.appendFileContent(file.path, content);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
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
          .any()
          .describe("JsonLogic query object to evaluate against each note"),
      },
      async ({ query }: { query: unknown }) => {
        const results = await this.ops.searchJsonLogic(query);
        return this.text(results);
      },
    );

    this.mcpServer.tool(
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

    this.mcpServer.tool(
      "tags_list",
      "Return all tags used across the vault, each with a usage count. " +
        "Tag names do not include the leading '#'.",
      {},
      async () => {
        return this.text({ tags: this.ops.getAllTags() });
      },
    );

    this.mcpServer.tool(
      "commands_list",
      "Return all registered Obsidian commands. " +
        "Each entry has an 'id' and a human-readable 'name'. " +
        "Pass the 'id' to command_execute to run a command.",
      {},
      async () => {
        return this.text({ commands: this.ops.listCommands() });
      },
    );

    this.mcpServer.tool(
      "command_execute",
      "Execute an Obsidian command by its ID. " +
        "Use commands_list to discover available command IDs. " +
        "Throws if the command ID does not exist.",
      { commandId: z.string().describe("The command ID to execute (e.g. 'editor:toggle-bold')") },
      async ({ commandId }: { commandId: string }) => {
        this.ops.executeCommand(commandId);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
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
