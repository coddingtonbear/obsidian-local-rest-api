import {
  authedFetch,
  unauthFetch,
  ensureServerReachable,
} from "./client";

const PREFERRED_COMMAND_ID = "editor:save-file";

let testCommandId: string | null = null;

beforeAll(async () => {
  await ensureServerReachable();
  const res = await authedFetch("/commands/");
  if (res.status === 200) {
    const body = await res.json();
    const commands: { id: string }[] = body.commands ?? [];
    const found = commands.find((c) => c.id === PREFERRED_COMMAND_ID);
    if (!found) {
      throw new Error(
        `Preferred command "${PREFERRED_COMMAND_ID}" not found in this Obsidian instance. ` +
        `Refusing to run an arbitrary command. Available IDs: ${commands.map((c) => c.id).join(", ")}`
      );
    }
    testCommandId = found.id;
  }
});

describe("GET /commands/", () => {
  test("returns 200 with commands array", async () => {
    const res = await authedFetch("/commands/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.commands)).toBe(true);
  });

  test("each command has id and name as strings", async () => {
    const res = await authedFetch("/commands/");
    const body = await res.json();
    expect(body.commands.length).toBeGreaterThan(0);
    for (const cmd of body.commands) {
      expect(typeof cmd.id).toBe("string");
      expect(typeof cmd.name).toBe("string");
    }
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/commands/");
    expect(res.status).toBe(401);
  });
});

describe("POST /commands/{id}/", () => {
  test("executes a known command and returns 204", async () => {
    if (!testCommandId) {
      return test.skip;
    }
    const res = await authedFetch(`/commands/${testCommandId}/`, { method: "POST" });
    expect(res.status).toBe(204);
  });

  test("returns 404 for unknown command ID", async () => {
    const res = await authedFetch("/commands/zzzz-nonexistent-command-zzzz/", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/commands/some-command/", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
