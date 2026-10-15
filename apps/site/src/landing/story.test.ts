// The three-sided story says what Lookover really does: the commands the agent types are ones `lookover` takes, the
// review and the thread read as Lookover posts them, and the scene draws in the page's tokens alone, so it follows
// the theme.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { USAGE } from "@lookover/agent-cli";
import { githubPanelHTML, THREE_SIDES_BEATS, threeSidesHTML } from "./story.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The text of every element with `class` in `html`, tags dropped. */
const textsOf = (html: string, cls: string): string[] =>
  [...html.matchAll(new RegExp(`class="${cls}"[^>]*>(.*?)</(?:span|p|div)>`, "g"))].map((m) =>
    (m[1] ?? "").replace(/<[^>]+>/g, "").trim(),
  );

/** What `lookover <verb>` takes, from its usage: how many arguments that are not flags. */
function positionals(verb: string): number | null {
  const line = USAGE.split("\n").find((l) =>
    l
      .trim()
      .replace(/^Usage:\s*/, "")
      .startsWith(`lookover ${verb} `),
  );
  if (line === undefined) return null;
  return [...line.replace(/\[[^\]]*\]/g, "").matchAll(/<[^>]+>/g)].length;
}

describe("the three-sided story", () => {
  test("every command the agent types is one `lookover` takes", () => {
    const typed = textsOf(threeSidesHTML(), "ts-ty").filter((t) => t.startsWith("lookover "));
    expect(typed).toEqual(["lookover wait", "lookover wait"]);
    for (const command of typed) {
      const [, verb = "", ...rest] = command.split(" ");
      expect(positionals(verb)).toBe(rest.filter((word) => !word.startsWith("--")).length);
    }
  });

  test("the review and the thread read as Lookover posts them, by the App, as itself", () => {
    const panel = githubPanelHTML();
    expect(textsOf(panel, "ts-rvtext")).toEqual([
      "Looked over a1f9c2e. One thing to fix, rateLimit.ts line 42. The rest can go.",
      "Looked over b2c3d4e. Nothing new to fix. The rest can go.",
    ]);
    expect(panel).toContain("<b>lookover</b>");
    // Lookover posts no reply on a fixed thread: `lookover wait` resolves it.
    expect(panel).toContain("<b>Resolved</b> · verified fixed in <code>b2c3d4e</code>");
    expect(panel).not.toContain("<b>lookover</b> ·");
  });

  test("the app says who found and who double-checked, in Lookover's words", () => {
    expect(threeSidesHTML()).toContain("1 found by Codex · double-checked by Claude · posted");
    expect(threeSidesHTML()).not.toContain("confirmed by");
  });

  test("five beats, the last one with merging left to you", () => {
    expect(THREE_SIDES_BEATS.map((b) => b.at)).toEqual([0, 2900, 6900, 11000, 17300]);
    expect(THREE_SIDES_BEATS.at(-1)?.text).toBe(
      "Verified fixed. The check turns green. Merging stays your call.",
    );
  });

  test("each drawing of the eyes has its own ids", () => {
    const ids = [...threeSidesHTML().matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no colour of its own: the scene's script, styles and markup use the tokens", () => {
    const colour = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
    for (const file of ["./story.ts", "../scripts/three-sides.js", "../styles/three-sides.css"]) {
      // Comments say what a colour was; a pull request's number (`#148`, between tags or words) is no colour.
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
        .replace(/(?<=[>\s])#\d+(?=[<\s])/g, "");
      expect({ file, colour: source.match(colour)?.[0] ?? null }).toEqual({ file, colour: null });
    }
  });
});
