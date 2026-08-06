import http from "http";
import express from "express";

// The real VaultOperations is never instantiated — see mcpHandler.test.ts for why it is
// kept out of the ts-jest compile.
jest.mock("./vaultOperations", () => ({ VaultOperations: jest.fn() }));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { McpHandler } from "./mcpHandler";
import { DEFAULT_SETTINGS } from "./constants";

// End-to-end interoperability with a real pre-2026 MCP client, driven by the v1 SDK — the
// same client the integration suite uses, and the shape every currently-shipping MCP host
// speaks. The 2026-07-28 migration must not change anything this client observes, so the
// whole legacy session lifecycle is exercised here: handshake, session id, tool calls, and
// the `tools/list_changed` notification an extension registering a tool has to produce.

jest.setTimeout(20000);

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("legacy MCP client interoperability", () => {
  let mcp: McpHandler;
  let server: http.Server;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  // The client opens its standalone notification stream lazily, with a GET. A
  // notification emitted before that stream exists has nowhere to go, so the test waits
  // for the GET to land rather than sleeping and hoping.
  let notificationStreamOpen = false;

  beforeEach(async () => {
    const ops = {
      app: { vault: { getAbstractFileByPath: jest.fn() }, workspace: { getActiveFile: jest.fn() } },
      getAllTags: jest.fn().mockReturnValue([{ name: "todo", count: 1 }]),
    };
    // @ts-ignore: partial VaultOperations stand-in
    mcp = new McpHandler(ops, DEFAULT_SETTINGS);

    const app = express();
    app.use(express.json());
    app.all("/mcp/", (req, res, next) => {
      if (req.method === "GET") notificationStreamOpen = true;
      mcp.handleRequest(req, res).catch(next);
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as { port: number };
    client = new Client({ name: "v1-legacy-client", version: "1.0.0" });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/`));
  });

  afterEach(async () => {
    await client.close().catch(() => undefined);
    mcp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    notificationStreamOpen = false;
  });

  test("connects, is given a session, and calls tools", async () => {
    await client.connect(transport);

    expect(transport.sessionId).toEqual(expect.any(String));
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect((await client.listTools()).tools).toHaveLength(16);

    const result = await client.callTool({ name: "tag_list", arguments: {} });
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({
      tags: [{ name: "todo", count: 1 }],
    });
  });

  test("is notified when an extension registers a tool, and can call it", async () => {
    let listChanged = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged = true;
    });
    await client.connect(transport);
    await waitFor(() => notificationStreamOpen, "the client's notification stream");

    mcp.registerTool("extension_tool", "From an extension", {}, async () => "hi");

    await waitFor(() => listChanged, "notifications/tools/list_changed");
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("extension_tool");
    expect(await client.callTool({ name: "extension_tool", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "hi" }],
    });
  });

  test("is notified when an extension removes a tool", async () => {
    const cleanup = mcp.registerTool("extension_tool", "From an extension", {}, async () => "hi");
    let listChanged = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged = true;
    });
    await client.connect(transport);
    await waitFor(() => notificationStreamOpen, "the client's notification stream");

    cleanup();

    await waitFor(() => listChanged, "notifications/tools/list_changed");
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("extension_tool");
  });

  test("terminating the session frees it server-side", async () => {
    await client.connect(transport);
    const sessionId = transport.sessionId;
    await transport.terminateSession();

    const sessions = (mcp as unknown as { legacySessions: Map<string, unknown> }).legacySessions;
    expect(sessionId).toEqual(expect.any(String));
    expect(sessions.size).toBe(0);
  });
});
