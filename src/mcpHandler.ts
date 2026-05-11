import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import express from "express";
import { TFile } from "obsidian";

import { VaultOperations } from "./vaultOperations";
import { PatchOperation, PatchTargetType } from "markdown-patch";

const PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

export class McpHandler {
  private readonly mcpServer: McpServer;
  private readonly transports: Map<string, SSEServerTransport> = new Map();

  constructor(private readonly ops: VaultOperations) {
    this.mcpServer = new McpServer({
      name: "obsidian-local-rest-api",
      version: "1.0.0",
    });
    this.registerTools();
  }

  async handleSse(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const transport = new SSEServerTransport("/mcp/", res);
    this.transports.set(transport.sessionId, transport);
    req.on("close", () => this.transports.delete(transport.sessionId));
    await this.mcpServer.connect(transport);
  }

  async handlePost(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const sessionId = req.query.sessionId as string;
    const transport = this.transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handlePostMessage(req, res);
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

  private registerTools(): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore TS2589: type inference depth limit with zod generics in TS 4.7
    this.mcpServer.tool(
      "vault_list",
      "List files and subdirectories in a vault directory",
      { path: z.string().optional().describe("Directory path (default: root)") },
      async ({ path }) => {
        const files = await this.ops.listVaultDirectory(path ?? "");
        return this.text({ files });
      },
    );

    this.mcpServer.tool(
      "vault_read",
      "Read a vault file's content and metadata",
      { path: z.string().describe("File path relative to vault root") },
      async ({ path }) => {
        const file = this.ops.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        const meta = await this.ops.getFileMetadataObject(file);
        return this.text(meta);
      },
    );

    this.mcpServer.tool(
      "vault_write",
      "Create or overwrite a vault file",
      {
        path: z.string().describe("File path relative to vault root"),
        content: z.string().describe("New file content"),
      },
      async ({ path, content }) => {
        await this.ops.writeFileContent(path, content);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "vault_append",
      "Append content to a vault file",
      {
        path: z.string().describe("File path relative to vault root"),
        content: z.string().describe("Content to append"),
      },
      async ({ path, content }) => {
        await this.ops.appendFileContent(path, content);
        return this.text({ message: "OK" });
      },
    );

    // @ts-ignore TS2589: type inference depth limit with zod generics in TS 4.7
    this.mcpServer.tool(
      "vault_patch",
      "Patch a specific section of a vault file",
      {
        path: z.string().describe("File path relative to vault root"),
        targetType: z
          .enum(["heading", "block", "frontmatter"])
          .describe("Type of target section"),
        target: z.string().describe("Target identifier (heading text, block id, or frontmatter key)"),
        operation: z
          .enum(["replace", "prepend", "append"])
          .describe("Patch operation"),
        content: z.string().describe("Content to apply"),
        contentType: z
          .string()
          .optional()
          .describe("Content type (default: text/plain)"),
        createTargetIfMissing: z
          .boolean()
          .optional()
          .describe("Create the target if it doesn't exist"),
        trimTargetWhitespace: z
          .boolean()
          .optional()
          .describe("Trim whitespace from target before patching"),
        targetDelimiter: z
          .string()
          .optional()
          .describe("Delimiter for nested heading paths (default: ::)"),
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
      }) => {
        await this.ops.patchFileSection(
          path,
          targetType as PatchTargetType,
          target,
          operation as PatchOperation,
          content,
          contentType ?? "text/plain",
          { createTargetIfMissing, trimTargetWhitespace, targetDelimiter },
        );
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "vault_delete",
      "Delete a file from the vault",
      { path: z.string().describe("File path relative to vault root") },
      async ({ path }) => {
        await this.ops.deleteVaultFile(path);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "active_file_read",
      "Read the currently active file's content and metadata",
      {},
      async () => {
        const file = this.getActiveFile();
        const meta = await this.ops.getFileMetadataObject(file);
        return this.text(meta);
      },
    );

    this.mcpServer.tool(
      "active_file_write",
      "Overwrite the currently active file",
      { content: z.string().describe("New file content") },
      async ({ content }) => {
        const file = this.getActiveFile();
        await this.ops.writeFileContent(file.path, content);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "active_file_append",
      "Append content to the currently active file",
      { content: z.string().describe("Content to append") },
      async ({ content }) => {
        const file = this.getActiveFile();
        await this.ops.appendFileContent(file.path, content);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "periodic_note_read",
      "Read a periodic note (daily, weekly, etc.)",
      {
        period: z
          .enum(PERIODS)
          .describe("Periodic note type"),
      },
      async ({ period }) => {
        const [file, err] = this.ops.periodicGetNote(period, Date.now());
        if (err || !file) throw new Error(`Periodic note not found: ${err}`);
        const meta = await this.ops.getFileMetadataObject(file);
        return this.text(meta);
      },
    );

    this.mcpServer.tool(
      "periodic_note_write",
      "Write (or create) a periodic note",
      {
        period: z.enum(PERIODS).describe("Periodic note type"),
        content: z.string().describe("New file content"),
      },
      async ({ period, content }) => {
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
      "Append content to a periodic note (creating it if needed)",
      {
        period: z.enum(PERIODS).describe("Periodic note type"),
        content: z.string().describe("Content to append"),
      },
      async ({ period, content }) => {
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
      "search_simple",
      "Search vault files using Obsidian's simple search",
      {
        query: z.string().describe("Search query"),
        contextLength: z
          .number()
          .optional()
          .describe("Characters of context around each match (default: 100)"),
      },
      async ({ query, contextLength }) => {
        const results = await this.ops.simpleSearch(query, contextLength);
        return this.text(results);
      },
    );

    this.mcpServer.tool(
      "tags_list",
      "List all tags in the vault with usage counts",
      {},
      async () => {
        return this.text({ tags: this.ops.getAllTags() });
      },
    );

    this.mcpServer.tool(
      "commands_list",
      "List all available Obsidian commands",
      {},
      async () => {
        return this.text({ commands: this.ops.listCommands() });
      },
    );

    this.mcpServer.tool(
      "command_execute",
      "Execute an Obsidian command by ID",
      { commandId: z.string().describe("Command ID to execute") },
      async ({ commandId }) => {
        this.ops.executeCommand(commandId);
        return this.text({ message: "OK" });
      },
    );

    this.mcpServer.tool(
      "open_file",
      "Open a file in Obsidian",
      {
        path: z.string().describe("File path relative to vault root"),
        newLeaf: z.boolean().optional().describe("Open in a new leaf/pane"),
      },
      async ({ path, newLeaf }) => {
        this.ops.openVaultFile(path, newLeaf);
        return this.text({ message: "OK" });
      },
    );
  }
}
