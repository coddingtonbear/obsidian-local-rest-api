import { ErrorCode } from "../types";
import { AuthenticationFailureLimit, AuthenticationFailureWindowMs } from "../constants";
import { authedFetch, unauthFetch, ensureServerReachable } from "./client";

const WRONG_KEY = { Authorization: "Bearer not-the-key" };

beforeAll(ensureServerReachable);

// This suite spends the whole failure allowance for this machine's address, and while
// that window is open the live server answers 429 to any *wrong* credential from here --
// including the mismatched and spent signed URLs that the MCP and event-stream suites
// expect a 401 for. Jest does not promise a file order, so rather than hoping to run last,
// the suite waits the window out before it finishes (the last 429 says how long), and the
// first test accepts a window that an earlier, interrupted run may have left open.
let retryAfterSeconds = 0;

afterAll(async () => {
  if (retryAfterSeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, (retryAfterSeconds + 1) * 1000));
  }
}, AuthenticationFailureWindowMs + 10_000);

describe("failed-authentication throttle", () => {
  test("wrong keys are refused with 429 once the limit is reached", async () => {
    let refused: Response | undefined;
    for (let i = 0; i <= AuthenticationFailureLimit && refused === undefined; i++) {
      const res = await unauthFetch("/vault/", { headers: WRONG_KEY });
      expect([401, 429]).toContain(res.status);
      if (res.status === 429) refused = res;
    }
    expect(refused).toBeDefined();
    const body = (await refused.json()) as { errorCode: number; message: string };
    expect(body.errorCode).toBe(ErrorCode.TooManyAuthenticationFailures);
    expect(body.message).toMatch(/Too many failed authentication attempts/);
    retryAfterSeconds = Number(refused.headers.get("retry-after"));
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(AuthenticationFailureWindowMs / 1000);
  });

  test("the right key is served while wrong ones are refused", async () => {
    const res = await authedFetch("/");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(true);
    expect((await authedFetch("/vault/")).status).toBe(200);
    expect((await unauthFetch("/vault/", { headers: WRONG_KEY })).status).toBe(429);
  });

  test("requests presenting no credential are neither counted nor refused", async () => {
    expect((await unauthFetch("/vault/")).status).toBe(401);
    const root = await unauthFetch("/");
    expect(root.status).toBe(200);
    expect(((await root.json()) as { authenticated: boolean }).authenticated).toBe(false);
    expect((await unauthFetch("/openapi.json")).status).toBe(200);
  });

  test("GET / and /mcp/ refuse a wrong key like every other route", async () => {
    expect((await unauthFetch("/", { headers: WRONG_KEY })).status).toBe(429);
    const mcp = await unauthFetch("/mcp/", {
      method: "POST",
      headers: { ...WRONG_KEY, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(mcp.status).toBe(429);
  });
});
