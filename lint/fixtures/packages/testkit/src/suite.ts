import { test } from "bun:test";

export function suite(name: string): void {
  test(name, () => undefined);
}
