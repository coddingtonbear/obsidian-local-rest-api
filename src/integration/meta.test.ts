import * as tls from "tls";

import forge from "node-forge";

import { CERT_NAME } from "../constants";
import { authedFetch, unauthFetch, ensureServerReachable } from "./client";

beforeAll(async () => {
  await ensureServerReachable();
});

describe("GET /", () => {
  test("unauthenticated returns 200 with status OK and authenticated false", async () => {
    const res = await unauthFetch("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("OK");
    expect(body.authenticated).toBe(false);
  });

  test("authenticated returns authenticated true", async () => {
    const res = await authedFetch("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
  });

  test("returns service field", async () => {
    const res = await authedFetch("/");
    const body = await res.json();
    expect(body.service).toBe("Obsidian Local REST API");
  });

  test("returns versions object with obsidian and self strings", async () => {
    const res = await authedFetch("/");
    const body = await res.json();
    expect(typeof body.versions?.obsidian).toBe("string");
    expect(typeof body.versions?.self).toBe("string");
  });
});

describe("GET /openapi.yaml", () => {
  test("returns 200 with YAML content containing openapi field", async () => {
    const res = await unauthFetch("/openapi.yaml");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("openapi:");
  });

  test("content-type includes yaml", async () => {
    const res = await unauthFetch("/openapi.yaml");
    expect(res.headers.get("content-type")).toMatch(/yaml/);
  });
});

describe("certificate material", () => {
  // The integration suite talks to the HTTP server; the certificate checks
  // need the HTTPS one, which the plugin enables by default on 27124.
  const HTTPS_URL = (process.env.OBSIDIAN_HTTPS_HOST ?? "https://localhost:27124").replace(/\/$/, "");

  function certificateFromDer(der: Buffer): forge.pki.Certificate {
    return forge.pki.certificateFromAsn1(forge.asn1.fromDer(der.toString("binary")));
  }

  // Fetch the certificate the HTTPS server actually presents in the handshake,
  // without trusting it: the point is to inspect it, not to validate it.
  function fetchServedCertificate(): Promise<forge.pki.Certificate> {
    const { hostname, port } = new URL(HTTPS_URL);
    return new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: hostname, port: Number(port), rejectUnauthorized: false, servername: hostname },
        () => {
          const peer = socket.getPeerCertificate();
          socket.end();
          resolve(certificateFromDer(peer.raw));
        },
      );
      socket.on("error", reject);
    });
  }

  test("the downloadable certificate is a certificate authority that the served certificate chains to", async () => {
    const downloadRes = await unauthFetch(`/${CERT_NAME}`);
    expect(downloadRes.status).toBe(200);
    const downloaded = forge.pki.certificateFromPem(await downloadRes.text());
    const served = await fetchServedCertificate();

    const infoRes = await authedFetch("/");
    const info = (await infoRes.json()) as {
      certificateInfo?: { regenerateRecommended: boolean; regenerateReason: string | null };
    };
    expect(info.certificateInfo).toBeDefined();

    const basicConstraints = (name: forge.pki.Certificate) =>
      name.getExtension("basicConstraints") as { cA?: boolean } | undefined;

    if (info.certificateInfo?.regenerateReason === "ca-used-as-leaf") {
      // This Obsidian still runs material from before the CA/leaf split: the
      // download is the self-signed certificate itself, and the plugin says so.
      expect(info.certificateInfo.regenerateRecommended).toBe(true);
      expect(forge.pki.certificateToPem(served)).toEqual(forge.pki.certificateToPem(downloaded));
      return;
    }

    expect(info.certificateInfo?.regenerateRecommended).toBe(false);
    expect(basicConstraints(downloaded)?.cA).toBe(true);
    expect(basicConstraints(served)?.cA).toBe(false);
    expect(downloaded.issued(served)).toBe(true);
    expect(downloaded.verify(served)).toBe(true);
    const store = forge.pki.createCaStore([downloaded]);
    expect(forge.pki.verifyCertificateChain(store, [served])).toBe(true);
  });
});
