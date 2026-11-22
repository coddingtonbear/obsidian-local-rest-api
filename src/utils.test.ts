import { constantTimeEquals } from "./utils";

// The module object itself (not an import namespace), so its functions can be spied on.
const nodeCrypto = jest.requireActual<typeof import("crypto")>("crypto");

describe("constantTimeEquals", () => {
  afterEach(() => jest.restoreAllMocks());

  test("is true for identical strings", () => {
    expect(constantTimeEquals("Bearer abc123", "Bearer abc123")).toBe(true);
    expect(constantTimeEquals("", "")).toBe(true);
  });

  test("is false for strings that differ anywhere", () => {
    expect(constantTimeEquals("Bearer abc123", "Bearer abc124")).toBe(false);
    expect(constantTimeEquals("Bearer abc123", "bearer abc123")).toBe(false);
  });

  test("is false, without throwing, for strings of different lengths", () => {
    // timingSafeEqual itself throws on buffers of unequal length; a length
    // check in front of it would leak the expected length through timing.
    expect(constantTimeEquals("Bearer abc123", "Bearer abc1234")).toBe(false);
    expect(constantTimeEquals("Bearer abc123", "Bearer abc12")).toBe(false);
    expect(constantTimeEquals("Bearer abc123", "")).toBe(false);
  });

  test("compares UTF-8 bytes, not UTF-16 code units", () => {
    expect(constantTimeEquals("Bearer ü", "Bearer ü")).toBe(true);
    expect(constantTimeEquals("Bearer ü", "Bearer u")).toBe(false);
  });

  test("decides through crypto.timingSafeEqual on equal-length buffers", () => {
    const spy = jest.spyOn(nodeCrypto, "timingSafeEqual");

    constantTimeEquals("short", "a considerably longer string");

    expect(spy).toHaveBeenCalledTimes(1);
    const [a, b] = spy.mock.calls[0] as [Buffer, Buffer];
    expect(a.length).toBe(b.length);
  });
});
