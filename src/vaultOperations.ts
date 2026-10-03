import {
  getAllTags,
  App,
  CachedMetadata,
  Command,
  Component,
  MarkdownRenderer,
  prepareSimpleSearch,
  TAbstractFile,
  TFile,
} from "obsidian";
import path from "path";
import {
  applyPatch,
  getDocumentMap,
  PatchInstruction,
  PatchOperation,
  PatchTargetType,
} from "markdown-patch";
import {
  patch as patchV2,
  projectMap,
  buildModel,
  readTarget,
} from "markdown-patch-2";
import type {
  InstructionInput,
  PatchResult,
  PublicMap,
  ReadTarget,
  ReadResult,
} from "markdown-patch-2";
import jsonLogic from "json-logic-js";
import WildcardRegexp from "glob-to-regexp";

export class FileNotFoundError extends Error {}
export class CommandNotFoundError extends Error {}
export class DestinationAlreadyExistsError extends Error {}

import {
  DocumentMapObject,
  FileMetadataObject,
  LocalRestApiSettings,
  SearchContext,
  SearchJsonResponseItem,
  SearchResponseItem,
} from "./types";
import { toArrayBuffer } from "./utils";
import {
  assertVaultPathIsContained,
  assertConfigDirAccessAllowed,
  configDirMatcher,
  onDiskAccessFor,
  ConfigDirAccessError,
  PathTraversalError,
  type LinkMemo,
} from "./vaultPath";

/**
 * Every event Obsidian's metadata cache publicly declares, and every event its
 * vault publicly declares.
 *
 * Deliberately the whole surface rather than the subset that looks like it moves
 * the link graph. `resolvedLinks` is Obsidian's own derived state, and which of
 * its events happen to precede an update to it is an implementation detail of a
 * dependency -- betting a cache's correctness on having read that detail right
 * is a bet nobody can win permanently. Subscribing to everything removes the
 * judgement call, and costs only a rebuild the uncached code performed on every
 * single read anyway.
 *
 * `src/vaultOperations.test.ts` reads these names back out of the installed
 * obsidian typings and fails if the two ever disagree, so an Obsidian upgrade
 * that adds an event is a red test rather than a cache that quietly goes stale.
 */
export const METADATA_CACHE_EVENTS = [
  "changed",
  "deleted",
  "resolve",
  "resolved",
] as const;
export const VAULT_EVENTS = ["create", "modify", "delete", "rename"] as const;

/**
 * The metadata-cache events that mean the link graph is moving. `resolved`,
 * the one left out, means the opposite: a pass has just finished.
 */
export const METADATA_CACHE_ACTIVITY_EVENTS = METADATA_CACHE_EVENTS.filter(
  (event): event is Exclude<(typeof METADATA_CACHE_EVENTS)[number], "resolved"> =>
    event !== "resolved",
);

/**
 * How long a built backlinks index may be served before it is rebuilt anyway.
 *
 * The listeners above cover everything Obsidian announces, but "everything it
 * announces" is not the same as "everything that happens": an event added in a
 * future release, or an internal path that rewrites `resolvedLinks` without
 * saying so, would otherwise leave a stale index in place for as long as the
 * plugin runs. Ageing the index out turns that unbounded failure into a bounded
 * one, without depending on any part of Obsidian's API being what we think.
 */
export const BACKLINKS_INDEX_MAX_AGE_MS = 60_000;

/**
 * How long the vault must stay quiet, once Obsidian's layout is up, before
 * link resolution is assumed to have settled without `resolved` saying so.
 *
 * `links`, `backlinks`, and `unresolvedLinks` are vault-global: which of the
 * first two a wikilink lands in depends on whether its *target* has been
 * indexed, and a backlink exists only once the file holding it has. Obsidian
 * announces the end of a vault-wide resolution pass with `resolved`, and that
 * is the signal {@link VaultOperations.isLinkIndexReady} trusts. But a pass
 * that finished before this plugin loaded -- the normal case for a toggle, a
 * community-plugins reload, or a dev rebuild -- was announced to nobody, and
 * waiting for the next one would mean answering null until the vault changed.
 * Silence is the only evidence such a vault offers, so after this much of it
 * the pass is taken as complete. Before `workspace.layoutReady` silence proves
 * nothing: a cold Obsidian may still be loading its persisted cache.
 *
 * It also bounds the other direction. Should some change fail to be followed
 * by a `resolved` -- an event Obsidian stops sending, an internal path that
 * resolves without announcing it -- the fields are null for this long after
 * the last announcement rather than for the rest of the session.
 */
export const LINK_INDEX_SETTLE_MS = 5000;

/**
 * Writes go through Vault.modify/Vault.create rather than Vault.adapter.write.
 *
 * The adapter writes straight to disk, behind Obsidian's back: the change is only
 * noticed later, by the file watcher. Until it is, metadataCache still describes the
 * previous revision, and because getFileMetadataObject serves frontmatter and tags
 * from that cache, a client that wrote and immediately read back could be handed
 * pre-write metadata. Going through the Vault API keeps Obsidian's own bookkeeping in
 * step with the write instead of racing it.
 */
export class VaultOperations {
  private cachedBacklinksIndex: Record<string, string[]> | null = null;
  private cachedBacklinksIndexBuiltAt = 0;

  /**
   * Whether Obsidian has announced the end of a vault-wide resolution pass
   * (`resolved`) with no change announced since. Not a latch: any later
   * announcement clears it, because a pass is in flight again and the link
   * graph is mid-rewrite -- during a rename, precisely the moment a client
   * repairing links most needs to be told the answer is provisional.
   */
  private linkIndexSettled = false;
  /** When Obsidian last announced anything; see {@link LINK_INDEX_SETTLE_MS}. */
  private linkIndexLastActivityAt = Date.now();

  /**
   * Called whenever Obsidian says anything has happened, other than that
   * resolution has finished.
   *
   * Deliberately one handler for every announcement rather than a targeted
   * update per event: rebuilding is the same work the uncached code did on
   * every request, so an invalidation too many costs a scan we were paying for
   * anyway, while one too few serves a client stale backlinks. Readiness is
   * handled the same way, for the same reason: every announcement means the
   * graph may be about to move, and reopening the window too often costs a
   * client a retry, while reopening it too seldom hands them a partial graph
   * labelled as complete.
   */
  private readonly onVaultActivity = (): void => {
    this.cachedBacklinksIndex = null;
    this.linkIndexSettled = false;
    this.linkIndexLastActivityAt = Date.now();
  };

  /**
   * `vault modify` alone: counted as activity only for a file the metadata
   * cache indexes.
   *
   * Only a change to a file Obsidian parses is followed by a `resolved` to
   * close the window again. An attachment, a drawing, a plugin's data file
   * being rewritten starts no resolution pass, so treating it as activity
   * would hold the link fields at null for LINK_INDEX_SETTLE_MS each time
   * with nothing in the graph changed -- and a file that autosaves every few
   * seconds would hold them there for good. The backlinks cache is still
   * dropped, since that costs a scan rather than a client's trust. `create`,
   * `delete`, and `rename` stay unconditional: a path of any type appearing
   * or vanishing can flip a link between resolved and unresolved.
   */
  private readonly onVaultModify = (file: TAbstractFile): void => {
    if (file instanceof TFile && file.extension === "md") {
      this.onVaultActivity();
    } else {
      this.cachedBacklinksIndex = null;
    }
  };

  /** Called when Obsidian announces a vault-wide resolution pass has finished. */
  private readonly onLinksResolved = (): void => {
    this.cachedBacklinksIndex = null;
    this.linkIndexSettled = true;
  };

  constructor(readonly app: App, readonly settings: LocalRestApiSettings) {
    this.app.metadataCache.on("resolved", this.onLinksResolved);
    for (const event of METADATA_CACHE_ACTIVITY_EVENTS) {
      this.app.metadataCache.on(event as "changed", this.onVaultActivity);
    }
    this.app.vault.on("modify", this.onVaultModify);
    for (const event of VAULT_EVENTS) {
      if (event !== "modify") this.app.vault.on(event as "create", this.onVaultActivity);
    }
    // Quiet before the layout is up proves nothing (see LINK_INDEX_SETTLE_MS),
    // so the period only starts counting from there. Obsidian calls this at
    // once when the layout is already ready.
    this.app.workspace.onLayoutReady(() => {
      this.linkIndexLastActivityAt = Date.now();
    });

    jsonLogic.add_operation(
      "glob",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          return WildcardRegexp(pattern).test(field);
        }
        return false;
      },
    );
    jsonLogic.add_operation(
      "regexp",
      (pattern: string | undefined, field: string | undefined) => {
        if (typeof field === "string" && typeof pattern === "string") {
          return new RegExp(pattern).test(field);
        }
        return false;
      },
    );
  }

  /**
   * Releases the link-graph listeners registered in the constructor.
   *
   * This object lives as long as the plugin does, so this matters only at
   * unload -- but a listener left behind holds the whole instance alive and
   * goes on invalidating a cache nobody will read again.
   */
  dispose(): void {
    this.app.metadataCache.off("resolved", this.onLinksResolved);
    for (const event of METADATA_CACHE_ACTIVITY_EVENTS) {
      this.app.metadataCache.off(event, this.onVaultActivity);
    }
    this.app.vault.off("modify", this.onVaultModify);
    for (const event of VAULT_EVENTS) {
      if (event !== "modify") this.app.vault.off(event, this.onVaultActivity);
    }
  }

  /**
   * Whether `links`, `backlinks`, and `unresolvedLinks` can currently be
   * trusted to describe the whole vault.
   *
   * True when Obsidian has announced the end of a vault-wide resolution pass
   * and nothing since, or -- for a vault whose last pass finished before this
   * plugin was listening -- when the vault has been quiet for
   * {@link LINK_INDEX_SETTLE_MS} with the layout up. Recomputed on every call
   * rather than cached as a verdict, so it cannot go stale between
   * announcements.
   *
   * Callers serving link fields sample this *after* reading them: a change
   * announced between the read and the sample makes the sample false, which
   * errs towards null rather than towards an array read from a moving graph.
   */
  isLinkIndexReady(): boolean {
    if (this.linkIndexSettled) return true;
    return (
      this.app.workspace.layoutReady &&
      Date.now() - this.linkIndexLastActivityAt >= LINK_INDEX_SETTLE_MS
    );
  }

  /** Refuse a client-supplied path this API is not allowed to touch.
   *
   *  Every caller -- the REST handler, the MCP tools, a plugin holding the
   *  extension API -- funnels through this class, so the authorization decision
   *  lives here as well as at each boundary. The boundaries exist to give a
   *  caller a well-shaped error (a 400/403 with an errorCode, a legible MCP tool
   *  error); this exists so that a boundary someone forgets to guard cannot reach
   *  the filesystem. Two rules apply:
   *
   *  - The path must stay inside the vault root (see ./vaultPath for why
   *    Obsidian's own API does not enforce this).
   *  - The path must not be inside Obsidian's configuration directory unless the
   *    operator has turned that on. Writing there is code execution (Obsidian
   *    evals an enabled plugin's main.js) and reading there leaks secrets such as
   *    this plugin's own API key; see GHSA-66m9-r757-qvq7. */
  private assertContained(filePath: string, label = "Path"): void {
    assertVaultPathIsContained(filePath, label);
    assertConfigDirAccessAllowed(
      filePath,
      this.app.vault.configDir,
      this.settings.enableConfigDirAccess ?? false,
      label,
      onDiskAccessFor(this.app.vault.adapter),
    );
  }

  /** The indexed markdown files a bulk read -- a search, the tag census -- may
   *  touch: everything Obsidian indexes, minus whatever lives in the
   *  configuration directory. Obsidian never indexes a dot-directory itself, so
   *  a config-dir file only gets here through a symlink the owner planted in the
   *  vault; a direct read of that path is refused, and a search handing its
   *  contents out instead would be the same disclosure by another route. The
   *  matcher is built once per call so the whole index costs one on-disk lookup
   *  per directory, not per file. */
  private readableMarkdownFiles(): TFile[] {
    const files = this.app.vault.getMarkdownFiles();
    if (this.settings.enableConfigDirAccess) return files;
    const inConfigDir = configDirMatcher(
      this.app.vault.configDir,
      onDiskAccessFor(this.app.vault.adapter),
      this.linkMemo,
    );
    const readable = files.filter(
      (file) => !inConfigDir(file.path, `${file.stat.ctime}:${file.stat.mtime}:${file.stat.size}`),
    );
    // Forget files that have left the index, so the memo tracks the vault's
    // size rather than its history.
    if (this.linkMemo.size > files.length * 2) {
      const current = new Set(files.map((file) => file.path));
      for (const key of this.linkMemo.keys()) {
        if (!current.has(key)) this.linkMemo.delete(key);
      }
    }
    return readable;
  }

  /** What {@link readableMarkdownFiles} remembers between searches: whether each
   *  indexed file is a symlink, keyed by the file's literal path and valid while
   *  its indexed ctime/mtime/size are unchanged. See {@link configDirMatcher}. */
  private readonly linkMemo: LinkMemo = new Map();

  /** The gate for an operation that creates or removes an *entry* -- a move,
   *  a copy, a delete -- rather than reading or writing a file's contents.
   *
   *  {@link assertContained} follows a symlink to its target, which is right
   *  for a read or a content write: those act on the target. But an entry is
   *  created or removed in its *parent*, and a symlink the owner planted inside
   *  the config dir that points back into the vault passes the target check
   *  while living somewhere this API may not touch: removing it removes a
   *  config-dir entry, and an overwrite would then create a real file at that
   *  spelling inside the config dir. So the parent is checked too, before
   *  anything is removed. */
  private assertEntryContained(filePath: string, label = "Path"): void {
    this.assertContained(filePath, label);
    const parent = path.posix.dirname(filePath);
    this.assertContained(parent === "." ? "" : parent, label);
  }

  /** Stat a path straight from the adapter, through the authorization gate.
   *
   *  The REST whole-file GET handler needs a raw stat to tell a file from a
   *  directory from a miss, and historically called `adapter.stat` directly --
   *  the one filesystem access that bypassed this class. Routing it here keeps
   *  this class the single place a path is authorized before it reaches disk. */
  async statPath(
    filePath: string,
  ): Promise<ReturnType<typeof this.app.vault.adapter.stat>> {
    this.assertContained(filePath);
    return this.app.vault.adapter.stat(filePath);
  }

  /** Read a path's raw bytes straight from the adapter, through the gate.
   *
   *  Unlike {@link readBinaryFileContent}, this does not require the path to be an
   *  indexed vault file: the REST GET handler has already confirmed it exists via
   *  {@link statPath} and may be serving a target-addressed path. It exists so that
   *  read, too, funnels through this class rather than touching the adapter
   *  directly. */
  async readBinaryPath(filePath: string): Promise<ArrayBuffer> {
    this.assertContained(filePath);
    return this.app.vault.adapter.readBinary(filePath);
  }

  private waitForFileCache(
    file: TFile,
    timeoutMs = 5000,
  ): Promise<CachedMetadata | null> {
    const existingCache = this.app.metadataCache.getFileCache(file);
    if (existingCache) {
      return Promise.resolve(existingCache);
    }

    return new Promise((resolve) => {
      let resolved = false;

      const onCacheChange = (...data: unknown[]) => {
        const changedFile = data[0];
        if (!(changedFile instanceof TFile)) return;
        if (changedFile.path === file.path && !resolved) {
          resolved = true;
          this.app.metadataCache.off("changed", onCacheChange);
          window.clearTimeout(timeoutId);
          resolve(this.app.metadataCache.getFileCache(file));
        }
      };

      const timeoutId = window.setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.app.metadataCache.off("changed", onCacheChange);
          console.warn(
            `[REST API] Timeout waiting for metadata cache for ${file.path} after ${timeoutMs}ms`,
          );
          resolve(this.app.metadataCache.getFileCache(file));
        }
      }, timeoutMs);

      this.app.metadataCache.on("changed", onCacheChange);

      const cacheAfterListener = this.app.metadataCache.getFileCache(file);
      if (cacheAfterListener && !resolved) {
        resolved = true;
        this.app.metadataCache.off("changed", onCacheChange);
        window.clearTimeout(timeoutId);
        resolve(cacheAfterListener);
      }
    });
  }

  async getDocumentMapObject(file: TFile): Promise<DocumentMapObject> {
    const content = await this.app.vault.adapter.read(file.path);
    const documentMap = getDocumentMap(content);

    return {
      headings: Object.keys(documentMap.heading)
        .filter((h) => h)
        .map((h) => h.split("\x1f").join("::")),
      blocks: Object.keys(documentMap.block),
      frontmatterFields: Object.keys(documentMap.frontmatter),
    };
  }

  /**
   * The markdown-patch 2.0 document map: headings nested by containment (each
   * heading text maps to its child headings; every occurrence of a repeated
   * sibling gets its own key, later ones carrying a reserved marker suffix),
   * block ids disambiguated the same way, frontmatter field names, and the
   * content-hash `version` token clients pass back as a patch `ifMatch`
   * precondition.
   */
  async getDocumentMapV2Object(file: TFile): Promise<PublicMap> {
    const content = await this.app.vault.adapter.read(file.path);
    return projectMap(buildModel(content));
  }

  /**
   * The markdown-patch 2.0 targeted read: resolve a `(targetType, target)`
   * address — a heading path array, a bare block id, or a frontmatter key — and
   * return the section body (headings/blocks) or parsed value (frontmatter).
   * Throws {@link TargetNotFoundError} when the address does not resolve.
   *
   * `content` lets a caller that has already read the file supply what it read,
   * rather than paying for a second read — MCP's `vault_read` decodes the raw
   * bytes itself so it can refuse a file that is not valid UTF-8, and passes the
   * result through here.
   */
  async readFileSectionMdp2(
    file: TFile,
    target: ReadTarget,
    content?: string,
  ): Promise<ReadResult> {
    const text = content ?? (await this.app.vault.adapter.read(file.path));
    return readTarget(text, target);
  }

  async readFileSection(
    file: TFile,
    targetType: string,
    target: string,
    targetDelimiter = "::",
  ): Promise<unknown> {
    const content = await this.app.vault.adapter.read(file.path);
    const documentMap = getDocumentMap(content);

    if (targetType === "frontmatter") {
      const value: unknown = documentMap.frontmatter[target];
      if (value === undefined)
        throw new Error(`Frontmatter key not found: ${target}`);
      return value;
    }

    const mapKey =
      targetType === "heading"
        ? target.split(targetDelimiter).join("\x1f")
        : target;

    const entry =
      targetType === "heading"
        ? documentMap.heading[mapKey]
        : documentMap.block[mapKey];

    if (!entry) throw new Error(`${targetType} not found: ${target}`);

    return content.substring(entry.content.start, entry.content.end);
  }

  /**
   * The vault-wide "who links here" index, built at most once per link-graph
   * change and, failing that, at most once per BACKLINKS_INDEX_MAX_AGE_MS.
   *
   * The age check is the half that does not trust Obsidian: the listeners drop
   * the index the moment anything is announced, and the ceiling makes sure an
   * announcement that never comes cannot keep a wrong answer in circulation.
   *
   * Callers doing bulk work should build one snapshot with this and thread it
   * through their loop (see `getFileMetadataObject`'s second argument), so that
   * every row of a result set describes the same moment even if the graph moves
   * mid-loop.
   */
  getBacklinksIndex(): Record<string, string[]> {
    const now = Date.now();
    if (
      this.cachedBacklinksIndex === null ||
      now - this.cachedBacklinksIndexBuiltAt >= BACKLINKS_INDEX_MAX_AGE_MS
    ) {
      this.cachedBacklinksIndex = this.buildBacklinksIndex();
      this.cachedBacklinksIndexBuiltAt = now;
    }
    return this.cachedBacklinksIndex;
  }

  buildBacklinksIndex(): Record<string, string[]> {
    const index: Record<string, string[]> = {};
    for (const [sourcePath, targets] of Object.entries(
      this.app.metadataCache.resolvedLinks,
    )) {
      for (const targetPath of Object.keys(targets)) {
        (index[targetPath] ??= []).push(sourcePath);
      }
    }
    return index;
  }

  /**
   * `content`, like {@link readFileSectionMdp2}'s, is content the caller has
   * already read: supplying it skips the `cachedRead` below. Ignored when
   * `includeContent` is false, since then nothing is read at all.
   */
  async getFileMetadataObject(
    file: TFile,
    backlinksIndex?: Record<string, string[]>,
    includeContent = true,
    content?: string,
  ): Promise<FileMetadataObject> {
    // A TFile came from the index, which only ever says the file exists -- not
    // that this API may read it. Gated here so a caller handing over a TFile it
    // found by other means is held to the same rule as one naming a path.
    this.assertContained(file.path);
    return this.metadataObjectFor(file, backlinksIndex, includeContent, content);
  }

  /** {@link getFileMetadataObject} without the gate, for {@link searchJsonLogic},
   *  which has already authorized every file it iterates in one pass. */
  private async metadataObjectFor(
    file: TFile,
    backlinksIndex?: Record<string, string[]>,
    includeContent = true,
    content?: string,
  ): Promise<FileMetadataObject> {
    const cache = await this.waitForFileCache(file);

    const frontmatter = { ...(cache?.frontmatter ?? {}) };
    delete frontmatter.position;

    const directTags = (cache?.tags ?? [])
      .filter((tag) => tag)
      .map((tag) => tag.tag);
    const frontmatterTags = Array.isArray(frontmatter.tags)
      ? (frontmatter.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const filteredTags: string[] = [...frontmatterTags, ...directTags]
      .filter((tag) => tag)
      .map((tag) => tag.replace(/^#/, ""))
      .filter((value, index, self) => self.indexOf(value) === index);

    const links = Object.keys(
      this.app.metadataCache.resolvedLinks[file.path] ?? {},
    );
    const unresolvedLinks = Object.keys(
      this.app.metadataCache.unresolvedLinks[file.path] ?? {},
    );

    const index = backlinksIndex ?? this.getBacklinksIndex();
    // Copied rather than handed out: the cached index outlives the response
    // built from it, so one caller mutating what it was given would otherwise
    // reach every caller after it.
    const backlinks = [...(index[file.path] ?? [])];

    // Sampled after the three reads above, and once for all three: see
    // isLinkIndexReady for why after, and the NoteJson docs for why together.
    const linkIndexReady = this.isLinkIndexReady();

    return {
      tags: filteredTags,
      frontmatter: frontmatter,
      stat: file.stat,
      path: file.path,
      content: includeContent
        ? (content ?? (await this.app.vault.cachedRead(file)))
        : "",
      links: linkIndexReady ? links : null,
      backlinks: linkIndexReady ? backlinks : null,
      unresolvedLinks: linkIndexReady ? unresolvedLinks : null,
    };
  }

  async renderFileToHtml(file: TFile, content?: string): Promise<string> {
    this.assertContained(file.path);
    const markdown = content ?? (await this.app.vault.cachedRead(file));
    const el = activeDocument.createElement("div");
    const component = new Component();
    component.load();
    try {
      await MarkdownRenderer.render(this.app, markdown, el, file.path, component);
      return el.innerHTML;
    } finally {
      component.unload();
    }
  }

  async resolvePathAndTarget(rawSegments: string[]): Promise<{
    filePath: string;
    targetType?: string;
    target?: string;
    // For a heading target, the raw path segments as an array (e.g. ["A", "B"]
    // for `.../heading/A/B`). Preserved alongside the `::`-joined `target` so the
    // 2.0 engine can address headings array-natively without a delimiter split
    // that a heading containing `::` would break.
    targetSegments?: string[];
  } | null> {
    // Segments arrive already split on the URL's *raw* slashes and decoded one
    // by one, so a `%2F` inside a segment is a literal `/` belonging to that
    // segment (a heading name), not a path boundary. Drop a trailing empty
    // segment left by a trailing slash.
    const segments =
      rawSegments.length > 0 && rawSegments[rawSegments.length - 1] === ""
        ? rawSegments.slice(0, -1)
        : rawSegments;
    if (segments.length === 0) return null;

    // The joined address is checked first so an escaping or refused address is
    // a no-match before anything is statted. That check does *not* cover the
    // prefixes the walk below stats: "notes/cfg/README.md/comments/../../../safe"
    // resolves to "notes/safe" and passes, while the walk would stat
    // "notes/cfg/README.md" -- a protected file if "cfg" is a symlink into the
    // config dir. So every stat goes through the gate (statPath), and a refused
    // candidate is a miss. A refusal is a no-match, not an error: both callers
    // (the REST GET and the sub-resource dispatcher) read null as "not a file
    // here", and the REST boundary has already sent its own 403 for anything
    // the joined check would refuse. Only a refusal is a miss, though: anything
    // else thrown while deciding is a fault, and swallowing it would hide it
    // behind a 404.
    try {
      this.assertContained(segments.join("/"));
    } catch (error) {
      if (error instanceof PathTraversalError || error instanceof ConfigDirAccessError) {
        return null;
      }
      throw error;
    }

    // A file or folder name cannot contain `/`, so a candidate file path is only
    // valid when none of its segments do. This is what keeps a decoded `%2F`
    // from re-forming a path separator: `folder%2Fnote.md` is a single segment
    // "folder/note.md", which can never be a file component and so never
    // resolves as one.
    const isFilePath = (parts: string[]): boolean =>
      parts.every((part) => !part.includes("/"));

    if (isFilePath(segments)) {
      let exactStat = null;
      try {
        exactStat = await this.statPath(segments.join("/"));
      } catch {
        // ENOTDIR: a path component is a file, not a directory;
        // fall through to the backward walk which will find the actual file.
      }
      if (exactStat?.type === "file") {
        return { filePath: segments.join("/") };
      }
    }

    for (let i = segments.length - 1; i >= 1; i--) {
      const prefix = segments.slice(0, i);
      if (!isFilePath(prefix)) continue;
      const candidate = prefix.join("/");
      let s = null;
      try {
        s = await this.statPath(candidate);
      } catch {
        // ENOTDIR, or a candidate the gate refused: either way not a file here.
        continue;
      }
      if (s?.type === "file") {
        const remainder = segments.slice(i);
        const targetType = remainder[0];
        const targetSegments =
          targetType === "heading" ? remainder.slice(1) : undefined;
        const target =
          targetType === "heading"
            ? remainder.slice(1).join("::")
            : remainder[1];
        return { filePath: candidate, targetType, target, targetSegments };
      }
    }

    return null;
  }

  async listVaultDirectory(dirPath: string): Promise<string[]> {
    this.assertContained(dirPath, "Directory path");
    const normalizedPath = dirPath.endsWith("/")
      ? dirPath.slice(0, -1)
      : dirPath;
    const prefix = normalizedPath ? normalizedPath + "/" : "";
    const files = [
      ...new Set(
        this.app.vault
          .getFiles()
          .map((e) => e.path)
          .filter((filename) => filename.startsWith(prefix))
          .map((filename) => {
            const subPath = filename.slice(prefix.length);
            if (subPath.indexOf("/") > -1) {
              return subPath.slice(0, subPath.indexOf("/") + 1);
            }
            return subPath;
          }),
      ),
    ];
    files.sort();
    return files;
  }

  async readFileContent(filePath: string): Promise<string> {
    this.assertContained(filePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return this.app.vault.read(file);
  }

  // Reads a file as raw bytes rather than decoding it as UTF-8, which is what
  // `readFileContent` above (and `cachedRead` behind `getFileMetadataObject`) does. The
  // REST layer reaches for `adapter.readBinary` directly; MCP goes through here so the
  // "does this file exist" answer is the same one `vault_read` gives.
  async readBinaryFileContent(filePath: string): Promise<ArrayBuffer> {
    this.assertContained(filePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return this.app.vault.adapter.readBinary(filePath);
  }

  async writeFileContent(
    filePath: string,
    content: string | Buffer,
  ): Promise<void> {
    this.assertContained(filePath);
    try {
      await this.app.vault.createFolder(path.dirname(filePath));
    } catch {
      // folder already exists
    }
    if (typeof content === "string") {
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(filePath, content);
      }
    } else {
      await this.app.vault.adapter.writeBinary(
        filePath,
        toArrayBuffer(content),
      );
    }
  }

  async appendFileContent(filePath: string, content: string): Promise<void> {
    this.assertContained(filePath);
    try {
      await this.app.vault.createFolder(path.dirname(filePath));
    } catch {
      // folder already exists
    }
    let fileContents = "";
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      fileContents = await this.app.vault.read(file);
      if (!fileContents.endsWith("\n")) {
        fileContents += "\n";
      }
      fileContents += content;
      await this.app.vault.modify(file, fileContents);
      return;
    }
    await this.app.vault.create(filePath, content);
  }

  async deleteVaultFile(filePath: string, permanent = false): Promise<void> {
    this.assertEntryContained(filePath);
    if (permanent) {
      const pathExists = await this.app.vault.adapter.exists(filePath);
      if (!pathExists) {
        throw new FileNotFoundError(`File not found: ${filePath}`);
      }
      await this.app.vault.adapter.remove(filePath);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) {
      throw new FileNotFoundError(`File not found: ${filePath}`);
    }
    await this.app.fileManager.trashFile(file);
  }

  async moveVaultFile(
    sourcePath: string,
    destinationPath: string,
    allowOverwrite = false,
  ): Promise<string> {
    this.assertEntryContained(sourcePath, "Source path");
    this.assertEntryContained(destinationPath, "Destination path");
    if (!destinationPath) {
      throw new Error("Destination path must not be empty.");
    }

    if (sourcePath === destinationPath) {
      return sourcePath;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) {
      throw new FileNotFoundError(`File not found: ${sourcePath}`);
    }

    const destExists = await this.app.vault.adapter.exists(destinationPath);
    if (destExists) {
      if (!allowOverwrite) {
        throw new DestinationAlreadyExistsError(
          `Destination already exists: ${destinationPath}`,
        );
      }
      await this.app.vault.adapter.remove(destinationPath);
    }

    const parentDir = destinationPath.substring(
      0,
      destinationPath.lastIndexOf("/"),
    );
    if (parentDir && !(await this.app.vault.adapter.exists(parentDir))) {
      await this.app.vault.createFolder(parentDir);
    }

    // @ts-ignore - fileManager exists at runtime but not in type definitions
    await this.app.fileManager.renameFile(sourceFile, destinationPath);
    return sourceFile.path;
  }

  async copyVaultFile(
    sourcePath: string,
    destinationPath: string,
    allowOverwrite = false,
  ): Promise<string> {
    this.assertEntryContained(sourcePath, "Source path");
    this.assertEntryContained(destinationPath, "Destination path");
    if (!destinationPath) {
      throw new Error("Destination path must not be empty.");
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) {
      throw new FileNotFoundError(`File not found: ${sourcePath}`);
    }

    if (sourcePath === destinationPath) {
      throw new DestinationAlreadyExistsError(
        `Destination already exists: ${destinationPath}`,
      );
    }

    const destExists = await this.app.vault.adapter.exists(destinationPath);
    if (destExists) {
      if (!allowOverwrite) {
        throw new DestinationAlreadyExistsError(
          `Destination already exists: ${destinationPath}`,
        );
      }
      await this.app.vault.adapter.remove(destinationPath);
    }

    const parentDir = destinationPath.substring(
      0,
      destinationPath.lastIndexOf("/"),
    );
    if (parentDir && !(await this.app.vault.adapter.exists(parentDir))) {
      await this.app.vault.createFolder(parentDir);
    }

    const copiedFile = await this.app.vault.copy(sourceFile, destinationPath);
    return copiedFile.path;
  }

  // Throws PatchFailed on patch error; caller is responsible for mapping to
  // the appropriate HTTP error code or MCP error.
  async patchFileSection(
    filePath: string,
    targetType: PatchTargetType,
    target: string,
    operation: PatchOperation,
    content: unknown,
    contentType: string,
    options?: {
      createTargetIfMissing?: boolean;
      rejectIfContentPreexists?: boolean;
      trimTargetWhitespace?: boolean;
      targetDelimiter?: string;
      targetScope?: string;
    },
  ): Promise<string> {
    this.assertContained(filePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new FileNotFoundError(`File not found: ${filePath}`);
    }
    const fileContents = await this.app.vault.read(file);

    const delimiter = options?.targetDelimiter ?? "::";
    const resolvedTarget: string | string[] =
      targetType === "heading" ? target.split(delimiter) : target;

    const instruction: PatchInstruction = {
      operation,
      targetType,
      target: resolvedTarget,
      contentType,
      content,
      rejectIfContentPreexists: options?.rejectIfContentPreexists ?? false,
      trimTargetWhitespace: options?.trimTargetWhitespace ?? false,
      createTargetIfMissing: options?.createTargetIfMissing ?? false,
      ...(options?.targetScope ? { targetScope: options.targetScope } : {}),
    } as PatchInstruction;

    const patched = applyPatch(fileContents, instruction);
    await this.app.vault.modify(file, patched);
    return patched;
  }

  // Applies a single markdown-patch 2.0 instruction and writes the result.
  // ("Mdp2" = markdown-patch 2.0, not the removed API version 2.0 PATCH.)
  // Throws FileNotFoundError when the file is missing; lets the 2.0 engine's
  // typed errors (TargetNotFoundError, PreconditionFailedError, …) propagate for
  // the caller to map to HTTP responses. Returns the patched document alongside
  // any advisory warnings the engine surfaced (e.g. heading-depth overflow).
  async patchFileSectionMdp2(
    filePath: string,
    instruction: InstructionInput,
  ): Promise<PatchResult> {
    this.assertContained(filePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new FileNotFoundError(`File not found: ${filePath}`);
    }
    const fileContents = await this.app.vault.read(file);
    const result = patchV2(fileContents, instruction);
    await this.app.vault.modify(file, result.document);
    return result;
  }

  async simpleSearch(
    query: string,
    contextLength = 100,
  ): Promise<SearchResponseItem[]> {
    const results: SearchResponseItem[] = [];
    const search = prepareSimpleSearch(query);

    for (const file of this.readableMarkdownFiles()) {
      const cachedContents = await this.app.vault.cachedRead(file);

      const filenamePrefix = file.basename + "\n\n";
      const result = search(filenamePrefix + cachedContents);
      const positionOffset = filenamePrefix.length;

      if (result) {
        const contextMatches: SearchContext[] = [];
        for (const match of result.matches) {
          if (match[0] < positionOffset && match[1] <= positionOffset) {
            contextMatches.push({
              match: {
                start: match[0],
                end: Math.min(match[1], file.basename.length),
                source: "filename",
              },
              context: file.basename,
            });
          } else if (match[0] >= positionOffset) {
            contextMatches.push({
              match: {
                start: match[0] - positionOffset,
                end: match[1] - positionOffset,
                source: "content",
              },
              context: cachedContents.slice(
                ...this.widenToCodePointBoundaries(
                  cachedContents,
                  Math.max(match[0] - positionOffset - contextLength, 0),
                  match[1] - positionOffset + contextLength,
                ),
              ),
            });
          }
        }

        results.push({
          filename: file.path,
          score: result.score,
          matches: contextMatches,
        });
      }
    }

    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return results;
  }

  async searchJsonLogic(
    query: unknown,
  ): Promise<SearchJsonResponseItem[]> {
    const results: SearchJsonResponseItem[] = [];
    const backlinksIndex = this.getBacklinksIndex();
    const includeContent = JSON.stringify(query).includes('"content"');

    for (const file of this.readableMarkdownFiles()) {
      const fileContext = await this.metadataObjectFor(file, backlinksIndex, includeContent);

      try {
        const fileResult = jsonLogic.apply(query, fileContext);

        if (this.isTruthy(fileResult)) {
          results.push({ filename: file.path, result: fileResult });
        }
      } catch (e) {
        const error = e as Error;
        throw new Error(`${error.message} (while processing ${file.path})`);
      }
    }

    return results;
  }

  private isTruthy(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
  }

  /**
   * Widen a `[start, end)` UTF-16 code-unit range in `text` so that neither
   * end falls between the two halves of a surrogate pair. `String.prototype.slice`
   * works in code units, so a window computed from `contextLength` can bisect a
   * non-BMP character such as an emoji and hand back an unpaired surrogate
   * (e.g. `\udd0c`), which cannot be encoded as UTF-8. The range is only ever
   * grown, by at most one code unit per side: a `start` on a low surrogate
   * moves back to include its high surrogate, and an `end` just past a high
   * surrogate moves forward to include its low surrogate. Out-of-range bounds
   * and boundaries already on a whole code point are returned unchanged.
   * Lone surrogates already present in `text` are not repaired.
   *
   * This is deliberately not `String.prototype.toWellFormed()` (ES2024). That
   * method operates on an already-sliced string, so the missing half of the
   * pair is gone by the time it runs and the character cannot be recovered;
   * it substitutes U+FFFD (`\ufffd`) for each lone surrogate instead, which
   * would put a visible replacement character into user-facing search context
   * where the original emoji belongs. Widening the range before slicing keeps
   * the whole character.
   *
   * @param text The string the range indexes into.
   * @param start Inclusive start offset, in UTF-16 code units.
   * @param end Exclusive end offset, in UTF-16 code units.
   * @returns The `[start, end)` pair, widened where necessary, suitable for
   *   spreading into `text.slice`.
   */
  private widenToCodePointBoundaries(
    text: string,
    start: number,
    end: number,
  ): [number, number] {
    let widenedStart = start;
    if (widenedStart > 0 && widenedStart < text.length) {
      const codeUnit = text.charCodeAt(widenedStart);
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        widenedStart -= 1;
      }
    }
    let widenedEnd = end;
    if (widenedEnd > 0 && widenedEnd < text.length) {
      const codeUnit = text.charCodeAt(widenedEnd - 1);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        widenedEnd += 1;
      }
    }
    return [widenedStart, widenedEnd];
  }

  getAllTags(): Array<{ name: string; count: number }> {
    const tagCounts: Record<string, number> = {};
    for (const file of this.readableMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      const fileTags = getAllTags(cache);
      if (!fileTags) continue;
      for (const rawTag of fileTags) {
        const tag = rawTag.startsWith("#") ? rawTag.slice(1) : rawTag;
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        const parts = tag.split("/");
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          tagCounts[parent] = (tagCounts[parent] || 0) + 1;
        }
      }
    }
    const tags: { name: string; count: number }[] = [];
    for (const [tag, count] of Object.entries(tagCounts)) {
      if (!tag) continue;
      tags.push({ name: tag, count });
    }
    return tags;
  }

  listCommands(): Command[] {
    const commands: Command[] = [];
    for (const commandName in this.app.commands.commands) {
      commands.push({
        id: commandName,
        name: this.app.commands.commands[commandName].name,
      });
    }
    return commands;
  }

  executeCommand(commandId: string): void {
    const cmd = this.app.commands.commands[commandId];
    if (!cmd) {
      throw new CommandNotFoundError(`Command not found: ${commandId}`);
    }
    this.app.commands.executeCommandById(commandId);
  }

  openVaultFile(filePath: string, newLeaf = false): void {
    this.assertContained(filePath);
    // Intentionally fire-and-forget: the caller (POST /open/) has already
    // responded by the time this settles, since a client asking Obsidian to
    // focus a file has no reason to wait on that UI action finishing. The
    // rejection still needs a home, though -- an un-awaited promise with no
    // .catch is an unhandled rejection the moment openLinkText throws (e.g.
    // an invalid path), and while that's non-fatal in Obsidian's renderer
    // process, it's still an unexplained error with nothing to explain it.
    this.app.workspace.openLinkText(filePath, "/", newLeaf).catch((error) => {
      console.error(`[REST API] Failed to open "${filePath}":`, error);
    });
  }
}
