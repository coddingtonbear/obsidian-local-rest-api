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

/** Whether `host` parses as an IPv4 or IPv6 address (as opposed to a DNS name). */
function isIpAddress(host: string): boolean {
  return forge.util.bytesFromIP(host) !== null;
}

function buildSubjectAltNames(options: SubjectAltNameOptions): AltName[] {
  const altNames: AltName[] = [{ type: 7, ip: DefaultBindingHost }];
  const bindingHost = options.bindingHost?.trim();
  if (
    bindingHost &&
    bindingHost !== DefaultBindingHost &&
    bindingHost !== "0.0.0.0"
  ) {
    // The bind address is usually an IP, but "localhost" (or any resolvable
    // name) is a legitimate value and must be encoded as a DNS name.
    altNames.push(
      isIpAddress(bindingHost)
        ? { type: 7, ip: bindingHost }
        : { type: 2, value: bindingHost },
    );
  }
  for (const name of (options.subjectAltNames ?? "").split("\n")) {
    if (name.trim()) {
      altNames.push({ type: 2, value: name.trim() });
    }
  }
  return altNames;
}

const LOCALHOST = "localhost";

/**
 * The names the CA is allowed to certify: everything the leaf will carry,
 * plus `localhost`, which is how people most often type the address of a
 * server bound to loopback. Nothing else, so that a stolen CA key is useless
 * for impersonating any other site.
 */
function buildPermittedNames(options: SubjectAltNameOptions): AltName[] {
  const names = buildSubjectAltNames(options);
  const ips = names.filter((name) => name.type === 7);
  const dns = names.filter((name) => name.type === 2);
  if (!dns.some((name) => name.value === LOCALHOST)) {
    dns.unshift({ type: 2, value: LOCALHOST });
  }
  return [...ips, ...dns];
}

const { asn1 } = forge;
const GENERAL_NAME_DNS = 2;
const GENERAL_NAME_IP = 7;
const PERMITTED_SUBTREES_TAG = 0;

/**
 * Encode RFC 5280 NameConstraints with only permittedSubtrees:
 *
 *   NameConstraints ::= SEQUENCE { permittedSubtrees [0] GeneralSubtrees }
 *   GeneralSubtree  ::= SEQUENCE { base GeneralName }   -- minimum 0, no maximum
 *
 * An iPAddress GeneralName in a constraint is address followed by mask; every
 * entry here is a single host, so the mask is all ones.
 */
// node-forge knows this OID for parsing but not for building, so name it.
const NAME_CONSTRAINTS_OID = "2.5.29.30";

function nameConstraintsExtension(names: AltName[]): {
  id: string;
  name: string;
  critical: boolean;
  value: forge.asn1.Asn1;
} {
  const subtrees = names.map((name) => {
    let generalName: forge.asn1.Asn1;
    if (name.type === GENERAL_NAME_IP && name.ip) {
      const address = forge.util.bytesFromIP(name.ip);
      if (address === null) throw new Error(`Not an IP address: ${name.ip}`);
      const mask = "\xff".repeat(address.length);
      generalName = asn1.create(asn1.Class.CONTEXT_SPECIFIC, GENERAL_NAME_IP, false, address + mask);
    } else if (name.type === GENERAL_NAME_DNS && name.value) {
      generalName = asn1.create(asn1.Class.CONTEXT_SPECIFIC, GENERAL_NAME_DNS, false, name.value);
    } else {
      throw new Error(`Unsupported name constraint: ${JSON.stringify(name)}`);
    }
    return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [generalName]);
  });
  return {
    id: NAME_CONSTRAINTS_OID,
    name: "nameConstraints",
    // RFC 5280 §4.2.1.10: conforming CAs MUST mark this extension critical.
    critical: true,
    value: asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, PERMITTED_SUBTREES_TAG, true, subtrees),
    ]),
  };
}

/**
 * A name a CA's `nameConstraints` permits. IP entries carry the constraint's
 * mask (in address notation) only when it is narrower than a single host,
 * which the plugin never generates but may be handed by the user.
 */
export interface PermittedName extends AltName {
  mask?: string;
}

function asn1Children(node: forge.asn1.Asn1): forge.asn1.Asn1[] {
  return Array.isArray(node.value) ? node.value : [];
}

/**
 * The names a CA's `nameConstraints` extension permits it to certify, or
 * null when the certificate carries no such extension (and so may certify
 * anything). Name types the plugin does not use (email, URI, directory
 * names) are skipped; excludedSubtrees are ignored.
 */
export function readPermittedNames(certificate: pki.Certificate): PermittedName[] | null {
  const extension = certificate.getExtension("nameConstraints") as { value?: string } | undefined;
  if (!extension?.value) return null;

  const root = asn1.fromDer(extension.value);
  const permittedSubtrees = asn1Children(root).find(
    (child) =>
      child.tagClass === asn1.Class.CONTEXT_SPECIFIC && Number(child.type) === PERMITTED_SUBTREES_TAG,
  );
  const names: PermittedName[] = [];
  for (const subtree of permittedSubtrees ? asn1Children(permittedSubtrees) : []) {
    const base = asn1Children(subtree)[0];
    if (!base || base.tagClass !== asn1.Class.CONTEXT_SPECIFIC || typeof base.value !== "string") {
      continue;
    }
    if (Number(base.type) === GENERAL_NAME_DNS) {
      names.push({ type: GENERAL_NAME_DNS, value: base.value });
    } else if (Number(base.type) === GENERAL_NAME_IP) {
      const half = base.value.length / 2;
      const ip = forge.util.bytesToIP(base.value.slice(0, half));
      const maskBytes = base.value.slice(half);
      if (ip === null) continue;
      const isHostMask = [...maskBytes].every((byte) => byte === "\xff");
      const mask = forge.util.bytesToIP(maskBytes);
      names.push(
        isHostMask || mask === null
          ? { type: GENERAL_NAME_IP, ip }
          : { type: GENERAL_NAME_IP, ip, mask },
      );
    }
  }
  return names;
}

function dnsNameFits(requested: string, permitted: PermittedName[]): boolean {
  const candidate = requested.toLowerCase();
  return permitted.some(({ value }) => {
    if (!value) return false;
    const base = value.toLowerCase();
    return candidate === base || candidate.endsWith("." + base);
  });
}

function ipFits(requested: string, permitted: PermittedName[]): boolean {
  const address = forge.util.bytesFromIP(requested);
  if (address === null) return false;
  return permitted.some(({ ip, mask }) => {
    const base = ip ? forge.util.bytesFromIP(ip) : null;
    if (base === null || base.length !== address.length) return false;
    const maskBytes = (mask && forge.util.bytesFromIP(mask)) || "\xff".repeat(address.length);
    for (let i = 0; i < address.length; i++) {
      const bit = maskBytes.charCodeAt(i);
      if ((address.charCodeAt(i) & bit) !== (base.charCodeAt(i) & bit)) return false;
    }
    return true;
  });
}

/**
 * Whether every requested subjectAltName is inside the CA's permitted
 * subtrees. Per RFC 5280, a name type with no permitted entries at all is
 * unconstrained.
 */
function namesFitConstraints(requested: AltName[], permitted: PermittedName[]): boolean {
  const permittedDns = permitted.filter((name) => name.type === GENERAL_NAME_DNS);
  const permittedIps = permitted.filter((name) => name.type === GENERAL_NAME_IP);
  return requested.every((name) => {
    if (name.type === GENERAL_NAME_DNS && name.value) {
      return permittedDns.length === 0 || dnsNameFits(name.value, permittedDns);
    }
    if (name.type === GENERAL_NAME_IP && name.ip) {
      return permittedIps.length === 0 || ipFits(name.ip, permittedIps);
    }
    return true;
  });
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
    nameConstraintsExtension(buildPermittedNames(options)),
  ]);
  certificate.sign(keypair.privateKey, forge.md.sha256.create());
  return { certificate, keypair };
}

/**
 * The bytes of a CA's subjectKeyIdentifier, which its leaves must echo as
 * their authorityKeyIdentifier for verifiers to pair them up. The plugin's
 * own CA derives it from its public key, but a user-supplied CA may carry
 * any value, so read the extension rather than recomputing it.
 */
function subjectKeyIdentifierOf(certificate: pki.Certificate): string {
  const extension = certificate.getExtension("subjectKeyIdentifier") as
    | { subjectKeyIdentifier?: string }
    | undefined;
  return extension?.subjectKeyIdentifier
    ? forge.util.hexToBytes(extension.subjectKeyIdentifier)
    : certificate.generateSubjectKeyIdentifier().getBytes();
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
      keyIdentifier: subjectKeyIdentifierOf(ca.certificate),
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

/** Whether `certificate`'s signature verifies under `issuer`'s public key. */
function signedBy(issuer: pki.Certificate, certificate: pki.Certificate): boolean {
  try {
    return issuer.verify(certificate);
  } catch {
    // node-forge throws (rather than returning false) when the signature
    // does not decrypt under the issuer's key at all.
    return false;
  }
}

/**
 * Re-issue the server certificate from the stored CA when it is inside its
 * renewal window (or already expired). Returns the replacement settings, or
 * null when nothing needs doing or nothing can be done: legacy material
 * without a CA, an expired CA, CA material that does not parse, or a CA
 * whose name constraints do not cover the currently configured names.
 * Renewal never changes the CA, so trust already granted to it carries over.
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

  // The CA only permits the names it was minted with. If the user has since
  // changed the binding host or hostnames, a renewed leaf naming them would
  // be rejected by every verifier that honours the constraint, so do not
  // mint one; the expiry warning in settings leads them to regenerate.
  const permitted = readPermittedNames(caCertificate);
  if (permitted && !namesFitConstraints(buildSubjectAltNames(options), permitted)) {
    return null;
  }

  const renewed = generateServerCertificate(
    { certificate: caCertificate, privateKey: caPrivateKey },
    { ...options, now },
  );
  // A user-supplied key need not belong to the user-supplied certificate;
  // a leaf signed by the wrong key must never replace one that works.
  if (!signedBy(caCertificate, renewed.certificate)) return null;
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
 * The number of days of validity the settings page should report, or null
 * when the material does not parse.
 *
 * With CA-backed material the leaf renews itself on load, so the expiry
 * the user has to act on is the CA's: that is what they imported and will
 * have to import again. A leaf still inside its renewal window after load
 * means renewal was refused (the names changed since the CA was minted, or
 * the CA material is unusable); its expiry is what the server will
 * actually deliver, so report that instead. Legacy material has only the
 * one certificate.
 */
export function getReportedValidityDays(
  crypto: CryptoSettings,
  now: Date = new Date(),
): number | null {
  try {
    const leafDays = getCertificateValidityDays(pki.certificateFromPem(crypto.cert), now);
    if (!crypto.caCert || leafDays <= LEAF_RENEWAL_WINDOW_DAYS) return leafDays;
    return getCertificateValidityDays(pki.certificateFromPem(crypto.caCert), now);
  } catch {
    return null;
  }
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

