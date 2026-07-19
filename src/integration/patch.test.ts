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
} from "./fixtures";

// These exercise the deprecated 1.x header-driven PATCH format, which is no
// longer the default: every request opts in with `Markdown-Patch-Version: 1`.
// The 2.0 (default) format is covered by patch2.test.ts.

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
// PATCH v3 — heading targets
// ---------------------------------------------------------------------------

describe("PATCH v3 — append to heading", () => {
  test("returns 200 with appended content and original preserved", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "append",
        "Target-Type": "heading",
        Target: "Delta",
      },
      body: "v3-heading-append\n",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_DELTA);
    expect(text).toContain("v3-heading-append");
  });
});

describe("PATCH v3 — prepend to heading", () => {
  test("returns 200 with prepended content before original", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "prepend",
        "Target-Type": "heading",
        Target: "Delta",
      },
      body: "v3-heading-prepend\n",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("v3-heading-prepend");
    expect(text.indexOf("v3-heading-prepend")).toBeLessThan(text.indexOf(TERM_DELTA));
  });
});

describe("PATCH v3 — replace heading", () => {
  test("returns 200 with new content; original heading content gone", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "replace",
        "Target-Type": "heading",
        Target: "Delta",
      },
      body: "v3-heading-replace\n",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("v3-heading-replace");
    expect(text).not.toContain(TERM_DELTA);
  });
});

// ---------------------------------------------------------------------------
// PATCH v3 — block targets
// ---------------------------------------------------------------------------

describe("PATCH v3 — block targets", () => {
  test("append to block preserves original and adds new content", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "append",
        "Target-Type": "block",
        Target: "beta-block",
      },
      body: "v3-block-append\n",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_BETA);
    expect(text).toContain("v3-block-append");
  });

  test("replace block removes original block content", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "replace",
        "Target-Type": "block",
        Target: "beta-block",
      },
      body: "v3-block-replace\n",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TERM_BETA);
  });
});

// ---------------------------------------------------------------------------
// PATCH v3 — frontmatter targets
// ---------------------------------------------------------------------------

describe("PATCH v3 — frontmatter targets", () => {
  test("replace title field updates the frontmatter", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "application/json",
        Operation: "replace",
        "Target-Type": "frontmatter",
        Target: "title",
      },
      body: JSON.stringify("New Title"),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("New Title");
  });

  test("append to string frontmatter field returns 200", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "application/json",
        Operation: "append",
        "Target-Type": "frontmatter",
        Target: "title",
      },
      body: JSON.stringify(" appended"),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH v3 — error cases
// ---------------------------------------------------------------------------

describe("PATCH v3 — error cases", () => {
  test("returns 400 with errorCode 40056 when Operation header missing", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        "Target-Type": "heading",
        Target: "Delta",
      },
      body: "data\n",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40056);
  });

  test("returns 400 with errorCode 40053 when Target-Type header missing", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "append",
        Target: "Delta",
      },
      body: "data\n",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40053);
  });

  test("returns 400 with errorCode 40057 for invalid Operation value", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "obliterate",
        "Target-Type": "heading",
        Target: "Delta",
      },
      body: "data\n",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40057);
  });

  test("returns 400 with errorCode 40054 for invalid Target-Type value", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "append",
        "Target-Type": "paragraph",
        Target: "something",
      },
      body: "data\n",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe(40054);
  });

  test("returns 405 with errorCode 40510 on PATCH to directory", async () => {
    const res = await authedFetch(`/vault/${TEST_DIR}/`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "append",
        "Target-Type": "heading",
        Target: "Delta",
      },
      body: "data\n",
    });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.errorCode).toBe(40510);
  });
});

// ---------------------------------------------------------------------------
// PATCH v3 — Create-Target-If-Missing
// ---------------------------------------------------------------------------

describe("PATCH v3 — Create-Target-If-Missing", () => {
  test("creates a new heading section when it does not exist", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "append",
        "Target-Type": "heading",
        Target: "BrandNewSection",
        "Create-Target-If-Missing": "true",
      },
      body: "created-content\n",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("BrandNewSection");
    expect(text).toContain("created-content");
  });

  test("returns error when target missing and Create-Target-If-Missing not set", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "1",
        "Content-Type": "text/markdown",
        Operation: "append",
        "Target-Type": "heading",
        Target: "BrandNewSection",
      },
      body: "created-content\n",
    });
    expect(res.status).not.toBe(200);
  });
});
