import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  API_KEY,
  BASE_URL,
  ensureServerReachable,
  resetFixture,
  deleteFixture,
} from "./client";
import {
  TEST_DIR,
  TEST_PATH,
  FIXTURE_DOCUMENT,
  TERM_ALPHA,
  TERM_DELTA,
  FM_TITLE_VALUE,
  FM_PRIORITY_VALUE,
  TAG_FIXTURE,
  HEADING_DELTA,
  HEADING_ALPHA,
  HEADING_SUB,
  BLOCK_BETA,
  FM_TITLE,
  FM_PRIORITY,
  TERM_SUB,
} from "./fixtures";

// A separate temp path so vault_write / vault_delete tests don't touch the shared fixture.
const TEMP_PATH = `${TEST_DIR}/mcp-temp.md`;

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function makeClient(): Client {
  return new Client({ name: "integration-test", version: "1.0.0" });
}

function makeTransport(): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${API_KEY}` },
    },
  });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolResult): string {
  const item = (result.content as any[])[0];
  if (!item || item.type !== "text") throw new Error("Expected text content item");
  return item.text as string;
}

function jsonOf<T = unknown>(result: ToolResult): T {
  return JSON.parse(textOf(result)) as T;
}

// ---------------------------------------------------------------------------
// Shared client — opened once per file, closed in afterAll
// ---------------------------------------------------------------------------

let client: Client;

beforeAll(async () => {
  await ensureServerReachable();
  await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
  client = makeClient();
  await client.connect(makeTransport());
});

afterAll(async () => {
  await client?.close();
  await deleteFixture(TEST_PATH);
  // Best-effort cleanup of the temp path used by write/delete tests.
  await deleteFixture(TEMP_PATH).catch((_e: unknown): void => {});
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

describe("MCP resources", () => {
  test("openapi-spec resource is listed", async () => {
    const res = await client.listResources();
    expect(res.resources.some((r) => r.name === "openapi-spec")).toBe(true);
  });

  test("openapi-spec content contains 'openapi:'", async () => {
    const res = await client.readResource({
      uri: "obsidian://local-rest-api/openapi.yaml",
    });
    const item = res.contents[0];
    const text = item && "text" in item ? item.text : undefined;
    expect(typeof text).toBe("string");
    expect(text).toContain("openapi:");
  });
});

// ---------------------------------------------------------------------------
// vault_list
// ---------------------------------------------------------------------------

describe("vault_list tool", () => {
  test("lists integration test directory", async () => {
    const result = await client.callTool({
      name: "vault_list",
      arguments: { path: TEST_DIR },
    });
    const body = jsonOf<{ files: string[] }>(result);
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.some((f) => f.includes("fixture"))).toBe(true);
  });

  test("lists vault root when path omitted", async () => {
    const result = await client.callTool({ name: "vault_list", arguments: {} });
    const body = jsonOf<{ files: string[] }>(result);
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// vault_read
// ---------------------------------------------------------------------------

describe("vault_read tool", () => {
  test("returns correct metadata and content for fixture", async () => {
    const result = await client.callTool({
      name: "vault_read",
      arguments: { path: TEST_PATH },
    });
    const body = jsonOf<any>(result);
    expect(body.path).toBe(TEST_PATH);
    expect(body.frontmatter?.title).toBe(FM_TITLE_VALUE);
    expect(body.frontmatter?.priority).toBe(FM_PRIORITY_VALUE);
    expect(Array.isArray(body.tags)).toBe(true);
    expect(body.tags).toContain(TAG_FIXTURE);
    expect(typeof body.content).toBe("string");
    expect(body.content).toContain(TERM_ALPHA);
    expect(typeof body.stat?.ctime).toBe("number");
  });

  test("returns isError for non-existent file", async () => {
    const result = await client.callTool({
      name: "vault_read",
      arguments: { path: `${TEST_DIR}/no-such-file.md` },
    });
    expect(result.isError).toBe(true);
  });

  test("returns heading section content when targetType=heading", async () => {
    const result = await client.callTool({
      name: "vault_read",
      arguments: { path: TEST_PATH, targetType: "heading", target: HEADING_ALPHA },
    });
    const text = textOf(result);
    expect(text).toContain(TERM_ALPHA);
    expect(text).not.toContain(TERM_DELTA);
  });

  test("returns nested heading section using :: delimiter", async () => {
    const result = await client.callTool({
      name: "vault_read",
      arguments: {
        path: TEST_PATH,
        targetType: "heading",
        target: `${HEADING_ALPHA}::${HEADING_SUB}`,
      },
    });
    const text = textOf(result);
    expect(text).toContain(TERM_SUB);
    expect(text).not.toContain(TERM_ALPHA);
  });

  test("returns block content when targetType=block", async () => {
    const result = await client.callTool({
      name: "vault_read",
      arguments: { path: TEST_PATH, targetType: "block", target: BLOCK_BETA },
    });
    const text = textOf(result);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  test("returns frontmatter value when targetType=frontmatter", async () => {
    const result = await client.callTool({
      name: "vault_read",
      arguments: { path: TEST_PATH, targetType: "frontmatter", target: FM_TITLE },
    });
    expect(textOf(result)).toBe(FM_TITLE_VALUE);
  });

  test("returns numeric frontmatter value when targetType=frontmatter", async () => {
    const result = await client.callTool({
      name: "vault_read",
      arguments: { path: TEST_PATH, targetType: "frontmatter", target: FM_PRIORITY },
    });
    expect(JSON.parse(textOf(result))).toBe(FM_PRIORITY_VALUE);
  });

  test("returns isError when heading target is not found", async () => {
    const result = await client.callTool({
      name: "vault_read",
      arguments: { path: TEST_PATH, targetType: "heading", target: "NoSuchHeading" },
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vault_get_document_map
// ---------------------------------------------------------------------------

describe("vault_get_document_map tool", () => {
  test("returns headings, blocks, and frontmatterFields for fixture", async () => {
    const result = await client.callTool({
      name: "vault_get_document_map",
      arguments: { path: TEST_PATH },
    });
    const body = jsonOf<any>(result);
    expect(Array.isArray(body.headings)).toBe(true);
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(Array.isArray(body.frontmatterFields)).toBe(true);
    expect(body.headings).toContain(HEADING_ALPHA);
    expect(body.headings.some((h: string) => h.includes(HEADING_SUB))).toBe(true);
    expect(body.blocks).toContain(BLOCK_BETA);
    expect(body.frontmatterFields).toContain(FM_TITLE);
    expect(body.frontmatterFields).toContain(FM_PRIORITY);
  });

  test("returns isError for non-existent file", async () => {
    const result = await client.callTool({
      name: "vault_get_document_map",
      arguments: { path: `${TEST_DIR}/no-such-file.md` },
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vault_write + vault_delete (use TEMP_PATH to avoid disturbing shared fixture)
// ---------------------------------------------------------------------------

describe("vault_write and vault_delete tools", () => {
  test("writes a file, verifies content, then deletes it", async () => {
    const writeResult = await client.callTool({
      name: "vault_write",
      arguments: { path: TEMP_PATH, content: "# Temp\n\nwritten-by-mcp-test\n" },
    });
    expect(jsonOf<any>(writeResult).message).toBe("OK");

    // Give Obsidian's index a moment to register the new file.
    await new Promise((r) => setTimeout(r, 300));

    const readResult = await client.callTool({
      name: "vault_read",
      arguments: { path: TEMP_PATH },
    });
    expect(jsonOf<any>(readResult).content).toContain("written-by-mcp-test");

    const deleteResult = await client.callTool({
      name: "vault_delete",
      arguments: { path: TEMP_PATH },
    });
    expect(jsonOf<any>(deleteResult).message).toBe("OK");

    const afterDelete = await client.callTool({
      name: "vault_read",
      arguments: { path: TEMP_PATH },
    });
    expect(afterDelete.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vault_append
// ---------------------------------------------------------------------------

describe("vault_append tool", () => {
  beforeEach(async () => {
    await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
  });

  test("appends content and preserves original", async () => {
    const appendResult = await client.callTool({
      name: "vault_append",
      arguments: { path: TEST_PATH, content: "mcp-appended-content\n" },
    });
    expect(jsonOf<any>(appendResult).message).toBe("OK");

    const readResult = await client.callTool({
      name: "vault_read",
      arguments: { path: TEST_PATH },
    });
    const body = jsonOf<any>(readResult);
    expect(body.content).toContain("mcp-appended-content");
    expect(body.content).toContain(TERM_ALPHA);
  });
});

// ---------------------------------------------------------------------------
// vault_patch
// ---------------------------------------------------------------------------

describe("vault_patch tool", () => {
  beforeEach(async () => {
    await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
  });

  test("appends to a heading section", async () => {
    await client.callTool({
      name: "vault_patch",
      arguments: {
        path: TEST_PATH,
        targetType: "heading",
        target: HEADING_DELTA,
        operation: "append",
        content: "mcp-patch-append\n",
      },
    });
    const body = jsonOf<any>(
      await client.callTool({ name: "vault_read", arguments: { path: TEST_PATH } })
    );
    expect(body.content).toContain(TERM_DELTA);
    expect(body.content).toContain("mcp-patch-append");
  });

  test("replaces a heading section", async () => {
    await client.callTool({
      name: "vault_patch",
      arguments: {
        path: TEST_PATH,
        targetType: "heading",
        target: HEADING_DELTA,
        operation: "replace",
        content: "mcp-patch-replace\n",
      },
    });
    const body = jsonOf<any>(
      await client.callTool({ name: "vault_read", arguments: { path: TEST_PATH } })
    );
    expect(body.content).toContain("mcp-patch-replace");
    expect(body.content).not.toContain(TERM_DELTA);
  });

  test("replaces a frontmatter field", async () => {
    await client.callTool({
      name: "vault_patch",
      arguments: {
        path: TEST_PATH,
        targetType: "frontmatter",
        target: "title",
        operation: "replace",
        // Default contentType is text/markdown, so the string is stored verbatim.
        // (application/json content is parsed into a native value — see below.)
        content: "MCP Patched Title",
      },
    });
    const body = jsonOf<any>(
      await client.callTool({ name: "vault_read", arguments: { path: TEST_PATH } })
    );
    expect(body.frontmatter?.title).toBe("MCP Patched Title");
  });

  test("parses a stringified JSON array for application/json into a real list", async () => {
    await client.callTool({
      name: "vault_patch",
      arguments: {
        path: TEST_PATH,
        targetType: "frontmatter",
        target: "related",
        operation: "replace",
        contentType: "application/json",
        // MCP clients commonly send JSON content as a string; it must be parsed
        // into a native array so it is stored as a YAML sequence, not a quoted
        // string. frontmatter.related is Obsidian's parsed value, so an array
        // here proves the on-disk YAML is a real sequence.
        content: '["alpha","beta"]',
        createTargetIfMissing: true,
      },
    });
    const body = jsonOf<any>(
      await client.callTool({ name: "vault_read", arguments: { path: TEST_PATH } })
    );
    expect(body.frontmatter?.related).toEqual(["alpha", "beta"]);
  });

  test("rejects malformed application/json content", async () => {
    const result = await client.callTool({
      name: "vault_patch",
      arguments: {
        path: TEST_PATH,
        targetType: "frontmatter",
        target: "related",
        operation: "replace",
        contentType: "application/json",
        content: "[[../plans/foo]]",
        createTargetIfMissing: true,
      },
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vault_move
// ---------------------------------------------------------------------------

describe("vault_move tool", () => {
  const MOVE_SRC = `${TEST_DIR}/mcp-move-source.md`;
  const MOVE_DST = `${TEST_DIR}/mcp-move-destination.md`;

  beforeEach(async () => {
    const result = await client.callTool({
      name: "vault_write",
      arguments: { path: MOVE_SRC, content: "mcp-move-source-content\n" },
    });
    if (result.isError) throw new Error(`MOVE_SRC setup failed`);
    // Give Obsidian's index a moment to register the new file.
    await new Promise((r) => setTimeout(r, 300));
  });

  afterEach(async () => {
    await deleteFixture(MOVE_SRC).catch((_e: unknown): void => {});
    await deleteFixture(MOVE_DST).catch((_e: unknown): void => {});
  });

  test("moves file: returns oldPath and newPath, source gone, dest has original content", async () => {
    const result = await client.callTool({
      name: "vault_move",
      arguments: { path: MOVE_SRC, destination: MOVE_DST },
    });
    expect(result.isError).toBeFalsy();
    const body = jsonOf<any>(result);
    expect(body.message).toBe("OK");
    expect(body.oldPath).toBe(MOVE_SRC);
    expect(body.newPath).toBe(MOVE_DST);

    const srcRead = await client.callTool({ name: "vault_read", arguments: { path: MOVE_SRC } });
    expect(srcRead.isError).toBe(true);

    const dstRead = await client.callTool({ name: "vault_read", arguments: { path: MOVE_DST } });
    expect(jsonOf<any>(dstRead).content).toContain("mcp-move-source-content");
  });

  test("trailing-slash destination resolves to source filename", async () => {
    const dstDir = `${TEST_DIR}/mcp-move-subdir/`;
    const expectedDst = `${TEST_DIR}/mcp-move-subdir/mcp-move-source.md`;

    const result = await client.callTool({
      name: "vault_move",
      arguments: { path: MOVE_SRC, destination: dstDir },
    });
    expect(result.isError).toBeFalsy();
    expect(jsonOf<any>(result).newPath).toBe(expectedDst);

    await deleteFixture(expectedDst).catch((_e: unknown): void => {});
  });

  test("returns isError for non-existent source", async () => {
    const result = await client.callTool({
      name: "vault_move",
      arguments: { path: `${TEST_DIR}/no-such-file.md`, destination: MOVE_DST },
    });
    expect(result.isError).toBe(true);
  });

  test("returns isError when destination exists without allowOverwrite", async () => {
    const setup = await client.callTool({
      name: "vault_write",
      arguments: { path: MOVE_DST, content: "existing content\n" },
    });
    if (setup.isError) throw new Error(`MOVE_DST setup failed`);
    await new Promise((r) => setTimeout(r, 300));

    const result = await client.callTool({
      name: "vault_move",
      arguments: { path: MOVE_SRC, destination: MOVE_DST },
    });
    expect(result.isError).toBe(true);
  });

  test("allowOverwrite: true succeeds and dest has source content", async () => {
    const setup = await client.callTool({
      name: "vault_write",
      arguments: { path: MOVE_DST, content: "existing content\n" },
    });
    if (setup.isError) throw new Error(`MOVE_DST setup failed`);
    await new Promise((r) => setTimeout(r, 300));

    const result = await client.callTool({
      name: "vault_move",
      arguments: { path: MOVE_SRC, destination: MOVE_DST, allowOverwrite: true },
    });
    expect(result.isError).toBeFalsy();
    expect(jsonOf<any>(result).message).toBe("OK");

    const dstRead = await client.callTool({ name: "vault_read", arguments: { path: MOVE_DST } });
    expect(jsonOf<any>(dstRead).content).toContain("mcp-move-source-content");
  });
});

// ---------------------------------------------------------------------------
// search_simple
// ---------------------------------------------------------------------------

describe("search_simple tool", () => {
  test("finds fixture by unique term", async () => {
    const result = await client.callTool({
      name: "search_simple",
      arguments: { query: TERM_ALPHA },
    });
    const body = jsonOf<any[]>(result);
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((item) => item.filename === TEST_PATH)).toBe(true);
  });

  test("returns empty array for no-match query", async () => {
    const result = await client.callTool({
      name: "search_simple",
      arguments: { query: "zzzzzz-no-match-zzzzzz" },
    });
    const body = jsonOf<any[]>(result);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// search_query (JsonLogic)
// ---------------------------------------------------------------------------

describe("search_query tool", () => {
  test("tag membership query finds fixture", async () => {
    const result = await client.callTool({
      name: "search_query",
      arguments: { query: { in: [TAG_FIXTURE, { var: "tags" }] } },
    });
    const body = jsonOf<any[]>(result);
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((item) => item.filename === TEST_PATH)).toBe(true);
  });

  test("frontmatter numeric comparison finds fixture", async () => {
    const result = await client.callTool({
      name: "search_query",
      arguments: {
        query: { "==": [{ var: "frontmatter.priority" }, FM_PRIORITY_VALUE] },
      },
    });
    const body = jsonOf<any[]>(result);
    expect(body.some((item) => item.filename === TEST_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tag_list
// ---------------------------------------------------------------------------

describe("tag_list tool", () => {
  test("returns tags array containing fixture tag", async () => {
    const result = await client.callTool({ name: "tag_list", arguments: {} });
    const body = jsonOf<{ tags: { name: string; count: number }[] }>(result);
    expect(Array.isArray(body.tags)).toBe(true);
    expect(body.tags.some((t) => t.name === TAG_FIXTURE)).toBe(true);
  });

  test("each tag has name and count", async () => {
    const result = await client.callTool({ name: "tag_list", arguments: {} });
    const body = jsonOf<{ tags: { name: string; count: number }[] }>(result);
    for (const tag of body.tags) {
      expect(typeof tag.name).toBe("string");
      expect(typeof tag.count).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// command_list + command_execute
// ---------------------------------------------------------------------------

describe("command_list tool", () => {
  test("returns commands with id and name strings", async () => {
    const result = await client.callTool({ name: "command_list", arguments: {} });
    const body = jsonOf<{ commands: { id: string; name: string }[] }>(result);
    expect(Array.isArray(body.commands)).toBe(true);
    expect(body.commands.length).toBeGreaterThan(0);
    for (const cmd of body.commands) {
      expect(typeof cmd.id).toBe("string");
      expect(typeof cmd.name).toBe("string");
    }
  });
});

describe("command_execute tool", () => {
  test("executes editor:save-file and returns OK", async () => {
    const listResult = await client.callTool({ name: "command_list", arguments: {} });
    const { commands } = jsonOf<{ commands: { id: string }[] }>(listResult);
    if (!commands.find((c) => c.id === "editor:save-file")) {
      throw new Error(
        'Command "editor:save-file" not found — cannot safely execute an arbitrary command.'
      );
    }
    const result = await client.callTool({
      name: "command_execute",
      arguments: { commandId: "editor:save-file" },
    });
    expect(jsonOf<any>(result).message).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// open_file
// ---------------------------------------------------------------------------

describe("open_file tool", () => {
  test("opens fixture file and returns OK", async () => {
    const result = await client.callTool({
      name: "open_file",
      arguments: { path: TEST_PATH },
    });
    expect(jsonOf<any>(result).message).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// active_file_* (conditional on OBSIDIAN_ACTIVE_FILE)
// ---------------------------------------------------------------------------

const activeRun =
  typeof process.env.OBSIDIAN_ACTIVE_FILE === "string" &&
  process.env.OBSIDIAN_ACTIVE_FILE.length > 0;
const activeTest = activeRun ? test : test.skip;

describe("active_file_get_path tool", () => {
  activeTest("returns vault-relative path of active file", async () => {
    const result = await client.callTool({ name: "active_file_get_path", arguments: {} });
    const body = jsonOf<any>(result);
    expect(typeof body.path).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// periodic_note_* (conditional on OBSIDIAN_PERIODIC_NOTES=true)
// ---------------------------------------------------------------------------

const periodicTest =
  process.env.OBSIDIAN_PERIODIC_NOTES === "true" ? test : test.skip;

describe("periodic_note_get_path tool", () => {
  periodicTest("returns vault-relative path of the daily note", async () => {
    const result = await client.callTool({
      name: "periodic_note_get_path",
      arguments: { period: "daily" },
    });
    const body = jsonOf<any>(result);
    expect(typeof body.path).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Multi-session routing (regression for shared-McpServer bug)
// ---------------------------------------------------------------------------

describe("multi-session routing", () => {
  test("first session remains functional after a second session connects", async () => {
    const clientA = makeClient();
    const clientB = makeClient();
    try {
      await clientA.connect(makeTransport());
      // Connecting clientB previously overwrote the shared McpServer's internal
      // _transport reference, causing clientA's subsequent tool calls to hang
      // indefinitely as their responses were routed to clientB's transport.
      await clientB.connect(makeTransport());

      const resultA = await clientA.callTool({ name: "vault_list", arguments: {} });
      expect(resultA.isError).toBeFalsy();
      expect(Array.isArray(jsonOf<{ files: string[] }>(resultA).files)).toBe(true);

      const resultB = await clientB.callTool({ name: "vault_list", arguments: {} });
      expect(resultB.isError).toBeFalsy();
      expect(Array.isArray(jsonOf<{ files: string[] }>(resultB).files)).toBe(true);
    } finally {
      await clientA.close().catch((_e: unknown): void => {});
      await clientB.close().catch((_e: unknown): void => {});
    }
  });
});
