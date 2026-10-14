// The README read as the site's tests read it (`readme.test.ts`, `landing/facts.test.ts`): its text, a section's
// lines and a section's first fenced block, so the two say one thing about where the install commands are.
import { readFileSync } from "node:fs";

/** The repository's README, as it is on disk. */
export const README = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

/** The getting-started page of the docs, as it is on disk. */
export const GETTING_STARTED = readFileSync(new URL("./content/docs/docs/index.md", import.meta.url), "utf8");

/** The lines under `## <heading>`, up to the next `## `. */
export function section(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** The lines of a section's first fenced code block. */
function firstFence(lines: string[]): string[] {
  const open = lines.findIndex((line) => line.startsWith("```"));
  if (open < 0) return [];
  const close = lines.findIndex((line, i) => i > open && line.startsWith("```"));
  return lines.slice(open + 1, close < 0 ? undefined : close);
}

/** The non-blank lines of the first fenced block under `## <heading>`: the commands that section gives. */
export function commands(markdown: string, heading: string): string[] {
  return firstFence(section(markdown, heading)).filter((line) => line.trim() !== "");
}
