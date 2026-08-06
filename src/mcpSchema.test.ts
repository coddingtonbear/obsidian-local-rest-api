import { z } from "zod";

import { toStandardSchema } from "./mcpSchema";

describe("toStandardSchema", () => {
  test("advertises the shape as JSON Schema for tools/list", () => {
    const schema = toStandardSchema({
      path: z.string().describe("File path relative to vault root"),
      newLeaf: z.boolean().optional(),
    });

    const json = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });

    expect(json).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to vault root" },
        newLeaf: { type: "boolean" },
      },
      required: ["path"],
    });
  });

  test("keeps anyOf branches for union parameters", () => {
    const schema = toStandardSchema({
      target: z.union([z.array(z.string()), z.string()]).optional(),
    });

    const json = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }) as {
      properties: { target: { anyOf: unknown[] } };
    };

    expect(json.properties.target.anyOf).toHaveLength(2);
  });

  test("validates arguments with the zod schema the tool was registered with", async () => {
    const schema = toStandardSchema({ path: z.string() });

    const accepted = await schema["~standard"].validate({ path: "note.md" });
    expect(accepted).toEqual({ value: { path: "note.md" } });

    const rejected = await schema["~standard"].validate({ path: 42 });
    expect(rejected.issues).toBeDefined();
  });

  test("reports zod as the vendor so the SDK keeps its zod-aware error formatting", () => {
    expect(toStandardSchema({})["~standard"].vendor).toBe("zod");
  });
});
