// `enumOf` ties a Zod enum to its TypeScript type: the typecheck (`bun run check`) is the test here, and the
// runtime lines prove the enum parses what it lists and nothing else.
import { expect, test } from "bun:test";
import { enumOf } from "./index.ts";

type Side = "head" | "base";

test("an enum listing every value of its type parses those values and refuses any other", () => {
  const side = enumOf<Side>()(["head", "base"]);
  expect(side.parse("head")).toBe("head");
  expect(side.parse("base")).toBe("base");
  expect(side.safeParse("left").success).toBe(false);
});

test("a value of the type left out of the enum, or one not in the type, fails the typecheck", () => {
  // @ts-expect-error: `base` is a `Side` the enum leaves out
  const missing = enumOf<Side>()(["head"]);
  // @ts-expect-error: `left` is not a `Side`
  const extra = enumOf<Side>()(["head", "base", "left"]);
  expect(missing.options).toHaveLength(1);
  expect(extra.options).toHaveLength(3);
});
