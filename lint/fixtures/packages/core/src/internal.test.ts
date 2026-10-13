import { expect, test } from "bun:test";
import type { Kind } from "./kinds.ts";

test("a kind", () => {
  const kind: Kind = "ready";
  expect(kind).toBe("ready");
});
