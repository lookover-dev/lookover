// The docs (ADR 0062, D5; ADR 0064): eight pages, each in the sidebar once, none pointing into the private tree, and
// the coding agent's exit codes, `wait`'s defaults, `reply`'s claims and `settle`'s line as the agent's command has
// them, and what the pages say of settling on the owner's word (ADR 0101), the reason's limit as the service keeps it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { CLAIMS, USAGE } from "@lookover/agent-cli";
import { REASON_MAX } from "@lookover/contracts";

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

  test("the coding agent's page names the threads `wait` resolves as its help does", () => {
    const words = (text: string) =>
      /resolves\s+the\s+threads\s+of\s+the\s+findings\s+it\s+([^.]+)\./.exec(text)?.[1]?.replace(/\s+/g, " ");
    expect(words(USAGE)).toBe("verified fixed or withdrew, or the owner settled");
    expect(words(page("coding-agent.md"))).toBe(words(USAGE));
  });

  test("the coding agent's page puts a finding with no thread in the status block, no summary comment", () => {
    const text = page("coding-agent.md");
    expect(text).not.toContain("in the summary only");
    expect(text).toContain("in the status block only, in the pull request's description");
  });

  test("the coding agent's page lists `reply`'s claims, each with the words it opens the reply with", () => {
    const rows = lines("coding-agent.md")
      .map((line) => /^\| `([a-z-]+)` \| ([^:|]+):/.exec(line))
      .filter((row) => row !== null)
      .map((row) => ({ word: row[1], opening: row[2] }));
    expect(rows).toEqual(Object.values(CLAIMS).map(({ word, opening }) => ({ word, opening })));
  });

  test("the commands page gives `settle`'s line as its help does, and the coding agent's page its timeout", () => {
    const usage = /lookover settle (<finding> <accepted\|wrong> --confirmed-by-owner <reason>)/.exec(
      USAGE,
    )?.[1];
    expect(usage).toBe("<finding> <accepted|wrong> --confirmed-by-owner <reason>");
    expect(page("commands.md")).toContain(`\`lookover settle ${usage?.replace("|", "\\|")}\``);
    const timeout = /\(settle: (\d+)m, for Lookover's answer\)/.exec(USAGE)?.[1];
    expect(timeout).toBe("3");
    expect(
      /up to (\d+) minutes \(`--timeout`\)\. It exits 0 once the finding is settled/.exec(
        page("coding-agent.md"),
      )?.[1],
    ).toBe(timeout);
  });

  test("the coding agent's page and the security page say when the agent settles, and what nothing proves", () => {
    const words = (text: string) => text.replace(/\s+/g, " ");
    const agent = words(page("coding-agent.md"));
    expect(agent).toContain("`--confirmed-by-owner` is required and takes your reason");
    expect(agent).toContain(`on one line of at most ${REASON_MAX} characters`);
    expect(agent).toContain(
      "only when you said so in the conversation: never on its own judgment, never to get past a finding it disagrees with",
    );
    expect(agent).toContain("nothing on GitHub proves you confirmed it");
    expect(agent).not.toContain("No reply, comment or command settles it");
    expect(words(page("security.md"))).toContain("nothing on GitHub proves you confirmed it");
  });
});
