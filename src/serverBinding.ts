import type http from "http";
import type https from "https";

type Server = http.Server | https.Server;

/**
 * A message naming what stopped a server from listening, worded for the person who
 * has to fix it. The usual cause is a second vault with this plugin enabled: ports are
 * a per-vault setting, but every vault starts out on the same defaults.
 */
export function describeServerError(
  error: NodeJS.ErrnoException,
  protocol: string,
  host: string,
  port: number,
): string {
  const prefix = `Local REST API: the ${protocol} server could not start`;
  switch (error.code) {
    case "EADDRINUSE":
      return `${prefix} because port ${port} is already in use, possibly by this plugin in another vault. Choose a different port in this plugin's settings.`;
    case "EACCES":
      return `${prefix} because port ${port} requires elevated privileges on this system. Choose a port above 1024 in this plugin's settings.`;
    case "EADDRNOTAVAIL":
      return `${prefix} because ${host} is not an address of this machine. Check the binding host in this plugin's settings.`;
    default:
      return `${prefix} on ${host}:${port}: ${error.message}`;
  }
}

/**
 * Starts `server` listening, reporting a failure to `onError` instead of letting it
 * escape as an uncaught exception. Node reports a failed bind only as an `error`
 * event, so the listener has to be in place before `listen()` is called.
 */
export function listenServer(
  server: Server,
  port: number,
  host: string,
  callbacks: {
    onError: (error: NodeJS.ErrnoException) => void;
    onListening?: () => void;
  },
): void {
  server.on("error", callbacks.onError);
  server.listen(port, host, callbacks.onListening);
}

/**
 * Stops `server` and resolves once it has let go of its port, so that a replacement
 * can bind the same port straight away. Open connections are dropped rather than
 * waited on, as they always have been here. Never rejects: a server that never bound
 * has nothing to release.
 */
export function closeServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
