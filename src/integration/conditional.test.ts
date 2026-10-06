import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "crypto";

import {
  API_KEY,
  BASE_URL,
  authedFetch,
  ensureServerReachable,
  resetFixture,
  deleteFixture,
} from "./client";
import { TEST_DIR } from "./fixtures";

// Conditional writes: the ETag reads and writes answer with, and If-Match /
// If-None-Match on every vault write. Each test works on its own note so a
// failure in one cannot leave another looking at a changed file.

const NOTE = `${TEST_DIR}/conditional.md`;
const CREATED = `${TEST_DIR}/conditional-created.md`;
const MOVED = `${TEST_DIR}/conditional-moved.md`;
const ORIGINAL = "# Heading\n\nOriginal body.\n";
const STALE = '"000000"';

// markdown-patch's versionOf, restated: the integration config cannot load the
// library (its parser is ESM-only), and a test that checks the server against
// a fixed derivation is the stronger check anyway.
function versionOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 6);
}

function quoted(version: string): string {
  return `"${version}"`;
}

async function currentEtag(path: string): Promise<string | null> {
  const res = await authedFetch(`/vault/${path}`);
  await res.arrayBuffer();
  return res.status === 200 ? res.headers.get("ETag") : null;
}

async function currentText(path: string): Promise<string | null> {
  const res = await authedFetch(`/vault/${path}`);
  return res.status === 200 ? res.text() : null;
}

function put(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return authedFetch(`/vault/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown", ...headers },
    body,
  });
}

beforeAll(async () => {
  await ensureServerReachable();
});

beforeEach(async () => {
  await resetFixture(ORIGINAL, NOTE);
  await deleteFixture(CREATED);
  await deleteFixture(MOVED);
});

afterAll(async () => {
  await deleteFixture(NOTE);
  await deleteFixture(CREATED);
  await deleteFixture(MOVED);
});

describe("reads carry the file's version", () => {
  test("a whole-file GET answers with a strong ETag of the file's bytes", async () => {
    expect(await currentEtag(NOTE)).toBe(quoted(versionOf(ORIGINAL)));
  });

  test("the document map's version and note JSON's version are the same token", async () => {
    const etag = await currentEtag(NOTE);

    const mapRes = await authedFetch(`/vault/${NOTE}`, {
      headers: { Accept: "application/vnd.olrapi.document-map+json" },
    });
    const map = (await mapRes.json()) as { version: string };
    expect(quoted(map.version)).toBe(etag);
    expect(mapRes.headers.get("ETag")).toBe(etag);

    const noteRes = await authedFetch(`/vault/${NOTE}`, {
      headers: { Accept: "application/vnd.olrapi.note+json" },
    });
    const note = (await noteRes.json()) as { version: string };
    expect(quoted(note.version)).toBe(etag);
  });

  test("a matching If-None-Match on a GET answers 304", async () => {
    const etag = await currentEtag(NOTE);
    const res = await authedFetch(`/vault/${NOTE}`, {
      // Without an explicit Cache-Control, fetch adds `Cache-Control: no-cache`
      // to any request carrying If-None-Match (Fetch spec, HTTP-network-or-cache
      // fetch), and a server rightly answers that with the full 200.
      headers: { "If-None-Match": etag ?? "", "Cache-Control": "max-age=0" },
    });
    expect(res.status).toBe(304);
  });
});

describe("PUT", () => {
  test("a matching If-Match writes and answers with the new version", async () => {
    const etag = await currentEtag(NOTE);
    const res = await put(NOTE, "Replaced.\n", { "If-Match": etag ?? "" });
    expect(res.status).toBe(204);
    expect(res.headers.get("ETag")).toBe(quoted(versionOf("Replaced.\n")));
    expect(await currentEtag(NOTE)).toBe(res.headers.get("ETag"));
  });

  test("a stale If-Match answers 412 and leaves the file untouched", async () => {
    const res = await put(NOTE, "Replaced.\n", { "If-Match": STALE });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { errorCode: number; message: string };
    expect(body.errorCode).toBe(41200);
    expect(body.message).toContain(versionOf(ORIGINAL));
    expect(await currentText(NOTE)).toBe(ORIGINAL);
  });

  test("two writes racing on the same If-Match: exactly one lands", async () => {
    const etag = (await currentEtag(NOTE)) ?? "";
    const [first, second] = await Promise.all([
      put(NOTE, "First writer.\n", { "If-Match": etag }),
      put(NOTE, "Second writer.\n", { "If-Match": etag }),
    ]);
    expect([first.status, second.status].sort()).toEqual([204, 412]);
    const winner = first.status === 204 ? "First writer.\n" : "Second writer.\n";
    expect(await currentText(NOTE)).toBe(winner);
  });

  test("If-None-Match: * creates a missing file and refuses an existing one", async () => {
    const created = await put(CREATED, "New.\n", { "If-None-Match": "*" });
    expect(created.status).toBe(204);
    expect(await currentText(CREATED)).toBe("New.\n");

    const again = await put(CREATED, "Overwritten.\n", { "If-None-Match": "*" });
    expect(again.status).toBe(412);
    expect(await currentText(CREATED)).toBe("New.\n");
  });

  test("If-Match on a missing file answers 412 instead of creating it", async () => {
    const res = await put(CREATED, "New.\n", { "If-Match": quoted(versionOf(ORIGINAL)) });
    expect(res.status).toBe(412);
    expect(await currentText(CREATED)).toBeNull();
  });

  test("a heading-targeted PUT honors If-Match", async () => {
    const stale = await authedFetch(`/vault/${NOTE}/heading/Heading`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": STALE },
      body: "New body.\n",
    });
    expect(stale.status).toBe(412);
    expect(await currentText(NOTE)).toBe(ORIGINAL);
  });

  test("a malformed If-Match answers 400", async () => {
    const res = await put(NOTE, "Replaced.\n", { "If-Match": "W/unquoted" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errorCode: number }).errorCode).toBe(40024);
    expect(await currentText(NOTE)).toBe(ORIGINAL);
  });
});

describe("POST", () => {
  test("a stale If-Match appends nothing; a matching one appends", async () => {
    const stale = await authedFetch(`/vault/${NOTE}`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown", "If-Match": STALE },
      body: "More.\n",
    });
    expect(stale.status).toBe(412);
    expect(await currentText(NOTE)).toBe(ORIGINAL);

    const res = await authedFetch(`/vault/${NOTE}`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown", "If-Match": quoted(versionOf(ORIGINAL)) },
      body: "More.\n",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("ETag")).toBe(await currentEtag(NOTE));
  });
});

describe("PATCH", () => {
  const instruction = {
    targetType: "heading",
    target: ["Heading"],
    operation: "append",
    content: "Appended.\n",
  };

  test("an If-Match header gates a JSON-instruction patch", async () => {
    const stale = await authedFetch(`/vault/${NOTE}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": STALE },
      body: JSON.stringify(instruction),
    });
    expect(stale.status).toBe(412);
    expect(await currentText(NOTE)).toBe(ORIGINAL);

    const res = await authedFetch(`/vault/${NOTE}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": quoted(versionOf(ORIGINAL)) },
      body: JSON.stringify(instruction),
    });
    expect(res.status).toBe(200);
    const patched = await res.text();
    expect(res.headers.get("ETag")).toBe(quoted(versionOf(patched)));
    expect(await currentEtag(NOTE)).toBe(res.headers.get("ETag"));
  });
});

describe("DELETE, MOVE, COPY", () => {
  test("a stale If-Match keeps the file; a matching one deletes it", async () => {
    const stale = await authedFetch(`/vault/${NOTE}`, {
      method: "DELETE",
      headers: { "If-Match": STALE },
    });
    expect(stale.status).toBe(412);
    expect(await currentText(NOTE)).toBe(ORIGINAL);

    const res = await authedFetch(`/vault/${NOTE}`, {
      method: "DELETE",
      headers: { "If-Match": quoted(versionOf(ORIGINAL)) },
    });
    expect(res.status).toBe(204);
    expect(await currentText(NOTE)).toBeNull();
  });

  test.each([["MOVE"], ["COPY"]])("%s with a stale If-Match leaves both paths alone", async (method) => {
    const res = await authedFetch(`/vault/${NOTE}`, {
      method,
      headers: { Destination: MOVED, "If-Match": STALE },
    });
    expect(res.status).toBe(412);
    expect(await currentText(NOTE)).toBe(ORIGINAL);
    expect(await currentText(MOVED)).toBeNull();
  });

  test("MOVE with a matching If-Match moves the file", async () => {
    const res = await authedFetch(`/vault/${NOTE}`, {
      method: "MOVE",
      headers: { Destination: MOVED, "If-Match": quoted(versionOf(ORIGINAL)) },
    });
    expect(res.status).toBe(204);
    expect(await currentText(MOVED)).toBe(ORIGINAL);
  });
});

describe("MCP", () => {
  type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  function jsonOf<T>(result: ToolResult): T {
    const item = (result.content as Array<{ type: string; text?: string }>)[0];
    if (!item || item.type !== "text" || item.text === undefined) {
      throw new Error("Expected a text content item");
    }
    return JSON.parse(item.text) as T;
  }

  beforeAll(async () => {
    client = new Client({ name: "integration-test-conditional", version: "1.0.0" });
    transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await transport?.terminateSession();
    } finally {
      await client?.close();
    }
  });

  test("vault_read's version gates vault_write, which returns the new version", async () => {
    const read = jsonOf<{ version: string }>(
      await client.callTool({ name: "vault_read", arguments: { path: NOTE } }),
    );
    expect(quoted(read.version)).toBe(await currentEtag(NOTE));

    const stale = await client.callTool({
      name: "vault_write",
      arguments: { path: NOTE, content: "Lost update.\n", ifMatch: "000000" },
    });
    expect(stale.isError).toBe(true);
    expect(await currentText(NOTE)).toBe(ORIGINAL);

    const written = jsonOf<{ message: string; version: string }>(
      await client.callTool({
        name: "vault_write",
        arguments: { path: NOTE, content: "Agent edit.\n", ifMatch: read.version },
      }),
    );
    expect(written.message).toBe("OK");
    expect(quoted(written.version)).toBe(await currentEtag(NOTE));
  });

  test("vault_write with ifNoneMatch '*' will not overwrite", async () => {
    const result = await client.callTool({
      name: "vault_write",
      arguments: { path: NOTE, content: "Overwrite.\n", ifNoneMatch: "*" },
    });
    expect(result.isError).toBe(true);
    expect(await currentText(NOTE)).toBe(ORIGINAL);
  });

  test("vault_delete with a stale ifMatch keeps the file", async () => {
    const result = await client.callTool({
      name: "vault_delete",
      arguments: { path: NOTE, ifMatch: "000000" },
    });
    expect(result.isError).toBe(true);
    expect(await currentText(NOTE)).toBe(ORIGINAL);
  });
});
