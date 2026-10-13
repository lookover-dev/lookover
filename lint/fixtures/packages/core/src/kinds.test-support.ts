import { expect } from "bun:test";
import type { Kind } from "./index.ts";

export function expectDraft(kind: Kind): void {
  expect(kind).toBe("draft");
}
