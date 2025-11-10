import { App, Notice, TFile, normalizePath } from "obsidian";
import { StructuredExtractor, StructuredContent } from "./structuredExtractor";
import * as path from "path";
import * as crypto from "crypto";
import pdfParse from "pdf-parse";

export interface CacheMetadata {
  sourcePath: string;
  sourceHash: string;
  vaultMtime: number;
  renderedAt: number;
  pdfSize: number;
  textSize: number;
}

export interface CacheIndex {
  [fileHash: string]: CacheMetadata;
}

export interface RenderCacheSettings {
  cacheDirectory: string;
  maxCacheSizeMB: number;
  autoCleanup: boolean;
  renderTimeoutMs: number;
}

export class RenderCacheManager {
  app: App;
  settings: RenderCacheSettings;
  cacheIndex: CacheIndex;
  cacheIndexPath: string;
  structuredExtractor: StructuredExtractor;

  constructor(app: App, settings: RenderCacheSettings) {
    this.app = app;
    this.settings = settings;
    this.cacheIndex = {};
    this.cacheIndexPath = normalizePath(
      path.join(settings.cacheDirectory, "CacheIndex.json")
    );
    this.structuredExtractor = new StructuredExtractor();
  }

  async initialize(): Promise<void> {
    // Ensure cache directory exists
    try {
      await this.app.vault.adapter.mkdir(this.settings.cacheDirectory);
    } catch (error) {
      // Directory might already exist, that's fine
    }

    // Load cache index
    await this.loadCacheIndex();
  }

  private async loadCacheIndex(): Promise<void> {
    try {
      const indexData = await this.app.vault.adapter.read(this.cacheIndexPath);
      this.cacheIndex = JSON.parse(indexData);
    } catch (error) {
      // Index doesn't exist yet or is corrupted
      this.cacheIndex = {};
      await this.saveCacheIndex();
    }
  }

  private async saveCacheIndex(): Promise<void> {
    const indexData = JSON.stringify(this.cacheIndex, null, 2);
    await this.app.vault.adapter.write(this.cacheIndexPath, indexData);
  }

  private getFileHash(content: string): string {
    return crypto.createHash("md5").update(content).digest("hex");
  }

  private getCachePath(fileHash: string, extension: string): string {
    return normalizePath(
      path.join(this.settings.cacheDirectory, fileHash, `note.${extension}`)
    );
  }

  async isCacheValid(file: TFile): Promise<boolean> {
    const content = await this.app.vault.cachedRead(file);
    const fileHash = this.getFileHash(content);

    const metadata = this.cacheIndex[fileHash];
    if (!metadata) {
      return false;
    }

    // Check if source file has been modified
    if (file.stat.mtime > metadata.vaultMtime) {
      return false;
    }

    // Check if cached files exist
    const pdfPath = this.getCachePath(fileHash, "pdf");
    const textPath = this.getCachePath(fileHash, "txt");

    try {
      await this.app.vault.adapter.stat(pdfPath);
      await this.app.vault.adapter.stat(textPath);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getCachedTextPath(file: TFile): Promise<string | null> {
    const isValid = await this.isCacheValid(file);
    if (!isValid) {
      return null;
    }

    const content = await this.app.vault.cachedRead(file);
    const fileHash = this.getFileHash(content);
    return this.getCachePath(fileHash, "txt");
  }

  async renderToText(file: TFile): Promise<string> {
    // Check cache first
    const cachedPath = await this.getCachedTextPath(file);
    if (cachedPath) {
      return await this.app.vault.adapter.read(cachedPath);
    }

    // Render by extracting text directly from DOM
    const text = await this.extractTextFromDOM(file);

    // Cache the results (without PDF for now)
    await this.cacheTextOnly(file, text);

    return text;
  }

  private async extractTextFromDOM(file: TFile): Promise<string> {
    // Store current active file to restore later
    const originalFile = this.app.workspace.getActiveFile();
    const activeLeaf = this.app.workspace.getLeaf(false);
    const previousMode = (activeLeaf.view as any).getMode?.();
    
    try {
      // Open the file
      await activeLeaf.openFile(file);
      
      // Ensure preview mode
      const view = activeLeaf.view as any;
      if (view.getMode && view.getMode() !== "preview") {
        await view.setState({ mode: "preview" }, {});
      }
      
      // Wait for content to settle (Dataview, etc.)
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Extract text from the rendered DOM
      const contentEl = view.contentEl || view.containerEl;
      if (!contentEl) {
        throw new Error("Could not find content element");
      }
      
      // Get all text content from the preview
      const text = contentEl.innerText || contentEl.textContent || "";
      
      return text.trim();
    } finally {
      // Restore original file if there was one
      if (originalFile) {
        await activeLeaf.openFile(originalFile);
        if (previousMode && (activeLeaf.view as any).setState) {
          await (activeLeaf.view as any).setState({ mode: previousMode }, {});
        }
      }
    }
  }

  async renderToJson(file: TFile): Promise<StructuredContent> {
    const originalFile = this.app.workspace.getActiveFile();
    const activeLeaf = this.app.workspace.getLeaf(false);
    const previousMode = (activeLeaf.view as any).getMode?.();
    
    try {
      await activeLeaf.openFile(file);
      
      const view = activeLeaf.view as any;
      if (view.getMode && view.getMode() !== "preview") {
        await view.setState({ mode: "preview" }, {});
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const contentEl = view.contentEl || view.containerEl;
      if (!contentEl) {
        throw new Error("Could not find content element");
      }
      
      const fileCache = this.app.metadataCache.getFileCache(file);
      const frontmatter = fileCache?.frontmatter || {};
      
      const structured = this.structuredExtractor.extractStructured(file, frontmatter, contentEl);
      
      return structured;
    } finally {
      if (originalFile) {
        await activeLeaf.openFile(originalFile);
        if (previousMode && (activeLeaf.view as any).setState) {
          await (activeLeaf.view as any).setState({ mode: previousMode }, {});
        }
      }
    }
  }

  private async cacheTextOnly(
    file: TFile,
    text: string
  ): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const fileHash = this.getFileHash(content);

    // Create cache directory for this file
    const cacheDir = normalizePath(
      path.join(this.settings.cacheDirectory, fileHash)
    );
    await this.app.vault.adapter.mkdir(cacheDir);

    // Write text
    const textPath = this.getCachePath(fileHash, "txt");
    await this.app.vault.adapter.write(textPath, text);

    // Write metadata
    const metadataPath = this.getCachePath(fileHash, "json");
    const metadata: CacheMetadata = {
      sourcePath: file.path,
      sourceHash: fileHash,
      vaultMtime: file.stat.mtime,
      renderedAt: Date.now(),
      pdfSize: 0,
      textSize: text.length,
    };
    await this.app.vault.adapter.write(
      metadataPath,
      JSON.stringify(metadata, null, 2)
    );

    // Update index
    this.cacheIndex[fileHash] = metadata;
    await this.saveCacheIndex();
  }

  async invalidate(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const fileHash = this.getFileHash(content);

    if (this.cacheIndex[fileHash]) {
      delete this.cacheIndex[fileHash];
      await this.saveCacheIndex();

      // Optionally delete cached files
      const cacheDir = normalizePath(
        path.join(this.settings.cacheDirectory, fileHash)
      );
      try {
        await this.app.vault.adapter.rmdir(cacheDir, true);
      } catch (error) {
        // Directory might not exist, that's fine
      }
    }
  }

  async clearCache(): Promise<void> {
    this.cacheIndex = {};
    await this.saveCacheIndex();

    // Delete all cached files except index
    try {
      const files = await this.app.vault.adapter.list(
        this.settings.cacheDirectory
      );
      for (const dir of files.folders) {
        if (!dir.endsWith("CacheIndex.json")) {
          await this.app.vault.adapter.rmdir(dir, true);
        }
      }
    } catch (error) {
      console.error("Failed to clear cache:", error);
    }

    new Notice("Render cache cleared");
  }

  async getCacheStats(): Promise<{
    entryCount: number;
    totalSizeMB: number;
  }> {
    let totalSize = 0;
    const entryCount = Object.keys(this.cacheIndex).length;

    for (const metadata of Object.values(this.cacheIndex)) {
      totalSize += metadata.pdfSize + metadata.textSize;
    }

    return {
      entryCount,
      totalSizeMB: totalSize / (1024 * 1024),
    };
  }
}
