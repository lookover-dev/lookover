// The README and the getting-started page say one truth (ADR 0064, 10): every item of the README's "What you need"
// and its install commands are on the page word for word, as Markdown lines. The README stays the user's first
// page and links to the site.
import { describe, expect, test } from "bun:test";
import { commands, GETTING_STARTED, README, section } from "./readme.test-support.ts";

/** The lines each README section gives the page: "What you need"'s items, then each command block's lines. */
function sourced(readme: string): Array<[heading: string, lines: string[]]> {
  const items = section(readme, "What you need").filter(
    (line) => line.startsWith("- ") && line.trim() !== "",
  );
  return [
    ["What you need", items],
    ["Install", commands(readme, "Install")],
    ["First run", commands(readme, "First run")],
  ];
}

/** What the getting-started page must say as the README does: "What you need"'s items, then the commands. */
function required(readme: string): string[] {
  return sourced(readme).flatMap(([, lines]) => lines);
}

/** The sections that give the page nothing: a heading renamed or emptied would otherwise pass the test silently. */
function silent(readme: string): string[] {
  return sourced(readme)
    .filter(([, lines]) => lines.length === 0)
    .map(([heading]) => heading);
}

/** Each required line the page doesn't hold as one of its own lines, word for word. */
function drift(readme: string, page: string): string[] {
  const lines = new Set(page.split(/\r?\n/).map((line) => line.trim()));
  return required(readme).filter((line) => !lines.has(line.trim()));
}

const SAMPLE_README = [
  "# Tool",
  "## What you need",
  "",
  "- Node.js 18 or later.",
  "- A GitHub account.",
  "",
  "## Install",
  "",
  "```sh",
  "npm install -g tool",
  "```",
  "",
  "## First run",
  "",
  "```sh",
  "tool start",
  "```",
  "",
  "```sh",
  "tool stop",
  "```",
  "## Later",
  "- Not required.",
].join("\n");

describe("the README drift test", () => {
  test("needs every item of What you need, and the first command block of Install and of First run", () => {
    expect(required(SAMPLE_README)).toEqual([
      "- Node.js 18 or later.",
      "- A GitHub account.",
      "npm install -g tool",
      "tool start",
    ]);
  });

  test("passes a page that holds them all, in its own order and layout", () => {
    const page =
      "Start with `tool start`.\n\n```sh\ntool start\n```\n- A GitHub account.\n- Node.js 18 or later.\n\n```sh\nnpm install -g tool\n```";
    expect(drift(SAMPLE_README, page)).toEqual([]);
  });

  test("names each line the page changed or left out", () => {
    const page = "- Node.js 20 or later.\n- A GitHub account.\n\n```sh\nnpm i -g tool\ntool start\n```";
    expect(drift(SAMPLE_README, page)).toEqual(["- Node.js 18 or later.", "npm install -g tool"]);
  });

  test("names each of the three sections a renamed or emptied heading leaves without a line", () => {
    expect(silent(SAMPLE_README)).toEqual([]);
    const renamed = SAMPLE_README.replace("## Install", "## Installation").replace(
      "## First run",
      "## Start",
    );
    expect(silent(renamed)).toEqual(["Install", "First run"]);
    expect(silent(SAMPLE_README.replace("- Node.js 18 or later.\n- A GitHub account.", ""))).toEqual([
      "What you need",
    ]);
  });

  test("the getting-started page says what the README says", () => {
    expect(silent(README)).toEqual([]);
    expect(drift(README, GETTING_STARTED)).toEqual([]);
  });

  test("the README links to the site", () => {
    const links = README.match(/\]\(https:\/\/lookover\.dev[/)]/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
  });
});
