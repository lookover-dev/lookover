// The fake `codex` program (ADR 0039, ADR 0044): replays recordings of the real CLI, so the real `engines` module
// is tested in every check without calling `codex`. Run with bun:
//   codex.ts --recording <dir> [--recording <dir>...] [--as-version <x.y.z>] <codex's own arguments...>
// `--version` prints version.txt on stdout and `login status` auth.txt on stderr, as the real one answers it
// (codex-cli 0.162.1), both from the first recording (`--as-version` prints `codex-cli <x.y.z>` instead: another
// version of codex, for demo mode's "Update Codex"), and `exec --help` its help.txt, else the fake's own
// (`fake-codex/help.txt`, the real CLI's); `exec` is a run: the prompt is read from stdin, what was
// received (the arguments, the prompt, every environment variable's name, never its value) is written to codex.received.json in
// the working directory for the tests to read, then one recording's run.stdout.jsonl and run.stderr.txt are
// replayed. Which one: the first whose meta.json `when` is a text the prompt holds, else the first with no
// `when`, else the first given. The exit codes are in meta.json; a run marked `hang` never exits, as the real
// one never answered, until it is killed. A recording's meta.json `writes` (file name to content) is written in the
// working directory during the run, as a program whose sandbox gave way would.
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
let asVersion: string | null = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] ?? "";
  if (arg === "--recording") recordings.push(argv[++i] ?? "");
  else if (arg === "--as-version") asVersion = argv[++i] ?? "";
  else args.push(arg);
}
const first = recordings[0] ?? "";

const metaOf = (dir: string): Meta => JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const text = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

/** Writes `out` to `stream`, then ends with `code` once it is flushed: `process.exit` would cut a pipe short. */
function finish(stream: NodeJS.WriteStream, out: string, code: number): void {
  stream.write(out, () => {
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

if (args[0] === "exec" && args[1] === "--help") {
  finish(process.stdout, help(), 0);
} else if (args[0] === "--version") {
  const printed = asVersion === null ? text(first, "version.txt") : `codex-cli ${asVersion}\n`;
  finish(process.stdout, printed, metaOf(first).version.exitCode);
} else if (args[0] === "login" && args[1] === "status") {
  finish(process.stderr, text(first, "auth.txt"), metaOf(first).auth.exitCode);
} else if (args[0] === "exec") {
  const stdin = await Bun.stdin.text();
  // biome-ignore lint/plugin: the fake is the program that was started; what it reports is the environment it was given, which is what a test checks.
  const env = Object.keys(process.env).sort();
  writeFileSync(join(process.cwd(), "codex.received.json"), JSON.stringify({ args, stdin, env }, null, 2));
  const recording = chosen(stdin);
  const meta = metaOf(recording);
  for (const [file, content] of Object.entries(meta.writes ?? {}))
    writeFileSync(join(process.cwd(), file), content);
  process.stderr.write(text(recording, "run.stderr.txt"));
  if (meta.run.hang) {
    process.stdout.write(text(recording, "run.stdout.jsonl"));
    setInterval(() => {}, 1000);
  } else {
    finish(process.stdout, text(recording, "run.stdout.jsonl"), meta.run.exitCode);
  }
} else {
  finish(process.stderr, `error: unrecognized subcommand '${args[0] ?? ""}'\n`, 2);
}
