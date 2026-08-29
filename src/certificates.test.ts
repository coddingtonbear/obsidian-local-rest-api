import * as https from "https";
import * as tls from "tls";
import { AddressInfo } from "net";

import forge from "node-forge";

import {
  CA_VALIDITY_DAYS,
  LEAF_RENEWAL_WINDOW_DAYS,
  LEAF_VALIDITY_DAYS,
  buildServerCertificateChain,
  generateCryptoSettings,
  getCertificateStandardsIssue,
  readPermittedNames,
  renewServerCertificateIfNeeded,
} from "./certificates";
import { CryptoSettings } from "./types";

// 2048-bit RSA generation takes seconds per key under jest; the certificate
// shape under test does not depend on the key size.
const TEST_KEY_SIZE = 1024;

interface KeyUsage {
  digitalSignature?: boolean;
  keyEncipherment?: boolean;
  keyCertSign?: boolean;
  cRLSign?: boolean;
}
interface BasicConstraints {
  cA?: boolean;
}
interface ExtKeyUsage {
  serverAuth?: boolean;
  clientAuth?: boolean;
  codeSigning?: boolean;
}
interface SubjectAltName {
  altNames?: { type: number; value?: string; ip?: string }[];
}

function parse(pem: string): forge.pki.Certificate {
  return forge.pki.certificateFromPem(pem);
}

function extension<T>(cert: forge.pki.Certificate, name: string): T | undefined {
  return cert.getExtension(name) as T | undefined;
}

// node-forge parses an IP SAN with both the raw `value` bytes and the dotted
// `ip`; the tests only care about the latter.
function altNamesOf(cert: forge.pki.Certificate): { type: number; ip?: string; value?: string }[] {
  return (extension<SubjectAltName>(cert, "subjectAltName")?.altNames ?? []).map((altName) =>
    altName.type === 7 ? { type: altName.type, ip: altName.ip } : { type: altName.type, value: altName.value },
  );
}

// node-forge does not decode authorityKeyIdentifier when parsing, so read the
// keyIdentifier ([0] IMPLICIT OCTET STRING) out of the extension's DER value.
function authorityKeyIdentifierOf(cert: forge.pki.Certificate): string | undefined {
  const ext = cert.getExtension("authorityKeyIdentifier") as { value?: string } | undefined;
  if (!ext?.value) return undefined;
  const sequence = forge.asn1.fromDer(ext.value);
  const keyIdentifier = (sequence.value as forge.asn1.Asn1[]).find(
    (child) => child.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && Number(child.type) === 0,
  );
  return keyIdentifier ? forge.util.bytesToHex(keyIdentifier.value as string) : undefined;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 3600 * 24);
}

// The certificate the plugin generated before the CA/leaf split, so the
// migration nudge can be tested against the real legacy shape.
function generateLegacyCertificate(
  options: { ipv4SanFlaw?: boolean } = {},
): forge.pki.Certificate {
  const keypair = forge.pki.rsa.generateKeyPair(TEST_KEY_SIZE);
  const attrs = [{ name: "commonName", value: "Obsidian Local REST API" }];
  const certificate = forge.pki.createCertificate();
  certificate.setIssuer(attrs);
  certificate.setSubject(attrs);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: false,
      dataEncipherment: false,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        options.ipv4SanFlaw
          ? { type: 7, value: "\x00\x00\x00\x00" }
          : { type: 7, ip: "127.0.0.1" },
      ],
    },
  ]);
  certificate.serialNumber = "1";
  certificate.publicKey = keypair.publicKey;
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  certificate.sign(keypair.privateKey, forge.md.sha256.create());
  return certificate;
}

describe("generateCryptoSettings", () => {
  let now: Date;
  let crypto: CryptoSettings;
  let ca: forge.pki.Certificate;
  let leaf: forge.pki.Certificate;

  beforeAll(() => {
    now = new Date("2026-08-27T12:00:00Z");
    crypto = generateCryptoSettings({
      bindingHost: "192.168.1.10",
      subjectAltNames: "obsidian.local\n\n  vault.example.com  \n",
      now,
      keySize: TEST_KEY_SIZE,
    });
    ca = parse(crypto.caCert);
    leaf = parse(crypto.cert);
  });

  test("returns PEM material for both the CA and the leaf", () => {
    expect(crypto.cert).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(crypto.privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    expect(crypto.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(crypto.caCert).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(crypto.caPrivateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
  });

  test("the CA is a self-signed certificate authority", () => {
    expect(extension<BasicConstraints>(ca, "basicConstraints")?.cA).toBe(true);
    const keyUsage = extension<KeyUsage>(ca, "keyUsage");
    expect(keyUsage?.keyCertSign).toBe(true);
    expect(keyUsage?.cRLSign).toBe(true);
    expect(ca.isIssuer(ca)).toBe(true);
    expect(ca.verify(ca)).toBe(true);
    expect(ca.getExtension("subjectAltName")).toBeFalsy();
  });

  test("the leaf is an end-entity certificate, not a CA", () => {
    expect(extension<BasicConstraints>(leaf, "basicConstraints")?.cA).toBe(false);
    const keyUsage = extension<KeyUsage>(leaf, "keyUsage");
    expect(keyUsage?.digitalSignature).toBe(true);
    expect(keyUsage?.keyEncipherment).toBe(true);
    expect(keyUsage?.keyCertSign).toBeFalsy();
    const extKeyUsage = extension<ExtKeyUsage>(leaf, "extKeyUsage");
    expect(extKeyUsage?.serverAuth).toBe(true);
    expect(extKeyUsage?.codeSigning).toBeFalsy();
    expect(leaf.getExtension("nsCertType")).toBeFalsy();
  });

  test("the leaf is issued and signed by the CA and chains to it", () => {
    expect(ca.issued(leaf)).toBe(true);
    expect(ca.verify(leaf)).toBe(true);
    const store = forge.pki.createCaStore([ca]);
    expect(
      forge.pki.verifyCertificateChain(store, [leaf], {
        validityCheckDate: now,
      }),
    ).toBe(true);
  });

  test("the leaf's private key matches its public key", () => {
    const privateKey = forge.pki.privateKeyFromPem(crypto.privateKey);
    const publicKey = forge.pki.publicKeyFromPem(crypto.publicKey);
    expect(forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey(privateKey.n, privateKey.e))).toEqual(
      forge.pki.publicKeyToPem(publicKey),
    );
    expect(forge.pki.publicKeyToPem(leaf.publicKey)).toEqual(forge.pki.publicKeyToPem(publicKey));
  });

  test("the CA and leaf use different keypairs", () => {
    expect(forge.pki.publicKeyToPem(ca.publicKey)).not.toEqual(
      forge.pki.publicKeyToPem(leaf.publicKey),
    );
  });

  test("serial numbers are distinct, random, and positive", () => {
    expect(ca.serialNumber).not.toEqual(leaf.serialNumber);
    for (const serial of [ca.serialNumber, leaf.serialNumber]) {
      expect(serial).toMatch(/^[0-9a-f]{32}$/);
      // A DER INTEGER with its high bit set is negative; the first nibble
      // must therefore be < 8 for the serial to be positive.
      expect(parseInt(serial[0], 16)).toBeLessThan(8);
    }
  });

  test("validity periods start now and span the configured lifetimes", () => {
    expect(ca.validity.notBefore).toEqual(now);
    expect(leaf.validity.notBefore).toEqual(now);
    expect(daysBetween(now, ca.validity.notAfter)).toBeCloseTo(CA_VALIDITY_DAYS, 5);
    expect(daysBetween(now, leaf.validity.notAfter)).toBeCloseTo(LEAF_VALIDITY_DAYS, 5);
  });

  test("subject alternative names cover the loopback address, binding host, and configured hostnames", () => {
    expect(altNamesOf(leaf)).toEqual([
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip: "192.168.1.10" },
      { type: 2, value: "obsidian.local" },
      { type: 2, value: "vault.example.com" },
    ]);
  });

  test("the binding host is not repeated when it is the loopback address, and 0.0.0.0 is not a name", () => {
    for (const bindingHost of ["127.0.0.1", "0.0.0.0", undefined]) {
      const generated = generateCryptoSettings({ bindingHost, keySize: TEST_KEY_SIZE });
      expect(altNamesOf(parse(generated.cert))).toEqual([{ type: 7, ip: "127.0.0.1" }]);
    }
  });

  test("a binding host that is a hostname rather than an address becomes a DNS name", () => {
    const generated = generateCryptoSettings({ bindingHost: "localhost", keySize: TEST_KEY_SIZE });
    expect(altNamesOf(parse(generated.cert))).toEqual([
      { type: 7, ip: "127.0.0.1" },
      { type: 2, value: "localhost" },
    ]);
  });

  test("an IPv6 binding host is an IP name", () => {
    const generated = generateCryptoSettings({ bindingHost: "::1", keySize: TEST_KEY_SIZE });
    expect(altNamesOf(parse(generated.cert))).toEqual([
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip: "::1" },
    ]);
  });

  test("the leaf carries an authority key identifier matching the CA's subject key identifier", () => {
    const caSki = ca.getExtension("subjectKeyIdentifier") as { subjectKeyIdentifier?: string } | undefined;
    expect(caSki?.subjectKeyIdentifier).toBeTruthy();
    expect(authorityKeyIdentifierOf(leaf)).toEqual(caSki?.subjectKeyIdentifier);
  });
});

describe("getCertificateStandardsIssue", () => {
  test("a freshly generated leaf has no issue", () => {
    const crypto = generateCryptoSettings({ keySize: TEST_KEY_SIZE });
    expect(getCertificateStandardsIssue(parse(crypto.cert))).toBeNull();
  });

  test("a freshly generated CA, if it were served, has no issue either", () => {
    // The check is about what the plugin serves; the CA is never served as a
    // leaf, but must not be mistaken for a legacy certificate by callers that
    // inspect it for validity display.
    const crypto = generateCryptoSettings({ keySize: TEST_KEY_SIZE });
    expect(getCertificateStandardsIssue(parse(crypto.caCert), { role: "ca" })).toBeNull();
  });

  test("the legacy single self-signed certificate is reported as a CA used as a leaf", () => {
    expect(getCertificateStandardsIssue(generateLegacyCertificate())).toBe("ca-used-as-leaf");
  });

  test("the pre-2024 all-zero IPv4 SAN flaw still takes precedence", () => {
    expect(getCertificateStandardsIssue(generateLegacyCertificate({ ipv4SanFlaw: true }))).toBe(
      "legacy-ipv4-san",
    );
  });
});

describe("renewServerCertificateIfNeeded", () => {
  const issuedAt = new Date("2026-01-01T00:00:00Z");
  let crypto: CryptoSettings;

  beforeAll(() => {
    crypto = generateCryptoSettings({
      subjectAltNames: "obsidian.local",
      now: issuedAt,
      keySize: TEST_KEY_SIZE,
    });
  });

  test("does nothing while the leaf is comfortably valid", () => {
    const now = new Date(issuedAt.getTime() + 30 * 24 * 3600 * 1000);
    expect(renewServerCertificateIfNeeded(crypto, { now, keySize: TEST_KEY_SIZE })).toBeNull();
  });

  test("re-issues the leaf from the stored CA inside the renewal window", () => {
    const now = new Date(
      issuedAt.getTime() + (LEAF_VALIDITY_DAYS - LEAF_RENEWAL_WINDOW_DAYS + 1) * 24 * 3600 * 1000,
    );
    const renewed = renewServerCertificateIfNeeded(crypto, {
      now,
      keySize: TEST_KEY_SIZE,
      subjectAltNames: "obsidian.local",
    });
    expect(renewed).not.toBeNull();
    if (!renewed) return;

    expect(renewed.caCert).toEqual(crypto.caCert);
    expect(renewed.caPrivateKey).toEqual(crypto.caPrivateKey);
    expect(renewed.cert).not.toEqual(crypto.cert);
    expect(renewed.privateKey).not.toEqual(crypto.privateKey);

    const ca = parse(renewed.caCert);
    const leaf = parse(renewed.cert);
    expect(ca.verify(leaf)).toBe(true);
    expect(leaf.validity.notBefore).toEqual(now);
    expect(daysBetween(now, leaf.validity.notAfter)).toBeCloseTo(LEAF_VALIDITY_DAYS, 5);
    expect(altNamesOf(leaf)).toEqual([
      { type: 7, ip: "127.0.0.1" },
      { type: 2, value: "obsidian.local" },
    ]);
  });

  test("renews with a subset of the names the CA permits", () => {
    const now = new Date(issuedAt.getTime() + (LEAF_VALIDITY_DAYS + 10) * 24 * 3600 * 1000);
    const renewed = renewServerCertificateIfNeeded(crypto, { now, keySize: TEST_KEY_SIZE });
    expect(renewed).not.toBeNull();
    if (!renewed) return;
    expect(altNamesOf(parse(renewed.cert))).toEqual([{ type: 7, ip: "127.0.0.1" }]);
  });

  test("refuses to renew with names the CA's constraints do not permit", () => {
    // The user changed the hostnames since the CA was minted. A leaf naming
    // them would be signed by a CA that forbids them, so verifiers would
    // reject it; the user has to regenerate (which mints a new CA) instead.
    const now = new Date(issuedAt.getTime() + (LEAF_VALIDITY_DAYS + 10) * 24 * 3600 * 1000);
    for (const options of [
      { bindingHost: "10.0.0.5" },
      { subjectAltNames: "obsidian.local\nrenamed.local" },
      { bindingHost: "vault.lan" },
    ]) {
      expect(
        renewServerCertificateIfNeeded(crypto, { ...options, now, keySize: TEST_KEY_SIZE }),
      ).toBeNull();
    }
  });

  test("renews unconstrained CA material with whatever names are requested", () => {
    // CA material minted before name constraints were added carries none;
    // renewal must keep working for it rather than treating it as forbidding
    // everything.
    const unconstrained = generateCryptoSettings({ now: issuedAt, keySize: TEST_KEY_SIZE });
    const ca = parse(unconstrained.caCert);
    ca.setExtensions(ca.extensions.filter((ext: { name?: string }) => ext.name !== "nameConstraints"));
    ca.sign(forge.pki.privateKeyFromPem(unconstrained.caPrivateKey), forge.md.sha256.create());
    const material = { ...unconstrained, caCert: forge.pki.certificateToPem(ca) };
    expect(readPermittedNames(ca)).toBeNull();

    const now = new Date(issuedAt.getTime() + (LEAF_VALIDITY_DAYS + 10) * 24 * 3600 * 1000);
    const renewed = renewServerCertificateIfNeeded(material, {
      now,
      keySize: TEST_KEY_SIZE,
      subjectAltNames: "renamed.local",
    });
    expect(renewed).not.toBeNull();
    if (!renewed) return;
    expect(altNamesOf(parse(renewed.cert))).toEqual([
      { type: 7, ip: "127.0.0.1" },
      { type: 2, value: "renamed.local" },
    ]);
  });

  test("re-issues an already-expired leaf", () => {
    const now = new Date(issuedAt.getTime() + (LEAF_VALIDITY_DAYS + 10) * 24 * 3600 * 1000);
    expect(renewServerCertificateIfNeeded(crypto, { now, keySize: TEST_KEY_SIZE })).not.toBeNull();
  });

  test("leaves the legacy single-certificate layout alone", () => {
    const legacy: CryptoSettings = {
      cert: crypto.cert,
      privateKey: crypto.privateKey,
      publicKey: crypto.publicKey,
    };
    const now = new Date(issuedAt.getTime() + (LEAF_VALIDITY_DAYS + 10) * 24 * 3600 * 1000);
    expect(renewServerCertificateIfNeeded(legacy, { now, keySize: TEST_KEY_SIZE })).toBeNull();
  });

  test("does not renew when the CA itself has expired", () => {
    const now = new Date(issuedAt.getTime() + (CA_VALIDITY_DAYS + 1) * 24 * 3600 * 1000);
    expect(renewServerCertificateIfNeeded(crypto, { now, keySize: TEST_KEY_SIZE })).toBeNull();
  });

  test("does not renew when the stored CA key cannot be parsed", () => {
    const now = new Date(issuedAt.getTime() + (LEAF_VALIDITY_DAYS + 10) * 24 * 3600 * 1000);
    const broken: CryptoSettings = { ...crypto, caPrivateKey: "not a key" };
    expect(renewServerCertificateIfNeeded(broken, { now, keySize: TEST_KEY_SIZE })).toBeNull();
  });
});

// A leaf the CA signed for names it does not permit: what an attacker who
// stole the CA key from data.json would mint. Verifiers must reject it.
function signLeafWithCa(
  crypto: CryptoSettings,
  altNames: { type: number; ip?: string; value?: string }[],
): { cert: string; privateKey: string } {
  const ca = parse(crypto.caCert);
  const keypair = forge.pki.rsa.generateKeyPair(TEST_KEY_SIZE);
  const certificate = forge.pki.createCertificate();
  certificate.serialNumber = "02";
  certificate.publicKey = keypair.publicKey;
  certificate.setIssuer(ca.subject.attributes);
  certificate.setSubject([{ name: "commonName", value: "Obsidian Local REST API" }]);
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ]);
  certificate.sign(forge.pki.privateKeyFromPem(crypto.caPrivateKey), forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(certificate),
    privateKey: forge.pki.privateKeyToPem(keypair.privateKey),
  };
}

async function handshakeWith(
  served: { cert: string; privateKey: string; caCert?: string },
  trustedCa: string,
): Promise<boolean> {
  const server = https.createServer(
    { key: served.privateKey, cert: [served.cert, served.caCert ?? ""].join("\n") },
    (_req, res) => res.end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const socket = tls.connect(
        { host: "127.0.0.1", port, ca: trustedCa, rejectUnauthorized: true },
        () => {
          const authorized = socket.authorized;
          socket.end();
          resolve(authorized);
        },
      );
      socket.on("error", reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("CA name constraints", () => {
  // Trusting the CA at the OS or browser level trusts it for every hostname
  // unless the CA says otherwise. It says otherwise: a leaked CA key must not
  // be usable to impersonate anything but this plugin's own addresses.
  test("the CA is constrained to the loopback address, binding host, localhost, and configured hostnames", () => {
    const crypto = generateCryptoSettings({
      bindingHost: "192.168.1.10",
      subjectAltNames: "obsidian.local\n\nvault.example.com\n",
      keySize: TEST_KEY_SIZE,
    });
    const ca = parse(crypto.caCert);
    const ext = ca.getExtension("nameConstraints") as { critical?: boolean } | undefined;
    expect(ext?.critical).toBe(true);
    expect(readPermittedNames(ca)).toEqual([
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip: "192.168.1.10" },
      { type: 2, value: "localhost" },
      { type: 2, value: "obsidian.local" },
      { type: 2, value: "vault.example.com" },
    ]);
  });

  test("a hostname binding host is permitted once, and an IPv6 one is permitted as an address", () => {
    const local = generateCryptoSettings({ bindingHost: "localhost", keySize: TEST_KEY_SIZE });
    expect(readPermittedNames(parse(local.caCert))).toEqual([
      { type: 7, ip: "127.0.0.1" },
      { type: 2, value: "localhost" },
    ]);
    const v6 = generateCryptoSettings({ bindingHost: "::1", keySize: TEST_KEY_SIZE });
    expect(readPermittedNames(parse(v6.caCert))).toEqual([
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip: "::1" },
      { type: 2, value: "localhost" },
    ]);
  });

  test("a certificate without the extension is unconstrained", () => {
    expect(readPermittedNames(generateLegacyCertificate())).toBeNull();
  });

  test("the generated leaf satisfies its own CA's constraints in a real handshake", async () => {
    const crypto = generateCryptoSettings({
      subjectAltNames: "obsidian.local",
      keySize: TEST_KEY_SIZE,
    });
    await expect(handshakeWith(crypto, crypto.caCert)).resolves.toBe(true);
  });

  test("a client trusting the CA rejects a leaf the CA signed for a hostname outside its constraints", async () => {
    const crypto = generateCryptoSettings({ keySize: TEST_KEY_SIZE });
    const forged = signLeafWithCa(crypto, [
      { type: 7, ip: "127.0.0.1" },
      { type: 2, value: "bank.example.com" },
    ]);
    await expect(
      handshakeWith({ ...forged, caCert: crypto.caCert }, crypto.caCert),
    ).rejects.toThrow(/permitted subtree violation/i);
  });

  test("a client trusting the CA rejects a leaf the CA signed for an address outside its constraints", async () => {
    const crypto = generateCryptoSettings({ keySize: TEST_KEY_SIZE });
    const forged = signLeafWithCa(crypto, [{ type: 7, ip: "127.0.0.1" }, { type: 7, ip: "10.0.0.1" }]);
    await expect(
      handshakeWith({ ...forged, caCert: crypto.caCert }, crypto.caCert),
    ).rejects.toThrow(/permitted subtree violation/i);
  });
});

describe("buildServerCertificateChain", () => {
  test("legacy material presents the self-signed certificate alone", () => {
    expect(buildServerCertificateChain({ cert: "LEAF", privateKey: "k", publicKey: "p" })).toEqual("LEAF");
  });

  test("CA-backed material presents the leaf followed by the CA", () => {
    expect(
      buildServerCertificateChain({ cert: "LEAF\n", privateKey: "k", publicKey: "p", caCert: "CA\n" }),
    ).toEqual("LEAF\n\nCA\n");
  });

  // The end-to-end claim: a client that trusts only the downloadable CA
  // completes a fully verified TLS handshake with a server presenting the
  // generated chain, addressed by an IP subjectAltName.
  test("a client trusting only the CA verifies a handshake with the served chain", async () => {
    const crypto = generateCryptoSettings({ keySize: TEST_KEY_SIZE });
    const server = https.createServer(
      { key: crypto.privateKey, cert: buildServerCertificateChain(crypto) },
      (_req, res) => res.end("ok"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const peerChain = await new Promise<{ subject: string; issuer: string; authorized: boolean }>(
        (resolve, reject) => {
          const socket = tls.connect(
            { host: "127.0.0.1", port, ca: crypto.caCert, rejectUnauthorized: true },
            () => {
              const peer = socket.getPeerCertificate(true);
              const result = {
                subject: peer.subject.CN,
                issuer: peer.issuer.CN,
                authorized: socket.authorized,
              };
              socket.end();
              resolve(result);
            },
          );
          socket.on("error", reject);
        },
      );
      expect(peerChain).toEqual({
        subject: "Obsidian Local REST API",
        issuer: "Obsidian Local REST API CA",
        authorized: true,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a client trusting the CA rejects a leaf it did not sign", async () => {
    const served = generateCryptoSettings({ keySize: TEST_KEY_SIZE });
    const other = generateCryptoSettings({ keySize: TEST_KEY_SIZE });
    const server = https.createServer(
      { key: served.privateKey, cert: buildServerCertificateChain(served) },
      (_req, res) => res.end("ok"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = tls.connect(
            { host: "127.0.0.1", port, ca: other.caCert, rejectUnauthorized: true },
            () => {
              socket.end();
              resolve();
            },
          );
          socket.on("error", reject);
        }),
      ).rejects.toThrow(/unable to verify|self.signed|certificate/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
