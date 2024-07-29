import { App, PluginManifest } from "obsidian";
import LocalRestApiPublicApi from "./api";
import LocalRestApi from "./main";

export const getAPI = (
  app: App,
  manifest: PluginManifest
): LocalRestApiPublicApi | undefined => {
  const plugin = app.plugins.plugins["obsidian-local-rest-api"];
  if (plugin) {
    return (plugin as unknown as LocalRestApi).getPublicApi(manifest);
  }
};
