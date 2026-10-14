// The landing page's facts are the released program's: the commands it shows and copies are the README's, the
// lines `lookover start` prints are the program's own (`apps/service/src/background.ts`) and the ones the
// getting-started page quotes, the systems it runs on are the README's, the licence is the LICENSE file's, and every
// page of the docs it links to exists.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { commands, GETTING_STARTED, README } from "../readme.test-support.ts";
import { COMMANDS, DOCS, GITHUB, LICENCE, PLATFORMS, START_LINES } from "./facts.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** What a source prints with `print.out`, its `${command}` read as `lookover`, as a user who ran it sees it. */
function printed(source: string): string[] {
  const literals = source.matchAll(/print\.out\(\s*(["`])((?:\\.|(?!\1)[^\\])*)\1/g);
  return [...literals].map(([, , text = ""]) =>
    text.replace(/\$\{command\}/g, "lookover").replace(/\\(.)/g, "$1"),
  );
}

describe("the landing page's facts", () => {
  test("the commands are the README's: install, then the first run", () => {
    expect(COMMANDS).toEqual(["npm install -g lookover", "lookover start"]);
    expect([...commands(README, "Install"), ...commands(README, "First run")]).toEqual([...COMMANDS]);
  });

  test("`lookover start`'s lines are the program's, and the ones the getting-started page quotes", () => {
    expect(START_LINES).toEqual([
      "Lookover runs in the background.",
      "Lookover is opening in your browser.",
      "Don't see it? `lookover open --no-open` prints a link to paste (it works once, within 2 minutes).",
      "You can close this terminal.",
    ]);
    const program = printed(read("../../../service/src/background.ts"));
    for (const line of START_LINES) expect(program).toContain(line);
    const quoted = GETTING_STARTED.split(/\r?\n/).map((line) => line.trim());
    for (const line of START_LINES) expect(quoted).toContain(line);
  });

  test("the systems it runs on are the README's: Windows on x64 only", () => {
    expect(PLATFORMS).toBe("Windows (x64), macOS, Linux.");
    expect(README.split(/\r?\n/)).toContain("- Windows, macOS or Linux, on x64 or arm64 (Windows: x64).");
  });

  test("the licence is the LICENSE file's", () => {
    expect(LICENCE).toBe("MIT");
    expect(read("../../../../LICENSE").split(/\r?\n/)[0]).toBe(`${LICENCE} License`);
  });

  test("GitHub is the public repository", () => {
    expect(GITHUB).toBe("https://github.com/lookover-dev/lookover");
  });

  test("every docs page it links to exists", () => {
    expect(DOCS.index).toBe("/docs/");
    for (const [name, path] of Object.entries(DOCS)) {
      const slug = path.replace(/^\/docs\/|\/(#.*)?$/g, "").split("#")[0] || "index";
      expect(existsSync(new URL(`../content/docs/docs/${slug}.md`, import.meta.url)), name).toBe(true);
    }
  });
});
