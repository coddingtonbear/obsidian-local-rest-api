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
  TAG_FIXTURE,
  TAG_TEST,
  TAG_INLINE,
} from "./fixtures";

beforeAll(async () => {
  await ensureServerReachable();
  await resetFixture(FIXTURE_DOCUMENT, TEST_PATH);
});

afterAll(async () => {
  await deleteFixture(TEST_PATH);
});

describe("GET /tags/", () => {
  test("returns 200 with tags array", async () => {
    const res = await authedFetch("/tags/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tags)).toBe(true);
  });

  test("contains frontmatter tag integration-fixture with count ≥ 1", async () => {
    const res = await authedFetch("/tags/");
    const body = await res.json();
    const tag = body.tags.find((t: { name: string }) => t.name === TAG_FIXTURE);
    expect(tag).toBeDefined();
    expect(tag.count).toBeGreaterThanOrEqual(1);
  });

  test("contains frontmatter tag test-tag with count ≥ 1", async () => {
    const res = await authedFetch("/tags/");
    const body = await res.json();
    const tag = body.tags.find((t: { name: string }) => t.name === TAG_TEST);
    expect(tag).toBeDefined();
    expect(tag.count).toBeGreaterThanOrEqual(1);
  });

  test("contains inline tag inline-tag with count ≥ 1", async () => {
    const res = await authedFetch("/tags/");
    const body = await res.json();
    const tag = body.tags.find((t: { name: string }) => t.name === TAG_INLINE);
    expect(tag).toBeDefined();
    expect(tag.count).toBeGreaterThanOrEqual(1);
  });

  test("each tag entry has name (string) and count (number)", async () => {
    const res = await authedFetch("/tags/");
    const body = await res.json();
    expect(body.tags.length).toBeGreaterThan(0);
    for (const tag of body.tags) {
      expect(typeof tag.name).toBe("string");
      expect(typeof tag.count).toBe("number");
    }
  });

  test("returns 401 without auth", async () => {
    const res = await unauthFetch("/tags/");
    expect(res.status).toBe(401);
  });
});
