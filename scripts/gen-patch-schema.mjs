// Generate the OpenAPI `PatchInstruction` component from markdown-patch-2's
// published Zod schema, so the REST docs, the MCP tool input, and the engine's
// own validation are all one definition.
//
// Run by `npm run build-docs` before jsonnet compiles openapi.yaml; the output
// is imported by docs/src/openapi.jsonnet. Committed alongside openapi.yaml so
// the compiled spec is reproducible.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { InstructionInputObjectSchema } from "markdown-patch-2";
import { zodToJsonSchema } from "zod-to-json-schema";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "docs", "src", "lib", "patchInstruction.schema.json");

const schema = zodToJsonSchema(InstructionInputObjectSchema, {
  // Emit OpenAPI 3.0 dialect (nullable: true rather than a "null" type union).
  target: "openApi3",
  // Inline everything into one self-contained schema; no $ref/$defs to resolve.
  $refStrategy: "none",
});

// zod-to-json-schema tags the document with its meta-schema; OpenAPI embeds the
// bare schema, so drop it.
delete schema.$schema;

// Fix how the OpenAPI-3 target renders a `z.null()` union branch: it emits
// `{ enum: ["null"], nullable: true }`, which constrains to the *string*
// "null" rather than the JSON null. Idiomatic OA3 hoists `nullable: true` onto
// the union and drops the null branch, so `string[] | null` becomes an anyOf of
// the non-null branches with `nullable: true`.
const isNullSentinel = (node) =>
  node &&
  typeof node === "object" &&
  Array.isArray(node.enum) &&
  node.enum.length === 1 &&
  node.enum[0] === "null";

const fixNulls = (node) => {
  if (Array.isArray(node)) {
    node.forEach(fixNulls);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.anyOf)) {
    const hasNull = node.anyOf.some(isNullSentinel);
    if (hasNull) {
      node.anyOf = node.anyOf.filter((branch) => !isNullSentinel(branch));
      node.nullable = true;
    }
  }
  for (const value of Object.values(node)) fixNulls(value);
};
fixNulls(schema);

writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
