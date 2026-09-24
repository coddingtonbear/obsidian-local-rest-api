import { TFile } from "obsidian";
import type { App, CachedMetadata, TAbstractFile, WorkspaceLeaf } from "obsidian";
import type { IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { createSession, Session } from "better-sse";
import jsonLogic from "json-logic-js";

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
 * subscription's (signed, so unwidenable) filter mentions `content`, the same rule
 * `/search/` applies.
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
 * content when at least one subscription listening for the event mentions `content`;
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
export class UnknownEventError extends Error {}

/**
 * An event an extension has made streamable. It is streamed under the extension's
 * plugin id as the emitter: `/events/<plugin id>/<event>/`.
 */
export interface ExtensionEventDefinition {
  /** What the event fires on; Obsidian's `Events` fits. */
  source: NamedEventSource;
  /**
   * Turns a listener's arguments into what the stream sends and the filter sees. Null
   * drops the occurrence. The extension, which knows the payload, decides what is safe.
   */
  serialize: (
    ...args: unknown[]
  ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
}

/** Event names an extension may register: one URL path segment, no encoding needed. */
const EXTENSION_EVENT_NAME = /^[A-Za-z0-9._:-]{1,128}$/;

/** What registering a subscription hands back to a client. */
export interface EventListenerGrant {
  id: string;
  emitter: string;
  event: string;
  /** The stream's URL: signed when signed URLs are enabled, otherwise it needs the API key. */
  url: string;
  signed: boolean;
  expiresAt: string;
}

export interface Subscription {
  id: string;
  emitter: string;
  event: string;
  /** The JSONLogic expression events must satisfy, or null to receive every event. */
  filter: unknown;
  /** Whether the filter mentions `content`, and so whether events carry it. */
  includeContent: boolean;
  /**
   * Unix seconds, the same value the stream URL's signature carries as `exp`. A stream
   * opened before this stays open after it.
   */
  exp: number;
  sessions: Set<Session>;
}

/** Something whose events can be listened to by name, like Obsidian's `Events`. */
export interface NamedEventSource {
  on(name: string, callback: (...data: unknown[]) => unknown): unknown;
  off(name: string, callback: (...data: unknown[]) => unknown): void;
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
  /** Events extensions have registered, by emitter (the extension's plugin id). */
  private readonly extensionEvents = new Map<string, Map<string, ExtensionEventDefinition>>();

  constructor(
    private readonly app: App,
    private readonly operations: VaultOperations,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether `<emitter>/<event>` is on the built-in allowlist or registered by an extension. */
  isStreamable(emitter: string, event: string): boolean {
    if (isEventEmitterName(emitter)) return isStreamableEvent(emitter, event);
    return this.extensionEvents.get(emitter)?.has(event) ?? false;
  }

  /** Everything that can be streamed right now, by emitter. */
  supportedEvents(): Record<string, readonly string[]> {
    const supported: Record<string, readonly string[]> = { ...STREAMABLE_EVENTS };
    for (const [emitter, events] of this.extensionEvents) {
      supported[emitter] = [...events.keys()];
    }
    return supported;
  }

  /**
   * Make an extension's event streamable under `emitter`, the extension's plugin id.
   * Throws for a built-in emitter name, an event name that is not one URL-safe path
   * segment, or an event already registered.
   */
  addExtensionEvent(emitter: string, event: string, definition: ExtensionEventDefinition): void {
    if (isEventEmitterName(emitter)) {
      throw new Error(`"${emitter}" is a built-in event emitter and cannot be extended.`);
    }
    if (!EXTENSION_EVENT_NAME.test(emitter)) {
      throw new Error(`"${emitter}" cannot be used as an event emitter name in a URL.`);
    }
    if (!EXTENSION_EVENT_NAME.test(event)) {
      throw new Error(
        `Event name "${event}" must be 1-128 letters, digits, or ".", "_", ":", "-".`,
      );
    }
    const events = this.extensionEvents.get(emitter) ?? new Map<string, ExtensionEventDefinition>();
    if (events.has(event)) {
      throw new Error(`The event "${event}" is already registered for "${emitter}".`);
    }
    events.set(event, definition);
    this.extensionEvents.set(emitter, events);
  }

  /**
   * Remove every event registered under `emitter`, closing their open streams and
   * dropping their subscriptions. Called when the extension unregisters.
   */
  removeExtensionEvents(emitter: string): void {
    const events = this.extensionEvents.get(emitter);
    if (!events) return;
    for (const event of events.keys()) this.detach(emitter, event);
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.emitter !== emitter) continue;
      for (const session of subscription.sessions) this.responses.get(session)?.end();
      this.subscriptions.delete(id);
    }
    this.extensionEvents.delete(emitter);
  }

  /**
   * Register a subscription and return the URL that streams it. `signer` is null when
   * signed URLs are disabled, and the URL then needs the API key like any other request.
   *
   * Throws {@link UnknownEventError} for an event that is not streamable,
   * {@link InvalidEventFilterError} for a filter JSONLogic cannot evaluate, and
   * {@link TooManySubscriptionsError} at the cap.
   */
  createListener(
    emitter: string,
    event: string,
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
    emitter: string,
    event: string,
    filter: unknown,
    ttlSeconds: number,
  ): Subscription {
    if (!this.isStreamable(emitter, event)) {
      throw new UnknownEventError(`${emitter}/${event} cannot be streamed.`);
    }
    if (filter != null) {
      // JSONLogic has no validator; applying the filter once to an empty event is how an
      // unknown operator or a malformed rule gets refused now, rather than silently
      // matching nothing on every event later.
      try {
        jsonLogic.apply(filter, { emitter, event, path: null, file: null });
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
      // Search looks for `"content"`; here the content sits one level down, so a filter
      // names it as `file.content`. Either spelling counts.
      includeContent: filter != null && /[".]content"/.test(JSON.stringify(filter)),
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
    if (this.openStreamCount >= MaximumOpenStreams) {
      throw new TooManyStreamsError(
        `At most ${MaximumOpenStreams} event streams may be open at once.`,
      );
    }
    const session = await createSession(req, res, {
      // A client-supplied Last-Event-ID is ignored: nothing is replayed, so it would only
      // be echoed back.
      trustClientEventId: false,
      keepAlive: 15_000,
      headers: {
        // Asks a buffering reverse proxy (nginx) not to hold events back.
        "X-Accel-Buffering": "no",
      },
    });
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
      const [emitter, event] = key.split("/");
      this.detach(emitter, event);
    }
    // Ending the response closes it, which is what better-sse watches for to disconnect.
    for (const res of this.responses.values()) res.end();
    this.responses.clear();
    this.subscriptions.clear();
    this.extensionEvents.clear();
  }

  private source(emitter: string, event: string): NamedEventSource | null {
    if (isEventEmitterName(emitter)) return this.app[emitter];
    return this.extensionEvents.get(emitter)?.get(event)?.source ?? null;
  }

  private attach(emitter: string, event: string): void {
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
    const source = this.source(emitter, event);
    if (!source) return;
    this.listeners.set(key, listener);
    source.on(event, listener);
  }

  private detachIfUnused(emitter: string, event: string): void {
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

  private detach(emitter: string, event: string): void {
    const key = `${emitter}/${event}`;
    const listener = this.listeners.get(key);
    if (!listener) return;
    this.source(emitter, event)?.off(event, listener);
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

  private async deliver(emitter: string, event: string, args: unknown[]): Promise<void> {
    const listening = [...this.subscriptions.values()].filter(
      (subscription) =>
        subscription.emitter === emitter &&
        subscription.event === event &&
        subscription.sessions.size > 0,
    );
    if (listening.length === 0) return;

    const payloads = await this.serialize(emitter, event, args, listening);
    if (!payloads) return;
    const id = `${this.epoch}-${++this.counter}`;

    for (const subscription of listening) {
      const payload = subscription.includeContent ? payloads.full : payloads.withoutContent;
      if (!this.matches(subscription, payload)) continue;
      for (const session of subscription.sessions) {
        if (session.isConnected) session.push(payload, event, id);
      }
    }
  }

  /**
   * The payload for one occurrence, with and without note content, or null to drop it.
   * An extension's payload is sent as its serializer returned it: the content rule is
   * about the NoteJson built-in events carry, and an extension decides for itself.
   */
  private async serialize(
    emitter: string,
    event: string,
    args: unknown[],
    listening: Subscription[],
  ): Promise<{ full: Record<string, unknown>; withoutContent: Record<string, unknown> } | null> {
    if (isEventEmitterName(emitter)) {
      const includeContent = listening.some((subscription) => subscription.includeContent);
      const serializer = (SERIALIZERS[emitter] as Record<string, Serializer>)[event];
      const serialized = await serializer(
        { note: (file) => this.note(file, includeContent) },
        args,
      );
      const full: StreamedEvent = { emitter, event, ...serialized };
      return { full: { ...full }, withoutContent: { ...stripContent(full) } };
    }
    const definition = this.extensionEvents.get(emitter)?.get(event);
    if (!definition) return null;
    const data = await definition.serialize(...args);
    if (data === null) return null;
    // emitter and event last, so a serializer cannot relabel what fired.
    const payload = { ...data, emitter, event };
    return { full: payload, withoutContent: payload };
  }

  private matches(subscription: Subscription, payload: Record<string, unknown>): boolean {
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
