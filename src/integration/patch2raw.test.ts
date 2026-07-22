import {
  authedFetch,
  ensureServerReachable,
  resetFixture,
  deleteFixture,
} from "./client";
import {
  TEST_PATH,
  FIXTURE_DOCUMENT,
  TERM_DELTA,
  TERM_SUB,
  HEADING_ALPHA,
  HEADING_SUB,
  HEADING_DELTA,
  BLOCK_TABLE,
  FM_TITLE,
} from "./fixtures";

// Integration coverage for PATCH raw-content mode: the instruction's fields
// ride in URL path elements (or Target-Type/Target headers with an explicit
// Markdown-Patch-Version: 2) and the body is the raw payload — text/* is the
// `content` carrier, application/json the `value` carrier, and an empty body
// carries nothing. patch2.test.ts covers the JSON-instruction body mode.

beforeAll(async () => {
  await ensureServerReachable();
});

beforeEach(async () => {
  await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
});

afterAll(async () => {
  await deleteFixture(TEST_PATH);
});

async function fetchDocumentVersion(): Promise<string> {
  const res = await authedFetch(`/vault/${TEST_PATH}`, {
    headers: { Accept: "application/vnd.olrapi.document-map+json" },
  });
  expect(res.status).toBe(200);
  const map = (await res.json()) as { version: string };
  return map.version;
}

describe("PATCH raw-content mode — URL-segment targeting", () => {
  test("append under a heading with a raw text body", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_DELTA}`,
      {
        method: "PATCH",
        headers: { Operation: "append", "Content-Type": "text/markdown" },
        body: "raw-url-append\n",
      },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TERM_DELTA);
    expect(text).toContain("raw-url-append");
  });

  test("replace a nested heading's content", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_ALPHA}/${HEADING_SUB}`,
      {
        method: "PATCH",
        headers: { Operation: "replace", "Content-Type": "text/markdown" },
        body: "raw-url-replace\n",
      },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("raw-url-replace");
    expect(text).not.toContain(TERM_SUB);
  });

  test("delete with an empty body clears the section content", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_DELTA}`,
      { method: "PATCH", headers: { Operation: "delete" } },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(`# ${HEADING_DELTA}`);
    expect(text).not.toContain(TERM_DELTA);
  });

  test("a JSON body on a block target appends table rows", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}/block/${BLOCK_TABLE}`, {
      method: "PATCH",
      headers: { Operation: "append", "Content-Type": "application/json" },
      body: JSON.stringify([["Raw A", "Raw B"]]),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Raw A");
  });

  test("a JSON body on a frontmatter target replaces the value", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/frontmatter/${FM_TITLE}`,
      {
        method: "PATCH",
        headers: { Operation: "replace", "Content-Type": "application/json" },
        body: JSON.stringify("Raw Mode Title"),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("title: Raw Mode Title");
  });

  test("Target-Scope: marker renames the heading from a raw text body", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_DELTA}`,
      {
        method: "PATCH",
        headers: {
          Operation: "replace",
          "Target-Scope": "marker",
          "Content-Type": "text/markdown",
        },
        body: "DeltaRenamed",
      },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# DeltaRenamed");
    expect(text).toContain(TERM_DELTA);
  });

  test("a Destination header moves a heading with an empty body", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_ALPHA}/${HEADING_SUB}`,
      {
        method: "PATCH",
        headers: {
          Operation: "replace",
          "Target-Scope": "parent",
          Destination: encodeURIComponent(
            JSON.stringify({ parent: [HEADING_DELTA], place: "last" }),
          ),
        },
      },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.indexOf(HEADING_SUB)).toBeGreaterThan(
      text.indexOf(`# ${HEADING_DELTA}`),
    );
  });
});

describe("PATCH raw-content mode — header targeting", () => {
  test("a heading Target is percent-encoded JSON under an explicit version 2", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Markdown-Patch-Version": "2",
        "Target-Type": "heading",
        Target: encodeURIComponent(JSON.stringify([HEADING_DELTA])),
        Operation: "append",
        "Content-Type": "text/markdown",
      },
      body: "raw-header-append\n",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("raw-header-append");
  });

  test("header targeting without an explicit version returns 400 (40084)", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Target-Type": "heading",
        Target: encodeURIComponent(JSON.stringify([HEADING_DELTA])),
        Operation: "append",
        "Content-Type": "text/markdown",
      },
      body: "x",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCode: number };
    expect(body.errorCode).toBe(40084);
  });
});

describe("PATCH raw-content mode — If-Match", () => {
  test("a matching version token from the document map succeeds", async () => {
    const version = await fetchDocumentVersion();
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_DELTA}`,
      {
        method: "PATCH",
        headers: {
          Operation: "append",
          "If-Match": version,
          "Content-Type": "text/markdown",
        },
        body: "if-match-append\n",
      },
    );
    expect(res.status).toBe(200);
  });

  test("a stale version token fails with 412 and leaves the file untouched", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_DELTA}`,
      {
        method: "PATCH",
        headers: {
          Operation: "append",
          "If-Match": "000000",
          "Content-Type": "text/markdown",
        },
        body: "must-not-land\n",
      },
    );
    expect(res.status).toBe(412);
    const readBack = await authedFetch(`/vault/${TEST_PATH}`);
    expect(await readBack.text()).not.toContain("must-not-land");
  });
});

describe("PATCH raw-content mode — conflicts and edge cases", () => {
  test("URL target + Target-Type header returns 422", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_DELTA}`,
      {
        method: "PATCH",
        headers: {
          "Target-Type": "heading",
          Operation: "append",
          "Content-Type": "text/markdown",
        },
        body: "x",
      },
    );
    expect(res.status).toBe(422);
  });

  test("the instruction content type + URL target returns 422", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_DELTA}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/vnd.olrapi.patch-instruction+json",
        },
        body: JSON.stringify({
          targetType: "heading",
          target: [HEADING_DELTA],
          operation: "append",
          content: "x",
        }),
      },
    );
    expect(res.status).toBe(422);
  });

  test("the instruction content type alone is instruction mode", async () => {
    const res = await authedFetch(`/vault/${TEST_PATH}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/vnd.olrapi.patch-instruction+json",
      },
      body: JSON.stringify({
        targetType: "heading",
        target: [HEADING_DELTA],
        operation: "append",
        content: "explicit-instruction-append\n",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("explicit-instruction-append");
  });

  test("an empty body on a replace is a missing carrier (40081)", async () => {
    const res = await authedFetch(
      `/vault/${TEST_PATH}/heading/${HEADING_DELTA}`,
      {
        method: "PATCH",
        headers: { Operation: "replace", "Content-Type": "text/markdown" },
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCode: number };
    expect(body.errorCode).toBe(40081);
  });
});
