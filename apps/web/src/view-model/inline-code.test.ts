// A finding's inline code, split as GitHub shows it: CommonMark's code spans, backticks only (ADR 0070).
import { expect, test } from "bun:test";
import { codeSpans } from "./inline-code.ts";

const text = (t: string) => ({ code: false, text: t });
const code = (t: string) => ({ code: true, text: t });

test("text without a backtick is one text part", () => {
  expect(codeSpans("The day is off by one.")).toEqual([text("The day is off by one.")]);
});

test("nothing gives no part", () => {
  expect(codeSpans("")).toEqual([]);
});

test("a single backtick pair is a code span", () => {
  expect(codeSpans("When `day` is today, it shows tomorrow.")).toEqual([
    text("When "),
    code("day"),
    text(" is today, it shows tomorrow."),
  ]);
});

test("an unmatched backtick stays as typed", () => {
  expect(codeSpans("it's `day for now")).toEqual([text("it's `day for now")]);
});

test("a span closes only on a run of the same length", () => {
  expect(codeSpans("``a `b` c`` then")).toEqual([code("a `b` c"), text(" then")]);
});

test("double backticks hold a single one", () => {
  expect(codeSpans("type `` ` `` to quote")).toEqual([text("type "), code("`"), text(" to quote")]);
});

test("a run left unclosed stays as typed and the scan goes on after it", () => {
  expect(codeSpans("``foo`bar`")).toEqual([text("``foo"), code("bar")]);
});

test("a run longer than the opening one doesn't close it", () => {
  expect(codeSpans("`a``b`")).toEqual([code("a``b")]);
});

test("one space either side goes when both are there", () => {
  expect(codeSpans("`` `a` ``")).toEqual([code("`a`")]);
  expect(codeSpans("` a`")).toEqual([code(" a")]);
  expect(codeSpans("`  b  `")).toEqual([code(" b ")]);
});

test("a span of spaces only keeps them", () => {
  expect(codeSpans("` ` and `  `")).toEqual([code(" "), text(" and "), code("  ")]);
});

test("a line end inside a span reads as a space", () => {
  expect(codeSpans("`if (a)\nreturn`")).toEqual([code("if (a) return")]);
  expect(codeSpans("`a\r\nb`")).toEqual([code("a b")]);
});

test("a backslash before a backtick outside a span shows the backtick", () => {
  expect(codeSpans("\\`day\\` is literal")).toEqual([text("`day` is literal")]);
  expect(codeSpans("\\``day`")).toEqual([text("`"), code("day")]);
});

test("an escaped backslash before a backtick does not escape the backtick", () => {
  expect(codeSpans("a \\\\`x`")).toEqual([text("a \\\\"), code("x")]);
});

test("a backslash inside a span stays, and other backslashes stay as typed", () => {
  expect(codeSpans("`a\\`b`")).toEqual([code("a\\"), text("b`")]);
  expect(codeSpans("C:\\path\\n and *not* emphasis")).toEqual([text("C:\\path\\n and *not* emphasis")]);
});

test("three backticks are a run like any other", () => {
  expect(codeSpans("```x```")).toEqual([code("x")]);
});
