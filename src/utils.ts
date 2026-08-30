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
