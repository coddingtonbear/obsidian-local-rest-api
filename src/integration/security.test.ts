/**
 * Integration tests for path traversal vulnerability (GHSA-62gx-5q78-wrvx).
 *
 * The /vault/{path} endpoint decodes %2F after Express routing, which lets
 * "..%2F" sequences escape the vault root. These tests confirm the bug exists
 * (each one currently fails with a 2xx) and will pass once the fix is applied.
 *
 * Strategy: create a canary file in /tmp/ and attempt to reach it via 20
 * "..%2F" segments. posix.resolve clamps extra ".." at the filesystem root,
 * so 20 is sufficient regardless of how deep the vault directory sits.
 */

import { writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { authedFetch, ensureServerReachable } from "./client";

const TRAVERSAL_PREFIX = "..%2F".repeat(20);

function vaultTraversalUrl(absPath: string): string {
  // absPath must start with "/"; strip the leading "/" then encode each "/" as %2F
  const encoded = absPath.slice(1).replace(/\//g, "%2F");
  return `/vault/${TRAVERSAL_PREFIX}${encoded}`;
}

const STAMP = Date.now();
const READ_CANARY_PATH = `/tmp/olrapi-traversal-read-${STAMP}.txt`;
const READ_CANARY_CONTENT = `traversal-read-sentinel-${STAMP}`;
const WRITE_CANARY_PATH = `/tmp/olrapi-traversal-write-${STAMP}.txt`;
const APPEND_CANARY_PATH = `/tmp/olrapi-traversal-append-${STAMP}.txt`;
const APPEND_CANARY_CONTENT = `traversal-append-sentinel-${STAMP}`;
const DELETE_CANARY_PATH = `/tmp/olrapi-traversal-delete-${STAMP}.txt`;

beforeAll(async () => {
  await ensureServerReachable();
  writeFileSync(READ_CANARY_PATH, READ_CANARY_CONTENT, "utf8");
  writeFileSync(APPEND_CANARY_PATH, APPEND_CANARY_CONTENT, "utf8");
  writeFileSync(DELETE_CANARY_PATH, "delete-me", "utf8");
  // WRITE_CANARY_PATH intentionally does not exist before the test
});

afterAll(() => {
  for (const p of [READ_CANARY_PATH, WRITE_CANARY_PATH, APPEND_CANARY_PATH, DELETE_CANARY_PATH]) {
    try { unlinkSync(p); } catch { /* already gone or never created — fine */ }
  }
});

// ---------------------------------------------------------------------------
// GET — should not be able to read files outside the vault
// ---------------------------------------------------------------------------

describe("GET /vault/{path} — path traversal prevention", () => {
  test("rejects ..%2F traversal with 400; canary content not returned", async () => {
    const res = await authedFetch(vaultTraversalUrl(READ_CANARY_PATH));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(READ_CANARY_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// PUT — should not be able to write files outside the vault
// ---------------------------------------------------------------------------

describe("PUT /vault/{path} — path traversal prevention", () => {
  test("rejects ..%2F traversal with 400; no file created outside vault", async () => {
    const res = await authedFetch(vaultTraversalUrl(WRITE_CANARY_PATH), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "pwned-via-traversal",
    });
    expect(res.status).toBe(400);
    expect(existsSync(WRITE_CANARY_PATH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST — should not be able to append to files outside the vault
// ---------------------------------------------------------------------------

describe("POST /vault/{path} — path traversal prevention", () => {
  test("rejects ..%2F traversal with 400; canary file content unchanged", async () => {
    const res = await authedFetch(vaultTraversalUrl(APPEND_CANARY_PATH), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "appended-via-traversal",
    });
    expect(res.status).toBe(400);
    expect(readFileSync(APPEND_CANARY_PATH, "utf8")).toBe(APPEND_CANARY_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// DELETE — should not be able to delete files outside the vault
// ---------------------------------------------------------------------------

describe("DELETE /vault/{path} — path traversal prevention", () => {
  test("rejects ..%2F traversal with 400; canary file still exists", async () => {
    const res = await authedFetch(vaultTraversalUrl(DELETE_CANARY_PATH), {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    expect(existsSync(DELETE_CANARY_PATH)).toBe(true);
  });
});
