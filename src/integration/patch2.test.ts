import {
  authedFetch,
  ensureServerReachable,
  resetFixture,
  deleteFixture,
} from "./client";
import {
  TEST_DIR,
  TEST_PATH,
  FIXTURE_DOCUMENT,
  TERM_BETA,
  TERM_DELTA,
  TERM_SUB,
} from "./fixtures";

// Integration coverage for the markdown-patch 2.0 PATCH format: the whole
// instruction rides in a JSON request body and there are no Target-* headers.
// Selection is by request shape (no Target-Type header + object body), so these
// requests hit the 2.0 engine while the header-driven tests in patch.test.ts
// still exercise the deprecated 1.x path.

beforeAll(async () => {
  await ensureServerReachable();
});

beforeEach(async () => {
  await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
});

afterAll(async () => {
  await deleteFixture(TEST_PATH);
});

function patchV2(instruction: unknown, path = TEST_PATH): Promise<Response> {
  return authedFetch(`/vault/${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(instruction),
  });
}

// ---------------------------------------------------------------------------
// Heading targets
// ---------------------------------------------------------------------------

describe("PATCH 2.0 — heading content", () => {
  test("append adds content below the heading, preserving the original", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Delta"],
      operation: "append",
      scope: "content",
      content: "v2-heading-append",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_DELTA);
    expect(text).toContain("v2-heading-append");
  });

  test("prepend inserts content before the original body", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Delta"],
      operation: "prepend",
      scope: "content",
      content: "v2-heading-prepend",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.indexOf("v2-heading-prepend")).toBeLessThan(text.indexOf(TERM_DELTA));
  });

  test("replace swaps the heading body", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Delta"],
      operation: "replace",
      scope: "content",
      content: "v2-heading-replace",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("v2-heading-replace");
    expect(text).not.toContain(TERM_DELTA);
  });

  test("an omitted scope defaults to content", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Delta"],
      operation: "replace",
      content: "v2-default-scope",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("v2-default-scope");
  });

  test("a nested heading is addressed by its path array", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Alpha", "Subsection"],
      operation: "append",
      content: "v2-nested-append",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_SUB);
    expect(text).toContain("v2-nested-append");
  });

  test("marker scope renames the heading, keeping its level", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Delta"],
      operation: "replace",
      scope: "marker",
      content: "Renamed",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# Renamed");
    expect(text).not.toContain("# Delta");
  });
});

// ---------------------------------------------------------------------------
// Block targets
// ---------------------------------------------------------------------------

describe("PATCH 2.0 — block content", () => {
  test("append adds to the block, preserving the original", async () => {
    const res = await patchV2({
      targetType: "block",
      target: "beta-block",
      operation: "append",
      content: "v2-block-append",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_BETA);
    expect(text).toContain("v2-block-append");
  });
});

// ---------------------------------------------------------------------------
// Frontmatter targets (JSON `value` carrier)
// ---------------------------------------------------------------------------

describe("PATCH 2.0 — frontmatter", () => {
  test("replace sets a field from a native JSON value", async () => {
    const res = await patchV2({
      targetType: "frontmatter",
      target: "title",
      operation: "replace",
      value: "New V2 Title",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("New V2 Title");
  });

  test("append merges a new tag into the tags list", async () => {
    const res = await patchV2({
      targetType: "frontmatter",
      target: "tags",
      operation: "append",
      value: ["v2-new-tag"],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("v2-new-tag");
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("PATCH 2.0 — delete", () => {
  test("delete markerAndContent removes the whole section subtree", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Gamma"],
      operation: "delete",
      scope: "markerAndContent",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("This section contains a table");
    // Sibling sections are untouched.
    expect(text).toContain(TERM_DELTA);
  });
});

// ---------------------------------------------------------------------------
// Warnings, preconditions, creation
// ---------------------------------------------------------------------------

describe("PATCH 2.0 — warnings and preconditions", () => {
  test("a heading rebased past level 6 returns a Markdown-Patch-Warnings header", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Delta"],
      operation: "replace",
      scope: "content",
      content: "###### deep", // 6 + Delta's level (1) = 7, overflows h6
    });
    expect(res.status).toBe(200);
    const warnings = res.headers.get("Markdown-Patch-Warnings");
    expect(warnings).toBeTruthy();
    // Percent-encoded: a warning message embeds document text verbatim, which
    // may contain non-ASCII characters that are not valid in a raw header value.
    expect(JSON.parse(decodeURIComponent(warnings ?? "%5B%5D"))[0].code).toBe(
      "heading-depth-overflow",
    );
  });

  test("an ifMatch mismatch returns 412 and does not modify the file", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Delta"],
      operation: "replace",
      scope: "content",
      content: "should-not-apply",
      ifMatch: "deadbeef-not-the-version",
    });
    expect(res.status).toBe(412);
    // The document is unchanged.
    const after = await authedFetch(`/vault/${TEST_PATH}`);
    expect(await after.text()).toContain(TERM_DELTA);
  });

  test("createTargetIfMissing creates a new heading section", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["BrandNewV2Section"],
      operation: "append",
      content: "v2-created-content",
      createTargetIfMissing: true,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("BrandNewV2Section");
    expect(text).toContain("v2-created-content");
  });

  test("a missing target without createTargetIfMissing returns 404", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["NoSuchV2Heading"],
      operation: "replace",
      scope: "content",
      content: "x",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Error cases and routing
// ---------------------------------------------------------------------------

describe("PATCH 2.0 — errors and routing", () => {
  test("an invalid targetType returns 400 (40054)", async () => {
    const res = await patchV2({
      targetType: "paragraph",
      target: ["Delta"],
      operation: "replace",
      content: "x",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe(40054);
  });

  test("a heading write missing its content carrier returns 400 (40081)", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Delta"],
      operation: "replace",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe(40081);
  });

  test("a frontmatter value write carrying content instead of value is rejected (40081)", async () => {
    const res = await patchV2({
      targetType: "frontmatter",
      target: "title",
      operation: "replace",
      content: "not-a-value",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe(40081);
  });

  test("an operation×scope outside the algebra returns 400 (40081)", async () => {
    const res = await patchV2({
      targetType: "block",
      target: "someblock",
      operation: "replace",
      scope: "parent",
      destination: { parent: null, place: "last" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe(40081);
  });

  test("a PATCH to a directory returns 405", async () => {
    const res = await patchV2(
      { targetType: "heading", target: ["Delta"], operation: "append", content: "x" },
      `${TEST_DIR}/`,
    );
    expect(res.status).toBe(405);
  });

  test("the 2.0 response has no Deprecation header", async () => {
    const res = await patchV2({
      targetType: "heading",
      target: ["Delta"],
      operation: "append",
      content: "x",
    });
    expect(res.headers.get("Deprecation")).toBeNull();
  });

  test("a header-driven (1.x) request still works and is marked deprecated", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "append",
        "Target-Type": "heading",
        Target: "Delta",
      },
      body: "legacy-still-works\n",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBe('true; sunset-version="6.0"');
  });

  test("a 1.x-style request without the opt-in header hits the 2.0 engine (400)", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "text/markdown",
        Operation: "append",
        "Target-Type": "heading",
        Target: "Delta",
      },
      body: "legacy-without-optin\n",
    });
    // No version header -> 2.0 default -> a text body is not an instruction.
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe(40081);
  });

  test("an invalid Markdown-Patch-Version returns 400 (40082)", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Markdown-Patch-Version": "9" },
      body: JSON.stringify({ targetType: "heading", target: ["Delta"], operation: "append", content: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe(40082);
  });
});
