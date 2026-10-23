/**
 * Integration tests for the configuration-directory access guard
 * (GHSA-66m9-r757-qvq7).
 *
 * The /vault/{path} endpoints used to read and write anything under the vault
 * root, Obsidian's configuration directory (.obsidian) included. Writing a
 * plugin there and enabling it is arbitrary code execution; reading there leaks
 * secrets such as this plugin's own API key from data.json. These tests confirm
 * that both reads and writes of a config-dir path are now refused with 403 and
 * error code 40321, and that a sibling directory that merely shares the name
 * prefix is unaffected.
 *
 * They assume the running plugin has "Allow access to the configuration
 * directory" OFF, which is the default. Set OBSIDIAN_CONFIG_DIR_ACCESS=1 to skip
 * them when you have deliberately turned that setting on.
 *
 * One test needs the vault's location on disk, because it plants a symlink there
 * and checks the guard follows it: set OBSIDIAN_VAULT_PATH to the vault's absolute
 * path to enable it. The symlink lives under the integration fixture directory and
 * is removed afterwards.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from "fs";
import path from "path";

import { authedFetch, ensureServerReachable } from "./client";
import { TEST_DIR } from "./fixtures";

const STAMP = Date.now();
const CONFIG_PLUGIN_PATH = `/vault/.obsidian/plugins/olrapi-canary-${STAMP}/main.js`;
const CONFIG_READ_PATH = "/vault/.obsidian/community-plugins.json";
const SIBLING_PATH = `/vault/.obsidian-olrapi-canary-${STAMP}/note.md`;

const run = process.env.OBSIDIAN_CONFIG_DIR_ACCESS === "1" ? describe.skip : describe;

async function expectConfigRefusal(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errorCode?: number };
  expect(body.errorCode).toBe(40321);
}

beforeAll(async () => {
  await ensureServerReachable();
});

run("configuration-directory access is refused", () => {
  test("GET of a config-dir file is refused and leaks nothing", async () => {
    const res = await authedFetch(CONFIG_READ_PATH);
    await expectConfigRefusal(res);
  });

  test("PUT into the config dir is refused", async () => {
    const res = await authedFetch(CONFIG_PLUGIN_PATH, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "module.exports = class { onload() {} };",
    });
    await expectConfigRefusal(res);
  });

  test("POST into the config dir is refused", async () => {
    const res = await authedFetch(CONFIG_PLUGIN_PATH, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "appended",
    });
    await expectConfigRefusal(res);
  });

  test("DELETE of a config-dir file is refused", async () => {
    const res = await authedFetch(CONFIG_READ_PATH, { method: "DELETE" });
    await expectConfigRefusal(res);
  });

  test("the config dir itself is refused", async () => {
    const res = await authedFetch("/vault/.obsidian");
    await expectConfigRefusal(res);
  });

  // Spellings a case-insensitive filesystem (macOS APFS, Windows NTFS) or Win32's
  // trailing-dot stripping would resolve to the real config dir. Read-only, so
  // the live vault is never written to even if the guard were missing.
  test.each([
    "/vault/.OBSIDIAN/community-plugins.json",
    "/vault/.Obsidian/community-plugins.json",
    "/vault/.obsidian./community-plugins.json",
  ])("alternate spelling %s is refused", async (path) => {
    const res = await authedFetch(path);
    await expectConfigRefusal(res);
  });

  test("a sibling directory that merely shares the prefix is not refused", async () => {
    // Not a config path, so the guard does not fire. The file does not exist, so
    // the API answers 404 rather than 403 -- the point is only that it is not the
    // config-dir refusal.
    const res = await authedFetch(SIBLING_PATH);
    expect(res.status).not.toBe(403);
  });
});

// A spelling the guard can only catch by asking the disk where it lands. An NTFS
// 8.3 short name is the motivating case but needs Windows; a symlink exercises the
// same realpath walk on every platform. The link is planted in the vault from
// outside the API, which is why this needs the vault's path on disk.
const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
const runOnDisk =
  process.env.OBSIDIAN_CONFIG_DIR_ACCESS === "1" || !vaultPath ? describe.skip : describe;

runOnDisk("a symlink into the configuration directory is refused", () => {
  const linkName = `olrapi-cfglink-${STAMP}`;
  const linkPath = path.join(vaultPath ?? "", TEST_DIR, linkName);

  beforeAll(() => {
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(path.join("..", ".obsidian"), linkPath, "dir");
  });

  afterAll(() => {
    if (existsSync(linkPath)) rmSync(linkPath);
  });

  test("GET through the symlink is refused and leaks nothing", async () => {
    const res = await authedFetch(`/vault/${TEST_DIR}/${linkName}/community-plugins.json`);
    await expectConfigRefusal(res);
  });

  test("PUT through the symlink is refused", async () => {
    const res = await authedFetch(`/vault/${TEST_DIR}/${linkName}/plugins/olrapi-canary-${STAMP}/main.js`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "module.exports = class { onload() {} };",
    });
    await expectConfigRefusal(res);
  });
});
