import {
  DefaultSignedUrlTtlSeconds,
  MaximumSignedUrlTtlSeconds,
  MinimumSignedUrlTtlSeconds,
  UrlSigner,
  buildSignedUrl,
  clampSignedUrlTtl,
  normalizeVaultFilePath,
} from "./signedUrls";

describe("signedUrls", () => {
  describe("normalizeVaultFilePath", () => {
    test.each([
      ["a/b.png", "a/b.png"],
      ["/a/b.png", "a/b.png"],
      ["a//b.png", "a/b.png"],
      ["a\\b.png", "a/b.png"],
      ["a/./b.png", "a/b.png"],
      ["a/../b.png", "b.png"],
      ["./b.png", "b.png"],
    ])("%s normalizes to %s", (input, expected) => {
      expect(normalizeVaultFilePath(input)).toBe(expected);
    });

    test.each([
      ["escapes the root", "../secret.txt"],
      ["escapes the root after descending", "a/../../secret.txt"],
      ["is empty", ""],
      ["is the root", "/"],
      ["names a directory", "a/"],
    ])("rejects a path that %s", (_label, input) => {
      expect(normalizeVaultFilePath(input)).toBeNull();
    });
  });

  describe("clampSignedUrlTtl", () => {
    test("uses the default for an absent or unusable value", () => {
      expect(clampSignedUrlTtl(undefined)).toBe(DefaultSignedUrlTtlSeconds);
      expect(clampSignedUrlTtl(Number.NaN)).toBe(DefaultSignedUrlTtlSeconds);
    });
    test("clamps into the supported range and floors fractions", () => {
      expect(clampSignedUrlTtl(1)).toBe(MinimumSignedUrlTtlSeconds);
      expect(clampSignedUrlTtl(10 ** 9)).toBe(MaximumSignedUrlTtlSeconds);
      expect(clampSignedUrlTtl(42.9)).toBe(42);
    });
  });

  describe("UrlSigner", () => {
    let clock: number;
    let signer: UrlSigner;

    beforeEach(() => {
      clock = 1_700_000_000_000;
      signer = new UrlSigner(Buffer.from("test-secret"), () => clock);
    });

    test("a signature verifies for the method, path, and expiry it was issued for", () => {
      const { sig, exp } = signer.sign("GET", "attachments/pixel.png", 300);
      expect(exp).toBe(1_700_000_000 + 300);
      expect(signer.verify("GET", "attachments/pixel.png", String(exp), sig)).toBe("ok");
    });

    test("the path is normalized on both sides, so different spellings of one file share a signature", () => {
      const { sig, exp } = signer.sign("GET", "notes/../attachments/pixel.png", 300);
      expect(signer.verify("GET", "attachments/pixel.png", String(exp), sig)).toBe("ok");
      expect(signer.verify("GET", "/attachments//pixel.png", String(exp), sig)).toBe("ok");
    });

    test("a signature for one file does not verify for another", () => {
      const { sig, exp } = signer.sign("GET", "a.png", 300);
      expect(signer.verify("GET", "b.png", String(exp), sig)).toBe("invalid");
    });

    test("a GET signature does not authorize a PUT, and nothing authorizes another method", () => {
      const { sig, exp } = signer.sign("GET", "a.png", 300);
      expect(signer.verify("PUT", "a.png", String(exp), sig)).toBe("invalid");
      expect(signer.verify("DELETE", "a.png", String(exp), sig)).toBe("invalid");
    });

    test("changing the expiry invalidates the signature rather than extending it", () => {
      const { sig, exp } = signer.sign("GET", "a.png", 300);
      expect(signer.verify("GET", "a.png", String(exp + 1), sig)).toBe("invalid");
    });

    test("a valid signature past its expiry is reported as expired", () => {
      const { sig, exp } = signer.sign("GET", "a.png", 300);
      clock += 301_000;
      expect(signer.verify("GET", "a.png", String(exp), sig)).toBe("expired");
    });

    test("a forged signature is invalid whatever expiry it carries", () => {
      expect(signer.verify("GET", "a.png", "1", "00")).toBe("invalid");
      expect(signer.verify("GET", "a.png", "not-a-number", "0".repeat(64))).toBe("invalid");
      expect(signer.verify("GET", "a.png", "1700000300", "zz".repeat(32))).toBe("invalid");
    });

    test("two signers do not accept each other's signatures", () => {
      const other = new UrlSigner(Buffer.from("other-secret"), () => clock);
      const { sig, exp } = signer.sign("GET", "a.png", 300);
      expect(other.verify("GET", "a.png", String(exp), sig)).toBe("invalid");
    });

    test("a PUT signature is single-use once consumed; a GET signature is not", () => {
      const put = signer.sign("PUT", "a.png", 300);
      expect(signer.verify("PUT", "a.png", String(put.exp), put.sig)).toBe("ok");
      signer.consume("PUT", String(put.exp), put.sig);
      expect(signer.verify("PUT", "a.png", String(put.exp), put.sig)).toBe("consumed");

      const get = signer.sign("GET", "a.png", 300);
      signer.consume("GET", String(get.exp), get.sig);
      expect(signer.verify("GET", "a.png", String(get.exp), get.sig)).toBe("ok");
    });

    test("consumed PUT signatures are forgotten once they expire", () => {
      const put = signer.sign("PUT", "a.png", 300);
      signer.consume("PUT", String(put.exp), put.sig);
      clock += 301_000;
      // Expired wins over consumed, and the entry has been pruned either way.
      expect(signer.verify("PUT", "a.png", String(put.exp), put.sig)).toBe("expired");
      // @ts-ignore: reaching into the private set to prove the prune happened.
      expect(signer.consumedPutSignatures.size).toBe(0);
    });

    test("the TTL is clamped when signing", () => {
      expect(signer.sign("GET", "a.png", 1).exp).toBe(1_700_000_000 + MinimumSignedUrlTtlSeconds);
      expect(signer.sign("GET", "a.png", 10 ** 9).exp).toBe(1_700_000_000 + MaximumSignedUrlTtlSeconds);
    });

    test("refuses to sign a path that cannot name a vault file", () => {
      expect(() => signer.sign("GET", "../etc/passwd", 300)).toThrow(/does not name a file/);
      expect(() => signer.sign("PUT", "folder/", 300)).toThrow(/does not name a file/);
    });
  });

  describe("buildSignedUrl", () => {
    test("encodes each path segment and appends the signature parameters", () => {
      const url = buildSignedUrl(
        "https://127.0.0.1:27124/",
        "notes/a b/c#d.png",
        { sig: "abc", exp: 123 },
      );
      expect(url).toBe("https://127.0.0.1:27124/vault/notes/a%20b/c%23d.png?sig=abc&exp=123");
    });

    test("carries extra query parameters ahead of the signature", () => {
      const url = buildSignedUrl("http://h", "a.png", { sig: "s", exp: 1 }, { download: "1" });
      expect(url).toBe("http://h/vault/a.png?download=1&sig=s&exp=1");
    });
  });
});
