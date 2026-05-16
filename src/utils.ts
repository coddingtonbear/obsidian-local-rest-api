import forge from "node-forge";

export function toArrayBuffer(
  arr: Uint8Array | ArrayBuffer | DataView | object,
): ArrayBuffer {
  if (arr instanceof ArrayBuffer) {
    return arr;
  }

  if (arr instanceof Uint8Array || arr instanceof DataView) {
    const view =
      arr instanceof Uint8Array
        ? arr
        : new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);

    if (view.buffer instanceof ArrayBuffer) {
      return view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength,
      );
    }

    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }

  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify(arr)).buffer;
}

export function getCertificateValidityDays(
  certificate: forge.pki.Certificate,
): number {
  return (
    (certificate.validity.notAfter.getTime() - new Date().getTime()) /
    (1000 * 3600 * 24)
  );
}

export function getCertificateIsUptoStandards(
  certificate: forge.pki.Certificate,
): boolean {
  const extension: Record<string, unknown> =
    certificate.getExtension("subjectAltName");
  let hasStandardsFlaw = false;
  if (extension && extension.altNames) {
    (extension.altNames as Record<string, unknown>[]).forEach((altName) => {
      if (altName.type === 7 && altName.value === "\x00\x00\x00\x00") {
        hasStandardsFlaw = true;
      }
    });
  }
  return !hasStandardsFlaw;
}
