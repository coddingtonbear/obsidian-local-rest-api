import { API_KEY, BASE_URL, authedFetch, deleteFixture, ensureServerReachable } from "./client";
import { TEST_DIR } from "./fixtures";

// Signed URLs are on by default; OBSIDIAN_SIGNED_URLS=0 opts out, and the streams are
// then opened with the API key instead.
const SIGNED_URLS = process.env.OBSIDIAN_SIGNED_URLS !== "0";

const EVENTS_PATH = `${TEST_DIR}/events-fixture.md`;
const RENAMED_PATH = `${TEST_DIR}/events-fixture-renamed.md`;

interface StreamedMessage {
  event: string;
  id: string;
  data: Record<string, unknown>;
}

/**
 * Open a stream with fetch and hand back a reader for its data-carrying messages.
 * `close` aborts the request, which is what a client going away looks like to the server.
 */
async function openStream(url: string): Promise<{
  status: number;
  contentType: string | null;
  next: (timeoutMs?: number) => Promise<StreamedMessage>;
  close: () => void;
}> {
  const controller = new AbortController();
  const headers: Record<string, string> = SIGNED_URLS ? {} : { Authorization: `Bearer ${API_KEY}` };
  const res = await fetch(url, { headers, signal: controller.signal });
  if (!res.body) throw new Error(`No response body (status ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function next(timeoutMs = 10_000): Promise<StreamedMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
          if (line.startsWith(":") || !line.includes(":")) continue;
          const colon = line.indexOf(":");
          fields[line.slice(0, colon)] = line.slice(colon + 1).replace(/^ /, "");
        }
        if (fields.data !== undefined) {
          return {
            event: fields.event ?? "message",
            id: fields.id ?? "",
            data: JSON.parse(fields.data) as Record<string, unknown>,
          };
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Timed out waiting for an event");
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for an event")), remaining),
        ),
      ]);
      if (chunk.done) throw new Error("Stream ended");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    next,
    close: () => controller.abort(),
  };
}

async function subscribe(
  route: string,
  filter: unknown,
): Promise<{ id: string; url: string; signed: boolean }> {
  const res = await authedFetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.olrapi.jsonlogic+json" },
    body: JSON.stringify(filter),
  });
  expect(res.status).toBe(201);
  const grant = (await res.json()) as { id: string; url: string; signed: boolean };
  if (SIGNED_URLS) {
    expect(grant.signed).toBe(true);
  }
  // The URL names the host the request reached; point it at the one the tests use.
  const url = new URL(grant.url);
  return { ...grant, url: `${BASE_URL}${url.pathname}${url.search}` };
}

async function writeNote(path: string, content: string): Promise<void> {
  const res = await authedFetch(`/vault/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown" },
    body: content,
  });
  expect(res.status).toBe(204);
}

beforeAll(async () => {
  await ensureServerReachable();
});

afterAll(async () => {
  await deleteFixture(EVENTS_PATH);
  await deleteFixture(RENAMED_PATH);
});

describe("event streams", () => {
  test("metadataCache changed delivers fresh frontmatter for a matching note only", async () => {
    await writeNote(EVENTS_PATH, "---\nstatus: draft\n---\n\nbody\n");
    const grant = await subscribe("/events/metadataCache/changed/", {
      "==": [{ var: "path" }, EVENTS_PATH],
    });
    if (!SIGNED_URLS) expect(grant.signed).toBe(false);
    const stream = await openStream(grant.url);
    try {
      expect(stream.status).toBe(200);
      expect(stream.contentType).toMatch(/^text\/event-stream/);

      await writeNote(EVENTS_PATH, "---\nstatus: done\n---\n\nsecret body text\n");

      const message = await stream.next();
      expect(message.event).toBe("changed");
      expect(message.id).toMatch(/^[0-9a-f]+-\d+$/);
      expect(message.data).toMatchObject({
        emitter: "metadataCache",
        event: "changed",
        path: EVENTS_PATH,
        file: { path: EVENTS_PATH, frontmatter: { status: "done" } },
      });
      // Obsidian passes `changed` the note's text; it is not what the filter asked for.
      expect(JSON.stringify(message.data)).not.toContain("secret body text");
    } finally {
      stream.close();
    }
  });

  test("content is sent when the filter mentions it", async () => {
    await writeNote(EVENTS_PATH, "first\n");
    const grant = await subscribe("/events/metadataCache/changed/", {
      and: [
        { "==": [{ var: "path" }, EVENTS_PATH] },
        { in: ["needle", { var: "file.content" }] },
      ],
    });
    const stream = await openStream(grant.url);
    try {
      await writeNote(EVENTS_PATH, "no match here\n");
      await writeNote(EVENTS_PATH, "has the needle\n");
      const message = await stream.next();
      expect((message.data.file as { content: string }).content).toBe("has the needle\n");
    } finally {
      stream.close();
    }
  });

  test("vault rename carries the old path", async () => {
    await writeNote(EVENTS_PATH, "to be renamed\n");
    const grant = await subscribe("/events/vault/rename/", {
      "==": [{ var: "oldPath" }, EVENTS_PATH],
    });
    const stream = await openStream(grant.url);
    try {
      const move = await authedFetch(`/vault/${EVENTS_PATH}`, {
        method: "MOVE",
        headers: { Destination: RENAMED_PATH },
      });
      expect(move.status).toBeLessThan(300);
      const message = await stream.next();
      expect(message.data).toMatchObject({
        event: "rename",
        path: RENAMED_PATH,
        oldPath: EVENTS_PATH,
        isFolder: false,
      });
    } finally {
      stream.close();
    }
  });

  test("an event that is not streamable is refused with the list of those that are", async () => {
    const res = await authedFetch("/events/workspace/quick-preview/", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { supportedEvents: Record<string, string[]> };
    expect(body.supportedEvents.vault).toEqual(["create", "modify", "delete", "rename"]);
  });

  test("a stream URL for one subscription does not open another", async () => {
    if (!SIGNED_URLS) return;
    const first = await subscribe("/events/vault/modify/", { "==": [1, 1] });
    const second = await subscribe("/events/vault/modify/", { "==": [1, 1] });
    const query = new URL(first.url).search;
    const res = await fetch(`${BASE_URL}/events/vault/modify/${second.id}/${query}`);
    expect(res.status).toBe(401);
  });
});
