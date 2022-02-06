class DataAdapter {
  _exists = true;
  _read = "";
  _write: [string, string];
  _remove: [string];

  async exists(path: string): Promise<boolean> {
    return this._exists;
  }

  async read(path: string): Promise<string> {
    return this._read;
  }

  async write(path: string, content: string): Promise<void> {
    this._write = [path, content];
  }

  async remove(path: string): Promise<void> {
    this._remove = [path];
  }
}

class Vault {
  _getAbstractFileByPath: TFile | null = new TFile();
  _read = "";
  _files: TFile[] = [];

  adapter = new DataAdapter();

  async read(file: TFile): Promise<string> {
    return this._read;
  }

  getFiles(): TFile[] {
    return this._files;
  }

  getAbstractFileByPath(path: string): TFile {
    return this._getAbstractFileByPath;
  }
}

export class Loc {
  line = -1;
}

export class Pos {
  start = new Loc();
  end = new Loc();
}

export class HeadingCache {
  level = 1;
  heading = "";
  position = new Pos();
}

export class CachedMetadata {
  headings: HeadingCache[] = [];
}

export class MetadataCache {
  _getFileCache = new CachedMetadata();

  getFileCache(file: TFile): CachedMetadata {
    return this._getFileCache;
  }
}

export class App {
  _executeCommandById: [string];

  vault = new Vault();
  metadataCache = new MetadataCache();
  commands = {
    commands: {} as Record<string, Command>,

    executeCommandById: (id: string) => {
      this._executeCommandById = [id];
    },
  };
}

export class Command {
  id = "";
  name = "";
}

export class TFile {
  path = "";
}

export class PluginManifest {
  version = "";
}

export class SettingTab {}

export class Workspace {}

export const apiVersion = "1.0.0";
