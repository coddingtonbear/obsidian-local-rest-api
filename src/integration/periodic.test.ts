// Periodic note tests require daily notes to be enabled under this plugin's own
// "Periodic Notes" settings section (Settings → Local REST API with MCP → Periodic Notes → Daily).
// Set OBSIDIAN_PERIODIC_NOTES=true to run these tests.
// Optionally set OBSIDIAN_DAILY_NOTE_EXISTS=true|false to gate which sub-tests run.

import { authedFetch, ensureServerReachable } from "./client";

const run = process.env.OBSIDIAN_PERIODIC_NOTES === "true";
const maybeTest = run ? test : test.skip;
const dailyNoteExists = process.env.OBSIDIAN_DAILY_NOTE_EXISTS !== "false";

beforeAll(async () => {
  await ensureServerReachable();
});

describe("GET /periodic/daily", () => {
  maybeTest("returns 200 with content-location header pointing to the daily note file", async () => {
    if (!dailyNoteExists) return;
    const res = await authedFetch("/periodic/daily/");
    expect(res.status).toBe(200);
    const contentLocation = res.headers.get("content-location");
    expect(contentLocation).toBeTruthy();
    expect(contentLocation).toMatch(/\.md$/);
  });

  maybeTest("returns 404 with errorCode 40461 when daily note does not exist", async () => {
    if (dailyNoteExists) return;
    const res = await authedFetch("/periodic/daily/");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errorCode).toBe(40461);
  });
});

describe("PUT /periodic/daily", () => {
  maybeTest("creates or replaces today's daily note and returns 200 or 204", async () => {
    const res = await authedFetch("/periodic/daily/", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "# Daily Note\n\nIntegration test content.\n",
    });
    expect([200, 204]).toContain(res.status);
  });
});

describe("POST /periodic/daily", () => {
  maybeTest("appends to today's daily note and returns 204", async () => {
    const res = await authedFetch("/periodic/daily/", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: "Integration test append.\n",
    });
    expect([200, 204]).toContain(res.status);
  });
});

describe("PATCH /periodic/daily — raw-content suffix targeting", () => {
  maybeTest("a URL suffix targets a section in raw-content mode", async () => {
    const res = await authedFetch("/periodic/daily/heading/Daily%20Note", {
      method: "PATCH",
      headers: {
        Operation: "append",
        "Create-Target-If-Missing": "true",
        "Content-Type": "text/markdown",
      },
      body: "Raw-content suffix append.\n",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Raw-content suffix append.");
  });
});

describe("DELETE /periodic/daily", () => {
  maybeTest("returns 204 or 404 when deleting today's daily note", async () => {
    const res = await authedFetch("/periodic/daily/", { method: "DELETE" });
    expect([204, 404]).toContain(res.status);
  });
});
