import { authedFetch, unauthFetch, ensureServerReachable } from "./client";

beforeAll(async () => {
  await ensureServerReachable();
});

describe("GET /", () => {
  test("unauthenticated returns 200 with status OK and authenticated false", async () => {
    const res = await unauthFetch("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("OK");
    expect(body.authenticated).toBe(false);
  });

  test("authenticated returns authenticated true", async () => {
    const res = await authedFetch("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
  });

  test("returns service field", async () => {
    const res = await authedFetch("/");
    const body = await res.json();
    expect(body.service).toBe("Obsidian Local REST API");
  });

  test("returns versions object with obsidian and self strings", async () => {
    const res = await authedFetch("/");
    const body = await res.json();
    expect(typeof body.versions?.obsidian).toBe("string");
    expect(typeof body.versions?.self).toBe("string");
  });
});

describe("GET /openapi.yaml", () => {
  test("returns 200 with YAML content containing openapi field", async () => {
    const res = await unauthFetch("/openapi.yaml");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("openapi:");
  });

  test("content-type includes yaml", async () => {
    const res = await unauthFetch("/openapi.yaml");
    expect(res.headers.get("content-type")).toMatch(/yaml/);
  });
});
