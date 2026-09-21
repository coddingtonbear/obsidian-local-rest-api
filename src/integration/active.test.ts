// Active-file tests require a file to be open in Obsidian.
// Set OBSIDIAN_ACTIVE_FILE to the vault-relative path of the open file to run these tests.
// Leave it unset (or empty) to skip the conditional tests; the 401 tests always run.

import { authedFetch, unauthFetch, ensureServerReachable } from "./client";

const activeFilePath = process.env.OBSIDIAN_ACTIVE_FILE ?? "";
const run = activeFilePath.length > 0;
const maybeTest = run ? test : test.skip;

/**
 * Mirrors `encodeVaultPath` in `src/requestHandler.ts`, which is what the server
 * runs a vault path through before putting it in a `Content-Location` header.
 * Duplicated rather than imported because importing the handler would drag the
 * `obsidian` module into a suite that only speaks HTTP to a live plugin.
 *
 * Asserting against the raw path passes only for filenames that happen to contain
 * nothing `encodeURIComponent` escapes; a space or a parenthesis is enough to
 * break it, which is exactly how this drifted unnoticed.
 */
const expectedContentLocation = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

beforeAll(async () => {
  await ensureServerReachable();
});

describe("GET /active/", () => {
  maybeTest("returns 200 with content-location header pointing to the active file", async () => {
    const res = await authedFetch("/active/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-location")).toBe(
      expectedContentLocation(activeFilePath)
    );
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/active/");
    expect(res.status).toBe(401);
  });
});

describe("PUT /active/", () => {
  maybeTest("replaces active file content and returns 200 or 204", async () => {
    const res = await authedFetch("/active/", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "# Active File\n\nReplaced by integration test.\n",
    });
    expect([200, 204]).toContain(res.status);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/active/", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "data\n",
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /active/ — append", () => {
  maybeTest("appends to active file and returns 204; subsequent GET contains appended text", async () => {
    const marker = `active-append-${Date.now()}`;
    const res = await authedFetch("/active/", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: `${marker}\n`,
    });
    expect(res.status).toBe(204);

    const getRes = await authedFetch("/active/");
    const text = await getRes.text();
    expect(text).toContain(marker);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/active/", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: "data\n",
    });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /active/", () => {
  maybeTest("patches active file via the 2.0 API and returns 200", async () => {
    const res = await authedFetch("/active/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetType: "heading",
        target: ["Active File"],
        operation: "append",
        content: "Patched by integration test.\n",
        createTargetIfMissing: true,
      }),
    });
    expect(res.status).toBe(200);
  });

  maybeTest("a URL suffix targets a section in raw-content mode", async () => {
    const res = await authedFetch("/active/heading/Active%20File", {
      method: "PATCH",
      headers: {
        Operation: "append",
        "Create-Target-If-Missing": "true",
        "Content-Type": "text/markdown",
      },
      body: "Raw-content suffix append.\n",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-location")).toBe(
      expectedContentLocation(activeFilePath)
    );
    expect(await res.text()).toContain("Raw-content suffix append.");
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/active/", { method: "PATCH" });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /active/", () => {
  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/active/", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
