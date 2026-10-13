// The pause's rules (ADR 0040): how long the app's three choices pause for, and whether a pause holds now.
import { expect, test } from "bun:test";
import { pausedAt, pauseOf } from "./index.ts";

const AT = Date.UTC(2026, 9, 7, 16, 0);
const HOUR = 3_600_000;

test("a pause for an hour ends an hour on, until tomorrow 18 hours on, and until resumed never", () => {
  expect(pauseOf("hour", AT)).toEqual({ since: AT, until: AT + HOUR });
  expect(pauseOf("tomorrow", AT)).toEqual({ since: AT, until: AT + 18 * HOUR });
  expect(pauseOf("forever", AT)).toEqual({ since: AT, until: null });
});

test("a pause holds until its end, not at it; one until resumed always holds; none never does", () => {
  const hour = { since: AT, until: AT + HOUR };
  expect(pausedAt(hour, AT)).toBe(true);
  expect(pausedAt(hour, AT + HOUR - 1)).toBe(true);
  expect(pausedAt(hour, AT + HOUR)).toBe(false);
  expect(pausedAt({ since: AT, until: null }, AT + 1000 * HOUR)).toBe(true);
  expect(pausedAt(null, AT)).toBe(false);
});
