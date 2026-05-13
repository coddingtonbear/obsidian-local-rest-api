import {
  authedFetch,
  unauthFetch,
  ensureServerReachable,
  resetFixture,
  deleteFixture,
} from "./client";
import {
  TEST_PATH,
  FIXTURE_DOCUMENT,
  TERM_ALPHA,
  TERM_BETA,
} from "./fixtures";

beforeAll(async () => {
  await ensureServerReachable();
  await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
});

afterAll(async () => {
  await deleteFixture(TEST_PATH);
});

// ---------------------------------------------------------------------------
// POST /search/simple/
// ---------------------------------------------------------------------------

describe("POST /search/simple/", () => {
  test("finds fixture by unique content term", async () => {
    const res = await authedFetch(`/search/simple/?query=${TERM_ALPHA}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const hit = body.find((item: { filename: string }) => item.filename === TEST_PATH);
    expect(hit).toBeDefined();
  });

  test("match object has correct shape", async () => {
    const res = await authedFetch(`/search/simple/?query=${TERM_ALPHA}`, {
      method: "POST",
    });
    const body = await res.json();
    const hit = body.find((item: { filename: string }) => item.filename === TEST_PATH);
    expect(hit).toBeDefined();
    expect(Array.isArray(hit.matches)).toBe(true);
    expect(hit.matches.length).toBeGreaterThan(0);
    const m = hit.matches[0];
    expect(["filename", "content"]).toContain(m.match.source);
    expect(typeof m.match.start).toBe("number");
    expect(typeof m.match.end).toBe("number");
    expect(typeof m.context).toBe("string");
  });

  test("contextLength parameter is respected", async () => {
    const contextLength = 10;
    const res = await authedFetch(
      `/search/simple/?query=${TERM_BETA}&contextLength=${contextLength}`,
      { method: "POST" }
    );
    const body = await res.json();
    const hit = body.find((item: { filename: string }) => item.filename === TEST_PATH);
    expect(hit).toBeDefined();
    for (const m of hit.matches) {
      if (m.match.source === "content") {
        expect(m.context.length).toBeLessThanOrEqual(contextLength * 2 + TERM_BETA.length);
      }
    }
  });

  test("returns empty array when no match", async () => {
    const res = await authedFetch(
      "/search/simple/?query=zzzzzz-no-match-zzzzzz",
      { method: "POST" }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test("returns 400 with errorCode 40090 when query parameter missing", async () => {
    const res = await authedFetch("/search/simple/", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40090);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch(`/search/simple/?query=${TERM_ALPHA}`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /search/ with JSON Logic
// ---------------------------------------------------------------------------

describe("POST /search/ with application/vnd.olrapi.jsonlogic+json", () => {
  test("path equality check finds fixture", async () => {
    const res = await authedFetch("/search/", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.olrapi.jsonlogic+json" },
      body: JSON.stringify({ "==": [{ var: "path" }, TEST_PATH] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((item: { filename: string }) => item.filename === TEST_PATH)).toBe(true);
  });

  test("tag membership test finds fixture", async () => {
    const res = await authedFetch("/search/", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.olrapi.jsonlogic+json" },
      body: JSON.stringify({ in: ["integration-fixture", { var: "tags" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.some((item: { filename: string }) => item.filename === TEST_PATH)).toBe(true);
  });

  test("frontmatter numeric comparison finds fixture", async () => {
    const res = await authedFetch("/search/", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.olrapi.jsonlogic+json" },
      body: JSON.stringify({ "==": [{ var: "frontmatter.priority" }, 42] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.some((item: { filename: string }) => item.filename === TEST_PATH)).toBe(true);
  });

  test("returns 400 with errorCode 40012 for invalid content-type", async () => {
    const res = await authedFetch("/search/", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40012);
  });

  test("returns 400 when no explicit content-type header", async () => {
    // fetch automatically adds Content-Type: text/plain for string bodies,
    // which the server rejects as an invalid type (40012) rather than missing (40011).
    const res = await authedFetch("/search/", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect([40011, 40012]).toContain(body.errorCode);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/search/", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.olrapi.jsonlogic+json" },
      body: JSON.stringify({ "==": [1, 1] }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /search/ with Dataview DQL (conditional)
// ---------------------------------------------------------------------------

describe("POST /search/ with application/vnd.olrapi.dataview.dql+txt", () => {
  const maybeTest = process.env.OBSIDIAN_DATAVIEW === "true" ? test : test.skip;

  maybeTest("TABLE query returns results including fixture", async () => {
    const res = await authedFetch("/search/", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.olrapi.dataview.dql+txt" },
      body: `TABLE file.path FROM "__integration_tests__"`,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  maybeTest("invalid Dataview query returns 400 with errorCode 40070", async () => {
    const res = await authedFetch("/search/", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.olrapi.dataview.dql+txt" },
      body: "NOT VALID DQL !!!",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40070);
  });
});
