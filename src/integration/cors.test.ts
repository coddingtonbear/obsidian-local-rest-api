import { authedFetch, unauthFetch, ensureServerReachable, resetFixture, deleteFixture, BASE_URL } from "./client";
import { FIXTURE_DOCUMENT, TEST_PATH, HEADING_DELTA } from "./fixtures";

// The unit tests assemble the router under supertest; these drive the real server, which
// is where the ordering of cors() against the auth and body-parsing middleware actually
// holds. A browser reads a response header only if Access-Control-Expose-Headers names
// it, and this API answers several questions in headers rather than in the body.

const ORIGIN = "https://example.com";

beforeAll(async () => {
  await ensureServerReachable();
});

describe("CORS exposed response headers", () => {
  test("GET / exposes every response header", async () => {
    const res = await unauthFetch("/", { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-expose-headers")).toBe("*");
  });

  test("the /mcp/ router exposes every response header", async () => {
    // cors runs ahead of the MCP router's auth middleware, so an unauthenticated request
    // is enough to observe the directive -- and it avoids needing a valid MCP handshake.
    // Mcp-Session-Id rides this router, and the MCP SDK's own browser client reads that
    // header off the response to establish a sessionful connection.
    const res = await fetch(`${BASE_URL}/mcp/`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-expose-headers")).toBe("*");
  });

  test("a preflight still reflects the headers the request asked for", async () => {
    // The request direction was never broken; pinned so that a change to the response
    // direction cannot quietly cost us the request direction.
    const res = await fetch(`${BASE_URL}/`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
  });

  describe("against a response that really sets a custom header", () => {
    beforeAll(async () => {
      await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
    });

    afterAll(async () => {
      await deleteFixture(TEST_PATH);
    });

    test("a POST that returns Content-Location exposes it to a browser", async () => {
      // Content-Location is the answer to "where did my write actually land" -- the whole
      // point of the section-targeting routes. Asserting the header and the directive
      // together is what proves a browser client can read it, rather than merely that the
      // directive is set on some other response.
      const res = await authedFetch(`/vault/${TEST_PATH}/heading/${HEADING_DELTA}`, {
        method: "POST",
        headers: { "Content-Type": "text/markdown", Origin: ORIGIN },
        body: "A line appended by the CORS integration test.",
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-location")).toBeTruthy();
      expect(res.headers.get("access-control-expose-headers")).toBe("*");
    });
  });
});
