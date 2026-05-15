// Integration tests for /secrets/ endpoints.
// Requires a live Obsidian instance with the plugin's insecure HTTP server enabled
// and OBSIDIAN_API_KEY set.
//
// These tests write and delete refs prefixed with "integ-test-" to avoid clobbering
// any real secrets stored by other plugins. Cleanup runs in afterEach.

import { authedFetch, unauthFetch, ensureServerReachable } from "./client";

const TEST_REF = `integ-test-${Date.now()}`;

beforeAll(async () => {
  await ensureServerReachable();
});

afterEach(async () => {
  // Best-effort cleanup; ignore failures.
  await authedFetch(`/secrets/${TEST_REF}/`, { method: "DELETE" }).catch(() => {});
});

describe("GET /secrets/diag/", () => {
  test("returns 200 with available/missing/methods/type fields", async () => {
    const res = await authedFetch("/secrets/diag/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("available");
    expect(body).toHaveProperty("missing");
    expect(body).toHaveProperty("methods");
    expect(body).toHaveProperty("type");
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/secrets/diag/");
    expect(res.status).toBe(401);
  });
});

describe("GET /secrets/", () => {
  test("returns 200 with refs array", async () => {
    const res = await authedFetch("/secrets/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.refs)).toBe(true);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/secrets/");
    expect(res.status).toBe(401);
  });
});

describe("/secrets/{ref}/ CRUD round-trip", () => {
  test("PUT then GET then DELETE then GET 404", async () => {
    const value = `secret-value-${Date.now()}`;

    // PUT (JSON body)
    const putRes = await authedFetch(`/secrets/${TEST_REF}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    expect(putRes.status).toBe(204);

    // GET — value returned
    const getRes = await authedFetch(`/secrets/${TEST_REF}/`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.ref).toBe(TEST_REF);
    expect(body.value).toBe(value);

    // Ref should appear in list
    const listRes = await authedFetch("/secrets/");
    const listBody = await listRes.json();
    expect(listBody.refs).toContain(TEST_REF);

    // DELETE
    const delRes = await authedFetch(`/secrets/${TEST_REF}/`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    // GET — 404 after delete
    const getRes2 = await authedFetch(`/secrets/${TEST_REF}/`);
    expect(getRes2.status).toBe(404);
  });

  test("PUT accepts raw text/plain body", async () => {
    const value = `plain-value-${Date.now()}`;
    const putRes = await authedFetch(`/secrets/${TEST_REF}/`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: value,
    });
    expect(putRes.status).toBe(204);

    const getRes = await authedFetch(`/secrets/${TEST_REF}/`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.value).toBe(value);
  });

  test("DELETE is idempotent (204 even when ref missing)", async () => {
    const ref = `integ-test-missing-${Date.now()}`;
    const res = await authedFetch(`/secrets/${ref}/`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("GET nonexistent ref returns 404", async () => {
    const ref = `integ-test-nope-${Date.now()}`;
    const res = await authedFetch(`/secrets/${ref}/`);
    expect(res.status).toBe(404);
  });

  test("GET returns 401 without auth", async () => {
    const res = await unauthFetch(`/secrets/${TEST_REF}/`);
    expect(res.status).toBe(401);
  });

  test("PUT returns 401 without auth", async () => {
    const res = await unauthFetch(`/secrets/${TEST_REF}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("DELETE returns 401 without auth", async () => {
    const res = await unauthFetch(`/secrets/${TEST_REF}/`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
