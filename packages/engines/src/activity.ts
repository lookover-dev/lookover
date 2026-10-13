// What an engine did, read from its stream as it comes (ADR 0055): the chunks `process` hands over are split into
// lines, and each line is read by its engine's reader. Only what the engine did comes out (a file read, a pattern
// searched or listed, a command run), never what the model wrote: its text, thinking, summaries and messages can be
// steered by the pull request (ADR 0048). See `index.ts`.
import type { EngineActivity } from "@lookover/contracts";
import { z } from "zod";
import { parseLine } from "./stream.ts";

/** Lines out of chunks: a partial line is held until the rest comes; `end` hands over a last line with no newline. */
export interface LineSplitter {
  push(chunk: string): void;
  end(): void;
}

export function lineSplitter(onLine: (line: string) => void): LineSplitter {
  // The partial line's pieces, joined once its newline comes: only each new chunk is searched for one, so a long
  // line in many chunks costs its length, not its length times its chunks.
  let held: string[] = [];
  return {
    push(chunk) {
      let start = 0;
      for (let at = chunk.indexOf("\n"); at !== -1; at = chunk.indexOf("\n", start)) {
        held.push(chunk.slice(start, at));
        const line = held.join("");
        held = [];
        start = at + 1;
        onLine(line);
      }
      if (start < chunk.length) held.push(chunk.slice(start));
    },
    end() {
      const last = held.join("");
      held = [];
      if (last !== "") onLine(last);
    },
  };
}

/** Where a Claude run's paths are shown from: its worktree, the home folder, and whether case counts (Windows: not). */
export interface Where {
  cwd: string;
  home: string | null;
  caseless: boolean;
}

const toolUse = z.object({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).catch({}),
});
const assistant = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()).catch([]) }),
});

/** A string field of a tool's input, or null when it isn't one. */
const field = (input: Record<string, unknown>, name: string): string | null => {
  const value = input[name];
  return typeof value === "string" && value !== "" ? value : null;
};

/**
 * What one line of Claude's stream says it did: each `tool_use` of an assistant event, a `Read` as its file (see
 * `shownPath`), a `Grep` as its pattern, a `Glob` as its pattern. Any other tool (none is allowed), and everything
 * else in the line, gives nothing.
 */
export function claudeActivitiesOf(line: string, where: Where): EngineActivity[] {
  const event = assistant.safeParse(parseLine(line));
  if (!event.success) return [];
  return event.data.message.content.flatMap((block): EngineActivity[] => {
    const use = toolUse.safeParse(block);
    if (!use.success) return [];
    const { name, input } = use.data;
    if (name === "Read") {
      const path = field(input, "file_path");
      return path === null ? [] : [{ kind: "read", path: shownPath(path, where) }];
    }
    const pattern = field(input, "pattern");
    if (pattern === null) return [];
    if (name === "Grep") return [{ kind: "search", pattern }];
    if (name === "Glob") return [{ kind: "list", pattern }];
    return [];
  });
}

const ABSOLUTE = /^(?:[A-Za-z]:)?[\\/]/;

/**
 * A path as the owner reads it: inside the worktree, relative to it with `/`; a relative one, with `/`; anywhere
 * else as it is, the home folder as `~`, so a read outside the change shows.
 */
function shownPath(path: string, where: Where): string {
  if (!ABSOLUTE.test(path)) return path.replace(/\\/g, "/");
  const inside = after(path, where.cwd, where.caseless);
  if (inside !== null) return inside.replace(/\\/g, "/");
  const home = where.home === null ? null : after(path, where.home, where.caseless);
  return home === null ? path : `~${path.slice(path.length - home.length - 1)}`;
}

/** What follows `folder` and a separator in `path`, either separator matching; null when `path` isn't under it. */
function after(path: string, folder: string, caseless: boolean): string | null {
  const base = folder.replace(/[\\/]+$/, "");
  if (base === "" || path.length <= base.length + 1) return null;
  // Compared on slices of equal length: lowercasing may change a text's length, so it is never sliced after.
  const same = (a: string, b: string) => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);
  const head = path.slice(0, base.length).replace(/\\/g, "/");
  const separator = path[base.length];
  if (!same(head, base.replace(/\\/g, "/")) || (separator !== "/" && separator !== "\\")) return null;
  return path.slice(base.length + 1);
}

const commandStarted = z.object({
  type: z.literal("item.started"),
  item: z.object({ type: z.literal("command_execution"), command: z.string() }),
});

/** What one line of Codex's stream says it did: a command it started, its shell wrapper removed (`unwrapped`). */
export function codexActivitiesOf(line: string): EngineActivity[] {
  const event = commandStarted.safeParse(parseLine(line));
  return event.success ? [{ kind: "command", text: unwrapped(event.data.item.command) }] : [];
}

/** The shells Codex wraps a command in (0.154.0: `pwsh.exe -Command` on Windows, `bash -lc` elsewhere). */
const SHELLS = new Set(["pwsh", "powershell", "bash", "sh", "zsh"]);
const SCRIPT_FLAGS = new Set(["-c", "-lc", "-command"]);

/**
 * The command without its shell: Codex shows a command as its words quoted as a POSIX shell would; a shell, its
 * flags (one of them `-c`, `-lc` or `-Command`) and a script give the script. Anything else is shown as it is.
 */
function unwrapped(command: string): string {
  const words = wordsOf(command);
  if (words === null || words.length < 3) return command;
  const shell = (words[0]?.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  const flags = words.slice(1, -1).map((w) => w.toLowerCase());
  const script = words.at(-1) ?? "";
  if (!SHELLS.has(shell) || !flags.every((f) => f.startsWith("-")) || !flags.some((f) => SCRIPT_FLAGS.has(f)))
    return command;
  return script;
}

/**
 * One piece of a POSIX shell's command line: blanks between words, or a part of a word (a single-quoted text, a
 * double-quoted one, an escaped character, a bare run).
 */
const PIECE = /\s+|'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])|([^\s'"\\]+)/y;

/** Inside double quotes, a backslash escapes only these. */
const unquoted = (text: string) => text.replace(/\\(["\\$`\n])/g, "$1");

/** The words of `text` as a POSIX shell splits them; null when a quote is left open. */
function wordsOf(text: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  PIECE.lastIndex = 0;
  while (PIECE.lastIndex < text.length) {
    const piece = PIECE.exec(text);
    if (piece === null) return null;
    const [, single, double, escaped, bare] = piece;
    const part = single ?? escaped ?? bare ?? (double === undefined ? null : unquoted(double));
    if (part === null) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + part;
  }
  if (word !== null) words.push(word);
  return words;
}
