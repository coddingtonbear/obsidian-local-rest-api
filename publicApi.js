"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiVersionUnsupportedError = exports.LOCAL_REST_API_PLUGIN_ID = void 0;
exports.getAPI = getAPI;
/** The plugin ID the host registers itself under in Obsidian's plugin registry. */
exports.LOCAL_REST_API_PLUGIN_ID = "obsidian-local-rest-api";
/**
 * Thrown by {@link getAPI} when the caller asks for an extension API version newer
 * than the installed plugin implements.
 */
class ApiVersionUnsupportedError extends Error {
    constructor(requestedVersion, availableVersion) {
        super(`Obsidian Local REST API does not support API version ${requestedVersion}. ` +
            `The installed plugin supports API version ${availableVersion}.`);
        this.requestedVersion = requestedVersion;
        this.availableVersion = availableVersion;
        this.name = "ApiVersionUnsupportedError";
    }
}
exports.ApiVersionUnsupportedError = ApiVersionUnsupportedError;
/**
 * Resolves the host plugin's extension API, or `undefined` when Obsidian Local REST
 * API is not installed or not yet loaded.
 *
 * Pass `version` to assert that the installed host implements at least that extension
 * API version; {@link ApiVersionUnsupportedError} is thrown when it does not.
 */
function getAPI(app, manifest, version) {
    const plugin = app.plugins?.plugins?.[exports.LOCAL_REST_API_PLUGIN_ID];
    if (!plugin)
        return undefined;
    const api = plugin.getPublicApi(manifest);
    if (version !== undefined) {
        // Hosts predating the apiVersion field implement version 1.
        const availableVersion = api.apiVersion ?? 1;
        if (availableVersion < version) {
            throw new ApiVersionUnsupportedError(version, availableVersion);
        }
    }
    return api;
}
