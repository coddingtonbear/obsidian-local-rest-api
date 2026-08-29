import {
  getAllTags,
  App,
  CachedMetadata,
  Command,
  Component,
  MarkdownRenderer,
  prepareSimpleSearch,
  TFile,
} from "obsidian";
import type { Events } from "obsidian";
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

/**
 * How long a built backlinks index may be served before it is rebuilt anyway.
 *
 * Trigger interception (see `interceptTriggers`) covers everything Obsidian
 * announces, whatever the announcement is called. What it cannot cover is a
 * change that announces nothing at all -- an internal path that rewrites
 * `resolvedLinks` in silence -- which would otherwise leave a stale index in
 * place for as long as the plugin runs. Ageing the index out turns that
 * unbounded failure into a bounded one without depending on any part of
 * Obsidian's API being what we think it is.
 *
 * The ceiling is the backstop, not the mechanism, so it is set where it costs
 * least: a rebuild scans the vault's whole link graph, measured at ~5 ms for a
 * 9,000-note vault and ~16 ms at four times that, and it runs on the same
 * thread as Obsidian's UI. A minute keeps that off the critical path of a
 * sustained read load entirely, while still bounding a silent change at a
 * minute rather than a session.
 */
export const BACKLINKS_INDEX_MAX_AGE_MS = 60_000;

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

  private readonly restoreTriggers: (() => void)[] = [];

  /**
   * Dropped whenever Obsidian says anything at all has happened.
   *
   * Deliberately one handler for every announcement rather than a targeted
   * update per event: rebuilding is the same work the uncached code did on
   * every request, so an invalidation too many costs a scan we were paying for
   * anyway, while one too few serves a client stale backlinks.
   */
  private readonly invalidateBacklinksIndex = (): void => {
    this.cachedBacklinksIndex = null;
  };

  constructor(readonly app: App, readonly settings: LocalRestApiSettings) {
    this.interceptTriggers(this.app.metadataCache);
    this.interceptTriggers(this.app.vault);

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
   * Drops the cached backlinks index on any event the emitter publishes, named
   * or not.
   *
   * Subscribing with `on` can only name events that exist when the name is
   * written, which makes the subscription list a bet that no future Obsidian
   * release adds an event that moves `resolvedLinks` -- a bet that loses
   * silently, by serving backlinks from a graph that no longer exists.
   * `Events.trigger` is the one point every published event passes through on
   * its way to those subscribers, so wrapping it is the same coverage with no
   * list to keep correct.
   *
   * Two constraints come with replacing a method on an object the whole
   * application shares. The wrapper must be transparent -- same arguments, same
   * return, and it cannot throw, which is why the work it does is a single
   * assignment. And it must unwind politely: another plugin may wrap the same
   * method afterwards, so `dispose` only restores while ours is still the
   * outermost wrapper (see below).
   *
   * The wrapper is an own property of the instance, so nothing else deriving
   * from `Events` is affected.
   */
  private interceptTriggers(emitter: Events): void {
    const hadOwnTrigger = Object.hasOwn(emitter, "trigger");

    // The method reference below is held only to be reinstalled, and is invoked
    // through .call(emitter), so the `this` the rule guards against losing is
    // supplied explicitly. Binding it instead would satisfy the linter, but this
    // project compiles without strictBindCallApply, under which bind() returns
    // `any` -- trading one suppressed rule for three unsafe-any errors.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = emitter.trigger;
    const wrapped = (name: string, ...data: unknown[]): void => {
      this.invalidateBacklinksIndex();
      original.call(emitter, name, ...data);
    };
    emitter.trigger = wrapped;

    this.restoreTriggers.push(() => {
      // Someone else's wrapper on top of ours: unwinding would take theirs with
      // it, and leaving ours in place is the lesser of those two.
      if (emitter.trigger !== wrapped) return;

      if (hadOwnTrigger) {
        emitter.trigger = original;
      } else {
        // Deleting rather than assigning leaves the object exactly as found,
        // with `trigger` resolving to the prototype again.
        delete (emitter as { trigger?: Events["trigger"] }).trigger;
      }
    });
  }

  /**
   * Puts back the `trigger` methods intercepted in the constructor.
   *
   * This object lives as long as the plugin does, so this matters only at
   * unload -- but the emitters outlive it, and a wrapper left on one holds the
   * whole instance alive and goes on invalidating a cache nobody will read.
   */
  dispose(): void {
    for (const restore of this.restoreTriggers) {
      restore();
    }
    this.restoreTriggers.length = 0;
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
   */
  async readFileSectionMdp2(
    file: TFile,
    target: ReadTarget,
  ): Promise<ReadResult> {
    const content = await this.app.vault.adapter.read(file.path);
    return readTarget(content, target);
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
   * The age check is the half that does not trust Obsidian: interception drops
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

  async getFileMetadataObject(
    file: TFile,
    backlinksIndex?: Record<string, string[]>,
    includeContent = true,
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

    return {
      tags: filteredTags,
      frontmatter: frontmatter,
      stat: file.stat,
      path: file.path,
      content: includeContent ? await this.app.vault.cachedRead(file) : "",
      links,
      backlinks,
      unresolvedLinks,
    };
  }

  async renderFileToHtml(file: TFile, content?: string): Promise<string> {
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
        exactStat = await this.app.vault.adapter.stat(segments.join("/"));
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
        s = await this.app.vault.adapter.stat(candidate);
      } catch {
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
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return this.app.vault.read(file);
  }

  async writeFileContent(
    filePath: string,
    content: string | Buffer,
  ): Promise<void> {
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

    for (const file of this.app.vault.getMarkdownFiles()) {
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

    for (const file of this.app.vault.getMarkdownFiles()) {
      const fileContext = await this.getFileMetadataObject(file, backlinksIndex, includeContent);

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
    for (const file of this.app.vault.getMarkdownFiles()) {
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
    void this.app.workspace.openLinkText(filePath, "/", newLeaf);
  }
}
