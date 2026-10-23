import type express from "express";
import type { TFile } from "obsidian";

import type { VaultSubresourceRequest } from "./publicApi";
import { vaultPathIsContained } from "./vaultPath";

/**
 * Target types the host addresses under a note itself, so an extension may not claim
 * them as sub-resource names. A new built-in target type belongs here too, or the first
 * extension to register its name would shadow it.
 */
export const RESERVED_VAULT_SUBRESOURCE_NAMES: readonly string[] = [
  "heading",
  "block",
  "frontmatter",
];

/** What the dispatcher needs from the host, kept narrow so it can be tested alone. */
export interface VaultSubresourceHost {
  resolvePathAndTarget(
    segments: string[],
  ): Promise<{ filePath: string; targetType?: string } | null>;
  /** The indexed vault file at `path`, or null when there is none. */
  getFile(path: string): TFile | null;
  getActiveFile(): TFile | null;
  /** True when the request was authenticated by a signed URL. */
  isSigned(req: express.Request): boolean;
}

/** A request the dispatcher has matched to a registered sub-resource. */
interface SubresourceMatch {
  router: express.Router;
  file: TFile;
  /** Decoded segments after the sub-resource name. */
  segments: string[];
  /** Whether the request path ended in a slash. */
  trailingSlash: boolean;
  /** The still-encoded path up to and including the sub-resource name. */
  basePath: string;
}

/**
 * Splits a still-encoded path remainder into decoded segments, one at a time, so a
 * `%2F` stays a literal `/` inside its own segment instead of re-forming a path
 * boundary. Returns null on malformed encoding.
 */
function decodeSegments(raw: string): { decoded: string[]; trailingSlash: boolean } | null {
  const rawSegments = raw.split("/");
  const trailingSlash = rawSegments.length > 1 && rawSegments[rawSegments.length - 1] === "";
  const kept = trailingSlash ? rawSegments.slice(0, -1) : rawSegments;
  try {
    return { decoded: kept.map((segment) => decodeURIComponent(segment)), trailingSlash };
  } catch {
    return null;
  }
}

/**
 * The sub-resource names extensions have registered, across every extension, and the
 * middleware that routes requests for them.
 *
 * A sub-resource lives under a note: `/vault/Notes/draft.md/comments/a1f3` is the
 * `comments` sub-resource of `Notes/draft.md`, addressed `/a1f3` within it. The
 * dispatcher runs ahead of the built-in `/vault/*` and `/active/*` handlers, and only
 * claims a request when the path resolves to an existing file followed by a registered
 * name. Anything else falls through untouched, so the built-in handlers keep their
 * current behavior, 404s included.
 */
export class VaultSubresourceRegistry {
  private routers = new Map<string, express.Router>();

  /** Claims `name` for `router`. Throws if the name is invalid, reserved, or taken. */
  register(name: string, router: express.Router): void {
    if (name === "" || name.includes("/")) {
      throw new Error(
        `Invalid vault sub-resource name "${name}": it must be a single, non-empty path segment.`,
      );
    }
    if (RESERVED_VAULT_SUBRESOURCE_NAMES.includes(name)) {
      throw new Error(
        `Cannot register a vault sub-resource named "${name}": this name is reserved by Obsidian Local REST API.`,
      );
    }
    if (this.routers.has(name)) {
      throw new Error(`A vault sub-resource named "${name}" is already registered.`);
    }
    this.routers.set(name, router);
  }

  /** Releases `name`, but only if it is still held by `router`. */
  unregister(name: string, router: express.Router): void {
    if (this.routers.get(name) === router) {
      this.routers.delete(name);
    }
  }

  /** The middleware to mount ahead of the built-in `/vault/*` and `/active/*` routes. */
  middleware(host: VaultSubresourceHost): express.RequestHandler {
    return (req, res, next) => {
      this.match(req, host)
        .then((match) => {
          if (!match) {
            next();
            return;
          }
          this.dispatch(req, res, next, match);
        })
        .catch(next);
    };
  }

  private async match(
    req: express.Request,
    host: VaultSubresourceHost,
  ): Promise<SubresourceMatch | null> {
    // Nothing registered is the common case; it costs one comparison.
    if (this.routers.size === 0) return null;
    // A signed URL authorizes a whole-file read or write of the path it names, and
    // nothing more, so it never reaches an extension's router.
    if (host.isSigned(req)) return null;

    if (req.path.startsWith("/vault/")) {
      return this.matchVault(req.path.slice("/vault/".length), host);
    }
    if (req.path.startsWith("/active/")) {
      return this.matchActive(req.path.slice("/active/".length), host);
    }
    return null;
  }

  private async matchVault(
    raw: string,
    host: VaultSubresourceHost,
  ): Promise<SubresourceMatch | null> {
    const split = decodeSegments(raw);
    if (!split) return null;
    const { decoded, trailingSlash } = split;
    // Only stat the vault when a registered name appears in the path at all.
    if (!decoded.some((segment) => this.routers.has(segment))) return null;
    if (!vaultPathIsContained(decoded.join("/"))) return null;

    const resolved = await host.resolvePathAndTarget(decoded);
    if (!resolved?.targetType) return null;
    const router = this.routers.get(resolved.targetType);
    if (!router) return null;
    const file = host.getFile(resolved.filePath);
    if (!file) return null;

    // resolvePathAndTarget only accepts file segments without a literal "/", so the
    // file path has exactly as many segments as the prefix it matched.
    const nameIndex = resolved.filePath.split("/").length;
    return {
      router,
      file,
      segments: decoded.slice(nameIndex + 1),
      trailingSlash,
      basePath: "/vault/" + raw.split("/").slice(0, nameIndex + 1).join("/"),
    };
  }

  private async matchActive(
    raw: string,
    host: VaultSubresourceHost,
  ): Promise<SubresourceMatch | null> {
    const split = decodeSegments(raw);
    if (!split) return null;
    const { decoded, trailingSlash } = split;
    const router = this.routers.get(decoded[0]);
    if (!router) return null;
    const file = host.getActiveFile();
    if (!file) return null;
    return {
      router,
      file,
      segments: decoded.slice(1),
      trailingSlash,
      basePath: "/active/" + raw.split("/")[0],
    };
  }

  /**
   * Hands the request to the extension's router with `req.url` rewritten to the part
   * after the sub-resource name. Each segment is re-encoded on its own, so a decoded
   * `%2F` goes back in as `%2F` rather than as a path boundary. If the router does not
   * answer, the URL is restored and the request continues to the built-in handlers.
   */
  private dispatch(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
    match: SubresourceMatch,
  ): void {
    const originalUrl = req.url;
    const originalBaseUrl = req.baseUrl;
    const queryIndex = originalUrl.indexOf("?");
    const query = queryIndex === -1 ? "" : originalUrl.slice(queryIndex);
    const encoded = match.segments.map((segment) => encodeURIComponent(segment)).join("/");
    const trailing = match.trailingSlash && match.segments.length > 0 ? "/" : "";

    req.url = "/" + encoded + trailing + query;
    req.baseUrl = originalBaseUrl + match.basePath;
    const subresourceRequest: VaultSubresourceRequest = Object.assign(req, {
      vaultFile: match.file,
      vaultSubresourceSegments: match.segments,
    });

    match.router(subresourceRequest, res, (err?: unknown) => {
      req.url = originalUrl;
      req.baseUrl = originalBaseUrl;
      // "router" and "route" only mean "leave this router"; passing them on would skip
      // the rest of the host's stack too.
      if (err === "router" || err === "route") {
        next();
        return;
      }
      next(err);
    });
  }
}
