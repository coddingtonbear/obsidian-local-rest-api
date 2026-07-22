import {
  getAllTags,
  App,
  CachedMetadata,
  Command,
  prepareSimpleSearch,
  TFile,
} from "obsidian";
import * as periodicNotes from "obsidian-daily-notes-interface";
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
 
const jsonLogic = require("json-logic-js") as {
  apply: (logic: unknown, data?: unknown) => unknown;
  add_operation: (name: string, code: (...args: unknown[]) => unknown) => void;
};
 
const WildcardRegexp = require("glob-to-regexp") as (pattern: string) => RegExp;

export class FileNotFoundError extends Error {}
export class CommandNotFoundError extends Error {}
export class DestinationAlreadyExistsError extends Error {}

import {
  DocumentMapObject,
  ErrorCode,
  FileMetadataObject,
  PeriodicNoteInterface,
  SearchContext,
  SearchJsonResponseItem,
  SearchResponseItem,
} from "./types";
import { toArrayBuffer } from "./utils";

export class VaultOperations {
  constructor(readonly app: App) {
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
   * heading text maps to its child headings; a repeated sibling keeps its first
   * occurrence), bare block ids, frontmatter field names, and the content-hash
   * `version` token clients pass back as a patch `ifMatch` precondition.
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

    const index = backlinksIndex ?? this.buildBacklinksIndex();
    const backlinks = index[file.path] ?? [];

    return {
      tags: filteredTags,
      frontmatter: frontmatter,
      stat: file.stat,
      path: file.path,
      content: includeContent ? await this.app.vault.cachedRead(file) : "",
      links,
      backlinks,
    };
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
      await this.app.vault.adapter.write(filePath, content);
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
    }
    fileContents += content;
    await this.app.vault.adapter.write(filePath, fileContents);
  }

  async deleteVaultFile(filePath: string): Promise<void> {
    const pathExists = await this.app.vault.adapter.exists(filePath);
    if (!pathExists) {
      throw new FileNotFoundError(`File not found: ${filePath}`);
    }
    await this.app.vault.adapter.remove(filePath);
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
    await this.app.vault.adapter.write(filePath, patched);
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
    await this.app.vault.adapter.write(filePath, result.document);
    return result;
  }

  getPeriodicNoteInterface(): Record<string, PeriodicNoteInterface> {
    return {
      daily: {
        settings: periodicNotes.getDailyNoteSettings(),
        loaded: periodicNotes.appHasDailyNotesPluginLoaded(),
        create: periodicNotes.createDailyNote,
        get: periodicNotes.getDailyNote,
        getAll: periodicNotes.getAllDailyNotes,
      },
      weekly: {
        settings: periodicNotes.getWeeklyNoteSettings(),
        loaded: periodicNotes.appHasWeeklyNotesPluginLoaded(),
        create: periodicNotes.createWeeklyNote,
        get: periodicNotes.getWeeklyNote,
        getAll: periodicNotes.getAllWeeklyNotes,
      },
      monthly: {
        settings: periodicNotes.getMonthlyNoteSettings(),
        loaded: periodicNotes.appHasMonthlyNotesPluginLoaded(),
        create: periodicNotes.createMonthlyNote,
        get: periodicNotes.getMonthlyNote,
        getAll: periodicNotes.getAllMonthlyNotes,
      },
      quarterly: {
        settings: periodicNotes.getQuarterlyNoteSettings(),
        loaded: periodicNotes.appHasQuarterlyNotesPluginLoaded(),
        create: periodicNotes.createQuarterlyNote,
        get: periodicNotes.getQuarterlyNote,
        getAll: periodicNotes.getAllQuarterlyNotes,
      },
      yearly: {
        settings: periodicNotes.getYearlyNoteSettings(),
        loaded: periodicNotes.appHasYearlyNotesPluginLoaded(),
        create: periodicNotes.createYearlyNote,
        get: periodicNotes.getYearlyNote,
        getAll: periodicNotes.getAllYearlyNotes,
      },
    };
  }

  periodicGetInterface(
    period: string,
  ): [PeriodicNoteInterface | null, ErrorCode | null] {
    const periodic = this.getPeriodicNoteInterface();
    if (!periodic[period]) {
      return [null, ErrorCode.PeriodDoesNotExist];
    }
    if (!periodic[period].loaded) {
      return [null, ErrorCode.PeriodIsNotEnabled];
    }
    return [periodic[period], null];
  }

  periodicGetNote(
    periodName: string,
    timestamp: number,
  ): [TFile | null, ErrorCode | null] {
    const [period, err] = this.periodicGetInterface(periodName);
    if (err || !period) {
      return [null, err ?? ErrorCode.PeriodDoesNotExist];
    }
    const now = window.moment(timestamp);
    const all = period.getAll();

    const file = period.get(now, all);
    if (!file) {
      return [null, ErrorCode.PeriodicNoteDoesNotExist];
    }
    return [file, null];
  }

  async periodicGetOrCreateNote(
    periodName: string,
    timestamp: number,
  ): Promise<[TFile | null, ErrorCode | null]> {
    const [gottenFile, err] = this.periodicGetNote(periodName, timestamp);
    let file = gottenFile;
    if (err === ErrorCode.PeriodicNoteDoesNotExist) {
      const [period] = this.periodicGetInterface(periodName);
      if (!period) {
        return [null, ErrorCode.PeriodDoesNotExist];
      }
      const now = window.moment(Date.now());

      file = await period.create(now);
      await this.waitForFileCache(file);
    } else if (err) {
      return [null, err];
    }

    return [file, null];
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
                Math.max(match[0] - positionOffset - contextLength, 0),
                match[1] - positionOffset + contextLength,
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
    const backlinksIndex = this.buildBacklinksIndex();
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
