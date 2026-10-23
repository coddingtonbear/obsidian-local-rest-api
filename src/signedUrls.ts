import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { vaultPathIsContained } from "./vaultPath";
import { posix } from "path";
import type { Request } from "express";

/**
 * Signed URLs: a way to hand a file's bytes to something that is not the MCP client
 * itself — a browser, a `curl` in the agent's shell, an `<img>` tag — without also
 * handing it the API key.
 *
 * A signed URL is `GET` or `PUT /vault/<path>?sig=<hmac>&exp=<unix seconds>&n=<nonce>`.
 * The signature is an HMAC-SHA256 over `METHOD\n<normalized vault path>\n<exp>\n<nonce>`
 * under a secret that is generated when the plugin loads and never written anywhere, so
 * every link dies when Obsidian restarts and nothing persisted can leak one. All three
 * query parameters are required: `n` is part of the signed material, so a URL missing it
 * cannot verify. See `sign` for why the nonce exists. The host is
 * deliberately not part of the signed material: the same link must work whether the
 * client reaches the server as `127.0.0.1`, `localhost`, or a hostname on the
 * certificate.
 *
 * The path is signed *after* the same normalization the REST `/vault/` handler applies
 * when it resolves a request, and verified against the request's normalized path, so a
 * link signed for one spelling of a path cannot be redeemed for a file it does not name.
 *
 * `PUT` links are single-use: the first request that finishes with a 2xx consumes the
 * signature, and a replay is refused. `GET` links stay valid until they expire, because
 * the things that follow them — browsers, image tags — retry.
 */

export const DefaultSignedUrlTtlSeconds = 300;
export const MinimumSignedUrlTtlSeconds = 10;
export const MaximumSignedUrlTtlSeconds = 86400;

/** The two methods a signature may authorize. Nothing else is signable. */
export type SignableMethod = "GET" | "PUT";

export function isSignableMethod(method: string): method is SignableMethod {
  return method === "GET" || method === "PUT";
}

/** Clamp a configured TTL into the supported range; anything unusable becomes the default. */
export function clampSignedUrlTtl(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return DefaultSignedUrlTtlSeconds;
  }
  return Math.min(
    MaximumSignedUrlTtlSeconds,
    Math.max(MinimumSignedUrlTtlSeconds, Math.floor(seconds)),
  );
}

/**
 * The one canonical spelling of a vault path, shared by signing and verification.
 *
 * Backslashes become slashes, runs of slashes collapse, `.` and `..` segments are
 * resolved, and the leading/trailing slashes go. Returns null for a path that escapes
 * the vault root, is empty, or names a directory (ends in `/`): none of those can be a
 * file that a signature should authorize.
 *
 * Containment is {@link vaultPathIsContained}, the same rule the REST routes, the MCP
 * tools and VaultOperations all refuse on, so there is one definition of what "escapes
 * the vault" means. The conditions this function adds are the ones about being a
 * *signable file* rather than about containment: a directory and the vault root itself
 * are both inside the vault, and neither is a file a signature can authorize.
 *
 * Leading slashes are the one place the two deliberately differ. Here they are stripped
 * rather than refused, because this is a canonical *spelling*: a signature minted for
 * "a/b.png" has to verify a request for "/a//b.png", which is a sloppy spelling of the
 * same file and not an escape from anywhere. Elsewhere a leading slash is refused,
 * because nothing else needs to tolerate it. Stripping happens first, so the containment
 * check still sees a relative path.
 */
export function normalizeVaultFilePath(path: string): string | null {
  const slashed = path.replace(/\\/g, "/");
  if (slashed.endsWith("/")) return null;
  const relative = slashed.replace(/^\/+/, "");
  if (!vaultPathIsContained(relative)) return null;
  const syntheticRoot = "/vault";
  const normalized = posix
    .resolve(syntheticRoot, relative)
    .slice(syntheticRoot.length + 1);
  return normalized.length > 0 ? normalized : null;
}

export type SignatureVerdict = "ok" | "expired" | "invalid" | "consumed";

export interface SignedUrlParams {
  sig: string;
  exp: number;
  /** Random per-link salt. See `sign` for why the signature is not a pure function. */
  nonce: string;
}

export class UrlSigner {
  private readonly secret: Buffer;
  // Signatures of PUT links that have been redeemed, keyed by signature, with the
  // expiry they carry so the set can be pruned. Memory only, like the secret.
  private readonly consumedPutSignatures = new Map<string, number>();

  constructor(
    secret: Buffer = randomBytes(32),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.secret = secret;
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  /**
   * `resource` is a normalized vault path, or an {@link eventStreamResource}. The two
   * cannot collide: a normalized vault path never starts with `/`, and an event-stream
   * resource always does.
   */
  private digest(
    method: SignableMethod,
    resource: string,
    exp: number,
    nonce: string,
  ): string {
    return createHmac("sha256", this.secret)
      .update(`${method}\n${resource}\n${exp}\n${nonce}`)
      .digest("hex");
  }

  /**
   * Sign a request for a file. `path` is normalized here; a path that cannot name a
   * file throws, since a signature for it could never verify.
   */
  sign(method: SignableMethod, path: string, ttlSeconds: number): SignedUrlParams {
    const normalized = normalizeVaultFilePath(path);
    if (normalized === null) {
      throw new Error(`Cannot sign a URL for "${path}": it does not name a file inside the vault.`);
    }
    const exp = this.nowSeconds() + clampSignedUrlTtl(ttlSeconds);
    // The nonce is what stops two links for the same file being the same link. Without
    // it the signed material is (method, path, exp) and `exp` has one-second
    // granularity, so minting twice for a path inside the same second produced
    // byte-identical URLs -- and since a spent PUT link is remembered *by signature*,
    // re-minting straight after an upload handed back the link that had just been
    // consumed. Two grants the issuer believed were independent were one grant.
    //
    // This is not a secrecy fix: a deterministic HMAC leaks nothing, and forging one
    // still needs the secret. It buys uniqueness, so each mint is its own grant.
    const nonce = randomBytes(9).toString("base64url");
    return { sig: this.digest(method, normalized, exp, nonce), exp, nonce };
  }

  /**
   * Sign a GET of an event stream. The expiry is the subscription's own, passed in
   * rather than computed, so the link and the subscription it names expire together.
   */
  signEventStream(resource: string, exp: number): SignedUrlParams {
    if (!resource.startsWith("/events/")) {
      throw new Error(`Not an event-stream resource: ${resource}`);
    }
    const nonce = randomBytes(9).toString("base64url");
    return { sig: this.digest("GET", resource, exp, nonce), exp, nonce };
  }

  /** Check a signature against a GET of an event stream. */
  verifyEventStream(
    resource: string,
    exp: string,
    sig: string,
    nonce: string,
  ): SignatureVerdict {
    if (!resource.startsWith("/events/")) return "invalid";
    return this.verifyResource("GET", resource, exp, sig, nonce);
  }

  /**
   * Check a signature against a request. `path` is the request's vault path, which is
   * normalized here the same way `sign` normalized it. `exp` arrives as the raw query
   * string value.
   */
  verify(
    method: string,
    path: string,
    exp: string,
    sig: string,
    nonce: string,
  ): SignatureVerdict {
    if (!isSignableMethod(method)) return "invalid";
    const normalized = normalizeVaultFilePath(path);
    if (normalized === null) return "invalid";
    return this.verifyResource(method, normalized, exp, sig, nonce);
  }

  private verifyResource(
    method: SignableMethod,
    resource: string,
    exp: string,
    sig: string,
    nonce: string,
  ): SignatureVerdict {
    if (!/^\d{1,12}$/.test(exp)) return "invalid";
    // Bound and charset-checked before it reaches the HMAC, so a hostile query string
    // cannot feed unbounded input through the digest on every request.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return "invalid";
    const expSeconds = Number(exp);
    const expected = Buffer.from(this.digest(method, resource, expSeconds, nonce), "hex");
    if (!/^[0-9a-f]+$/i.test(sig) || sig.length !== expected.length * 2) return "invalid";
    if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return "invalid";
    // Only a genuine signature gets to learn whether it is late: an attacker probing
    // signatures sees "invalid" for every guess whatever `exp` they attach.
    if (method === "PUT") this.prune();
    if (expSeconds < this.nowSeconds()) return "expired";
    if (method === "PUT" && this.consumedPutSignatures.has(sig.toLowerCase())) {
      return "consumed";
    }
    return "ok";
  }

  /**
   * Take a PUT link's single use, returning false if someone already holds it.
   *
   * This is deliberately a *claim* made before the request is dispatched, not a record
   * written once it succeeds. Verification and consumption used to sit at opposite ends
   * of the request, so concurrent redemptions all verified against a link nobody had
   * taken yet and all went on to write: six simultaneous PUTs with one link produced
   * four successful writes. Nothing awaits between `verify` and this call, so on a
   * single-threaded runtime the check and the set cannot interleave.
   *
   * A no-op returning true for any other method -- only PUT links are single-use; a GET
   * link is reusable until it expires.
   */
  claim(method: string, exp: string, sig: string): boolean {
    if (method !== "PUT") return true;
    const key = sig.toLowerCase();
    if (this.consumedPutSignatures.has(key)) return false;
    this.consumedPutSignatures.set(key, Number(exp));
    return true;
  }

  /**
   * Give a claimed PUT link back, for a request that did not end up succeeding. Without
   * this a rejected or aborted attempt would spend the link, which is worse than the
   * race it replaces: one typo and a legitimate upload can never be retried.
   */
  release(method: string, sig: string): void {
    if (method !== "PUT") return;
    this.consumedPutSignatures.delete(sig.toLowerCase());
  }

  private prune(): void {
    const now = this.nowSeconds();
    for (const [sig, exp] of this.consumedPutSignatures) {
      if (exp < now) this.consumedPutSignatures.delete(sig);
    }
  }
}

/**
 * Scheme and host as the caller reached us, so a link handed back resolves from wherever
 * the caller is. The scheme is the listener's, unless a proxy in front says otherwise;
 * the host is the Host header as sent. A forged Host misleads only the caller who forged
 * it, so neither is validated further.
 */
export function requestBaseUrl(req: Request): string {
  const forwarded = req.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const socket = req.socket as { encrypted?: boolean } | undefined;
  const scheme =
    forwarded === "http" || forwarded === "https"
      ? forwarded
      : socket?.encrypted
        ? "https"
        : "http";
  const host = req.get("host");
  if (!host) {
    throw new Error("Cannot build a URL for this server: the request carried no Host header.");
  }
  return `${scheme}://${host}`;
}

/**
 * The signed material naming one event stream: its request path, without the trailing
 * slash. Emitter and event names come from a fixed allowlist and ids are base64url, so
 * none of the three needs encoding.
 */
export function eventStreamResource(emitter: string, event: string, id: string): string {
  return `/events/${emitter}/${event}/${id}`;
}

/** Build the URL for an event stream, signed when `params` is given. */
export function buildEventStreamUrl(
  baseUrl: string,
  resource: string,
  params: SignedUrlParams | null,
): string {
  const url = `${baseUrl.replace(/\/+$/, "")}${resource}/`;
  if (!params) return url;
  const query = new URLSearchParams({
    sig: params.sig,
    exp: String(params.exp),
    n: params.nonce,
  });
  return `${url}?${query.toString()}`;
}

/**
 * Build the URL a client should call. `baseUrl` is scheme and host only (no trailing
 * slash); the path is re-encoded segment by segment so the REST handler, which decodes
 * segments individually, recovers exactly the path that was signed.
 */
export function buildSignedUrl(
  baseUrl: string,
  normalizedPath: string,
  params: SignedUrlParams,
  extraQuery: Record<string, string> = {},
): string {
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  const query = new URLSearchParams({
    ...extraQuery,
    sig: params.sig,
    exp: String(params.exp),
    n: params.nonce,
  });
  return `${baseUrl.replace(/\/+$/, "")}/vault/${encodedPath}?${query.toString()}`;
}
