// The owner's reason for a decision (ADR 0100, ADR 0101): one line, at most `REASON_MAX` characters once collapsed.
import { expect, test } from "bun:test";
import { oneLineReason, REASON_MAX } from "./index.ts";

test("a reason is one line: runs of white space one space, none at the ends", () => {
  expect(oneLineReason("  keep\n\tit   simple ")).toEqual({ reason: "keep it simple" });
});

test("no reason, or only white space, is none", () => {
  expect(oneLineReason(null)).toEqual({ reason: null });
  expect(oneLineReason(" \n ")).toEqual({ reason: null });
});

test("a reason of the limit once collapsed is kept; one past it is too long, its collapsed length said", () => {
  expect(REASON_MAX).toBe(200);
  expect(oneLineReason(`${"word \n ".repeat(39)}fives`)).toEqual({ reason: `${"word ".repeat(39)}fives` });
  expect(oneLineReason(`${"a ".repeat(100)}  b`)).toEqual({ tooLong: 201 });
});

test("a reason that reads like a refusal is still a reason", () => {
  expect(oneLineReason("reason_too_long")).toEqual({ reason: "reason_too_long" });
});
