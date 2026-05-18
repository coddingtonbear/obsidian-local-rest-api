// Periodic note tests require the Daily Notes (or Calendar) plugin to be enabled in Obsidian.
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
  maybeTest("returns 200 with content-location header when daily note exists for today", async () => {
    if (!dailyNoteExists) return;
    const res = await authedFetch("/periodic/daily");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-location")).toBeTruthy();
  });

  maybeTest("returns 404 with errorCode 40461 when daily note does not exist", async () => {
    if (dailyNoteExists) return;
    const res = await authedFetch("/periodic/daily");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errorCode).toBe(40461);
  });
});

describe("GET /periodic/daily — plugin not enabled", () => {
  // Only run when OBSIDIAN_PERIODIC_NOTES=false is explicitly set
  const pluginDisabledTest = process.env.OBSIDIAN_PERIODIC_NOTES === "false" ? test : test.skip;

  pluginDisabledTest("returns 400 with errorCode 40060 when period is not enabled", async () => {
    const res = await authedFetch("/periodic/daily");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40060);
  });
});

describe("PUT /periodic/daily", () => {
  maybeTest("creates or replaces today's daily note and returns 200 or 204", async () => {
    const res = await authedFetch("/periodic/daily", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "# Daily Note\n\nIntegration test content.\n",
    });
    expect([200, 204]).toContain(res.status);
  });
});

describe("POST /periodic/daily", () => {
  maybeTest("appends to today's daily note and returns 204", async () => {
    const res = await authedFetch("/periodic/daily", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: "Integration test append.\n",
    });
    expect([200, 204]).toContain(res.status);
  });
});

describe("DELETE /periodic/daily", () => {
  maybeTest("returns 204 or 404 when deleting today's daily note", async () => {
    const res = await authedFetch("/periodic/daily", { method: "DELETE" });
    expect([204, 404]).toContain(res.status);
  });
});
