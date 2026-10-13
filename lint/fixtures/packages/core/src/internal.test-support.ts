import { expect } from "bun:test";
import type { Kind } from "./kinds.ts";

export function expectReady(kind: Kind): void {
  expect(kind).toBe("ready");
}
