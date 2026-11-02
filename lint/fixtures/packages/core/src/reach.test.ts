import { expect, test } from "bun:test";
import type { Reached } from "@lookover/contracts";

test("a reached id", () => {
  const id: Reached = "a";
  expect(id).toBe("a");
});
