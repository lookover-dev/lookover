// `tiedTo` ties a Zod schema to the TypeScript type it parses, both ways: the typecheck (`bun run check`) is the test
// here, and the runtime lines prove an exact schema parses a value of the type to an equal one.
import { expect, test } from "bun:test";
import { z } from "zod";
import { tiedTo } from "./index.ts";

interface Pin {
  path: string;
  side: "head" | "base";
  /** Absent when the pin is on the whole file. */
  line?: number;
}

/** An intersection, as `TimelineEntry` and `CommandPathState` are written: its schema is the union flattened. */
type Mark = { at: number } & ({ kind: "seen" } | { kind: "said"; text: string });

test("a schema naming every field of its type, optional ones included, parses a value of it to an equal one", () => {
  const pin = tiedTo<Pin>()(
    z.object({ path: z.string(), side: z.enum(["head", "base"]), line: z.number().exactOptional() }),
  );
  expect(pin.parse({ path: "a.ts", side: "head", line: 3 })).toEqual({ path: "a.ts", side: "head", line: 3 });
  expect(pin.parse({ path: "a.ts", side: "base" })).toEqual({ path: "a.ts", side: "base" });
  expect(pin.safeParse({ path: "a.ts", side: "left" }).success).toBe(false);
});

test("an intersection's schema is its union flattened, and a nested object is compared field by field", () => {
  const mark = tiedTo<Mark>()(
    z.discriminatedUnion("kind", [
      z.object({ at: z.number(), kind: z.literal("seen") }),
      z.object({ at: z.number(), kind: z.literal("said"), text: z.string() }),
    ]),
  );
  expect(mark.parse({ at: 1, kind: "said", text: "hi" })).toEqual({ at: 1, kind: "said", text: "hi" });
  const marks = tiedTo<{ marks: Mark[]; pin: Pin | null }>()(
    z.object({
      marks: z.array(mark),
      pin: z
        .object({ path: z.string(), side: z.enum(["head", "base"]), line: z.number().exactOptional() })
        .nullable(),
    }),
  );
  expect(marks.parse({ marks: [], pin: null })).toEqual({ marks: [], pin: null });
});

test("a schema missing a field, optional ones included, adding one or widening a value fails the typecheck", () => {
  const schemas = [
    // @ts-expect-error: `line`, an optional field of `Pin`, is missing
    tiedTo<Pin>()(z.object({ path: z.string(), side: z.enum(["head", "base"]) })),
    // @ts-expect-error: `line` is optional in `Pin`, required here
    tiedTo<Pin>()(z.object({ path: z.string(), side: z.enum(["head", "base"]), line: z.number() })),
    tiedTo<Pin>()(
      // @ts-expect-error: `.optional()` lets `line` be `undefined`, which `Pin` doesn't (exactOptionalPropertyTypes)
      z.object({ path: z.string(), side: z.enum(["head", "base"]), line: z.number().optional() }),
    ),
    tiedTo<Pin>()(
      // @ts-expect-error: `kind` is no field of `Pin`
      z.object({
        path: z.string(),
        side: z.enum(["head", "base"]),
        line: z.number().exactOptional(),
        kind: z.string(),
      }),
    ),
    // @ts-expect-error: `side` is widened to any string
    tiedTo<Pin>()(z.object({ path: z.string(), side: z.string(), line: z.number().exactOptional() })),
    // @ts-expect-error: `said`'s `text` is missing in the flattened union
    tiedTo<Mark>()(z.object({ at: z.number(), kind: z.enum(["seen", "said"]) })),
  ];
  expect(schemas).toHaveLength(6);
});
