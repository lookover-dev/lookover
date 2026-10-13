import { expect } from "bun:test";
import type { Kind } from "../src/index.ts";

export function expectDraft(kind: Kind): void {
  expect(kind).toBe("draft");
}
