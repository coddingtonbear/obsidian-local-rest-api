import {
  authedFetch,
  unauthFetch,
  ensureServerReachable,
  resetFixture,
  deleteFixture,
} from "./client";
import {
  TEST_DIR,
  TEST_PATH,
  FIXTURE_DOCUMENT,
  TERM_ALPHA,
  TERM_BETA,
  TERM_SUB,
  TERM_DELTA,
  HEADING_ALPHA,
  HEADING_SUB,
  BLOCK_BETA,
  BLOCK_TABLE,
  FM_TITLE,
  FM_PRIORITY,
  FM_TITLE_VALUE,
  FM_PRIORITY_VALUE,
  FM_ACTIVE_VALUE,
  TAG_FIXTURE,
  TAG_INLINE,
} from "./fixtures";

beforeAll(async () => {
  await ensureServerReachable();
});

beforeEach(async () => {
  await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
});

afterAll(async () => {
  await deleteFixture(TEST_PATH);
});

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

describe("GET /vault/ — directory listing", () => {
  test("returns 200 with files array containing test dir", async () => {
    const res = await authedFetch("/vault/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files).toContain(`${TEST_DIR}/`);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/vault/");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Raw file content
// ---------------------------------------------------------------------------

describe("GET /vault/{file} — raw content", () => {
  test("returns 200 with text/markdown content-type", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
  });

  test("response body contains fixture title", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`);
    const text = await res.text();
    expect(text).toContain(FM_TITLE_VALUE);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch(`/vault/${TEST_PATH}`);
    expect(res.status).toBe(401);
  });

  test("returns 404 for non-existent file", async () => {
    const res = await authedFetch(`/vault/${TEST_DIR}/no-such-file.md`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Accept: application/vnd.olrapi.note+json
// ---------------------------------------------------------------------------

describe("GET /vault/{file} with Accept: application/vnd.olrapi.note+json", () => {
  test("returns NoteJson with correct path, frontmatter, tags, stat, and content", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { Accept: "application/vnd.olrapi.note+json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(TEST_PATH);
    expect(body.frontmatter[FM_TITLE]).toBe(FM_TITLE_VALUE);
    expect(body.frontmatter[FM_PRIORITY]).toBe(FM_PRIORITY_VALUE);
    expect(body.frontmatter["active"]).toBe(FM_ACTIVE_VALUE);
    expect(body.tags).toContain(TAG_FIXTURE);
    expect(body.tags).toContain(TAG_INLINE);
    expect(typeof body.stat?.ctime).toBe("number");
    expect(typeof body.stat?.mtime).toBe("number");
    expect(typeof body.stat?.size).toBe("number");
    expect(typeof body.content).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Accept: application/vnd.olrapi.document-map+json
// ---------------------------------------------------------------------------

describe("GET /vault/{file} with Accept: application/vnd.olrapi.document-map+json", () => {
  test("defaults to the 2.0 map: nested heading tree, bare blocks, and a version", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { Accept: "application/vnd.olrapi.document-map+json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBeNull();
    const body = await res.json();
    expect(typeof body.version).toBe("string");
    expect(Array.isArray(body.headings)).toBe(false);
    expect(body.headings).toHaveProperty(HEADING_ALPHA);
    expect(body.headings[HEADING_ALPHA]).toHaveProperty(HEADING_SUB);
    expect(body.blocks).toContain(BLOCK_BETA);
    expect(body.frontmatterFields).toContain(FM_TITLE);
    expect(body.frontmatterFields).toContain(FM_PRIORITY);
  });

  test("Markdown-Patch-Version: 1 returns the deprecated ::-joined map", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: {
        Accept: "application/vnd.olrapi.document-map+json",
        "Markdown-Patch-Version": "1",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBe('true; sunset-version="6.0"');
    const body = await res.json();
    expect(body.version).toBeUndefined();
    expect(body.headings).toContain(HEADING_ALPHA);
    expect(body.headings).toContain(`${HEADING_ALPHA}::${HEADING_SUB}`);
    expect(body.blocks).toContain(BLOCK_BETA);
  });
});

// ---------------------------------------------------------------------------
// Malformed frontmatter YAML
// ---------------------------------------------------------------------------

describe("GET /vault/{file} with malformed frontmatter YAML", () => {
  const MALFORMED_FRONTMATTER_DOCUMENT = `---
purpose: Check patch behavior with targetType: block
---

# Heading1

Content.
`;

  beforeEach(async () => {
    await resetFixture(MALFORMED_FRONTMATTER_DOCUMENT, TEST_PATH);
  });

  test("the document map returns 400 (40005), not a 500", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { Accept: "application/vnd.olrapi.document-map+json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40005);
  });

  test("a path-targeted read returns 400 (40005), not a 500", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/heading/Heading1`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40005);
  });
});

// ---------------------------------------------------------------------------
// Target-Type: heading (header-based)
// ---------------------------------------------------------------------------

// Header-based targeting is a deprecated 1.x feature: it is only processed
// under Markdown-Patch-Version: 1 (which carries the sunset advisory). The 2.0
// (default) way to target a read is URL path elements, covered further below.
describe("GET /vault/{file} with Target-Type: heading (deprecated 1.x header targeting)", () => {
  test("returns content of named heading section", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: {
        Accept: "text/markdown",
        "Markdown-Patch-Version": "1",
        "Target-Type": "heading",
        Target: "Alpha",
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_ALPHA);
    expect(text).not.toContain(TERM_BETA);
  });

  test("without Markdown-Patch-Version: 1 the header is rejected (40083)", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { Accept: "text/markdown", "Target-Type": "heading", Target: "Alpha" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40083);
  });

  test("a Markdown-Patch-Version: 1 read still works and is marked deprecated", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: {
        Accept: "text/markdown",
        "Markdown-Patch-Version": "1",
        "Target-Type": "heading",
        Target: "Alpha",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBe('true; sunset-version="6.0"');
    expect(await res.text()).toContain(TERM_ALPHA);
  });

  test("returns nested heading via :: delimiter", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: {
        Accept: "text/markdown",
        "Markdown-Patch-Version": "1",
        "Target-Type": "heading",
        Target: "Alpha::Subsection",
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_SUB);
    expect(text).not.toContain(TERM_ALPHA);
  });

  test("returns 404 for non-existent heading", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: {
        "Markdown-Patch-Version": "1",
        "Target-Type": "heading",
        Target: "NoSuchHeading",
      },
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 with errorCode 40055 when Target-Type provided without Target", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { "Markdown-Patch-Version": "1", "Target-Type": "heading" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40055);
  });

  test("returns 400 with errorCode 40054 for invalid Target-Type value", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { "Target-Type": "bogus", Target: "Alpha" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40054);
  });
});

// ---------------------------------------------------------------------------
// Target-Type: block (header-based)
// ---------------------------------------------------------------------------

describe("GET /vault/{file} with Target-Type: block (deprecated 1.x header targeting)", () => {
  test("returns content of named block", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: {
        Accept: "text/markdown",
        "Markdown-Patch-Version": "1",
        "Target-Type": "block",
        Target: "beta-block",
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_BETA);
  });

  test("returns 404 for non-existent block ID", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: {
        "Markdown-Patch-Version": "1",
        "Target-Type": "block",
        Target: "no-such-block",
      },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Target-Type: frontmatter (header-based)
// ---------------------------------------------------------------------------

describe("GET /vault/{file} with Target-Type: frontmatter (deprecated 1.x header targeting)", () => {
  test("returns string field as JSON string", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { "Markdown-Patch-Version": "1", "Target-Type": "frontmatter", Target: "title" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBe(FM_TITLE_VALUE);
  });

  test("returns numeric field as JSON number", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { "Markdown-Patch-Version": "1", "Target-Type": "frontmatter", Target: "priority" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBe(FM_PRIORITY_VALUE);
  });

  test("returns boolean field as JSON boolean", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { "Markdown-Patch-Version": "1", "Target-Type": "frontmatter", Target: "active" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBe(true);
  });

  test("returns array field as JSON array", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { "Markdown-Patch-Version": "1", "Target-Type": "frontmatter", Target: "tags" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toContain(TAG_FIXTURE);
  });

  test("returns 404 for missing frontmatter field", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      headers: { "Markdown-Patch-Version": "1", "Target-Type": "frontmatter", Target: "nonexistent-field" },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// URL-embedded heading targets
// ---------------------------------------------------------------------------

describe("GET /vault/{file}/heading/{name} — URL-embedded target", () => {
  test("returns section content via URL path", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/heading/Alpha`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_ALPHA);
  });

  test("returns nested heading content via multi-segment URL", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/heading/Alpha/Subsection`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_SUB);
  });

  test("returns 422 with errorCode 42200 when URL target and Target-Type header both present", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/heading/Alpha`, {
      headers: { "Target-Type": "heading" },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe(42200);
  });

  test("returns 422 when URL target and Target header both present", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/heading/Alpha`, {
      headers: { Target: "Alpha" },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe(42200);
  });
});

// ---------------------------------------------------------------------------
// URL-embedded frontmatter targets
// ---------------------------------------------------------------------------

describe("GET /vault/{file}/frontmatter/{field} — URL-embedded target", () => {
  test("returns frontmatter field value as JSON", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/frontmatter/title`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBe(FM_TITLE_VALUE);
  });
});

// ---------------------------------------------------------------------------
// PUT — full file replacement
// ---------------------------------------------------------------------------

describe("PUT /vault/{file} — full file replacement", () => {
  test("returns 204 and subsequent GET reflects new content", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "replacement content\n",
    });
    expect(res.status).toBe(204);

    const getRes = await authedFetch(`/vault/${TEST_PATH}`);
    const text = await getRes.text();
    expect(text).toContain("replacement content");
    expect(text).not.toContain(FM_TITLE_VALUE);
  });

  test("returns 405 with errorCode 40510 on PUT to directory", async () => {
    const res = await authedFetch(`/vault/${TEST_DIR}/`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "data\n",
    });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.errorCode).toBe(40510);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch(`/vault/${TEST_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "data\n",
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PUT — targeted section replacement via URL
// ---------------------------------------------------------------------------

describe("PUT /vault/{file}/heading/{name} — section replacement", () => {
  test("returns 200 with replaced section; other sections preserved", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/heading/Delta`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "Replaced delta content.\n",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Replaced delta content.");
    expect(text).not.toContain(TERM_DELTA);
    expect(text).toContain(TERM_ALPHA);
  });

  test("returns 422 when URL target and Target-Type header both present", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/heading/Delta`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "Target-Type": "heading" },
      body: "data\n",
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// PUT/POST /vault/{file}/block/{id} with a JSON body — table-row writes
// (2.0 engine). A JSON array body on a block target is routed to the
// engine's structured `value` carrier rather than the literal `content`
// string carrier a text/markdown body uses.
// ---------------------------------------------------------------------------

describe("PUT /vault/{file}/block/{id} — table row replace via JSON body", () => {
  test("returns 200 with the table's body rows replaced, header preserved", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/block/${BLOCK_TABLE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([["New A", "New B"]]),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("| New A | New B |");
    expect(text).not.toContain("Row 1 A");
    expect(text).toContain("| Column A | Column B |");
  });
});

describe("POST /vault/{file}/block/{id} — table row append via JSON body", () => {
  test("returns 200 with a new row appended after the existing ones", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/block/${BLOCK_TABLE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([["Row 3 A", "Row 3 B"]]),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Row 1 A");
    expect(text).toContain("Row 2 A");
    expect(text).toContain("| Row 3 A | Row 3 B |");
  });

  test("a row with the wrong number of cells is rejected", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/block/${BLOCK_TABLE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([["only-one-cell"]]),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Header-based write targeting is a deprecated 1.x feature (only processed
// under Markdown-Patch-Version: 1); use URL path elements for 2.0 writes.
// ---------------------------------------------------------------------------

describe("Header-based targeting on writes (deprecated 1.x)", () => {
  test("PUT with a Target-Type header and no version is rejected (40083)", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "Target-Type": "heading", Target: "Delta" },
      body: "data\n",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40083);
  });

  test("PUT with a Target-Type header under Markdown-Patch-Version: 1 still writes and is deprecated", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PUT",
      headers: {
        "Content-Type": "text/markdown",
        "Markdown-Patch-Version": "1",
        "Target-Type": "heading",
        Target: "Delta",
      },
      body: "Replaced via 1.x header.\n",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBe('true; sunset-version="6.0"');
  });
});

// ---------------------------------------------------------------------------
// POST — append to file end
// ---------------------------------------------------------------------------

describe("POST /vault/{file} — append to end", () => {
  test("returns 204 and subsequent GET contains both original and appended content", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: "appended text\n",
    });
    expect(res.status).toBe(204);

    const getRes = await authedFetch(`/vault/${TEST_PATH}`);
    const text = await getRes.text();
    expect(text).toContain(TERM_DELTA);
    expect(text).toContain("appended text");
  });

  test("returns 405 with errorCode 40510 on POST to directory", async () => {
    const res = await authedFetch(`/vault/${TEST_DIR}/`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: "data\n",
    });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.errorCode).toBe(40510);
  });

  test("returns 400 with errorCode 40010 on non-text content-type", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "value" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40010);
  });
});

// ---------------------------------------------------------------------------
// POST — append to section via URL
// ---------------------------------------------------------------------------

describe("POST /vault/{file}/heading/{name} — append to section", () => {
  test("returns 200 with section content preserved and new content appended", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/heading/Delta`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: "delta-appended\n",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_DELTA);
    expect(text).toContain("delta-appended");
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe("DELETE /vault/{file}", () => {
  test("returns 204 on successful deletion", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("returns 404 on second delete", async () => {
    await authedFetch(`/vault/${TEST_PATH}`, { method: "DELETE" });
    const res = await authedFetch(`/vault/${TEST_PATH}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("returns 405 with errorCode 40510 on DELETE to directory", async () => {
    const res = await authedFetch(`/vault/${TEST_DIR}/`, { method: "DELETE" });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.errorCode).toBe(40510);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch(`/vault/${TEST_PATH}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// MOVE
// ---------------------------------------------------------------------------

describe("MOVE /vault/{file}", () => {
  const MOVE_SRC = `${TEST_DIR}/move-source.md`;
  const MOVE_DST = `${TEST_DIR}/move-destination.md`;

  beforeEach(async () => {
    const res = await authedFetch(`/vault/${MOVE_SRC}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "move-source-content\n",
    });
    if (res.status !== 204) throw new Error(`MOVE_SRC setup failed: ${res.status}`);
  });

  afterEach(async () => {
    await deleteFixture(MOVE_SRC).catch((_e: unknown): void => {});
    await deleteFixture(MOVE_DST).catch((_e: unknown): void => {});
  });

  test("returns 204, Content-Location header, source gone, dest has original content", async () => {
    const res = await authedFetch(`/vault/${MOVE_SRC}`, {
      method: "MOVE",
      headers: { Destination: MOVE_DST },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("content-location")).toBe(MOVE_DST);

    const srcRes = await authedFetch(`/vault/${MOVE_SRC}`);
    expect(srcRes.status).toBe(404);

    const dstRes = await authedFetch(`/vault/${MOVE_DST}`);
    expect(dstRes.status).toBe(200);
    expect(await dstRes.text()).toContain("move-source-content");
  });

  test("trailing-slash destination resolves to source filename", async () => {
    const dstDir = `${TEST_DIR}/move-subdir/`;
    const expectedDst = `${TEST_DIR}/move-subdir/move-source.md`;

    const res = await authedFetch(`/vault/${MOVE_SRC}`, {
      method: "MOVE",
      headers: { Destination: dstDir },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("content-location")).toBe(expectedDst);

    await deleteFixture(expectedDst).catch((_e: unknown): void => {});
  });

  test("returns 404 for non-existent source", async () => {
    const res = await authedFetch(`/vault/${TEST_DIR}/no-such-file.md`, {
      method: "MOVE",
      headers: { Destination: MOVE_DST },
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 when Destination header is missing", async () => {
    const res = await authedFetch(`/vault/${MOVE_SRC}`, { method: "MOVE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("Destination header is required");
  });

  test("returns 409 when destination already exists", async () => {
    const putRes = await authedFetch(`/vault/${MOVE_DST}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "existing content\n",
    });
    if (putRes.status !== 204) throw new Error(`MOVE_DST setup failed: ${putRes.status}`);

    const res = await authedFetch(`/vault/${MOVE_SRC}`, {
      method: "MOVE",
      headers: { Destination: MOVE_DST },
    });
    expect(res.status).toBe(409);
  });

  test("Allow-Overwrite: true overwrites existing destination", async () => {
    const putRes = await authedFetch(`/vault/${MOVE_DST}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: "existing content\n",
    });
    if (putRes.status !== 204) throw new Error(`MOVE_DST setup failed: ${putRes.status}`);

    const res = await authedFetch(`/vault/${MOVE_SRC}`, {
      method: "MOVE",
      headers: { Destination: MOVE_DST, "Allow-Overwrite": "true" },
    });
    expect(res.status).toBe(204);

    const dstRes = await authedFetch(`/vault/${MOVE_DST}`);
    const text = await dstRes.text();
    expect(text).toContain("move-source-content");
    expect(text).not.toContain("existing content");
  });

  test("MOVE to same path is a no-op; source file still exists", async () => {
    const res = await authedFetch(`/vault/${MOVE_SRC}`, {
      method: "MOVE",
      headers: { Destination: MOVE_SRC, "Allow-Overwrite": "true" },
    });
    expect(res.status).toBe(204);

    const srcRes = await authedFetch(`/vault/${MOVE_SRC}`);
    expect(srcRes.status).toBe(200);
    expect(await srcRes.text()).toContain("move-source-content");
  });

  test("returns 405 on MOVE to directory path", async () => {
    const res = await authedFetch(`/vault/${TEST_DIR}/`, {
      method: "MOVE",
      headers: { Destination: `${TEST_DIR}-moved/` },
    });
    expect(res.status).toBe(405);
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch(`/vault/${MOVE_SRC}`, {
      method: "MOVE",
      headers: { Destination: MOVE_DST },
    });
    expect(res.status).toBe(401);
  });
});
