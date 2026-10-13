// The fake `claude` program (ADR 0039): replays recordings of the real CLI, so the real `engines` module is
// tested in every check without calling `claude`. Run with bun:
//   claude.ts --recording <dir> [--recording <dir>...] <claude's own arguments...>
// `--version` prints version.txt and `auth status` auth.txt, both from the first recording, and `--help` its
// help.txt, else the fake's own (`fake-claude/help.txt`, the real CLI's); anything else is a run: the prompt is read
// from stdin, what was received (the arguments, the prompt, every environment variable's name, never its value) is written to
// claude.received.json in the working directory for the tests to read, then one recording's run.stdout.jsonl and
// run.stderr.txt are replayed. Which one: the first whose meta.json `when` is a text the prompt holds (a review
// recorded on one commit names it: `Head commit: <sha>`), else the first with no `when`, else the first given. The
// exit codes are in meta.json; a run marked `hang` never exits, as the real one never answered, until it is killed. A
// recording's meta.json `writes` (file name to content) is written in the working directory during the run, as a
// program whose wall gave way would. A file the recording read in the folder it was made in (its init line's `cwd`)
// is replayed as one read in the folder the fake runs in (ADR 0055): only a tool call's `file_path`, so what the
// self-test reads of denials and outputs stays as recorded.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Meta {
  version: { exitCode: number };
  auth: { exitCode: number };
  run: { exitCode: number; hang: boolean };
  /** The run is replayed when the prompt holds this text. */
  when?: string;
  /** Files the run writes in the working directory. */
  writes?: Record<string, string>;
}

const argv = process.argv.slice(2);
const recordings: string[] = [];
const args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] ?? "";
  if (arg === "--recording") recordings.push(argv[++i] ?? "");
  else args.push(arg);
}
const first = recordings[0] ?? "";

const metaOf = (dir: string): Meta => JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const text = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

/**
 * The recording's stdout, each `file_path` under the folder its init line names (as JSON writes it) moved under the
 * one the fake runs in, so a file the real run read inside its worktree is read inside the fake's.
 */
function replayed(dir: string): string {
  const stdout = text(dir, "run.stdout.jsonl");
  const init = /"subtype":"init"[^\n]*?"cwd":("(?:[^"\\]|\\.)*")/.exec(stdout);
  if (!init?.[1]) return stdout;
  const recorded = init[1].slice(1, -1);
  const here = JSON.stringify(process.cwd()).slice(1, -1);
  return stdout.split(`"file_path":"${recorded}`).join(`"file_path":"${here}`);
}

/** Writes `out`, then ends with `code` once it is flushed: `process.exit` right away would cut a pipe short. */
function finish(out: string, code: number): void {
  process.stdout.write(out, () => {
    process.exitCode = code;
  });
}

/** The recording to replay for `prompt` (see the header). */
function chosen(prompt: string): string {
  const metas = recordings.map((dir) => ({ dir, when: metaOf(dir).when }));
  const named = metas.find((m) => m.when !== undefined && prompt.includes(m.when));
  return (named ?? metas.find((m) => m.when === undefined) ?? { dir: first }).dir;
}

/** The help the first recording prints: its own help.txt, else the fake's. */
function help(): string {
  const own = join(first, "help.txt");
  return readFileSync(existsSync(own) ? own : join(import.meta.dir, "help.txt"), "utf8");
}

if (args[0] === "--help") {
  finish(help(), 0);
} else if (args[0] === "--version") {
  finish(text(first, "version.txt"), metaOf(first).version.exitCode);
} else if (args[0] === "auth" && args[1] === "status") {
  finish(text(first, "auth.txt"), metaOf(first).auth.exitCode);
} else {
  const stdin = await Bun.stdin.text();
  // biome-ignore lint/plugin: the fake is the program that was started; what it reports is the environment it was given, which is what a test checks.
  const env = Object.keys(process.env).sort();
  writeFileSync(join(process.cwd(), "claude.received.json"), JSON.stringify({ args, stdin, env }, null, 2));
  const recording = chosen(stdin);
  const meta = metaOf(recording);
  for (const [file, content] of Object.entries(meta.writes ?? {}))
    writeFileSync(join(process.cwd(), file), content);
  process.stderr.write(text(recording, "run.stderr.txt"));
  if (meta.run.hang) {
    process.stdout.write(replayed(recording));
    setInterval(() => {}, 1000);
  } else {
    finish(replayed(recording), meta.run.exitCode);
  }
}
