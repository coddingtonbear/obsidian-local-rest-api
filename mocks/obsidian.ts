class DataAdapter {
  _exists = true;
  _read_data = "";

  async exists(path: string): Promise<boolean> {
    return this._exists;
  }

  async read(path: string): Promise<string> {
    return "";
  }

  async write(path: string, content: string): Promise<void> {}

  async remove(path: string): Promise<void> {}
}

class Vault {
  _get_abstract_file_by_path = new TFile();
  _read = "";

  adapter = new DataAdapter();

  async read(file: TFile): Promise<string> {
    return this._read;
  }

  getFiles(): TFile[] {
    return [];
  }

  getAbstractFileByPath(path: string): TFile {
    return this._get_abstract_file_by_path;
  }
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
  _get_file_cache = new CachedMetadata();

  getFileCache(file: TFile): CachedMetadata {
    return this._get_file_cache;
  }
}

export class App {
  vault = new Vault();
  metadataCache = new MetadataCache();
}

export class Command {
  id = "";
  name = "";
}

export class TFile {
  path: "";
}

export class Loc {
  line: -1;
}

export class PluginManifest {}

export class SettingTab {}

export class Workspace {}
