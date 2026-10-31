// A port suite's wait predicates made of the very matchers that follow them (ADR 0069): the suite reads until the
// matcher passes of the read, then asserts it on that read, so the wait is exactly as strict as the assertion,
// asymmetric matchers included. For the suites alone: they need `bun:test`, which `holds` itself doesn't.
import { expect } from "bun:test";
import { holds } from "./read-until.ts";

/** Whether `toEqual(expected)` accepts the read: a failed `expect` is caught, and fails no test (the suites stay green). */
export const equals = (expected: unknown) => holds((actual: unknown) => expect(actual).toEqual(expected));

/** Whether `toMatchObject(expected)` accepts the read. */
export const matches = (expected: Record<string, unknown> | unknown[]) =>
  holds((actual: unknown) => expect(actual).toMatchObject(expected));
