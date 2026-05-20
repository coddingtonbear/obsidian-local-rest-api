import http from "http";
import {
  configureHttpServerTimeouts,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
} from "./serverTimeouts";

describe("HTTP server timeout configuration", () => {
  test("sets keep-alive lower than headers timeout", () => {
    const server = http.createServer((_req, res) => {
      res.end("ok");
    });

    try {
      configureHttpServerTimeouts(server);

      expect(server.keepAliveTimeout).toBe(SERVER_KEEP_ALIVE_TIMEOUT_MS);
      expect(server.headersTimeout).toBe(SERVER_HEADERS_TIMEOUT_MS);
      expect(server.keepAliveTimeout).toBeLessThan(server.headersTimeout);
    } finally {
      server.close();
    }
  });
});
