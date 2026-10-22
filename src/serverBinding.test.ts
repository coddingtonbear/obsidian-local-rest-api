import http from "http";
import net from "net";
import { closeServer, describeServerError, listenServer } from "./serverBinding";

const HOST = "127.0.0.1";

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** A port nothing is listening on, found by letting the OS pick one. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, HOST, resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

describe("describeServerError", () => {
  test("names the port and suggests another vault for EADDRINUSE", () => {
    const message = describeServerError(
      errno("EADDRINUSE", "listen EADDRINUSE: address already in use 127.0.0.1:27124"),
      "HTTPS",
      HOST,
      27124,
    );
    expect(message).toContain("HTTPS");
    expect(message).toContain("27124");
    expect(message).toContain("already in use");
    expect(message).toContain("another vault");
    expect(message).toContain("settings");
  });

  test("explains EACCES as a privileged port", () => {
    const message = describeServerError(
      errno("EACCES", "listen EACCES: permission denied 127.0.0.1:80"),
      "HTTP",
      HOST,
      80,
    );
    expect(message).toContain("80");
    expect(message).toContain("elevated privileges");
  });

  test("names the binding host for EADDRNOTAVAIL", () => {
    const message = describeServerError(
      errno("EADDRNOTAVAIL", "listen EADDRNOTAVAIL: address not available 10.9.9.9:27124"),
      "HTTPS",
      "10.9.9.9",
      27124,
    );
    expect(message).toContain("10.9.9.9");
    expect(message).toContain("binding host");
  });

  test("falls back to the underlying message for anything else", () => {
    const message = describeServerError(
      errno("EMFILE", "listen EMFILE: too many open files"),
      "HTTP",
      HOST,
      27123,
    );
    expect(message).toContain("27123");
    expect(message).toContain("too many open files");
  });
});

describe("listenServer", () => {
  test("reports a port that is already in use instead of throwing", async () => {
    const port = await freePort();
    const blocker = http.createServer();
    await listen(blocker, port);
    const second = http.createServer();

    try {
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
        listenServer(second, port, HOST, {
          onError: resolve,
          onListening: () => resolve(errno("UNEXPECTED", "second server bound")),
        });
      });
      expect(error.code).toBe("EADDRINUSE");
      expect(second.listening).toBe(false);
    } finally {
      await closeServer(blocker);
      await closeServer(second);
    }
  });

  test("calls onListening once the port is bound", async () => {
    const port = await freePort();
    const server = http.createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        listenServer(server, port, HOST, { onError: reject, onListening: resolve });
      });
      expect(server.listening).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});

describe("closeServer", () => {
  test("resolves for no server at all", async () => {
    await expect(closeServer(null)).resolves.toBeUndefined();
  });

  test("resolves for a server that never bound", async () => {
    await expect(closeServer(http.createServer())).resolves.toBeUndefined();
  });

  test("frees the port by the time it resolves, even with a keep-alive client attached", async () => {
    const port = await freePort();
    const server = http.createServer((_req, res) => res.end("ok"));
    await listen(server, port);

    // A client holding a keep-alive connection open would keep a plain close() waiting.
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      http
        .get({ host: HOST, port, agent }, (res) => {
          res.resume();
          res.on("end", resolve);
        })
        .on("error", reject);
    });

    const replacement = http.createServer();
    try {
      await closeServer(server);
      expect(server.listening).toBe(false);
      await listen(replacement, port);
      expect(replacement.listening).toBe(true);
    } finally {
      agent.destroy();
      await closeServer(replacement);
    }
  });
});
