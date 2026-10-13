import { expect, test } from "bun:test";
import type { Kind } from "./index.ts";

test("a kind", () => {
  const kind: Kind = "draft";
  expect(kind).toBe("draft");
});
