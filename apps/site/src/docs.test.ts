// The docs (ADR 0062, D5; ADR 0064): eight pages, each in the sidebar once, none pointing into the private tree, and
// the coding agent's exit codes, `wait`'s defaults and `reply`'s claims as the agent's command has them.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { CLAIMS, USAGE } from "@lookover/agent-cli";

const DOCS = new URL("./content/docs/docs/", import.meta.url);
const CONFIG = new URL("../astro.config.mjs", import.meta.url);

/** Each page's sidebar slug, from its file: `index.md` is `/docs/`, `setup.md` is `/docs/setup/`. */
const pageSlugs = (): string[] =>
  readdirSync(DOCS)
    .filter((name) => name.endsWith(".md") || name.endsWith(".mdx"))
    .map((name) => name.replace(/\.mdx?$/, ""))
    .map((name) => (name === "index" ? "docs" : `docs/${name}`));

/** The slugs the sidebar names, in its order. */
const sidebarSlugs = (config: string): string[] =>
  [...config.matchAll(/slug:\s*"([^"]+)"/g)].map((match) => match[1] ?? "");

const page = (name: string) => readFileSync(new URL(name, DOCS), "utf8");
const lines = (name: string) => page(name).split(/\r?\n/);

/** The codes a list such as `0 nothing to fix, 1 error, 2 usage` names, in order. */
const codesIn = (text: string): number[] =>
  [...text.matchAll(/(?:^|[,:]\s*)(\d+) [a-z]/g)].map((m) => Number(m[1]));

describe("the docs", () => {
  test("eight pages, each in the sidebar once, and the sidebar names no page that isn't there", () => {
    const pages = pageSlugs();
    const sidebar = sidebarSlugs(readFileSync(CONFIG, "utf8"));
    expect(pages).toHaveLength(8);
    expect(new Set(sidebar).size).toBe(sidebar.length);
    expect([...sidebar].sort()).toEqual([...pages].sort());
    expect(sidebar[0]).toBe("docs");
  });

  test("no page points into the private tree or names a private repository", () => {
    for (const name of readdirSync(DOCS)) {
      const text = page(name);
      expect({
        name,
        private: /lookover-private|\]\((?:\.\.\/)+docs\/|lookover\/(?:blob|tree)\/[^/]+\/docs\//.test(text),
      }).toEqual({
        name,
        private: false,
      });
    }
  });

  test("the coding agent's page gives every exit code `wait` and `feedback` have, and no other", () => {
    const exits = USAGE.slice(USAGE.indexOf("Exit (wait and feedback):"), USAGE.indexOf("reply:"));
    const known = codesIn(exits.replace("Exit (wait and feedback):", ":"));
    expect(known).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 10]);
    const table = lines("coding-agent.md")
      .map((line) => /^\| (\d+(?:, \d+)?) \|/.exec(line)?.[1])
      .filter((cell) => cell !== undefined)
      .flatMap((cell) => cell.split(", ").map(Number));
    expect([...table].sort((a, b) => a - b)).toEqual(known);
  });

  test("the coding agent's page gives `wait`'s defaults as its help does", () => {
    const help = {
      timeout: /\[--timeout (\d+)m\]/.exec(USAGE)?.[1],
      appear: /\[--appear-timeout (\d+)m\]/.exec(USAGE)?.[1],
    };
    expect(help).toEqual({ timeout: "30", appear: "3" });
    const text = page("coding-agent.md");
    expect({
      timeout: /up to (\d+) minutes \(`--timeout`\)/.exec(text)?.[1],
      appear: /(\d+) minutes for Lookover to pick the request up \(`--appear-timeout`\)/.exec(text)?.[1],
    }).toEqual(help);
  });

  test("the coding agent's page lists `reply`'s claims, each with the words it opens the reply with", () => {
    const rows = lines("coding-agent.md")
      .map((line) => /^\| `([a-z-]+)` \| ([^:|]+):/.exec(line))
      .filter((row) => row !== null)
      .map((row) => ({ word: row[1], opening: row[2] }));
    expect(rows).toEqual(Object.values(CLAIMS).map(({ word, opening }) => ({ word, opening })));
  });
});
