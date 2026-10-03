import type { ClientRateLimitInfo, Store } from "express-rate-limit";

/**
 * The in-memory counter behind the failed-authentication throttle.
 *
 * `express-rate-limit`'s own MemoryStore resets every key at once on a timer. This one
 * keeps a window per key, opened by the key's first hit and closed one window-length
 * later, and expires lazily: nothing runs in the background, so a plugin reload leaves
 * no interval behind, and a source that stops trying is forgotten the next time anything
 * touches the table. Only a handful of keys ever exist (the server binds to localhost by
 * default, so usually just one), which is why a sweep on each hit is affordable.
 */
export class FailureWindowStore implements Store {
  /** Keys never leave this process, so the limiter may call `resetKey` directly. */
  readonly localKeys = true;

  private readonly windows = new Map<string, { hits: number; resetTime: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** How many keys currently hold an open window. */
  get size(): number {
    this.sweep();
    return this.windows.size;
  }

  increment(key: string): ClientRateLimitInfo {
    const current = this.now();
    this.sweep(current);
    const open = this.windows.get(key);
    const window = open ?? { hits: 0, resetTime: current + this.windowMs };
    window.hits += 1;
    this.windows.set(key, window);
    return { totalHits: window.hits, resetTime: new Date(window.resetTime) };
  }

  decrement(key: string): void {
    const window = this.windows.get(key);
    if (!window) return;
    window.hits = Math.max(0, window.hits - 1);
  }

  get(key: string): ClientRateLimitInfo | undefined {
    this.sweep();
    const window = this.windows.get(key);
    if (!window) return undefined;
    return { totalHits: window.hits, resetTime: new Date(window.resetTime) };
  }

  resetKey(key: string): void {
    this.windows.delete(key);
  }

  resetAll(): void {
    this.windows.clear();
  }

  private sweep(current = this.now()): void {
    for (const [key, window] of this.windows) {
      if (window.resetTime <= current) this.windows.delete(key);
    }
  }
}
