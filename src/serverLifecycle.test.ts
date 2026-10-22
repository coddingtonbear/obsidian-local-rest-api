import http from "http";
import net from "net";

// jest.mock calls are hoisted before imports by ts-jest's babel transform.
jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  Plugin: class {
    constructor(
      public app: unknown,
      public manifest: unknown,
    ) {}
  },
  PluginSettingTab: class {},
  Setting: class {},
  ExtraButtonComponent: class {},
  ConfirmationModal: class {},
  Notice: jest.fn(),
}));
// The servers only need something to hand requests to; the router is tested elsewhere.
jest.mock("./requestHandler", () => ({ __esModule: true, default: jest.fn() }));

import { App, Notice, PluginManifest } from "obsidian";
import LocalRestApi from "./main";
import { DEFAULT_SETTINGS } from "./constants";
import RequestHandler from "./requestHandler";

const HOST = "127.0.0.1";
const NoticeMock = Notice as unknown as jest.Mock;

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, HOST, resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: HOST, port, agent: false }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

/** One vault's copy of the plugin, serving plain HTTP on `insecurePort`. */
function createPlugin(insecurePort: number): LocalRestApi {
  const plugin = new LocalRestApi(new App(), new PluginManifest());
  plugin.settings = {
    ...DEFAULT_SETTINGS,
    bindingHost: HOST,
    enableSecureServer: false,
    enableInsecureServer: true,
    insecurePort,
  };
  plugin.requestHandler = {
    api: (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("ok"),
    dispose: () => undefined,
  } as unknown as RequestHandler;
  return plugin;
}

/** Runs a refresh directly (skipping the debounce) and waits for it to finish. */
async function refresh(plugin: LocalRestApi): Promise<void> {
  plugin._refreshServerState();
  await (plugin as unknown as { serverRefresh: Promise<void> }).serverRefresh;
}

describe("server lifecycle", () => {
  const plugins: LocalRestApi[] = [];

  function track(plugin: LocalRestApi): LocalRestApi {
    plugins.push(plugin);
    return plugin;
  }

  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    NoticeMock.mockClear();
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    consoleError.mockRestore();
    for (const plugin of plugins.splice(0)) {
      plugin.onunload();
    }
    // onunload does not wait for the ports to be released.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test("a second vault on the same port gets a notice instead of an uncaught exception", async () => {
    const port = await freePort();
    const first = track(createPlugin(port));
    await refresh(first);
    await waitFor(() => first.insecureServer?.listening === true, "the first server to bind");

    const second = track(createPlugin(port));
    await refresh(second);
    await waitFor(() => NoticeMock.mock.calls.length > 0, "a notice");

    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const message = NoticeMock.mock.calls[0][0] as string;
    expect(message).toContain(String(port));
    expect(message).toContain("already in use");
    expect(second.insecureServer).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(String(port)),
      expect.objectContaining({ code: "EADDRINUSE" }),
    );

    // The vault that got there first is unaffected.
    await expect(get(port)).resolves.toBe("ok");
  });

  test("moving the second vault to a free port brings its server up", async () => {
    const port = await freePort();
    const first = track(createPlugin(port));
    await refresh(first);
    await waitFor(() => first.insecureServer?.listening === true, "the first server to bind");

    const second = track(createPlugin(port));
    await refresh(second);
    await waitFor(() => NoticeMock.mock.calls.length > 0, "a notice");

    const otherPort = await freePort();
    second.settings.insecurePort = otherPort;
    await refresh(second);
    await waitFor(() => second.insecureServer?.listening === true, "the second server to bind");

    await expect(get(otherPort)).resolves.toBe("ok");
    expect(NoticeMock).toHaveBeenCalledTimes(1);
  });

  test("refreshing repeatedly rebinds the same port without a conflict", async () => {
    const port = await freePort();
    const plugin = track(createPlugin(port));

    plugin._refreshServerState();
    plugin._refreshServerState();
    await refresh(plugin);
    await waitFor(() => plugin.insecureServer?.listening === true, "the server to bind");

    await expect(get(port)).resolves.toBe("ok");
    expect(NoticeMock).not.toHaveBeenCalled();
  });

  test("unloading while a refresh is pending leaves nothing listening", async () => {
    const port = await freePort();
    const plugin = createPlugin(port);
    await refresh(plugin);
    await waitFor(() => plugin.insecureServer?.listening === true, "the server to bind");

    plugin._refreshServerState();
    plugin.onunload();
    await (plugin as unknown as { serverRefresh: Promise<void> }).serverRefresh;

    // If anything were still bound, this would fail with EADDRINUSE.
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, HOST, resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});
