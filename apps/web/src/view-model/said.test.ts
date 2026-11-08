// Where a sentence's value goes (design-system.md "Inline code"): a short one sits whole in the sentence, one too long
// for it goes on its own line under the sentence said without it.
import { expect, test } from "bun:test";
import { codePlace, IN_DISPLAY, saidParts } from "./said.ts";

test("a citation, a file and a command of a few words sit in the sentence; a folder or a long command does not", () => {
  expect(codePlace("src/webhooks/payments.ts:12")).toBe("inline");
  expect(codePlace("/lookover review")).toBe("inline");
  expect(codePlace("lookover start")).toBe("inline");
  expect(codePlace("~/.local/bin")).toBe("inline");
  expect(codePlace("C:\\Users\\Your Name\\.claude\\skills\\lookover-review-loop")).toBe("line");
  expect(codePlace("C:\\Users\\Your Name\\AppData\\Local\\Lookover\\lookover.exe start")).toBe("line");
});

test("a short value is said in its sentence, whole", () => {
  expect(
    saidParts({
      before: "Run",
      command: "lookover open",
      after: "to open Lookover.",
      alone: "To open Lookover, run:",
    }),
  ).toEqual([
    { text: "Run " },
    { code: "lookover open", kind: "command", line: false },
    { text: " to open Lookover." },
  ]);
});

test("a long value goes on its own line, under the sentence said without it", () => {
  const folder = "C:\\Users\\Your Name\\.claude\\skills\\lookover-review-loop";
  expect(
    saidParts({
      before: "Installs the review loop's skill in",
      command: folder,
      kind: "path",
      after: "so Claude Code knows the loop.",
      alone: "Installs the review loop's skill, so Claude Code knows the loop, in:",
    }),
  ).toEqual([
    { text: "Installs the review loop's skill, so Claude Code knows the loop, in:" },
    { code: folder, kind: "path", line: true },
  ]);
});

test("a long value with no sentence to say it alone stays in its sentence", () => {
  const long = "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\lookover.exe";
  expect(saidParts({ before: "A terminal's", command: long, after: "runs this Lookover." })[1]).toEqual({
    code: long,
    kind: "command",
    line: false,
  });
});

test("a second value after a long one carries on under it, the punctuation that closed the first sentence dropped", () => {
  const start = "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\lookover.exe start";
  expect(
    saidParts({
      before: "Off: after you log in, run",
      command: start,
      after: { before: ". Another Lookover starts at login:", command: "lookover start", after: "." },
      alone: "Off: after you log in, run:",
    }),
  ).toEqual([
    { text: "Off: after you log in, run:" },
    { code: start, kind: "command", line: true },
    { text: "Another Lookover starts at login: " },
    { code: "lookover start", kind: "command", line: false },
    { text: "." },
  ]);
  expect(
    saidParts({
      before: "Off: after you log in, run",
      command: start,
      after: { before: ". Another:", command: start, after: ".", alone: ". Another:" },
      alone: "Off: after you log in, run:",
    }).slice(2),
  ).toEqual([{ text: "Another:" }, { code: start, kind: "command", line: true }]);
});

test("punctuation sits against an inline value; a device code is never set on a line of its own", () => {
  expect(
    saidParts({ before: "Enter", command: "WDJB-MJHT", kind: "device-code", after: "on GitHub." }),
  ).toEqual([
    { text: "Enter " },
    { code: "WDJB-MJHT", kind: "device-code", line: false },
    { text: " on GitHub." },
  ]);
  expect(saidParts({ before: "first, at", command: "~/bin", kind: "path", after: "." })[2]).toEqual({
    text: ".",
  });
  expect(saidParts("Plain.")).toEqual([{ text: "Plain." }]);
});

test("32 characters sit in a sentence; 33 go on a line of their own", () => {
  const at = (n: number) => `${"a".repeat(n - 4)}.tsx`;
  expect(codePlace(at(32))).toBe("inline");
  expect(codePlace(at(33))).toBe("line");
});

test("a display-size sentence (the session screen's) holds a shorter value", () => {
  expect(codePlace("a".repeat(IN_DISPLAY), IN_DISPLAY)).toBe("inline");
  expect(codePlace("a".repeat(IN_DISPLAY + 1), IN_DISPLAY)).toBe("line");
  const open = "lookover open --home=/tmp/a";
  const words = { before: "Run", command: open, after: "to open Lookover.", alone: "To open Lookover, run:" };
  expect(saidParts(words)[1]).toEqual({ code: open, kind: "command", line: false });
  expect(saidParts(words, IN_DISPLAY)).toEqual([
    { text: "To open Lookover, run:" },
    { code: open, kind: "command", line: true },
  ]);
});

test("a string after a long value is not said: the sentence said alone folds it in", () => {
  const long = "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\lookover.exe";
  const parts = saidParts({ before: "Run", command: long, after: "to open Lookover.", alone: "Run:" });
  expect(parts.map((part) => ("text" in part ? part.text : part.code))).toEqual(["Run:", long]);
});
