// What a web build emitted that a content security policy would block (ADR 0085, #674): a `@font-face` whose font is a
// `data:` URI when `font-src` doesn't allow `data:` (Vite inlines a small file unless told not to), and, in
// `index.html`, a `<script>` without `src`, a `<style>` or a `style=` attribute when `script-src` or `style-src`
// doesn't allow `'unsafe-inline'`. A directive the policy doesn't name falls back to `default-src`, as browsers do;
// with neither, nothing limits it.
// `cspFaults` reads the files' text, so fixture strings prove each rule bites (`csp-faults.test.ts`); `emittedOf`
// reads a build's folder for it (the web-build test). The policy is the service's own (`CSP`, never a copy).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** A build's files that a policy reaches by their text: its path under the build folder, with `/`, to its text. */
export type Emitted = Readonly<Record<string, string>>;

/** A policy's directives, each to its sources. */
function directivesOf(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !directives.has(name)) directives.set(name, sources);
  }
  return directives;
}

/** One rule: the directive that decides it, the source that lets the fault through, the fault, and where it's sought. */
interface Rule {
  directive: "font-src" | "script-src" | "style-src";
  allowedBy: string;
  fault: string;
  in(name: string): boolean;
  found(text: string): boolean;
}

const RULES: readonly Rule[] = [
  {
    directive: "font-src",
    allowedBy: "data:",
    fault: "a @font-face with a data: font",
    in: (name) => name.endsWith(".css"),
    found: (text) =>
      (text.match(/@font-face\s*\{[^}]*\}/gi) ?? []).some((face) => /url\(\s*["']?data:/i.test(face)),
  },
  {
    directive: "script-src",
    allowedBy: "'unsafe-inline'",
    fault: "a <script> without src",
    in: (name) => name === "index.html",
    found: (text) => (text.match(/<script\b[^>]*>/gi) ?? []).some((tag) => !/\ssrc\s*=/i.test(tag)),
  },
  {
    directive: "style-src",
    allowedBy: "'unsafe-inline'",
    fault: "a <style>",
    in: (name) => name === "index.html",
    found: (text) => /<style\b/i.test(text),
  },
  {
    directive: "style-src",
    allowedBy: "'unsafe-inline'",
    fault: "a style= attribute",
    in: (name) => name === "index.html",
    found: (text) => /<[a-z][^>]*\sstyle\s*=/i.test(text),
  },
];

/** The faults of the files, one line each: the file, then what the policy blocks in it. */
export function cspFaults(files: Emitted, csp: string): string[] {
  const directives = directivesOf(csp);
  // Undefined when the policy names neither the directive nor `default-src`: then nothing limits it.
  const sources = (name: string) => directives.get(name) ?? directives.get("default-src");
  const blocks = (rule: Rule) => {
    const allowed = sources(rule.directive);
    return allowed !== undefined && !allowed.includes(rule.allowedBy);
  };
  return Object.entries(files).flatMap(([name, text]) =>
    RULES.filter((rule) => rule.in(name) && blocks(rule) && rule.found(text)).map(
      (rule) =>
        `${name}: ${rule.fault}, which ${rule.directive} ${sources(rule.directive)?.join(" ")} blocks`,
    ),
  );
}

/** A build folder's `index.html` and every stylesheet under it, for `cspFaults`. */
export function emittedOf(dir: string): Emitted {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const name = relative(dir, join(dir, entry)).split(sep).join("/");
    if (name === "index.html" || name.endsWith(".css")) files[name] = readFileSync(join(dir, entry), "utf8");
  }
  return files;
}
