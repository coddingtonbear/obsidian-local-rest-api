import type { StateDefinition } from "./publicApi";
import { EVENT_EMITTERS, type NamedEventSource } from "./events";

/**
 * The `state` section of `GET /`: per-namespace observations a client reads to decide
 * whether to proceed.
 *
 * The host contributes `metadataCache`, built by {@link MetadataCacheObserver}; every
 * extension that calls `addState` contributes a namespace named by its plugin id, read
 * through a {@link StateRegistry}. Nothing here is a verdict. The host records what it
 * has heard and when, and the client applies its own tolerance -- see issue #327 and the
 * closed PR #373 for why the plugin does not decide "ready" on anyone's behalf.
 */

/** How long `GET /` waits for an extension's `read` before serving null for it. */
export const DefaultStateReadTimeoutMs = 100;
export const MinimumStateReadTimeoutMs = 10;
export const MaximumStateReadTimeoutMs = 10_000;

/** The stored budget, clamped to the allowed range, or the default when unset. */
export function clampStateReadTimeout(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DefaultStateReadTimeoutMs;
  return Math.min(MaximumStateReadTimeoutMs, Math.max(MinimumStateReadTimeoutMs, Math.round(value)));
}

/**
 * Namespaces the host keeps for itself. The same names as the built-in event emitters,
 * so that `state.metadataCache` and the `metadataCache` event stream describe the same
 * thing, and so that `vault` and `workspace` stay free for the host to use later.
 */
export const BUILT_IN_STATE_NAMESPACES: readonly string[] = EVENT_EMITTERS;

/** What the host publishes under `state.metadataCache`. */
export interface MetadataCacheState {
  /** When the plugin attached its listeners: the start of the window the other two describe. */
  listeningSince: string;
  /** The last `resolved` heard, or null if none since `listeningSince`. */
  lastResolvedAt: string | null;
  /** The last `changed`, `resolve`, or `resolved` heard, or null if none since `listeningSince`. */
  lastActivityAt: string | null;
}

/**
 * The metadata cache events that mean Obsidian is indexing. `deleted` is left out: a
 * removal is bookkeeping, not a sign that link resolution is under way.
 */
const ACTIVITY_EVENTS = ["changed", "resolve", "resolved"] as const;

/**
 * Listens to the metadata cache from construction until {@link dispose} and remembers
 * when it last heard each kind of event.
 *
 * Deliberately records timestamps and nothing else. `resolved` fires every time
 * Obsidian's resolver queue momentarily drains, which on a fresh cache or after a large
 * sync is many times before the real end, so "the last one heard" is an honest fact
 * where "indexing has finished" would be a guess.
 */
export class MetadataCacheObserver {
  private readonly listeningSince: number;
  private lastResolvedAt: number | null = null;
  private lastActivityAt: number | null = null;
  private readonly listeners: Record<(typeof ACTIVITY_EVENTS)[number], () => void>;

  constructor(
    private readonly metadataCache: NamedEventSource,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.listeningSince = this.now();
    this.listeners = {
      changed: () => this.heardActivity(),
      resolve: () => this.heardActivity(),
      resolved: () => {
        this.lastResolvedAt = this.heardActivity();
      },
    };
    for (const event of ACTIVITY_EVENTS) {
      this.metadataCache.on(event, this.listeners[event]);
    }
  }

  private heardActivity(): number {
    this.lastActivityAt = this.now();
    return this.lastActivityAt;
  }

  snapshot(): MetadataCacheState {
    const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
    return {
      listeningSince: new Date(this.listeningSince).toISOString(),
      lastResolvedAt: iso(this.lastResolvedAt),
      lastActivityAt: iso(this.lastActivityAt),
    };
  }

  dispose(): void {
    for (const event of ACTIVITY_EVENTS) {
      this.metadataCache.off(event, this.listeners[event]);
    }
  }
}

/** Every extension's namespace: its state, or null when it could not be read. */
export type ExtensionStates = Record<string, Record<string, unknown> | null>;

/**
 * The state providers extensions have registered, and the one way they are read.
 *
 * {@link collect} is the containment boundary. Every provider is started at once and
 * raced against one shared budget, so the slowest extension under budget decides the
 * added latency and an extension over budget costs exactly the budget. A provider that
 * throws, rejects, overruns, or returns anything other than a JSON-serializable object
 * is served as null, with one console warning naming it, and never affects another
 * namespace or the rest of `GET /`. A late result is discarded rather than kept for
 * the next request: serving something older than the request is the ambiguity this
 * section exists to remove.
 */
export class StateRegistry {
  private readonly providers = new Map<string, StateDefinition>();

  /**
   * Registers `definition` under `owner`, an extension's plugin id, returning a function
   * that removes it. Throws for a namespace the host reserves or one already registered.
   */
  add(owner: string, definition: StateDefinition): () => void {
    if (BUILT_IN_STATE_NAMESPACES.includes(owner)) {
      throw new Error(`The state namespace "${owner}" is reserved by Obsidian Local REST API.`);
    }
    if (this.providers.has(owner)) {
      throw new Error(`State is already registered for "${owner}".`);
    }
    this.providers.set(owner, definition);
    return () => {
      if (this.providers.get(owner) === definition) this.providers.delete(owner);
    };
  }

  /** Reads every registered provider at once, waiting at most `timeoutMs` in total. */
  async collect(timeoutMs: number): Promise<ExtensionStates> {
    const entries = await Promise.all(
      [...this.providers].map(async ([owner, definition]) => [
        owner,
        await this.readOne(owner, definition, timeoutMs),
      ] as const),
    );
    return Object.fromEntries(entries);
  }

  private async readOne(
    owner: string,
    definition: StateDefinition,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    let timer: number | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error(`read() did not finish within ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      // Promise.resolve().then() turns a synchronous throw from read() into a rejection,
      // so a provider written without async still lands in the catch below.
      const value = await Promise.race([Promise.resolve().then(() => definition.read()), budget]);
      return parseState(value);
    } catch (error) {
      console.warn(`[REST API] State from extension "${owner}" could not be read:`, error);
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }
}

/**
 * The provider's value as the client will receive it: a JSON round trip, which both
 * rejects what cannot be serialized (a BigInt, a cycle) and hands back a copy the
 * provider cannot change after the fact. Throws for anything but a plain object.
 */
function parseState(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("read() must resolve to a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
