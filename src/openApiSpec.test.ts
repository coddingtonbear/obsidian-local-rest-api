import { parse } from "yaml";
import openapiYaml from "../docs/openapi.yaml";
import { EXTENSION_PATH_MARKER, OpenApiSpec } from "./openApiSpec";
import type { OpenApiDescription, OpenApiObject } from "./publicApi";

interface ParsedSpec {
  paths: Record<string, OpenApiObject>;
  components: Record<string, Record<string, OpenApiObject>>;
  tags: { name: string }[];
}

const widgetDescription: OpenApiDescription = {
  paths: {
    "/widgets/{id}/": {
      get: {
        tags: ["Widgets"],
        summary: "Return one widget.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "The widget.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Widget" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: { Widget: { type: "object", properties: { id: { type: "string" } } } },
  },
  tags: [{ name: "Widgets", description: "Widget routes." }],
};

describe("OpenApiSpec", () => {
  test("serves the host spec byte for byte while nothing is contributed", () => {
    const spec = new OpenApiSpec(openapiYaml);
    expect(spec.yaml()).toBe(openapiYaml);
  });

  test("serves the same document as JSON", () => {
    const spec = new OpenApiSpec(openapiYaml);
    expect(spec.json()).toEqual(parse(openapiYaml));
  });

  test("declares every tag the host's own operations use", () => {
    const host = parse(openapiYaml) as ParsedSpec;
    const declared = host.tags.map((tag) => tag.name);
    const used = new Set<string>();
    for (const item of Object.values(host.paths)) {
      for (const operation of Object.values(item)) {
        const tags = (operation as { tags?: unknown }).tags;
        if (!Array.isArray(tags)) continue;
        for (const tag of tags as unknown[]) {
          if (typeof tag === "string") used.add(tag);
        }
      }
    }
    expect([...used].filter((tag) => !declared.includes(tag))).toEqual([]);
  });

  test("merges a contribution without disturbing the host's own spec", () => {
    const spec = new OpenApiSpec(openapiYaml);
    spec.add("widget-plugin", widgetDescription);

    const host = parse(openapiYaml) as ParsedSpec;
    const merged = parse(spec.yaml()) as ParsedSpec;

    for (const [path, item] of Object.entries(host.paths)) {
      expect(merged.paths[path]).toEqual(item);
    }
    expect(merged.components.schemas).toEqual({
      ...host.components.schemas,
      Widget: widgetDescription.components?.schemas?.Widget,
    });
    expect(merged.components.securitySchemes).toEqual(host.components.securitySchemes);
    expect(merged.tags).toEqual([...host.tags, { name: "Widgets", description: "Widget routes." }]);
    expect(merged.paths["/widgets/{id}/"]).toEqual({
      ...widgetDescription.paths?.["/widgets/{id}/"],
      [EXTENSION_PATH_MARKER]: "widget-plugin",
    });
    expect(spec.json()).toEqual(merged);
  });

  test("keeps long descriptions on one line", () => {
    const spec = new OpenApiSpec(openapiYaml);
    const summary = "A very long summary ".repeat(20).trim();
    spec.add("long", { paths: { "/long/": { get: { summary, responses: {} } } } });
    expect(spec.yaml()).toContain(`summary: ${summary}\n`);
  });

  test("removing a contribution restores the host spec byte for byte", () => {
    const spec = new OpenApiSpec(openapiYaml);
    const remove = spec.add("widget-plugin", widgetDescription);
    expect(spec.yaml()).not.toBe(openapiYaml);
    remove();
    expect(spec.yaml()).toBe(openapiYaml);
    remove();
    expect(spec.yaml()).toBe(openapiYaml);
  });

  test("publishes a copy, so later mutation by the extension changes nothing", () => {
    const spec = new OpenApiSpec(openapiYaml);
    const paths: Record<string, OpenApiObject> = {};
    spec.add("widget-plugin", { paths });
    const before = spec.yaml();
    paths["/injected/"] = { get: { responses: {} } };
    expect(spec.yaml()).toBe(before);
  });

  test("refuses a path the host already describes", () => {
    const spec = new OpenApiSpec(openapiYaml);
    expect(() =>
      spec.add("greedy", { paths: { "/openapi.yaml": { get: { responses: {} } } } }),
    ).toThrow('OpenAPI path "/openapi.yaml" is already described by Obsidian Local REST API.');
    expect(spec.yaml()).toBe(openapiYaml);
  });

  test("refuses a path another extension already describes, naming it", () => {
    const spec = new OpenApiSpec(openapiYaml);
    spec.add("widget-plugin", widgetDescription);
    expect(() =>
      spec.add("other", { paths: { "/widgets/{id}/": { get: { responses: {} } } } }),
    ).toThrow('already described by extension "widget-plugin"');
  });

  test("refuses a component name that already exists", () => {
    const spec = new OpenApiSpec(openapiYaml);
    const hostSchemas = (parse(openapiYaml) as ParsedSpec).components.schemas;
    const taken = Object.keys(hostSchemas)[0];
    expect(() =>
      spec.add("clash", { components: { schemas: { [taken]: { type: "string" } } } }),
    ).toThrow(`"components.schemas.${taken}" already exists`);
  });

  test("refuses a tag that is already declared", () => {
    const spec = new OpenApiSpec(openapiYaml);
    expect(() => spec.add("clash", { tags: [{ name: "System" }] })).toThrow(
      'OpenAPI tag "System" is already declared.',
    );
  });

  test("a refused description publishes nothing, even the parts that did not clash", () => {
    const spec = new OpenApiSpec(openapiYaml);
    expect(() =>
      spec.add("partial", {
        paths: { "/fine/": { get: { responses: {} } } },
        tags: [{ name: "System" }],
      }),
    ).toThrow();
    expect(spec.yaml()).toBe(openapiYaml);
  });

  test("lets a path freed by one extension be described by another", () => {
    const spec = new OpenApiSpec(openapiYaml);
    const remove = spec.add("widget-plugin", widgetDescription);
    remove();
    expect(() => spec.add("successor", widgetDescription)).not.toThrow();
  });

  test.each<[string, unknown, string]>([
    ["a non-object", "paths: {}", "must be an object"],
    ["a path without a leading slash", { paths: { "widgets/": {} } }, 'must start with "/"'],
    ["a non-object path item", { paths: { "/widgets/": [] } }, "must be an object"],
    ["a non-object component section", { components: { schemas: [] } }, "must be an object"],
    ["non-array tags", { tags: { name: "Widgets" } }, "must be an array"],
    ["a tag without a name", { tags: [{ description: "?" }] }, "string `name`"],
    ["a tag declared twice", { tags: [{ name: "W" }, { name: "W" }] }, "declared twice"],
  ])("rejects %s", (_label, description, message) => {
    const spec = new OpenApiSpec(openapiYaml);
    expect(() => spec.add("bad", description as OpenApiDescription)).toThrow(message);
    expect(spec.yaml()).toBe(openapiYaml);
  });
});

describe("OpenApiSpec state schemas", () => {
  interface StateSchema {
    properties: Record<string, OpenApiObject>;
  }

  function stateSchemaOf(document: unknown): StateSchema {
    const paths = (document as { paths: Record<string, OpenApiObject> }).paths;
    const get = paths["/"].get as { responses: Record<string, OpenApiObject> };
    const content = get.responses["200"].content as Record<
      string,
      { schema: { properties: Record<string, StateSchema> } }
    >;
    return content["application/json"].schema.properties.state;
  }

  const indexerState = {
    description: "Indexing progress.",
    schema: {
      type: "object",
      required: ["ready"],
      properties: { ready: { type: "boolean" }, pending: { type: "integer" } },
    },
  };

  test("the host documents its own metadataCache namespace", () => {
    const host = stateSchemaOf(parse(openapiYaml));
    expect(host.properties.metadataCache).toMatchObject({ type: "object" });
    const fields = (host.properties.metadataCache as { properties: Record<string, OpenApiObject> })
      .properties;
    expect(Object.keys(fields).sort()).toEqual(["lastActivityAt", "lastResolvedAt", "listeningSince"]);
  });

  test("documents an extension's state under GET /, marked with its plugin id", () => {
    const spec = new OpenApiSpec(openapiYaml);
    spec.addStateSchema("vault-indexer", indexerState);

    const merged = parse(spec.yaml());
    expect(stateSchemaOf(merged).properties["vault-indexer"]).toEqual({
      ...indexerState.schema,
      description: indexerState.description,
      [EXTENSION_PATH_MARKER]: "vault-indexer",
    });
    expect(stateSchemaOf(merged).properties.metadataCache).toEqual(
      stateSchemaOf(parse(openapiYaml)).properties.metadataCache,
    );
    expect(spec.json()).toEqual(merged);
  });

  test("publishes a free-form object when the extension gives no schema", () => {
    const spec = new OpenApiSpec(openapiYaml);
    spec.addStateSchema("publisher", { description: "Publishing status." });
    expect(stateSchemaOf(spec.json()).properties.publisher).toEqual({
      type: "object",
      additionalProperties: true,
      description: "Publishing status.",
      [EXTENSION_PATH_MARKER]: "publisher",
    });
  });

  test("the extension's description wins over one inside its schema", () => {
    const spec = new OpenApiSpec(openapiYaml);
    spec.addStateSchema("publisher", {
      description: "Outer.",
      schema: { type: "object", description: "Inner." },
    });
    expect(stateSchemaOf(spec.json()).properties.publisher.description).toBe("Outer.");
  });

  test("removing a state schema restores the host spec byte for byte", () => {
    const spec = new OpenApiSpec(openapiYaml);
    const remove = spec.addStateSchema("vault-indexer", indexerState);
    expect(spec.yaml()).not.toBe(openapiYaml);
    remove();
    expect(spec.yaml()).toBe(openapiYaml);
    remove();
    expect(spec.yaml()).toBe(openapiYaml);
  });

  test("refuses a second schema for the same extension", () => {
    const spec = new OpenApiSpec(openapiYaml);
    spec.addStateSchema("vault-indexer", indexerState);
    expect(() => spec.addStateSchema("vault-indexer", indexerState)).toThrow(/already/);
  });

  test("refuses a schema for a namespace the host documents", () => {
    const spec = new OpenApiSpec(openapiYaml);
    expect(() => spec.addStateSchema("metadataCache", indexerState)).toThrow(/already/);
  });

  test("publishes a copy, so later mutation by the extension changes nothing", () => {
    const spec = new OpenApiSpec(openapiYaml);
    const schema: OpenApiObject = { type: "object", properties: { ready: { type: "boolean" } } };
    spec.addStateSchema("vault-indexer", { description: "Indexing progress.", schema });
    (schema.properties as Record<string, unknown>).leaked = { type: "string" };
    const published = stateSchemaOf(spec.json()).properties["vault-indexer"] as {
      properties: Record<string, unknown>;
    };
    expect(published.properties.leaked).toBeUndefined();
  });

  test("coexists with route contributions and is removed independently", () => {
    const spec = new OpenApiSpec(openapiYaml);
    const removeRoutes = spec.add("vault-indexer", widgetDescription);
    const removeState = spec.addStateSchema("vault-indexer", indexerState);
    expect(stateSchemaOf(spec.json()).properties["vault-indexer"]).toBeDefined();
    expect(spec.json().paths).toHaveProperty(["/widgets/{id}/"]);

    removeState();
    expect(stateSchemaOf(spec.json()).properties["vault-indexer"]).toBeUndefined();
    expect(spec.json().paths).toHaveProperty(["/widgets/{id}/"]);

    removeRoutes();
    expect(spec.yaml()).toBe(openapiYaml);
  });
});
