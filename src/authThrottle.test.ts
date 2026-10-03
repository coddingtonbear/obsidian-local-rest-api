import { FailureWindowStore } from "./authThrottle";

describe("FailureWindowStore", () => {
  const WINDOW = 60_000;
  let clock: number;
  let store: FailureWindowStore;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    store = new FailureWindowStore(WINDOW, () => clock);
  });

  test("the first hit opens a window that closes one window-length later", () => {
    const info = store.increment("a");
    expect(info.totalHits).toBe(1);
    expect(info.resetTime?.getTime()).toBe(clock + WINDOW);
  });

  test("hits inside the window accumulate without moving its end", () => {
    const first = store.increment("a");
    clock += 10_000;
    const second = store.increment("a");
    expect(second.totalHits).toBe(2);
    expect(second.resetTime?.getTime()).toBe(first.resetTime?.getTime());
  });

  test("a hit after the window has passed starts a fresh window", () => {
    store.increment("a");
    store.increment("a");
    clock += WINDOW;
    const info = store.increment("a");
    expect(info.totalHits).toBe(1);
    expect(info.resetTime?.getTime()).toBe(clock + WINDOW);
  });

  test("keys are counted independently", () => {
    store.increment("a");
    store.increment("a");
    expect(store.increment("b").totalHits).toBe(1);
    expect(store.get("a")?.totalHits).toBe(2);
  });

  test("decrement takes a hit back and never goes below zero", () => {
    store.increment("a");
    store.increment("a");
    store.decrement("a");
    expect(store.get("a")?.totalHits).toBe(1);
    store.decrement("a");
    store.decrement("a");
    expect(store.get("a")?.totalHits ?? 0).toBe(0);
    store.decrement("never-seen");
    expect(store.get("never-seen")).toBeUndefined();
  });

  test("get reports nothing for an unknown or expired key", () => {
    expect(store.get("a")).toBeUndefined();
    store.increment("a");
    clock += WINDOW;
    expect(store.get("a")).toBeUndefined();
  });

  test("resetKey forgets one key and resetAll forgets every key", () => {
    store.increment("a");
    store.increment("b");
    store.resetKey("a");
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")?.totalHits).toBe(1);
    store.resetAll();
    expect(store.get("b")).toBeUndefined();
  });

  test("expired windows are dropped so the table cannot grow without bound", () => {
    for (let i = 0; i < 50; i++) store.increment(`key-${i}`);
    clock += WINDOW;
    store.increment("fresh");
    expect(store.size).toBe(1);
  });
});
