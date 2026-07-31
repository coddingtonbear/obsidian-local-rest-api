import { App, PluginManifest } from "../mocks/obsidian";
import {
  ApiVersionUnsupportedError,
  LOCAL_REST_API_PLUGIN_ID,
  LocalRestApiPublicApi,
  getAPI,
} from "./publicApi";

// ---------------------------------------------------------------------------
// getAPI is the entry point extension authors call, and it is the one piece of the
// public surface that has no compile-time guard tying it to the implementation — the
// interface is checked against ./api by `implements`, but this function pokes at
// Obsidian's undocumented plugin registry through a structural cast. These tests pin
// down the behavior that cast is standing in for.
// ---------------------------------------------------------------------------

function stubApi(apiVersion: number | undefined): LocalRestApiPublicApi {
  return { apiVersion } as unknown as LocalRestApiPublicApi;
}

function appHosting(
  plugin: unknown,
): { app: App; manifest: PluginManifest } {
  const app = new App();
  if (plugin !== undefined) {
    // The mock types this registry as holding plugin manifests; getAPI only cares that
    // whatever sits here answers getPublicApi.
    (app.plugins.plugins as Record<string, unknown>)[LOCAL_REST_API_PLUGIN_ID] =
      plugin;
  }
  const manifest = new PluginManifest();
  manifest.id = "some-extension";
  manifest.name = "Some Extension";
  manifest.version = "1.0.0";
  return { app, manifest };
}

describe("getAPI", () => {
  test("returns undefined when the host plugin is not present", () => {
    const { app, manifest } = appHosting(undefined);
    expect(getAPI(app, manifest)).toBeUndefined();
  });

  test("returns the host's public API, passing along the caller's manifest", () => {
    const api = stubApi(2);
    const getPublicApi = jest.fn().mockReturnValue(api);
    const { app, manifest } = appHosting({ getPublicApi });

    expect(getAPI(app, manifest)).toBe(api);
    expect(getPublicApi).toHaveBeenCalledWith(manifest);
  });

  test("accepts a version the host supports", () => {
    const api = stubApi(2);
    const { app, manifest } = appHosting({ getPublicApi: () => api });
    expect(getAPI(app, manifest, 2)).toBe(api);
  });

  test("throws ApiVersionUnsupportedError when the host is too old", () => {
    const { app, manifest } = appHosting({ getPublicApi: () => stubApi(2) });

    expect(() => getAPI(app, manifest, 3)).toThrow(ApiVersionUnsupportedError);
    try {
      getAPI(app, manifest, 3);
    } catch (e) {
      const err = e as ApiVersionUnsupportedError;
      expect(err.requestedVersion).toBe(3);
      expect(err.availableVersion).toBe(2);
      expect(err.message).toContain("does not support API version 3");
    }
  });

  test("treats a host with no apiVersion as implementing version 1", () => {
    // Hosts released before the field existed only implement version 1, so asking for
    // 2 must fail rather than silently handing back a handle missing addMcpTool.
    const { app, manifest } = appHosting({
      getPublicApi: () => stubApi(undefined),
    });

    expect(() => getAPI(app, manifest, 2)).toThrow(ApiVersionUnsupportedError);
    expect(getAPI(app, manifest, 1)).toBeDefined();
  });

  test("does not check the version when the caller does not ask for one", () => {
    const api = stubApi(undefined);
    const { app, manifest } = appHosting({ getPublicApi: () => api });
    expect(getAPI(app, manifest)).toBe(api);
  });
});
