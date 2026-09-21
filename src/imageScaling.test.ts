import {
  CanvasImageScaler,
  MaximumImageEdge,
  RendererImageGlobals,
  fitWithin,
  isCanvasImageScalingAvailable,
  outputTypeFor,
} from "./imageScaling";

describe("imageScaling", () => {
  describe("fitWithin", () => {
    test("leaves an image that already fits alone", () => {
      expect(fitWithin(800, 600, MaximumImageEdge)).toEqual({ width: 800, height: 600, scaled: false });
      expect(fitWithin(1568, 10, MaximumImageEdge)).toEqual({ width: 1568, height: 10, scaled: false });
    });

    test("scales the longer edge down to the limit and keeps the aspect ratio", () => {
      expect(fitWithin(4000, 3000, 1568)).toEqual({ width: 1568, height: 1176, scaled: true });
      expect(fitWithin(3000, 4000, 1568)).toEqual({ width: 1176, height: 1568, scaled: true });
    });

    test("never collapses a very thin image to zero pixels", () => {
      expect(fitWithin(100000, 1, 1568)).toEqual({ width: 1568, height: 1, scaled: true });
    });
  });

  describe("outputTypeFor", () => {
    test("keeps JPEG as JPEG and re-encodes everything else as PNG", () => {
      expect(outputTypeFor("image/jpeg")).toBe("image/jpeg");
      expect(outputTypeFor("image/png")).toBe("image/png");
      expect(outputTypeFor("image/svg+xml")).toBe("image/png");
      expect(outputTypeFor("image/bmp")).toBe("image/png");
    });
  });

  // The scaler is exercised against a stand-in for the renderer's image stack, since
  // jest runs under Node. What is under test is the decision logic around it: when to
  // resample, when to re-encode, and when to hand the original bytes through.
  describe("CanvasImageScaler", () => {
    let drawn: Array<{ width: number; height: number }>;
    let converted: Array<{ type?: string; quality?: number }>;
    let bitmapSize: { width: number; height: number };
    let closed: number;
    let globals: RendererImageGlobals;

    beforeEach(() => {
      drawn = [];
      converted = [];
      closed = 0;
      bitmapSize = { width: 100, height: 50 };
      class FakeOffscreenCanvas {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return {
            drawImage: (_bitmap: unknown, _x: number, _y: number, width: number, height: number) => {
              drawn.push({ width, height });
            },
          };
        }
        async convertToBlob(options: { type?: string; quality?: number } = {}) {
          converted.push(options);
          const encoded = Buffer.from(`encoded:${options.type ?? "image/png"}`);
          return {
            arrayBuffer: async () =>
              encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
          };
        }
      }
      globals = {
        createImageBitmap: async () => ({
          width: bitmapSize.width,
          height: bitmapSize.height,
          close: () => {
            closed += 1;
          },
        }),
        OffscreenCanvas: FakeOffscreenCanvas,
      };
    });

    test("availability follows the presence of the renderer globals", () => {
      expect(isCanvasImageScalingAvailable(globals)).toBe(true);
      expect(isCanvasImageScalingAvailable({ OffscreenCanvas: globals.OffscreenCanvas })).toBe(false);
      expect(isCanvasImageScalingAvailable(undefined)).toBe(false);
    });

    test("hands a model-readable image that already fits through untouched", async () => {
      const bytes = Buffer.from([1, 2, 3]);
      const result = await new CanvasImageScaler(globals).scale(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        "image/png",
        1568,
      );
      expect(result).toMatchObject({ mimeType: "image/png", width: 100, height: 50, transformed: false });
      expect(result.data.equals(bytes)).toBe(true);
      expect(drawn).toEqual([]);
      expect(closed).toBe(1);
    });

    test("resamples an oversized image to the limit and re-encodes it", async () => {
      bitmapSize = { width: 4000, height: 3000 };
      const result = await new CanvasImageScaler(globals).scale(new ArrayBuffer(8), "image/png", 1568);
      expect(drawn).toEqual([{ width: 1568, height: 1176 }]);
      expect(converted).toEqual([{ type: "image/png" }]);
      expect(result).toMatchObject({ mimeType: "image/png", width: 1568, height: 1176, transformed: true });
      expect(result.data.toString()).toBe("encoded:image/png");
    });

    test("re-encodes a JPEG as JPEG with a quality setting", async () => {
      bitmapSize = { width: 2000, height: 2000 };
      await new CanvasImageScaler(globals).scale(new ArrayBuffer(8), "image/jpeg", 1568);
      expect(converted).toEqual([{ type: "image/jpeg", quality: 0.85 }]);
    });

    test("re-encodes a type the model cannot read even when it already fits", async () => {
      const result = await new CanvasImageScaler(globals).scale(new ArrayBuffer(8), "image/svg+xml", 1568);
      expect(drawn).toEqual([{ width: 100, height: 50 }]);
      expect(result).toMatchObject({ mimeType: "image/png", transformed: true });
    });

    test("closes the bitmap even when decoding succeeds but encoding fails", async () => {
      class NoContextCanvas {
        getContext() {
          return null;
        }
      }
      globals.OffscreenCanvas = NoContextCanvas as unknown as RendererImageGlobals["OffscreenCanvas"];
      bitmapSize = { width: 4000, height: 10 };
      await expect(
        new CanvasImageScaler(globals).scale(new ArrayBuffer(8), "image/png", 1568),
      ).rejects.toThrow(/canvas context/);
      expect(closed).toBe(1);
    });

    test("reports the runtime as unable rather than throwing something opaque", async () => {
      await expect(
        new CanvasImageScaler(undefined).scale(new ArrayBuffer(8), "image/png", 1568),
      ).rejects.toThrow(/not available/);
    });
  });
});
