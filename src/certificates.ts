import forge, { pki } from "node-forge";

import { DefaultBindingHost } from "./constants";
import { CryptoSettings } from "./types";

/** How long a generated certificate authority stays valid. */
export const CA_VALIDITY_DAYS = 3650;
/** How long a generated (or renewed) server certificate stays valid. */
export const LEAF_VALIDITY_DAYS = 365;
/**
 * How close to expiry the server certificate must be before the plugin
 * re-issues it from the stored CA on load.
 */
export const LEAF_RENEWAL_WINDOW_DAYS = 30;

const DEFAULT_KEY_SIZE = 2048;
const CA_COMMON_NAME = "Obsidian Local REST API CA";
const LEAF_COMMON_NAME = "Obsidian Local REST API";

const MS_PER_DAY = 1000 * 3600 * 24;

/**
 * Something about a served certificate that newer verifiers object to and
 * that regenerating the plugin's material fixes.
 *
 * - `legacy-ipv4-san`: an all-zero IPv4 subjectAltName produced by a
 *   pre-2024 generator bug.
 * - `ca-used-as-leaf`: the certificate is marked as a certificate authority
 *   (basicConstraints cA:true) but is served as the TLS end-entity, which
 *   mozilla::pkix (Firefox) and rustls reject outright.
 */
export type CertificateStandardsIssue = "legacy-ipv4-san" | "ca-used-as-leaf";

export interface SubjectAltNameOptions {
  /** The address the HTTPS server binds to; added as an IP SAN when it names a real host. */
  bindingHost?: string;
  /** Extra DNS names, one per line, as entered in the settings panel. */
  subjectAltNames?: string;
}

export interface GenerateOptions extends SubjectAltNameOptions {
  /** The moment validity starts; defaults to the current time. */
  now?: Date;
  /** RSA modulus size in bits. Tests use a smaller size; production uses the default. */
  keySize?: number;
}

interface AltName {
  type: number;
  ip?: string;
  value?: string;
}

interface GeneratedCertificate {
  certificate: pki.Certificate;
  keypair: pki.rsa.KeyPair;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

// X.509 serial numbers are DER INTEGERs, so a leading byte with the high bit
// set would encode a negative number, which verifiers reject. Clear it.
function randomSerialNumber(): string {
  const bytes = forge.random.getBytesSync(16);
  const first = bytes.charCodeAt(0) & 0x7f;
  return forge.util.bytesToHex(String.fromCharCode(first) + bytes.slice(1));
}

function buildSubjectAltNames(options: SubjectAltNameOptions): AltName[] {
  const altNames: AltName[] = [{ type: 7, ip: DefaultBindingHost }];
  if (
    options.bindingHost &&
    options.bindingHost !== DefaultBindingHost &&
    options.bindingHost !== "0.0.0.0"
  ) {
    altNames.push({ type: 7, ip: options.bindingHost });
  }
  for (const name of (options.subjectAltNames ?? "").split("\n")) {
    if (name.trim()) {
      altNames.push({ type: 2, value: name.trim() });
    }
  }
  return altNames;
}

function generateCertificateAuthority(options: GenerateOptions): GeneratedCertificate {
  const now = options.now ?? new Date();
  const keypair = pki.rsa.generateKeyPair(options.keySize ?? DEFAULT_KEY_SIZE);
  const attrs = [{ name: "commonName", value: CA_COMMON_NAME }];
  const certificate = pki.createCertificate();
  certificate.serialNumber = randomSerialNumber();
  certificate.publicKey = keypair.publicKey;
  certificate.setIssuer(attrs);
  certificate.setSubject(attrs);
  certificate.validity.notBefore = now;
  certificate.validity.notAfter = addDays(now, CA_VALIDITY_DAYS);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  certificate.sign(keypair.privateKey, forge.md.sha256.create());
  return { certificate, keypair };
}

function generateServerCertificate(
  ca: { certificate: pki.Certificate; privateKey: pki.PrivateKey },
  options: GenerateOptions,
): GeneratedCertificate {
  const now = options.now ?? new Date();
  const keypair = pki.rsa.generateKeyPair(options.keySize ?? DEFAULT_KEY_SIZE);
  const certificate = pki.createCertificate();
  certificate.serialNumber = randomSerialNumber();
  certificate.publicKey = keypair.publicKey;
  certificate.setIssuer(ca.certificate.subject.attributes);
  certificate.setSubject([{ name: "commonName", value: LEAF_COMMON_NAME }]);
  certificate.validity.notBefore = now;
  certificate.validity.notAfter = addDays(now, LEAF_VALIDITY_DAYS);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectKeyIdentifier" },
    {
      name: "authorityKeyIdentifier",
      keyIdentifier: ca.certificate.generateSubjectKeyIdentifier().getBytes(),
    },
    { name: "subjectAltName", altNames: buildSubjectAltNames(options) },
  ]);
  certificate.sign(ca.privateKey, forge.md.sha256.create());
  return { certificate, keypair };
}

/**
 * Generate a fresh certificate authority and a server certificate signed by
 * it, returning everything the plugin persists in `settings.crypto`.
 */
export function generateCryptoSettings(options: GenerateOptions = {}): CryptoSettings {
  const ca = generateCertificateAuthority(options);
  const leaf = generateServerCertificate(
    { certificate: ca.certificate, privateKey: ca.keypair.privateKey },
    options,
  );
  return {
    cert: pki.certificateToPem(leaf.certificate),
    privateKey: pki.privateKeyToPem(leaf.keypair.privateKey),
    publicKey: pki.publicKeyToPem(leaf.keypair.publicKey),
    caCert: pki.certificateToPem(ca.certificate),
    caPrivateKey: pki.privateKeyToPem(ca.keypair.privateKey),
  };
}

/**
 * Re-issue the server certificate from the stored CA when it is inside its
 * renewal window (or already expired). Returns the replacement settings, or
 * null when nothing needs doing or nothing can be done: legacy material
 * without a CA, an expired CA, or CA material that does not parse. Renewal
 * never changes the CA, so trust already granted to it carries over.
 */
export function renewServerCertificateIfNeeded(
  crypto: CryptoSettings,
  options: GenerateOptions = {},
): CryptoSettings | null {
  if (!crypto.caCert || !crypto.caPrivateKey) return null;
  const now = options.now ?? new Date();

  let caCertificate: pki.Certificate;
  let caPrivateKey: pki.PrivateKey;
  let leaf: pki.Certificate;
  try {
    caCertificate = pki.certificateFromPem(crypto.caCert);
    caPrivateKey = pki.privateKeyFromPem(crypto.caPrivateKey);
    leaf = pki.certificateFromPem(crypto.cert);
  } catch {
    return null;
  }

  if (caCertificate.validity.notAfter.getTime() <= now.getTime()) return null;
  if (getCertificateValidityDays(leaf, now) > LEAF_RENEWAL_WINDOW_DAYS) return null;

  const renewed = generateServerCertificate(
    { certificate: caCertificate, privateKey: caPrivateKey },
    { ...options, now },
  );
  return {
    ...crypto,
    cert: pki.certificateToPem(renewed.certificate),
    privateKey: pki.privateKeyToPem(renewed.keypair.privateKey),
    publicKey: pki.publicKeyToPem(renewed.keypair.publicKey),
  };
}

/**
 * The PEM chain the HTTPS server presents: the server certificate followed
 * by the CA that signed it, so a client that trusts the CA can build the
 * chain without having seen it before. Legacy material has no CA and
 * presents its self-signed certificate alone.
 */
export function buildServerCertificateChain(crypto: CryptoSettings): string {
  return [crypto.cert, crypto.caCert]
    .filter((pem): pem is string => Boolean(pem))
    .join("\n");
}

export function getCertificateValidityDays(
  certificate: pki.Certificate,
  now: Date = new Date(),
): number {
  return (certificate.validity.notAfter.getTime() - now.getTime()) / MS_PER_DAY;
}

/**
 * Report whether a certificate was generated in a shape that current
 * verifiers reject. `role` says what the certificate is used as: the CA bit
 * is only a problem on the certificate the server presents.
 */
export function getCertificateStandardsIssue(
  certificate: pki.Certificate,
  { role = "leaf" }: { role?: "leaf" | "ca" } = {},
): CertificateStandardsIssue | null {
  const subjectAltName = certificate.getExtension("subjectAltName") as
    | { altNames?: AltName[] }
    | undefined;
  for (const altName of subjectAltName?.altNames ?? []) {
    if (altName.type === 7 && altName.value === "\x00\x00\x00\x00") {
      return "legacy-ipv4-san";
    }
  }

  const basicConstraints = certificate.getExtension("basicConstraints") as
    | { cA?: boolean }
    | undefined;
  if (role === "leaf" && basicConstraints?.cA === true) {
    return "ca-used-as-leaf";
  }

  return null;
}
