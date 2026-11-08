// A path or a command, cut into the pieces a line may break between (design-system.md "Inline code").
import { expect, test } from "bun:test";
import { pathPieces } from "./path.ts";

test("a Windows path breaks only after its backslashes, never at the space in a folder's name", () => {
  expect(pathPieces("C:\\Users\\Your Name\\.claude\\skills\\lookover-review-loop", "path")).toEqual([
    "C:\\",
    "Users\\",
    "Your Name\\",
    ".claude\\",
    "skills\\",
    "lookover-review-loop",
  ]);
});

test("a slash is a separator too; a leading one, a doubled one and a trailing one cut nothing", () => {
  expect(pathPieces("~/.local/bin", "path")).toEqual(["~/", ".local/", "bin"]);
  expect(pathPieces("/usr/local/bin/", "path")).toEqual(["/usr/", "local/", "bin/"]);
  expect(pathPieces("\\\\server\\share", "path")).toEqual(["\\\\server\\", "share"]);
  expect(pathPieces("https://example.com/a", "path")).toEqual(["https://", "example.com/", "a"]);
});

test("a citation breaks after its folders, its line kept with its file", () => {
  expect(pathPieces("src/webhooks/payments.ts:12", "command")).toEqual([
    "src/",
    "webhooks/",
    "payments.ts:12",
  ]);
});

test("a command breaks at the spaces between its words, never inside quotes", () => {
  expect(pathPieces("& 'C:\\Users\\Your Name\\Downloads\\lookover.exe' wait", "command")).toEqual([
    "&",
    " ",
    "'C:\\",
    "Users\\",
    "Your Name\\",
    "Downloads\\",
    "lookover.exe'",
    " ",
    "wait",
  ]);
  expect(pathPieces('"C:\\Program Files\\Lookover\\lookover.exe"  start', "command")).toEqual([
    '"C:\\',
    "Program Files\\",
    "Lookover\\",
    'lookover.exe"',
    "  ",
    "start",
  ]);
});

test("the line Lookover writes for PowerShell: a quoted program and a quoted --home, each broken after its folders", () => {
  expect(
    pathPieces("& 'C:\\Users\\Your Name\\lookover.exe' '--home=C:\\Lookover data' open", "command"),
  ).toEqual([
    "&",
    " ",
    "'C:\\",
    "Users\\",
    "Your Name\\",
    "lookover.exe'",
    " ",
    "'--home=C:\\",
    "Lookover data'",
    " ",
    "open",
  ]);
});

test("a POSIX line: the slash that starts a value after = is a leading one, kept with what follows", () => {
  expect(pathPieces("/home/sam/bin/lookover --home=/home/sam/data open", "command")).toEqual([
    "/home/",
    "sam/",
    "bin/",
    "lookover",
    " ",
    "--home=/home/",
    "sam/",
    "data",
    " ",
    "open",
  ]);
});

test("a POSIX path with an apostrophe, closed, escaped and reopened, stays one quoted word", () => {
  expect(pathPieces("'/home/O'\\''Brien/bin/lookover' open", "command")).toEqual([
    "'/home/",
    "O'\\''Brien/",
    "bin/",
    "lookover'",
    " ",
    "open",
  ]);
});

test("in a command, a backslash before a space escapes it", () => {
  expect(pathPieces("/Users/Your\\ Name/bin/lookover open", "command")).toEqual([
    "/Users/",
    "Your\\ Name/",
    "bin/",
    "lookover",
    " ",
    "open",
  ]);
});

test("a path's spaces are its own, and a hyphen cuts nothing", () => {
  expect(pathPieces("lookover review-loop", "path")).toEqual(["lookover review-loop"]);
  expect(pathPieces("/lookover review", "command")).toEqual(["/lookover", " ", "review"]);
});

test("the pieces joined are the text as given", () => {
  const text = "& 'C:\\Users\\Your Name\\lookover.exe' --home 'C:\\Lookover data' start";
  expect(pathPieces(text, "command").join("")).toBe(text);
  expect(pathPieces("", "path")).toEqual([]);
});
