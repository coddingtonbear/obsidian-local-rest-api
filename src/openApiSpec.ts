import { parse, stringify } from "yaml";
import type { OpenApiDescription, OpenApiObject, OpenApiTag } from "./publicApi";

/**
 * The extension that contributed a path item, stamped onto that item in the merged
 * spec so a reader can tell the host's operations from an extension's.
 */
export const EXTENSION_PATH_MARKER = "x-obsidian-extension";

interface Contribution {
  owner: string;
  description: OpenApiDescription;
}

/** The parts of the host document this module reads and writes. */
interface OpenApiDocument extends OpenApiObject {
  paths?: Record<string, OpenApiObject>;
  components?: Record<string, Record<string, OpenApiObject>>;
  tags?: OpenApiTag[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a description handed over by an extension at runtime. The published types
 * already say all of this, but an extension written in plain JavaScript, or one built
 * against a looser copy of the types, gets no compile-time check, and a malformed
 * fragment would otherwise surface only as a broken merged spec for every client.
 */
function assertValidDescription(description: unknown): asserts description is OpenApiDescription {
  if (!isPlainObject(description)) {
    throw new Error("An OpenAPI description must be an object.");
  }
  const { paths, components, tags } = description;
  if (paths !== undefined) {
    if (!isPlainObject(paths)) throw new Error("`paths` must be an object.");
    for (const [path, item] of Object.entries(paths)) {
      if (!path.startsWith("/")) {
        throw new Error(`OpenAPI path "${path}" must start with "/".`);
      }
      if (!isPlainObject(item)) {
        throw new Error(`The path item for "${path}" must be an object.`);
      }
    }
  }
  if (components !== undefined) {
    if (!isPlainObject(components)) throw new Error("`components` must be an object.");
    for (const [section, entries] of Object.entries(components)) {
      if (!isPlainObject(entries)) {
        throw new Error(`\`components.${section}\` must be an object.`);
      }
    }
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags)) throw new Error("`tags` must be an array.");
    const seen = new Set<string>();
    for (const tag of tags) {
      if (!isPlainObject(tag) || typeof tag.name !== "string") {
        throw new Error("Every tag must be an object with a string `name`.");
      }
      if (seen.has(tag.name)) {
        throw new Error(`Tag "${tag.name}" is declared twice in the same description.`);
      }
      seen.add(tag.name);
    }
  }
}

/**
 * The OpenAPI document the server publishes: the host's own spec plus whatever the
 * registered extensions have described.
 *
 * The host spec arrives as the YAML text compiled from `docs/src/` at build time. While
 * no extension has contributed anything, {@link yaml} returns that text unchanged, byte
 * for byte, so a server with no extensions serves exactly what it always has. Parsing
 * happens only once there is something to merge.
 */
export class OpenApiSpec {
  private readonly hostYaml: string;
  private hostDocument: OpenApiDocument | null = null;
  private contributions: Contribution[] = [];
  private mergedDocument: OpenApiDocument | null = null;
  private mergedYaml: string | null = null;

  constructor(hostYaml: string) {
    this.hostYaml = hostYaml;
  }

  private host(): OpenApiDocument {
    if (this.hostDocument === null) {
      const parsed: unknown = parse(this.hostYaml);
      if (!isPlainObject(parsed)) {
        throw new Error("The host OpenAPI spec did not parse to an object.");
      }
      this.hostDocument = parsed;
    }
    return this.hostDocument;
  }

  /**
   * Adds `description` to the published spec on behalf of `owner` (an extension's
   * plugin id), returning a function that removes it again.
   *
   * Throws, leaving the spec unchanged, when the description declares a path, a
   * component, or a tag that the host or another contribution already declares. Merging
   * silently would let one extension overwrite the documentation of another's routes,
   * or of the host's.
   */
  add(owner: string, description: OpenApiDescription): () => void {
    assertValidDescription(description);
    // A private copy: the extension keeps its own object, and mutating it afterwards
    // must not change what is published without going through these checks.
    const copy = structuredClone(description);
    this.assertNoCollisions(copy);

    const contribution: Contribution = { owner, description: copy };
    this.contributions.push(contribution);
    this.invalidate();

    return () => {
      const index = this.contributions.indexOf(contribution);
      if (index !== -1) {
        this.contributions.splice(index, 1);
        this.invalidate();
      }
    };
  }

  private assertNoCollisions(description: OpenApiDescription): void {
    const current = this.merged();
    for (const path of Object.keys(description.paths ?? {})) {
      if (current.paths?.[path] !== undefined) {
        throw new Error(
          `OpenAPI path "${path}" is already described${this.describedBy(current.paths[path])}.`,
        );
      }
    }
    for (const [section, entries] of Object.entries(description.components ?? {})) {
      for (const name of Object.keys(entries)) {
        if (current.components?.[section]?.[name] !== undefined) {
          throw new Error(`OpenAPI component "components.${section}.${name}" already exists.`);
        }
      }
    }
    const existingTags = new Set((current.tags ?? []).map((tag) => tag.name));
    for (const tag of description.tags ?? []) {
      if (existingTags.has(tag.name)) {
        throw new Error(`OpenAPI tag "${tag.name}" is already declared.`);
      }
    }
  }

  private describedBy(pathItem: OpenApiObject): string {
    const owner = pathItem[EXTENSION_PATH_MARKER];
    return typeof owner === "string" ? ` by extension "${owner}"` : " by Obsidian Local REST API";
  }

  private invalidate(): void {
    this.mergedDocument = null;
    this.mergedYaml = null;
  }

  private merged(): OpenApiDocument {
    if (this.mergedDocument !== null) return this.mergedDocument;
    if (this.contributions.length === 0) {
      this.mergedDocument = this.host();
      return this.mergedDocument;
    }

    const document: OpenApiDocument = structuredClone(this.host());
    for (const { owner, description } of this.contributions) {
      for (const [path, item] of Object.entries(description.paths ?? {})) {
        document.paths = document.paths ?? {};
        document.paths[path] = { ...item, [EXTENSION_PATH_MARKER]: owner };
      }
      for (const [section, entries] of Object.entries(description.components ?? {})) {
        document.components = document.components ?? {};
        document.components[section] = { ...document.components[section], ...entries };
      }
      if (description.tags?.length) {
        document.tags = [...(document.tags ?? []), ...description.tags];
      }
    }
    this.mergedDocument = document;
    return document;
  }

  /** The published spec as YAML. */
  yaml(): string {
    if (this.contributions.length === 0) return this.hostYaml;
    if (this.mergedYaml === null) {
      // lineWidth 0 turns off folding, so long descriptions stay on one line the way
      // the jsonnet-compiled host spec writes them.
      this.mergedYaml = stringify(this.merged(), { lineWidth: 0 });
    }
    return this.mergedYaml;
  }

  /** The published spec as JSON, the same document {@link yaml} describes. */
  json(): OpenApiObject {
    return this.merged();
  }
}
