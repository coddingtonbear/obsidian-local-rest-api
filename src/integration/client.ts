export const BASE_URL = (process.env.OBSIDIAN_HOST ?? "http://localhost:27123").replace(/\/$/, "");
export const API_KEY = process.env.OBSIDIAN_API_KEY ?? "";

if (!API_KEY) {
  throw new Error("OBSIDIAN_API_KEY env var is required to run integration tests.");
}

export function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${API_KEY}`);
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

export function unauthFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, init);
}

export async function ensureServerReachable(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status !== 401) throw new Error(`status ${res.status}`);
  } catch (e) {
    throw new Error(
      `Cannot reach Obsidian REST API at ${BASE_URL}. ` +
      `Start Obsidian with the Local REST API plugin's insecure server enabled. Error: ${e}`
    );
  }
}

// Poll GET / until Obsidian's startup indexing has finished, so that a note's
// links/backlinks/unresolvedLinks are arrays rather than null.
//
// Readiness is a one-way latch, so this only needs to run once per suite (a beforeAll),
// not after every fixture write.
export async function waitForLinkIndexReady(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await authedFetch("/");
    if (res.status === 200) {
      const body = (await res.json()) as { linkIndexReady?: boolean };
      if (body.linkIndexReady === true) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForLinkIndexReady: link resolution did not settle within ${timeoutMs}ms`);
}

// PUT the fixture doc to the vault, then poll until Obsidian's metadata cache reflects
// the content we just wrote.
//
// A 200 from the note+json endpoint is NOT sufficient on its own. Every suite reuses the
// same fixture path, so on all but the first reset the file already exists with the
// *previous* test's content, and Obsidian already holds a cache entry for it. The plugin's
// waitForFileCache returns any existing cache entry immediately rather than waiting for one
// current with the latest write, so a 200 can be served entirely from the pre-PUT snapshot.
// A test that then patched and read back could observe frontmatter from before the reset.
//
// Comparing the returned content against what we PUT closes that window: the cache can only
// echo this exact body once it has caught up with our write.
export async function resetFixture(content: string, path: string): Promise<void> {
  const putRes = await authedFetch(`/vault/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown" },
    body: content,
  });
  if (putRes.status !== 204) throw new Error(`resetFixture PUT /vault/${path} => ${putRes.status}`);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const check = await authedFetch(`/vault/${path}`, {
      headers: { Accept: "application/vnd.olrapi.note+json" },
    });
    if (check.status !== 200) continue;
    const body = (await check.json()) as { content?: string };
    if (body.content === content) return;
  }
  throw new Error(`resetFixture: Obsidian did not index ${path} within 5s`);
}

export async function deleteFixture(path: string): Promise<void> {
  await authedFetch(`/vault/${path}`, { method: "DELETE" });
}
