import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// zod-to-json-schema's generic signature is resolved eagerly against the converted
// schema and trips TypeScript's instantiation-depth limit on this project's larger tool
// shapes. Only the JSON Schema document is needed here, so the call is made through a
// narrowed alias.
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: z.ZodTypeAny,
  options?: { strictUnions?: boolean; pipeStrategy?: "input" | "output" },
) => Record<string, unknown>;

/**
 * The MCP TypeScript SDK v2 registers tools with a Standard Schema that also knows how to
 * describe itself as JSON Schema (`~standard.jsonSchema`). Zod only grew that member in
 * v4, and the SDK refuses a bare zod 3 schema outright, but this plugin's tool schemas —
 * and the `addMcpTool` extension API that third-party plugins compile against — are zod 3
 * and cannot be moved without breaking every extension author.
 *
 * This adapter closes that gap: validation is delegated to zod 3's own Standard Schema
 * implementation, and the JSON Schema is produced by `zod-to-json-schema` with the same
 * options SDK v1 used, so `tools/list` advertises identical shapes under either SDK.
 *
 * Delete this file once the project's own schemas are zod 4, which implements
 * `~standard.jsonSchema` natively.
 */
export function toStandardSchema(
  shape: Record<string, z.ZodTypeAny>,
): StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>> {
  // Annotated as the base type rather than the inferred ZodObject: the SDK's Standard
  // Schema surface only needs the base.
  const schema: z.ZodTypeAny = z.object(shape);
  const standard = schema["~standard"];
  const jsonSchema = toJsonSchema(schema, {
    strictUnions: true,
    pipeStrategy: "input",
  });

  return {
    "~standard": {
      version: 1,
      vendor: standard.vendor,
      validate: (value) => standard.validate(value),
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}
