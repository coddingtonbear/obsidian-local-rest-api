import { MetadataCache, TFile } from "../mocks/obsidian";
import {
  DefaultStateReadTimeoutMs,
  MaximumStateReadTimeoutMs,
  MetadataCacheObserver,
  MinimumStateReadTimeoutMs,
  StateRegistry,
  clampStateReadTimeout,
} from "./serverState";
import type { StateDefinition } from "./publicApi";

describe("MetadataCacheObserver", () => {
  let cache: MetadataCache;
  let now: number;
  let observer: MetadataCacheObserver;

  beforeEach(() => {
    cache = new MetadataCache();
    now = Date.UTC(2026, 9, 3, 14, 2, 11, 408);
    observer = new MetadataCacheObserver(cache, () => now);
  });

  afterEach(() => {
    observer.dispose();
  });

  test("starts listening at construction and has heard nothing yet", () => {
    expect(observer.snapshot()).toEqual({
      listeningSince: "2026-10-03T14:02:11.408Z",
      lastResolvedAt: null,
      lastActivityAt: null,
    });
  });

  test("resolved sets both the resolved and activity timestamps", () => {
    now += 2_543;
    cache._emit("resolved");
    expect(observer.snapshot()).toEqual({
      listeningSince: "2026-10-03T14:02:11.408Z",
      lastResolvedAt: "2026-10-03T14:02:13.951Z",
      lastActivityAt: "2026-10-03T14:02:13.951Z",
    });
  });

  test.each(["changed", "resolve"])("%s counts as activity but not as resolved", (event) => {
    now += 1_000;
    cache._emit(event, new TFile());
    expect(observer.snapshot()).toEqual({
      listeningSince: "2026-10-03T14:02:11.408Z",
      lastResolvedAt: null,
      lastActivityAt: "2026-10-03T14:02:12.408Z",
    });
  });

  test("deleted is not indexing activity", () => {
    now += 1_000;
    cache._emit("deleted", new TFile());
    expect(observer.snapshot().lastActivityAt).toBeNull();
  });

  test("keeps the latest of several observations", () => {
    now += 1_000;
    cache._emit("resolved");
    now += 1_000;
    cache._emit("resolve", new TFile());
    expect(observer.snapshot()).toEqual({
      listeningSince: "2026-10-03T14:02:11.408Z",
      lastResolvedAt: "2026-10-03T14:02:12.408Z",
      lastActivityAt: "2026-10-03T14:02:13.408Z",
    });
  });

  test("snapshot returns a fresh object each time", () => {
    const first = observer.snapshot();
    cache._emit("resolved");
    expect(observer.snapshot()).not.toBe(first);
    expect(first.lastResolvedAt).toBeNull();
  });

  test("dispose detaches every listener", () => {
    observer.dispose();
    expect([...cache._listeners.values()].flat()).toHaveLength(0);
    now += 1_000;
    cache._emit("resolved");
    expect(observer.snapshot().lastResolvedAt).toBeNull();
  });
});

describe("clampStateReadTimeout", () => {
  test("defaults when unset", () => {
    expect(clampStateReadTimeout(undefined)).toBe(DefaultStateReadTimeoutMs);
  });

  test("clamps to the allowed range", () => {
    expect(clampStateReadTimeout(0)).toBe(MinimumStateReadTimeoutMs);
    expect(clampStateReadTimeout(MaximumStateReadTimeoutMs * 10)).toBe(MaximumStateReadTimeoutMs);
    expect(clampStateReadTimeout(250)).toBe(250);
  });

  test("treats a non-number as unset", () => {
    expect(clampStateReadTimeout(Number.NaN)).toBe(DefaultStateReadTimeoutMs);
  });
});

describe("StateRegistry", () => {
  let registry: StateRegistry;
  let warn: jest.SpyInstance;

  function definition(overrides: Partial<StateDefinition> = {}): StateDefinition {
    return {
      description: "Test state.",
      read: async () => ({ ready: true }),
      ...overrides,
    };
  }

  beforeEach(() => {
    registry = new StateRegistry();
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("collects nothing while nothing is registered", async () => {
    expect(await registry.collect(100)).toEqual({});
  });

  test("serves each extension's state under its plugin id", async () => {
    registry.add("vault-indexer", definition({ read: async () => ({ ready: false, pending: 3 }) }));
    registry.add("publisher", definition({ read: async () => ({ lastPublishedAt: null }) }));
    expect(await registry.collect(100)).toEqual({
      "vault-indexer": { ready: false, pending: 3 },
      publisher: { lastPublishedAt: null },
    });
  });

  test("reads every provider at once rather than one after another", async () => {
    jest.useFakeTimers();
    const slow = (value: Record<string, unknown>) => () =>
      new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve(value), 50));
    registry.add("one", definition({ read: slow({ n: 1 }) }));
    registry.add("two", definition({ read: slow({ n: 2 }) }));

    const collected = registry.collect(100);
    await jest.advanceTimersByTimeAsync(50);
    expect(await collected).toEqual({ one: { n: 1 }, two: { n: 2 } });
  });

  test("serves null, and warns, for a provider that exceeds the budget", async () => {
    jest.useFakeTimers();
    registry.add(
      "slow-plugin",
      definition({
        read: () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 200)),
      }),
    );
    registry.add("prompt-plugin", definition());

    const collected = registry.collect(100);
    await jest.advanceTimersByTimeAsync(100);
    expect(await collected).toEqual({ "slow-plugin": null, "prompt-plugin": { ready: true } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("slow-plugin"), expect.anything());

    // The late answer is not kept for next time: a later read starts over.
    await jest.advanceTimersByTimeAsync(200);
    const again = registry.collect(100);
    await jest.advanceTimersByTimeAsync(100);
    expect((await again)["slow-plugin"]).toBeNull();
  });

  test("serves null, and warns, for a provider that rejects", async () => {
    registry.add("broken", definition({ read: async () => { throw new Error("boom"); } }));
    registry.add("fine", definition());
    expect(await registry.collect(100)).toEqual({ broken: null, fine: { ready: true } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken"), expect.anything());
  });

  test("serves null for a provider that throws synchronously", async () => {
    registry.add(
      "throws",
      definition({
        read: () => {
          throw new Error("sync boom");
        },
      }),
    );
    expect(await registry.collect(100)).toEqual({ throws: null });
  });

  test("serves null for a value that cannot be serialized as JSON", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    registry.add("circular", definition({ read: async () => circular }));
    registry.add("bigint", definition({ read: async () => ({ n: BigInt(1) }) }));
    expect(await registry.collect(100)).toEqual({ circular: null, bigint: null });
  });

  test("serves null for a value that is not an object", async () => {
    registry.add(
      "scalar",
      definition({ read: (async () => 42) as unknown as StateDefinition["read"] }),
    );
    registry.add(
      "array",
      definition({ read: (async () => [1]) as unknown as StateDefinition["read"] }),
    );
    expect(await registry.collect(100)).toEqual({ scalar: null, array: null });
  });

  test("serves a copy the provider cannot change after the fact", async () => {
    const live: Record<string, unknown> = { count: 1 };
    registry.add("live", definition({ read: async () => live }));
    const collected = await registry.collect(100);
    live.count = 2;
    expect(collected.live).toEqual({ count: 1 });
  });

  test("warns once for a failing provider, and again only after it has succeeded", async () => {
    let fail = true;
    registry.add(
      "flaky",
      definition({
        read: async () => {
          if (fail) throw new Error("boom");
          return { ok: true };
        },
      }),
    );

    expect(await registry.collect(100)).toEqual({ flaky: null });
    expect(await registry.collect(100)).toEqual({ flaky: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/flaky/);

    fail = false;
    expect(await registry.collect(100)).toEqual({ flaky: { ok: true } });
    fail = true;
    expect(await registry.collect(100)).toEqual({ flaky: null });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("a re-registered extension that fails is warned about afresh", async () => {
    const broken = definition({ read: async () => { throw new Error("boom"); } });
    const remove = registry.add("again", broken);
    await registry.collect(100);
    remove();
    registry.add("again", broken);
    await registry.collect(100);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("refuses a definition whose read is not a function", async () => {
    for (const read of [undefined, null, { ready: true }, "ready"]) {
      expect(() => registry.add("plain-js", definition({ read: read as unknown as StateDefinition["read"] }))).toThrow(
        /read/,
      );
    }
    expect(await registry.collect(100)).toEqual({});
  });

  test("refuses a definition whose description is not a string", () => {
    const noDescription = { ...definition(), description: undefined } as unknown as StateDefinition;
    expect(() => registry.add("plain-js", noDescription)).toThrow(/description/);
  });

  test("refuses a schema that is not an object", () => {
    for (const schema of [null, "object", ["object"], 1]) {
      expect(() =>
        registry.add("plain-js", definition({ schema: schema as unknown as StateDefinition["schema"] })),
      ).toThrow(/schema/);
    }
    registry.add("plain-js", definition({ schema: undefined }));
  });

  test("refuses a second registration for the same extension", () => {
    registry.add("twice", definition());
    expect(() => registry.add("twice", definition())).toThrow(/already/);
  });

  test.each(["vault", "metadataCache", "workspace"])(
    "refuses the built-in namespace %s",
    (name) => {
      expect(() => registry.add(name, definition())).toThrow(/reserved/);
    },
  );

  test("removing a registration drops its namespace and frees the id", async () => {
    const remove = registry.add("gone", definition());
    remove();
    expect(await registry.collect(100)).toEqual({});
    remove();
    registry.add("gone", definition({ read: async () => ({ back: true }) }));
    expect(await registry.collect(100)).toEqual({ gone: { back: true } });
  });

  test("removing a stale registration does not remove its replacement", async () => {
    const stale = registry.add("replaced", definition({ read: async () => ({ v: 1 }) }));
    stale();
    registry.add("replaced", definition({ read: async () => ({ v: 2 }) }));
    stale();
    expect(await registry.collect(100)).toEqual({ replaced: { v: 2 } });
  });
});
