// `AsyncLocalStorage` crashes Obsidian's renderer outright. Under Electron's Node 24 it
// keeps its state in V8's continuation-preserved embedder data, a slot Blink also writes
// for tasks descended from a user gesture; a server created during such a task -- the
// plugin toggled on from the settings screen -- hands its sockets Blink's value, and the
// first `getStore()` on it trips a fatal V8 check that takes the whole window down.
// Nothing about that is reproducible under Jest, so this file stands in for it by making
// every use of `AsyncLocalStorage` throw, and checks that the MCP endpoint -- including
// the signed-URL tools, which need to know the request they arrived on -- never reaches
// for it.
jest.mock("async_hooks", () => {
  const actual = jest.requireActual("async_hooks");
  class ForbiddenAsyncLocalStorage {
    constructor() {
      throw new Error("AsyncLocalStorage crashes Obsidian's renderer; do not use it");
    }
  }
  return { ...actual, AsyncLocalStorage: ForbiddenAsyncLocalStorage };
});

import http from "http";
import https from "https";
import { AddressInfo } from "net";

import RequestHandler from "./requestHandler";
import { buildServerCertificateChain, generateCryptoSettings } from "./certificates";
import { LocalRestApiSettings } from "./types";
import { App, PluginManifest } from "../mocks/obsidian";

const API_KEY = "my api key";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-06-18";

// Generated once: key generation is the slow part of this file.
const crypto = generateCryptoSettings();

type Scheme = "http" | "https";

// A minimal client that talks to a real server over the given scheme, trusting the
// test's own self-signed certificate.
function post(
  scheme: Scheme,
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const payload = JSON.stringify(body);
  const options: https.RequestOptions = {
    host: "127.0.0.1",
    port,
    path: "/mcp/",
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(payload).toString(),
      ...headers,
    },
    rejectUnauthorized: false,
  };
  const transport = scheme === "https" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

// The JSON-RPC message in a response, whichever of JSON or SSE framing it came in.
function jsonRpc(text: string): { result?: { content?: { text: string }[] }; error?: unknown } {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice("data: ".length) : text);
}

function uploadUrlFrom(message: ReturnType<typeof jsonRpc>): string {
  const block = message.result?.content?.[0];
  if (!block) throw new Error(`No tool result in ${JSON.stringify(message)}`);
  return (JSON.parse(block.text) as { url: string }).url;
}

describe.each<Scheme>(["http", "https"])("MCP signed URLs over %s", (scheme) => {
  let handler: RequestHandler;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const settings: LocalRestApiSettings = {
      apiKey: API_KEY,
      crypto,
      port: 1,
      insecurePort: 2,
      enableInsecureServer: false,
      enableSignedUrls: true,
    };
    // @ts-ignore: the Obsidian App mock does not implement every App member.
    handler = new RequestHandler(new App(), new PluginManifest(), settings);
    handler.setupRouter();
    server =
      scheme === "https"
        ? https.createServer(
            { key: crypto.privateKey, cert: buildServerCertificateChain(crypto) },
            handler.api,
          )
        : http.createServer(handler.api);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    handler.mcpHandler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test("the sessionless leg builds the link from the request's scheme and host", async () => {
    const res = await post(
      scheme,
      port,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "vault_get_upload_url",
          arguments: { path: "upload.bin" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "context-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      {
        "MCP-Protocol-Version": MODERN_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "vault_get_upload_url",
      },
    );

    expect(res.status).toBe(200);
    expect(uploadUrlFrom(jsonRpc(res.text))).toMatch(
      new RegExp(`^${scheme}://127\\.0\\.0\\.1:${port}/vault/upload\\.bin\\?`),
    );
  });

  test("the sessionful leg builds the link from the request's scheme and host", async () => {
    const init = await post(
      scheme,
      port,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LEGACY_VERSION,
          capabilities: {},
          clientInfo: { name: "context-test", version: "1.0.0" },
        },
      },
      {},
    );
    expect(init.status).toBe(200);
    const sessionId = init.headers["mcp-session-id"] as string;

    const res = await post(
      scheme,
      port,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "vault_get_upload_url", arguments: { path: "upload.bin" } },
      },
      { "MCP-Protocol-Version": LEGACY_VERSION, "Mcp-Session-Id": sessionId },
    );

    expect(res.status).toBe(200);
    expect(uploadUrlFrom(jsonRpc(res.text))).toMatch(
      new RegExp(`^${scheme}://127\\.0\\.0\\.1:${port}/vault/upload\\.bin\\?`),
    );
  });

  test("a forwarded scheme from a proxy in front of the server is honoured", async () => {
    const res = await post(
      scheme,
      port,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "vault_get_upload_url",
          arguments: { path: "upload.bin" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "context-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      {
        "MCP-Protocol-Version": MODERN_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "vault_get_upload_url",
        "X-Forwarded-Proto": "https, http",
      },
    );

    expect(res.status).toBe(200);
    expect(uploadUrlFrom(jsonRpc(res.text))).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/vault\//);
  });
});
