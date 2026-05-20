import type http from "http";
import type https from "https";

export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 60_000;
export const SERVER_HEADERS_TIMEOUT_MS = 65_000;

export function configureHttpServerTimeouts(server: http.Server | https.Server) {
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
}
