/**
 * Downscaling images for MCP `image` content blocks.
 *
 * A model is billed for an image by its pixel dimensions, not its byte size, and every
 * current Claude model resizes anything whose long edge exceeds 1568px before looking at
 * it. Sending a 4000px photo therefore costs the bytes of the full file for no gain in
 * what the model can see. Scaling it here, before it is base64-encoded into the result,
 * is what makes `vault_read_binary` on a photo cost a couple of thousand tokens rather
 * than several hundred thousand.
 *
 * The plugin runs in Obsidian's Electron renderer, which has the browser image stack:
 * `createImageBitmap` decodes, `OffscreenCanvas` resamples and re-encodes. That is the
 * only implementation; there is no Node fallback, because jest runs under plain Node
 * where none of it exists. The handler takes an `ImageScaler` so tests inject one.
 */

/** The longest edge, in pixels, an image is downscaled to before it goes to the model. */
export const MaximumImageEdge = 1568;

/** Image types a model can be handed as-is. Anything else is re-encoded. */
export const ModelReadableImageTypes: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface ScaledImage {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  /** True when the bytes differ from the input: it was resized, re-encoded, or both. */
  transformed: boolean;
}

export interface ImageScaler {
  /**
   * Fit an image inside `maxEdge` on its longer side, re-encoding into a
   * model-readable type where necessary. Rejects when the bytes are not a decodable
   * image.
   */
  scale(bytes: ArrayBuffer, mimeType: string, maxEdge: number): Promise<ScaledImage>;
}

/** Pick the output encoding: JPEG stays JPEG (no alpha, smaller), everything else is PNG. */
export function outputTypeFor(mimeType: string): "image/jpeg" | "image/png" {
  return mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
}

/** The dimensions an image ends up with once fitted inside `maxEdge`. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, scaled: false };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

/** The slice of the renderer's window this scaler uses. */
export interface RendererImageGlobals {
  createImageBitmap?: (blob: Blob) => Promise<ImageBitmap>;
  OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas;
}

/** The renderer's window, when there is one; jest runs under Node, where there is not. */
function rendererWindow(): RendererImageGlobals | undefined {
  return typeof window === "undefined" ? undefined : window;
}

/** Whether the browser image stack this scaler needs is present in this runtime. */
export function isCanvasImageScalingAvailable(
  globals: RendererImageGlobals | undefined = rendererWindow(),
): boolean {
  return (
    typeof globals?.createImageBitmap === "function" &&
    typeof globals?.OffscreenCanvas === "function"
  );
}

export class CanvasImageScaler implements ImageScaler {
  constructor(private readonly globals: RendererImageGlobals | undefined = rendererWindow()) {}

  async scale(bytes: ArrayBuffer, mimeType: string, maxEdge: number): Promise<ScaledImage> {
    const globals = this.globals;
    if (!globals?.createImageBitmap || !globals.OffscreenCanvas) {
      throw new Error("Image scaling is not available in this runtime.");
    }
    const bitmap = await globals.createImageBitmap(new Blob([bytes], { type: mimeType }));
    try {
      const fitted = fitWithin(bitmap.width, bitmap.height, maxEdge);
      if (!fitted.scaled && ModelReadableImageTypes.has(mimeType)) {
        return {
          data: Buffer.from(bytes),
          mimeType,
          width: bitmap.width,
          height: bitmap.height,
          transformed: false,
        };
      }
      const canvas = new globals.OffscreenCanvas(fitted.width, fitted.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not get a 2d canvas context.");
      context.drawImage(bitmap, 0, 0, fitted.width, fitted.height);
      const outputType = outputTypeFor(mimeType);
      const blob = await canvas.convertToBlob(
        outputType === "image/jpeg" ? { type: outputType, quality: 0.85 } : { type: outputType },
      );
      return {
        data: Buffer.from(await blob.arrayBuffer()),
        mimeType: outputType,
        width: fitted.width,
        height: fitted.height,
        transformed: true,
      };
    } finally {
      bitmap.close();
    }
  }
}
