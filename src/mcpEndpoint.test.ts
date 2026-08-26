import http from "http";
import request from "supertest";

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";
import { App, PluginManifest } from "../mocks/obsidian";

// The mounted `/mcp/` endpoint, wired through the real RequestHandler *and* the real
// McpHandler. requestHandler.test.ts mocks McpHandler, which means it cannot show what
// the router's middleware order does to a real request: whether an unrecognised protocol
// version is answered by the router or reaches the SDK, and whether the sessionless and sessionful
// legs are picked correctly, are both decided by that order.

const API_KEY = "my api key";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-06-18";
// The newest sessionful revision, which `src/constants.ts`, `src/mcpHandler.ts`, and the
// Readme all promise to serve. Deliberately a literal rather than the SDK's
// `LATEST_PROTOCOL_VERSION`: it happens to be the SDK's latest today, so reading the
// constant would make these assertions tautological and they would keep passing if a
// future SDK bump dropped this revision out of `SUPPORTED_PROTOCOL_VERSIONS` and started
// negotiating clients down from it. Pinning the literal is what makes that visible.
const NEWEST_SESSIONFUL_VERSION = "2025-11-25";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "endpoint-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
    ...overrides,
  };
}

function sessionlessBody(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: envelope(envelopeOverrides) },
  };
}

// Read the JSON-RPC message out of a sessionful-leg SSE response.
function sseResult(text: string) {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`No SSE data frame in response: ${text}`);
  return JSON.parse(line.slice("data: ".length));
}

describe("mounted /mcp/ endpoint", () => {
  let handler: RequestHandler;
  let server: http.Server;

  beforeEach(() => {
    const settings: LocalRestApiSettings = {
      apiKey: API_KEY,
      crypto: { cert: "cert", privateKey: "privateKey", publicKey: "publicKey" },
      port: 1,
      insecurePort: 2,
      enableInsecureServer: false,
    };
    // @ts-ignore: the Obsidian App mock does not implement every App member.
    handler = new RequestHandler(new App(), new PluginManifest(), settings);
    handler.setupRouter();
    server = http.createServer(handler.api);
  });

  afterEach(() => {
    handler.mcpHandler.close();
    server.close();
  });

  function authed(method: "post" | "get" | "delete", path = "/mcp/") {
    return request(server)[method](path).set("Authorization", `Bearer ${API_KEY}`);
  }

  describe("middleware order", () => {
    test("authentication is checked before the protocol version filter", async () => {
      // An unauthenticated request with a bad version must fail as 401, not 400: the
      // version filter must never run for a caller that has not proven itself.
      await request(server)
        .post("/mcp/")
        .set("MCP-Protocol-Version", "9999-01-01")
        .send(sessionlessBody(1, "tools/list"))
        .expect(401);
    });

    test("an unrecognised version on a sessionless-shaped request is answered by the SDK with -32022", async () => {
      const res = await authed("post")
        .set("MCP-Protocol-Version", "2026-07-29")
        .set("Mcp-Method", "tools/list")
        .send(
          sessionlessBody(1, "tools/list", {}, {
            "io.modelcontextprotocol/protocolVersion": "2026-07-29",
          }),
        )
        .expect(400);

      expect(res.body.error.code).toBe(-32022);
      expect(res.body.error.data.supported).toContain(MODERN_VERSION);
    });

    test("an unrecognised version on a POST reaches the SDK, which names what is missing", async () => {
      // The SDK classifies any POST whose version header it does not recognise as
      // sessionless-shaped, so that the SDK's validation ladder — not a bare `{error}` body —
      // gets to answer. A body with no envelope is -32602; one claiming the unknown
      // revision is -32022 (covered above).
      const res = await authed("post")
        .set("MCP-Protocol-Version", "9999-01-01")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        .expect(400);

      expect(res.body.jsonrpc).toBe("2.0");
      expect(res.body.error.code).toBe(-32602);
    });

    test("a body-less session operation with an unrecognised version keeps the router's plain rejection", async () => {
      for (const method of ["get", "delete"] as const) {
        const res = await authed(method)
          .set("MCP-Protocol-Version", "9999-01-01")
          .expect(400);

        expect(res.body.error).toMatch(/Unsupported MCP-Protocol-Version: 9999-01-01/);
        expect(res.body.jsonrpc).toBeUndefined();
      }
    });
  });

  describe("sessionless leg", () => {
    test("serves tools/call with no session and mints no session id", async () => {
      const res = await authed("post")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "tools/call")
        .set("Mcp-Name", "tag_list")
        .send(sessionlessBody(1, "tools/call", { name: "tag_list", arguments: {} }))
        .expect(200);

      expect(res.headers["mcp-session-id"]).toBeUndefined();
      expect(res.body.result.resultType).toBe("complete");
    });

    test("serves server/discover", async () => {
      const res = await authed("post")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", MODERN_VERSION)
        .set("Mcp-Method", "server/discover")
        .send(sessionlessBody(1, "server/discover"))
        .expect(200);

      expect(res.body.result.supportedVersions).toContain(MODERN_VERSION);
    });
  });

  describe("sessionful leg", () => {
    async function initializeAt(
      version: string,
    ): Promise<{ sessionId: string; result: any }> {
      const res = await authed("post")
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
      const sessionId = res.headers["mcp-session-id"];
      expect(typeof sessionId).toBe("string");
      return { sessionId, result: sseResult(res.text).result };
    }

    async function initialize(): Promise<string> {
      return (await initializeAt(LEGACY_VERSION)).sessionId;
    }

    test("initialize at the newest sessionful revision negotiates it unchanged", async () => {
      // Regression cover for issue #329, which reported that `initialize` at 2025-11-25
      // never gets an answer. It does — but nothing pinned that, so the "through
      // 2025-11-25" promise rested entirely on the pinned SDK's own version list.
      const { sessionId, result } = await initializeAt(NEWEST_SESSIONFUL_VERSION);
      expect(result.protocolVersion).toBe(NEWEST_SESSIONFUL_VERSION);
      expect(sessionId.length).toBeGreaterThan(0);
    });

    test("the newest sessionful revision passes the router's version filter", async () => {
      // The filter at requestHandler.ts's `/mcp/` mount rejects any version it does not
      // know with a plain 400 before the SDK ever sees it, so a revision dropping out of
      // that list would fail here rather than at the handshake.
      const { sessionId } = await initializeAt(NEWEST_SESSIONFUL_VERSION);
      const res = await authed("post")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", NEWEST_SESSIONFUL_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
        .expect(200);

      expect(sseResult(res.text).result.tools).toHaveLength(18);
    });

    test("initialize opens a session and later requests reuse it", async () => {
      const sessionId = await initialize();
      const res = await authed("post")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", sessionId)
        .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
        .expect(200);

      expect(sseResult(res.text).result.tools).toHaveLength(18);
    });

    test("an unknown session id is rejected with 404", async () => {
      const res = await authed("post")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", LEGACY_VERSION)
        .set("Mcp-Session-Id", "a-session-that-never-existed")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        .expect(404);

      expect(res.body.error).toMatch(/Session not found/);
    });
  });
});
