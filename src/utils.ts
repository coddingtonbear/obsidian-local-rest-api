import { createHash, timingSafeEqual } from "crypto";

/**
 * Whether two strings are equal, decided in time that depends on neither where
 * they first differ nor how long the expected one is.
 *
 * A plain `===` stops at the first differing character, so a caller who can
 * time responses learns how much of a guess was right. `timingSafeEqual`
 * compares in constant time but throws on buffers of unequal length, and a
 * length check in front of it would leak the expected length instead. Both
 * sides are therefore hashed to SHA-256 first: the digests always have the
 * same length, and equal digests mean equal strings for any practical input.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

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
