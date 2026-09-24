import fs from "fs";
import http from "http";
import { AddressInfo } from "net";
import path from "path";
import request from "supertest";

// Mock McpHandler so tests don't load the MCP SDK (which bundles ESM-only zod)
jest.mock("./mcpHandler", () => ({
  McpHandler: jest.fn().mockImplementation(() => ({
    handleRequest: jest.fn(),
    isSessionlessRequest: jest.fn().mockResolvedValue(false),
    registerTool: jest.fn().mockReturnValue(jest.fn()),
    close: jest.fn(),
  })),
}));

import RequestHandler from "./requestHandler";
import { ErrorCode, LocalRestApiSettings } from "./types";
import {
  EVENT_EMITTERS,
  EventStreams,
  MaximumOpenStreams,
  STREAMABLE_EVENTS,
  UNSTREAMABLE_EVENTS,
} from "./events";
import { VaultOperations } from "./vaultOperations";
import { App, CachedMetadata, PluginManifest, TFile, TFolder } from "../mocks/obsidian";

const API_KEY = "my api key";
const JSONLOGIC = "application/vnd.olrapi.jsonlogic+json";

interface ReceivedEvent {
  event: string;
  id: string;
  data: Record<string, unknown>;
}

/**
 * A minimal SSE client over a raw HTTP request: `next()` resolves with the next event
 * that carries data, skipping keep-alive comments and the initial `retry:` block.
 */
function openStream(url: string): Promise<{
  response: http.IncomingMessage;
  next: () => Promise<ReceivedEvent>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (response) => {
      const queued: ReceivedEvent[] = [];
      const waiting: ((event: ReceivedEvent) => void)[] = [];
      let buffer = "";
      response.setEncoding("utf-8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
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
          if (fields.data === undefined) continue;
          const received = {
            event: fields.event ?? "message",
            id: fields.id ?? "",
            data: JSON.parse(fields.data) as Record<string, unknown>,
          };
          const waiter = waiting.shift();
          if (waiter) waiter(received);
          else queued.push(received);
        }
      });
      resolve({
        response,
        next: () =>
          new Promise((resolveNext) => {
            const ready = queued.shift();
            if (ready) resolveNext(ready);
            else waiting.push(resolveNext);
          }),
        close: () => req.destroy(),
      });
    });
    req.on("error", reject);
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function file(filePath: string): TFile {
  const created = new TFile();
  created.path = filePath;
  created.basename = path.basename(filePath, ".md");
  created.extension = path.extname(filePath).slice(1);
  return created;
}

describe("event streams over REST", () => {
  let settings: LocalRestApiSettings;
  let app: App;
  let handler: RequestHandler;
  let server: http.Server;
  let baseUrl: string;
  const streams: { close: () => void }[] = [];

  beforeEach(async () => {
    settings = {
      apiKey: API_KEY,
      crypto: { cert: "cert", privateKey: "privateKey", publicKey: "publicKey" },
      port: 1,
      insecurePort: 2,
      enableInsecureServer: false,
      enableSignedUrls: true,
    };
    app = new App();
    // @ts-ignore: the mock App does not match Obsidian's App exactly
    handler = new RequestHandler(app, new PluginManifest(), settings);
    handler.setupRouter();
    server = http.createServer(handler.api);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    handler.events.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  async function subscribe(
    route: string,
    filter?: unknown,
  ): Promise<{ id: string; url: string; signed: boolean; expiresAt: string }> {
    const req = request(server).post(route).set("Authorization", `Bearer ${API_KEY}`);
    const result =
      filter === undefined
        ? await req.expect(201)
        : await req.set("Content-Type", JSONLOGIC).send(JSON.stringify(filter)).expect(201);
    return result.body as { id: string; url: string; signed: boolean; expiresAt: string };
  }

  /** Open a stream on this test server, whatever host the grant's URL names. */
  async function open(url: string) {
    const parsed = new URL(url);
    const stream = await openStream(`${baseUrl}${parsed.pathname}${parsed.search}`);
    streams.push(stream);
    return stream;
  }

  function listenerCount(source: { _listeners: Map<string, unknown[]> }, event: string): number {
    return source._listeners.get(event)?.length ?? 0;
  }

  describe("registration", () => {
    test("requires the API key", async () => {
      await request(server).post("/events/vault/modify/").expect(401);
    });

    test("a bare /events/ is refused, listing what can be streamed", async () => {
      const result = await request(server)
        .get("/events/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(400);
      expect(result.body.errorCode).toBe(ErrorCode.EventNameRequired);
      expect(result.body.supportedEvents).toEqual(STREAMABLE_EVENTS);
    });

    test("an emitter without an event is refused", async () => {
      const result = await request(server)
        .post("/events/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(400);
      expect(result.body.errorCode).toBe(ErrorCode.EventNameRequired);
    });

    test.each([
      ["/events/nonsense/modify/"],
      ["/events/vault/changed/"],
      ["/events/workspace/quick-preview/"],
      ["/events/workspace/editor-change/"],
    ])("%s is not streamable", async (route) => {
      const result = await request(server)
        .post(route)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(404);
      expect(result.body.errorCode).toBe(ErrorCode.UnknownEvent);
      expect(result.body.supportedEvents).toEqual(STREAMABLE_EVENTS);
    });

    test("returns a signed URL for the subscription", async () => {
      const grant = await subscribe("/events/vault/modify/", { glob: ["notes/*", { var: "path" }] });
      expect(grant.signed).toBe(true);
      expect(grant.url).toMatch(
        new RegExp(`/events/vault/modify/${grant.id}/\\?sig=[0-9a-f]+&exp=\\d+&n=`),
      );
      expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
    });

    test("returns an unsigned URL while signed URLs are disabled", async () => {
      settings.enableSignedUrls = false;
      const grant = await subscribe("/events/vault/modify/");
      expect(grant.signed).toBe(false);
      expect(grant.url).toMatch(new RegExp(`/events/vault/modify/${grant.id}/$`));
    });

    test("honours ttl, clamped to the signed-URL range", async () => {
      const result = await request(server)
        .post("/events/vault/modify/?ttl=1")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(201);
      const lifetime = Date.parse(result.body.expiresAt as string) - Date.now();
      expect(lifetime).toBeGreaterThan(8_000);
      expect(lifetime).toBeLessThanOrEqual(11_000);
    });

    test("a filter JSONLogic cannot evaluate is refused", async () => {
      const result = await request(server)
        .post("/events/vault/modify/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", JSONLOGIC)
        .send(JSON.stringify({ "no-such-operator": [1] }))
        .expect(400);
      expect(result.body.errorCode).toBe(ErrorCode.InvalidFilterQuery);
    });

    test("a filter in some other content type is refused", async () => {
      const result = await request(server)
        .post("/events/vault/modify/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/plain")
        .send("path == notes")
        .expect(400);
      expect(result.body.errorCode).toBe(ErrorCode.InvalidContentType);
    });
  });

  describe("streaming", () => {
    test("a signed URL streams matching events without the API key", async () => {
      const grant = await subscribe("/events/vault/modify/", { glob: ["notes/*", { var: "path" }] });
      const stream = await open(grant.url);
      expect(stream.response.statusCode).toBe(200);
      expect(stream.response.headers["content-type"]).toMatch(/^text\/event-stream/);
      await waitFor(() => listenerCount(app.vault, "modify") === 2);

      app.vault._emit("modify", file("elsewhere/skip.md"));
      app.vault._emit("modify", file("notes/keep.md"));

      const received = await stream.next();
      expect(received.event).toBe("modify");
      expect(received.id).toBe(`${handler.events.epoch}-2`);
      expect(received.data).toMatchObject({
        emitter: "vault",
        event: "modify",
        path: "notes/keep.md",
        isFolder: false,
        file: { path: "notes/keep.md", tags: [], frontmatter: {} },
      });
    });

    test("content is sent only when the filter mentions it", async () => {
      app.vault._cachedRead = "secret body";
      const plain = await subscribe("/events/vault/modify/");
      const withContent = await subscribe("/events/vault/modify/", {
        in: ["secret", { var: "file.content" }],
      });
      const plainStream = await open(plain.url);
      const contentStream = await open(withContent.url);
      await waitFor(() => handler.events.openStreamCount === 2);

      app.vault._emit("modify", file("a.md"));

      const withoutBody = await plainStream.next();
      const withBody = await contentStream.next();
      expect(withoutBody.data.file).not.toHaveProperty("content");
      expect((withBody.data.file as { content: string }).content).toBe("secret body");
    });

    test("vault rename carries the old path, and folders carry no NoteJson", async () => {
      const grant = await subscribe("/events/vault/rename/");
      const stream = await open(grant.url);
      await waitFor(() => listenerCount(app.vault, "rename") === 2);

      const folder = new TFolder();
      folder.path = "new-folder";
      app.vault._emit("rename", folder, "old-folder");

      const received = await stream.next();
      expect(received.data).toEqual({
        emitter: "vault",
        event: "rename",
        path: "new-folder",
        isFolder: true,
        oldPath: "old-folder",
        file: null,
      });
    });

    test("metadataCache changed drops the note text Obsidian passes", async () => {
      const grant = await subscribe("/events/metadataCache/changed/");
      const stream = await open(grant.url);
      await waitFor(() => handler.events.openStreamCount === 1);
      const cache = new CachedMetadata();
      cache.frontmatter = { status: "done" };
      app.metadataCache._getFileCache = cache;

      app.metadataCache._emit("changed", file("a.md"), "the whole note text", cache);

      const received = await stream.next();
      expect(JSON.stringify(received.data)).not.toContain("the whole note text");
      expect(received.data).toMatchObject({
        path: "a.md",
        file: { frontmatter: { status: "done" } },
      });
    });

    test("metadataCache deleted sends the previous frontmatter and tags", async () => {
      const grant = await subscribe("/events/metadataCache/deleted/");
      const stream = await open(grant.url);
      await waitFor(() => handler.events.openStreamCount === 1);

      app.metadataCache._emit("deleted", file("gone.md"), {
        frontmatter: { status: "draft", position: {} },
        tags: [{ tag: "#idea" }],
      });

      const received = await stream.next();
      expect(received.data).toEqual({
        emitter: "metadataCache",
        event: "deleted",
        path: "gone.md",
        file: null,
        previous: { frontmatter: { status: "draft" }, tags: ["idea"] },
      });
    });

    test("workspace active-leaf-change sends only the path and view type", async () => {
      const grant = await subscribe("/events/workspace/active-leaf-change/");
      const stream = await open(grant.url);
      await waitFor(() => listenerCount(app.workspace, "active-leaf-change") === 1);

      app.workspace._emit("active-leaf-change", {
        view: { file: file("open.md"), getViewType: () => "markdown", editor: { secret: 1 } },
      });

      const received = await stream.next();
      expect(received.data).toEqual({
        emitter: "workspace",
        event: "active-leaf-change",
        path: "open.md",
        file: null,
        viewType: "markdown",
      });
    });

    test("the Obsidian listener is removed when the last stream closes", async () => {
      const grant = await subscribe("/events/workspace/layout-change/");
      const stream = await open(grant.url);
      await waitFor(() => listenerCount(app.workspace, "layout-change") === 1);

      stream.close();

      await waitFor(() => listenerCount(app.workspace, "layout-change") === 0);
      expect(handler.events.openStreamCount).toBe(0);
    });

    test("the API key opens a stream too", async () => {
      settings.enableSignedUrls = false;
      const grant = await subscribe("/events/vault/create/");
      const response = await new Promise<http.IncomingMessage>((resolve) => {
        const req = http.get(
          `${baseUrl}/events/vault/create/${grant.id}/`,
          { headers: { Authorization: `Bearer ${API_KEY}` } },
          resolve,
        );
        streams.push({ close: () => req.destroy() });
      });
      expect(response.statusCode).toBe(200);
    });

    test("a signature does not open a different subscription", async () => {
      const first = await subscribe("/events/vault/modify/");
      const second = await subscribe("/events/vault/modify/");
      const query = new URL(first.url).search;
      await request(server).get(`/events/vault/modify/${second.id}/${query}`).expect(401);
    });

    test("a tampered signature is refused", async () => {
      const grant = await subscribe("/events/vault/modify/");
      const url = new URL(grant.url);
      url.searchParams.set("sig", "0".repeat(64));
      await request(server).get(`${url.pathname}${url.search}`).expect(401);
    });

    test("an unknown subscription is 404", async () => {
      const result = await request(server)
        .get("/events/vault/modify/nope/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(404);
      expect(result.body.errorCode).toBe(ErrorCode.EventSubscriptionNotFound);
    });

    test("a subscription is for the event it was registered for", async () => {
      const grant = await subscribe("/events/vault/modify/");
      await request(server)
        .get(`/events/vault/create/${grant.id}/`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(404);
    });

    test(`at most ${MaximumOpenStreams} streams are open at once`, async () => {
      const grant = await subscribe("/events/vault/modify/");
      for (let i = 0; i < MaximumOpenStreams; i++) {
        const stream = await open(grant.url);
        expect(stream.response.statusCode).toBe(200);
      }
      await waitFor(() => handler.events.openStreamCount === MaximumOpenStreams);
      const result = await request(server).get(new URL(grant.url).pathname + new URL(grant.url).search);
      expect(result.status).toBe(503);
      expect(result.body.errorCode).toBe(ErrorCode.EventCapacityReached);
    });

    test("dispose closes open streams and removes listeners", async () => {
      const grant = await subscribe("/events/vault/delete/");
      const stream = await open(grant.url);
      await waitFor(() => listenerCount(app.vault, "delete") === 2);
      const ended = new Promise((resolve) => stream.response.on("end", resolve));

      handler.events.dispose();

      await ended;
      expect(listenerCount(app.vault, "delete")).toBe(1);
    });
  });
});

describe("EventStreams expiry", () => {
  test("an expired subscription can no longer be opened", () => {
    let now = 1_000_000;
    const app = new App();
    // @ts-ignore: the mock App does not match Obsidian's App exactly
    const operations = new VaultOperations(app, {});
    // @ts-ignore: the mock App does not match Obsidian's App exactly
    const events = new EventStreams(app, operations, () => now);
    const subscription = events.subscribe("vault", "modify", null, 60);

    expect(events.get("vault", "modify", subscription.id)).toBe(subscription);
    now += 61_000;
    expect(events.get("vault", "modify", subscription.id)).toBeNull();
  });
});

// Every event Obsidian declares has to be sorted into streamable or not, so an upgrade
// that adds one is a failing test rather than an event that is silently missing -- or,
// worse, one that someone later exposes without writing a serializer that decides what
// it may send.
describe("Obsidian's declared event surface", () => {
  function declaredEvents(className: string): string[] {
    const typings = fs.readFileSync(
      path.join(__dirname, "..", "node_modules", "obsidian", "obsidian.d.ts"),
      "utf-8",
    );
    const start = typings.indexOf(`export class ${className} extends Events {`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = typings.indexOf("\nexport ", start + 1);
    const body = typings.slice(start, end === -1 ? undefined : end);
    return [...body.matchAll(/\bon\(name: '([^']+)'/g)].map((match) => match[1]).sort();
  }

  const classes = { vault: "Vault", metadataCache: "MetadataCache", workspace: "Workspace" };

  test.each(EVENT_EMITTERS.map((emitter) => [emitter]))(
    "every %s event is either streamable or deliberately not",
    (emitter) => {
      const streamable: readonly string[] = STREAMABLE_EVENTS[emitter];
      const excluded = Object.keys(UNSTREAMABLE_EVENTS[emitter]);
      expect(streamable.filter((event) => excluded.includes(event))).toEqual([]);
      expect([...streamable, ...excluded].sort()).toEqual(declaredEvents(classes[emitter]));
    },
  );
});
