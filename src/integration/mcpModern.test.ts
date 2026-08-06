import {
  authedFetch,
  unauthFetch,
  ensureServerReachable,
  resetFixture,
  deleteFixture,
} from "./client";
import { TEST_DIR, TEST_PATH, FIXTURE_DOCUMENT } from "./fixtures";

// Integration coverage for the 2026-07-28 protocol revision.
//
// The requests are hand-built rather than driven through an SDK client on purpose: this
// revision's contract is a set of wire-level requirements — the per-request `_meta`
// envelope, the standard `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers, and
// the `resultType` / `ttlMs` / `cacheScope` fields on results — and asserting them
// directly is the only way to prove a real client would see them. The 2025-era client
// path is covered by mcp.test.ts, which drives the SDK's `initialize` handshake.

const MODERN_VERSION = "2026-07-28";
const MCP_PATH = "/mcp/";

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: Record<string, any> };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "integration-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
    ...overrides,
  };
}

interface ModernCallOptions {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  envelopeOverrides?: Record<string, unknown>;
}

let nextId = 1;

async function call(
  method: string,
  { params = {}, headers = {}, envelopeOverrides = {} }: ModernCallOptions = {},
): Promise<{ status: number; sessionId: string | null; body: JsonRpcResponse }> {
  const id = nextId++;
  const res = await authedFetch(MCP_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MODERN_VERSION,
      "Mcp-Method": method,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: envelope(envelopeOverrides) },
    }),
  });
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    body: (await res.json()) as JsonRpcResponse,
  };
}

beforeAll(async () => {
  await ensureServerReachable();
  await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
});

afterAll(async () => {
  await deleteFixture(TEST_PATH);
});

describe("MCP 2026-07-28 discovery", () => {
  test("server/discover reports the modern revision, capabilities, and identity", async () => {
    const { status, body } = await call("server/discover");
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result?.supportedVersions).toContain(MODERN_VERSION);
    expect(body.result?.capabilities.tools).toBeDefined();
    expect(body.result?.capabilities.resources).toBeDefined();
    expect(body.result?._meta["io.modelcontextprotocol/serverInfo"].name).toBe(
      "obsidian-local-rest-api",
    );
  });

  test("every result carries resultType 'complete'", async () => {
    const discover = await call("server/discover");
    const tools = await call("tools/list");
    expect(discover.body.result?.resultType).toBe("complete");
    expect(tools.body.result?.resultType).toBe("complete");
  });

  test("cacheable results carry ttlMs and a private cacheScope", async () => {
    for (const method of ["server/discover", "tools/list", "resources/list"]) {
      const { body } = await call(method);
      expect(typeof body.result?.ttlMs).toBe("number");
      expect(body.result?.cacheScope).toBe("private");
    }
  });
});

describe("MCP 2026-07-28 stateless requests", () => {
  test("tools/call succeeds with no prior initialize and mints no session id", async () => {
    const { status, sessionId, body } = await call("tools/call", {
      params: { name: "vault_list", arguments: { path: TEST_DIR } },
      headers: { "Mcp-Name": "vault_list" },
    });

    expect(status).toBe(200);
    expect(sessionId).toBeNull();
    expect(body.error).toBeUndefined();
    const listed = JSON.parse(body.result?.content[0].text as string) as { files: string[] };
    expect(listed.files.some((f) => f.includes("fixture"))).toBe(true);
  });

  test("consecutive calls are independent — neither sends nor needs a session id", async () => {
    const first = await call("tools/call", {
      params: { name: "vault_read", arguments: { path: TEST_PATH } },
      headers: { "Mcp-Name": "vault_read" },
    });
    const second = await call("tools/call", {
      params: { name: "vault_read", arguments: { path: TEST_PATH } },
      headers: { "Mcp-Name": "vault_read" },
    });

    expect(first.sessionId).toBeNull();
    expect(second.sessionId).toBeNull();
    expect(JSON.parse(first.body.result?.content[0].text as string).path).toBe(TEST_PATH);
    expect(JSON.parse(second.body.result?.content[0].text as string).path).toBe(TEST_PATH);
  });

  test("a stale Mcp-Session-Id header is ignored rather than rejected", async () => {
    const { status, body } = await call("tools/list", {
      headers: { "Mcp-Session-Id": "a-session-that-never-existed" },
    });
    expect(status).toBe(200);
    expect(body.result?.tools.length).toBeGreaterThan(0);
  });

  test("resources/read serves the OpenAPI spec", async () => {
    const uri = "obsidian://local-rest-api/openapi.yaml";
    const { body } = await call("resources/read", {
      params: { uri },
      headers: { "Mcp-Name": uri },
    });
    expect(body.result?.contents[0].text).toContain("openapi:");
  });
});

describe("MCP 2026-07-28 header and version validation", () => {
  test("an Mcp-Method header that disagrees with the body is rejected with -32020", async () => {
    const { status, body } = await call("tools/list", {
      headers: { "Mcp-Method": "tools/call" },
    });
    expect(status).toBe(400);
    expect(body.error?.code).toBe(-32020);
  });

  test("a missing Mcp-Name header on tools/call is rejected with -32020", async () => {
    const { status, body } = await call("tools/call", {
      params: { name: "vault_list", arguments: {} },
    });
    expect(status).toBe(400);
    expect(body.error?.code).toBe(-32020);
  });

  test("an unsupported protocol version is rejected with -32022", async () => {
    const res = await authedFetch(MCP_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-29",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/list",
        params: {
          _meta: envelope({ "io.modelcontextprotocol/protocolVersion": "2026-07-29" }),
        },
      }),
    });
    const body = (await res.json()) as JsonRpcResponse;
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.data?.supported).toContain(MODERN_VERSION);
  });

  test("a version the endpoint filter does not know is rejected before the SDK sees it", async () => {
    const res = await authedFetch(MCP_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "9999-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
  });

  test("a modern request without authentication is rejected", async () => {
    const res = await unauthFetch(MCP_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MODERN_VERSION,
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/list",
        params: { _meta: envelope() },
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe("MCP 2026-07-28 removed session operations", () => {
  test("GET no longer opens a standalone stream", async () => {
    const res = await authedFetch(MCP_PATH, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
  });

  test("DELETE no longer terminates a session", async () => {
    const res = await authedFetch(MCP_PATH, { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});
