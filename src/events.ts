import { TFile } from "obsidian";
import type { App, CachedMetadata, TAbstractFile, WorkspaceLeaf } from "obsidian";
import type { IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { createSession, Session } from "better-sse";
import jsonLogic from "json-logic-js";
import WildcardRegexp from "glob-to-regexp";

import { FileMetadataObject } from "./types";
import { VaultOperations } from "./vaultOperations";
import { UrlSigner, buildEventStreamUrl, eventStreamResource } from "./signedUrls";

/**
 * Event streams: a Server-Sent Events feed of a single Obsidian event, filtered by a
 * JSONLogic expression the client registers up front.
 *
 * A client registers a subscription with `POST /events/<emitter>/<event>/` (the filter
 * in the body), gets back an id and a URL, and opens `GET /events/<emitter>/<event>/<id>/`
 * -- with the API key, or with the signature the URL carries -- to receive a stream. The
 * two-step shape exists because a browser's `EventSource` can only issue a GET, and a GET
 * has no body to carry the filter.
 *
 * Only the events listed in {@link STREAMABLE_EVENTS} can be streamed, each through a
 * serializer written for it. That serializer is the security boundary: Obsidian hands
 * its listeners live objects -- `TFile`s, `Editor`s, the full text of a note -- and
 * nothing leaves the plugin except what a serializer chose to copy out. Note content in
 * particular goes out only as the `content` field of a file's NoteJson, and only when the
 * subscription's (signed, so unwidenable) filter reads `file.content` -- a narrower
 * test than `/search/`'s, which fetches content for any filter that says "content".
 */

/** The three Obsidian objects whose events can be streamed. */
export const EVENT_EMITTERS = ["vault", "metadataCache", "workspace"] as const;
export type EventEmitterName = (typeof EVENT_EMITTERS)[number];

/**
 * Every event that can be streamed, by emitter.
 *
 * Names are Obsidian's own. Each one has a hand-written serializer below; adding a name
 * here without one is a type error.
 */
export const STREAMABLE_EVENTS = {
  vault: ["create", "modify", "delete", "rename"],
  metadataCache: ["changed", "deleted", "resolve", "resolved"],
  workspace: ["file-open", "active-leaf-change", "layout-change"],
} as const satisfies Record<EventEmitterName, readonly string[]>;

/**
 * Every event Obsidian declares that is deliberately *not* streamable, with the reason.
 *
 * `src/events.test.ts` reads the declared event names back out of the installed obsidian
 * typings and requires each one to appear either here or in {@link STREAMABLE_EVENTS}, so
 * an Obsidian upgrade that adds an event is a failing test -- somebody decides whether
 * to expose it -- rather than something that is silently exposed or silently missing.
 */
export const UNSTREAMABLE_EVENTS: Record<EventEmitterName, Record<string, string>> = {
  vault: {},
  metadataCache: {},
  workspace: {
    "quick-preview": "fires on every keystroke and carries the note's full text",
    "editor-change": "fires on every keystroke and carries a live Editor",
    "editor-paste": "carries clipboard data",
    "editor-drop": "carries drag-and-drop data",
    "file-menu": "carries a context menu, which means nothing to a remote client",
    "files-menu": "carries a context menu, which means nothing to a remote client",
    "url-menu": "carries a context menu, which means nothing to a remote client",
    "editor-menu": "carries a context menu, which means nothing to a remote client",
    "window-open": "carries window objects, which mean nothing to a remote client",
    "window-close": "carries window objects, which mean nothing to a remote client",
    resize: "UI-only; nothing a remote client can act on",
    "css-change": "UI-only; nothing a remote client can act on",
    quit: "fires as Obsidian shuts down, which closes every stream anyway",
  },
};

export type StreamableEventName<E extends EventEmitterName = EventEmitterName> =
  (typeof STREAMABLE_EVENTS)[E][number];

export function isEventEmitterName(value: string): value is EventEmitterName {
  return (EVENT_EMITTERS as readonly string[]).includes(value);
}

export function isStreamableEvent(
  emitter: EventEmitterName,
  event: string,
): event is StreamableEventName {
  return (STREAMABLE_EVENTS[emitter] as readonly string[]).includes(event);
}

/** A file's NoteJson as streamed: `content` is present only when the filter asked for it. */
export type StreamedNote = Omit<FileMetadataObject, "content"> & { content?: string };

/**
 * What a subscription's filter is evaluated against, and what the stream sends.
 *
 * `path` is the file (or folder) the event is about, when it is about one; `file` is that
 * file's NoteJson when the file still exists and is a file. The remaining fields appear
 * only on the events that have them.
 */
export interface StreamedEvent {
  emitter: EventEmitterName;
  event: string;
  path: string | null;
  file: StreamedNote | null;
  /** `vault` `create`/`modify`/`delete`/`rename`: whether the path names a folder. */
  isFolder?: boolean;
  /** `vault` `rename`: where the file was before. */
  oldPath?: string;
  /** `metadataCache` `deleted`: the frontmatter and tags the file had. */
  previous?: { frontmatter: Record<string, unknown>; tags: string[] } | null;
  /** `workspace` `active-leaf-change`: the type of the newly active view. */
  viewType?: string | null;
}

/**
 * What a serializer needs: a way to build a file's NoteJson. The NoteJson includes
 * content when at least one subscription listening for the event reads `file.content`;
 * it is stripped again for the ones that don't.
 */
interface SerializeContext {
  note: (file: TFile) => Promise<FileMetadataObject>;
}

type Serializer = (
  context: SerializeContext,
  args: unknown[],
) => Promise<Omit<StreamedEvent, "emitter" | "event">>;

async function noteOrNull(
  context: SerializeContext,
  file: unknown,
): Promise<FileMetadataObject | null> {
  return file instanceof TFile ? context.note(file) : null;
}

/** The vault path of a `TAbstractFile` argument, or null for anything else. */
function pathOf(file: unknown): string | null {
  if (typeof file !== "object" || file === null || !("path" in file)) return null;
  const { path } = file as Pick<TAbstractFile, "path">;
  return typeof path === "string" ? path : null;
}

async function vaultFileEvent(
  context: SerializeContext,
  args: unknown[],
): Promise<Omit<StreamedEvent, "emitter" | "event">> {
  const [file] = args;
  return {
    path: pathOf(file),
    isFolder: !(file instanceof TFile),
    file: await noteOrNull(context, file),
  };
}

function previousMetadata(cache: unknown): StreamedEvent["previous"] {
  if (typeof cache !== "object" || cache === null) return null;
  const { frontmatter, tags } = cache as Partial<CachedMetadata>;
  const copy: Record<string, unknown> = { ...(frontmatter ?? {}) };
  delete copy.position;
  return {
    frontmatter: copy,
    tags: (tags ?? []).map((tag) => tag.tag.replace(/^#/, "")),
  };
}

const SERIALIZERS: {
  [E in EventEmitterName]: Record<StreamableEventName<E>, Serializer>;
} = {
  vault: {
    create: vaultFileEvent,
    modify: vaultFileEvent,
    // The file is gone, so there is no NoteJson to build: the path is all there is.
    delete: async (_context, [file]) => ({
      path: pathOf(file),
      isFolder: !(file instanceof TFile),
      file: null,
    }),
    rename: async (context, args) => ({
      ...(await vaultFileEvent(context, args)),
      oldPath: typeof args[1] === "string" ? args[1] : undefined,
    }),
  },
  metadataCache: {
    // `changed`'s second argument is the note's full text. It is dropped: the NoteJson
    // carries the fresh frontmatter and tags, and content only when the filter asks.
    changed: async (context, [file]) => ({
      path: pathOf(file),
      file: await noteOrNull(context, file),
    }),
    deleted: async (_context, [file, prevCache]) => ({
      path: pathOf(file),
      file: null,
      previous: previousMetadata(prevCache),
    }),
    resolve: async (context, [file]) => ({
      path: pathOf(file),
      file: await noteOrNull(context, file),
    }),
    resolved: async () => ({ path: null, file: null }),
  },
  workspace: {
    "file-open": async (context, [file]) => ({
      path: pathOf(file),
      file: await noteOrNull(context, file),
    }),
    // Only the leaf's file path and view type: a WorkspaceLeaf is a live UI object.
    "active-leaf-change": async (_context, [leaf]) => {
      const view = (leaf as WorkspaceLeaf | null)?.view;
      const file: unknown = view && "file" in view ? (view as { file: unknown }).file : null;
      return {
        path: pathOf(file),
        file: null,
        viewType: view ? view.getViewType() : null,
      };
    },
    "layout-change": async () => ({ path: null, file: null }),
  },
};

/**
 * How many streams may be open at once. Every event is evaluated against every open
 * stream's filter, and a leaked `EventSource` reconnects forever, so the total is capped.
 */
export const MaximumOpenStreams = 16;
/**
 * How many subscriptions may be registered at once. Subscriptions are cheap, but each
 * POST creates one, so a client in a loop must not be able to grow the map without bound.
 */
export const MaximumSubscriptions = 256;

export class TooManyStreamsError extends Error {}
export class TooManySubscriptionsError extends Error {}
export class InvalidEventFilterError extends Error {}

/** What registering a subscription hands back to a client. */
export interface EventListenerGrant {
  id: string;
  emitter: EventEmitterName;
  event: StreamableEventName;
  /** The stream's URL: signed when signed URLs are enabled, otherwise it needs the API key. */
  url: string;
  signed: boolean;
  expiresAt: string;
}

export interface Subscription {
  id: string;
  emitter: EventEmitterName;
  event: StreamableEventName;
  /** The JSONLogic expression events must satisfy, or null to receive every event. */
  filter: unknown;
  /** Whether the filter reads `file.content`, and so whether events carry it. */
  includeContent: boolean;
  /**
   * Unix seconds, the same value the stream URL's signature carries as `exp`. A stream
   * opened before this stays open after it.
   */
  exp: number;
  sessions: Set<Session>;
}

/** Something whose events can be listened to by name, like Obsidian's `Events`. */
interface NamedEventSource {
  on(name: string, callback: (...data: unknown[]) => unknown): unknown;
  off(name: string, callback: (...data: unknown[]) => unknown): void;
}

/**
 * Every operation in a JSONLogic rule, depth first, as `[operator, arguments]`. A rule is
 * an object with one key, the operator, whose value is its argument or argument list.
 */
function* operationsIn(rule: unknown): Generator<[string, unknown[]]> {
  if (Array.isArray(rule)) {
    for (const item of rule) yield* operationsIn(item);
    return;
  }
  if (typeof rule !== "object" || rule === null) return;
  for (const [operator, raw] of Object.entries(rule)) {
    const args: unknown[] = Array.isArray(raw) ? raw : [raw];
    yield [operator, args];
    yield* operationsIn(args);
  }
}

/** The data paths a rule reads by name: `var`'s first argument, and `missing`'s lists. */
function* pathsReadBy(rule: unknown): Generator<string> {
  for (const [operator, args] of operationsIn(rule)) {
    if (operator === "var" && typeof args[0] === "string") {
      yield args[0];
    } else if (operator === "missing") {
      yield* args.filter((arg): arg is string => typeof arg === "string");
    } else if (operator === "missing_some" && Array.isArray(args[1])) {
      yield* args[1].filter((arg): arg is string => typeof arg === "string");
    }
  }
}

/**
 * Whether a filter reads note content -- a path that is, or is inside, `file.content`.
 * Only the paths the rule actually reads count, so a string literal that happens to say
 * "content" (a path compared against it, a `*.content` glob) doesn't send note bodies.
 * A `var` whose path is itself computed can't be read here and never counts: its
 * `file.content` is absent, as it is for any filter that doesn't name it.
 */
function readsContent(filter: unknown): boolean {
  for (const path of pathsReadBy(filter)) {
    if (path === "file.content" || path.startsWith("file.content.")) return true;
  }
  return false;
}

/**
 * Compile every literal `regexp` and `glob` pattern in a filter, throwing for one that
 * won't compile. Applying the filter to an empty event doesn't catch these: both
 * operators return false without compiling when the field they test is null.
 */
function checkPatterns(filter: unknown): void {
  for (const [operator, args] of operationsIn(filter)) {
    const [pattern] = args;
    if (typeof pattern !== "string") continue;
    if (operator === "regexp") new RegExp(pattern);
    else if (operator === "glob") WildcardRegexp(pattern);
  }
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export class EventStreams {
  private readonly subscriptions = new Map<string, Subscription>();
  /** The HTTP response behind each open stream, so unload can close them. */
  private readonly responses = new Map<Session, ServerResponse>();
  /** Obsidian listeners currently attached, keyed by `<emitter>/<event>`. */
  private readonly listeners = new Map<string, (...args: unknown[]) => void>();
  /**
   * Per-event delivery chains. Serializing a file is async (it may wait on the metadata
   * cache), so events are queued per `<emitter>/<event>` to reach clients in the order
   * Obsidian fired them.
   */
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Event ids are `<epoch>-<counter>`. The epoch changes every time the plugin loads, so
   * a client that reconnects can tell it missed events: a new epoch, or a gap in the
   * counter. Nothing is replayed.
   */
  readonly epoch = randomBytes(4).toString("hex");
  private counter = 0;
  /** Streams admitted by {@link open} whose session is still being created. */
  private opening = 0;

  constructor(
    private readonly app: App,
    private readonly operations: VaultOperations,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Register a subscription and return the URL that streams it. `signer` is null when
   * signed URLs are disabled, and the URL then needs the API key like any other request.
   *
   * Throws {@link InvalidEventFilterError} for a filter JSONLogic cannot evaluate, and
   * {@link TooManySubscriptionsError} at the cap.
   */
  createListener(
    emitter: EventEmitterName,
    event: StreamableEventName,
    filter: unknown,
    ttlSeconds: number,
    baseUrl: string,
    signer: UrlSigner | null,
  ): EventListenerGrant {
    const subscription = this.subscribe(emitter, event, filter, ttlSeconds);
    const resource = eventStreamResource(emitter, event, subscription.id);
    const params = signer ? signer.signEventStream(resource, subscription.exp) : null;
    return {
      id: subscription.id,
      emitter,
      event,
      url: buildEventStreamUrl(baseUrl, resource, params),
      signed: params !== null,
      expiresAt: new Date(subscription.exp * 1000).toISOString(),
    };
  }

  /** Register a subscription. See {@link createListener} for what it throws. */
  subscribe(
    emitter: EventEmitterName,
    event: StreamableEventName,
    filter: unknown,
    ttlSeconds: number,
  ): Subscription {
    if (filter != null) {
      // JSONLogic has no validator; applying the filter once to an empty event is how an
      // unknown operator or a malformed rule gets refused now, rather than silently
      // matching nothing on every event later. Patterns are compiled separately, since
      // an empty event never reaches them.
      try {
        checkPatterns(filter);
        jsonLogic.apply(filter, {
          emitter,
          event,
          path: null,
          file: null,
        } satisfies StreamedEvent);
      } catch (error) {
        throw new InvalidEventFilterError((error as Error).message);
      }
    }
    this.prune();
    if (this.subscriptions.size >= MaximumSubscriptions) {
      throw new TooManySubscriptionsError(
        `At most ${MaximumSubscriptions} event subscriptions may exist at once.`,
      );
    }
    const subscription: Subscription = {
      id: randomBytes(12).toString("base64url"),
      emitter,
      event,
      filter: filter ?? null,
      includeContent: readsContent(filter),
      exp: this.nowSeconds() + ttlSeconds,
      sessions: new Set(),
    };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  /**
   * The subscription `id` names, if it exists, is for this emitter and event, and has not
   * expired. Expiry only stops new streams: one already open keeps running.
   */
  get(emitter: string, event: string, id: string): Subscription | null {
    const subscription = this.subscriptions.get(id);
    if (
      !subscription ||
      subscription.emitter !== emitter ||
      subscription.event !== event ||
      subscription.exp < this.nowSeconds()
    ) {
      return null;
    }
    return subscription;
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  get openStreamCount(): number {
    let count = 0;
    for (const subscription of this.subscriptions.values()) {
      count += subscription.sessions.size;
    }
    return count;
  }

  /**
   * Open a stream for a subscription on an HTTP request. Throws
   * {@link TooManyStreamsError} before writing anything when the cap is reached, so the
   * caller can still answer with an error status.
   */
  async open(
    subscription: Subscription,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Session> {
    // Streams still being set up count against the cap too: a session only joins
    // `sessions` after `createSession` resolves, and without the reservation concurrent
    // opens could all pass the check before any of them was counted.
    if (this.openStreamCount + this.opening >= MaximumOpenStreams) {
      throw new TooManyStreamsError(
        `At most ${MaximumOpenStreams} event streams may be open at once.`,
      );
    }
    this.opening++;
    let session: Session;
    try {
      session = await createSession(req, res, {
        // A client-supplied Last-Event-ID is ignored: nothing is replayed, so it would
        // only be echoed back.
        trustClientEventId: false,
        keepAlive: 15_000,
        headers: {
          // Asks a buffering reverse proxy (nginx) not to hold events back.
          "X-Accel-Buffering": "no",
        },
      });
    } finally {
      this.opening--;
    }
    // The subscription may have been dropped during the await -- the plugin unloaded, or
    // it expired and was pruned. Nothing would ever close this stream then.
    if (this.subscriptions.get(subscription.id) !== subscription) {
      res.end();
      return session;
    }
    subscription.sessions.add(session);
    this.responses.set(session, res);
    this.attach(subscription.emitter, subscription.event);
    session.once("disconnected", () => {
      subscription.sessions.delete(session);
      this.responses.delete(session);
      this.detachIfUnused(subscription.emitter, subscription.event);
      this.prune();
    });
    return session;
  }

  /** Close every stream and remove every listener. Called at plugin unload. */
  dispose(): void {
    for (const key of [...this.listeners.keys()]) {
      const [emitter, event] = key.split("/") as [EventEmitterName, string];
      this.detach(emitter, event);
    }
    // Ending the response closes it, which is what better-sse watches for to disconnect.
    for (const res of this.responses.values()) res.end();
    this.responses.clear();
    this.subscriptions.clear();
  }

  private source(emitter: EventEmitterName): NamedEventSource {
    return this.app[emitter];
  }

  private attach(emitter: EventEmitterName, event: StreamableEventName): void {
    const key = `${emitter}/${event}`;
    if (this.listeners.has(key)) return;
    const listener = (...args: unknown[]) => {
      const previous = this.queues.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => this.deliver(emitter, event, args))
        .catch((error: unknown) => {
          console.error(`[REST API] Failed to deliver ${key} event`, error);
        });
      this.queues.set(key, next);
    };
    this.listeners.set(key, listener);
    this.source(emitter).on(event, listener);
  }

  private detachIfUnused(emitter: EventEmitterName, event: string): void {
    for (const subscription of this.subscriptions.values()) {
      if (
        subscription.emitter === emitter &&
        subscription.event === event &&
        subscription.sessions.size > 0
      ) {
        return;
      }
    }
    this.detach(emitter, event);
  }

  private detach(emitter: EventEmitterName, event: string): void {
    const key = `${emitter}/${event}`;
    const listener = this.listeners.get(key);
    if (!listener) return;
    this.source(emitter).off(event, listener);
    this.listeners.delete(key);
    this.queues.delete(key);
  }

  /** Drop expired subscriptions that have no open stream. */
  private prune(): void {
    const now = this.nowSeconds();
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.exp < now && subscription.sessions.size === 0) {
        this.subscriptions.delete(id);
      }
    }
  }

  private async deliver(
    emitter: EventEmitterName,
    event: StreamableEventName,
    args: unknown[],
  ): Promise<void> {
    const listening = [...this.subscriptions.values()].filter(
      (subscription) =>
        subscription.emitter === emitter &&
        subscription.event === event &&
        subscription.sessions.size > 0,
    );
    if (listening.length === 0) return;

    const includeContent = listening.some((subscription) => subscription.includeContent);
    const serializer = (SERIALIZERS[emitter] as Record<string, Serializer>)[event];
    const serialized = await serializer(
      { note: (file) => this.note(file, includeContent) },
      args,
    );
    const full: StreamedEvent = { emitter, event, ...serialized };
    const withoutContent = stripContent(full);
    const id = `${this.epoch}-${++this.counter}`;

    for (const subscription of listening) {
      const payload = subscription.includeContent ? full : withoutContent;
      if (!this.matches(subscription, payload)) continue;
      for (const session of subscription.sessions) {
        if (session.isConnected) session.push(payload, event, id);
      }
    }
  }

  private matches(subscription: Subscription, payload: StreamedEvent): boolean {
    if (subscription.filter === null) return true;
    try {
      return isTruthy(jsonLogic.apply(subscription.filter, payload));
    } catch (error) {
      console.warn(`[REST API] Event filter for subscription failed to evaluate`, error);
      return false;
    }
  }

  /**
   * A file's NoteJson. Non-markdown files have no metadata-cache entry, and
   * `getFileMetadataObject` would wait for one that never arrives, so they get the
   * metadata-free shape straight away.
   */
  private async note(file: TFile, includeContent: boolean): Promise<FileMetadataObject> {
    if (file.extension !== "md") {
      return {
        path: file.path,
        stat: file.stat,
        tags: [],
        frontmatter: {},
        content: "",
        links: [],
        backlinks: [...(this.operations.getBacklinksIndex()[file.path] ?? [])],
        unresolvedLinks: [],
      };
    }
    return this.operations.getFileMetadataObject(file, undefined, includeContent);
  }
}

/** The same event with any NoteJson `content` removed. */
export function stripContent(event: StreamedEvent): StreamedEvent {
  if (!event.file) return event;
  const file: StreamedNote = { ...event.file };
  delete file.content;
  return { ...event, file };
}
