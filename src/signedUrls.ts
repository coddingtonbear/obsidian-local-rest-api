import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { posix } from "path";

/**
 * Signed URLs: a way to hand a file's bytes to something that is not the MCP client
 * itself — a browser, a `curl` in the agent's shell, an `<img>` tag — without also
 * handing it the API key.
 *
 * A signed URL is `GET` or `PUT /vault/<path>?sig=<hmac>&exp=<unix seconds>`. The
 * signature is an HMAC-SHA256 over `METHOD\n<normalized vault path>\n<exp>` under a
 * secret that is generated when the plugin loads and never written anywhere, so every
 * link dies when Obsidian restarts and nothing persisted can leak one. The host is
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
 */
export function normalizeVaultFilePath(path: string): string | null {
  const slashed = path.replace(/\\/g, "/");
  if (slashed.endsWith("/")) return null;
  const syntheticRoot = "/vault";
  const resolved = posix.resolve(syntheticRoot, slashed.replace(/^\/+/, ""));
  if (!resolved.startsWith(syntheticRoot + "/")) return null;
  const normalized = resolved.slice(syntheticRoot.length + 1);
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

  private digest(
    method: SignableMethod,
    normalizedPath: string,
    exp: number,
    nonce: string,
  ): string {
    return createHmac("sha256", this.secret)
      .update(`${method}\n${normalizedPath}\n${exp}\n${nonce}`)
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
    if (!/^\d{1,12}$/.test(exp)) return "invalid";
    // Bound and charset-checked before it reaches the HMAC, so a hostile query string
    // cannot feed unbounded input through the digest on every request.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return "invalid";
    const expSeconds = Number(exp);
    const expected = Buffer.from(this.digest(method, normalized, expSeconds, nonce), "hex");
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
