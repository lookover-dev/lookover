// The installed skill's text (ADR 0058): `packages/agent-cli/skill/SKILL.md` rendered with Lookover's command, every
// spot filled and the rest of the file as written, its stamp in place of the template's note, the dev name for a
// development run; and the command line itself, written once for both a POSIX shell (Claude Code's Git Bash on
// Windows) and PowerShell (Codex's on Windows), run through both shells on a harmless program in a folder with a
// space in its name, and in one with an apostrophe too; refused, saying why, for a path no such line holds.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_TEMPLATE, skillTemplateOf } from "@lookover/agent-cli";
import { renderSkill, skillCommandLine, skillStampOf } from "./index.ts";

const EXE = "C:/Users/Your Name/Downloads/lookover.exe";
const BINARY = skillCommandLine([EXE]);
const CLONE = skillCommandLine([
  "C:/Users/Your Name/.bun/bin/bun.exe",
  "D:/code/my lookover/apps/service/src/main.ts",
]);
const HOME = skillCommandLine([EXE, "--home=D:/lookover data"]);

/** The template's own note, which the stamp replaces: a reader of this repository's, not an agent's. */
const NOTE = /^<!-- The skill Lookover installs[\s\S]*? -->$/m;

/** The template's text between its spots, in order: what every rendering keeps as written. */
const fixedParts = (): string[] =>
  SKILL_TEMPLATE.replace(/^name: .*$/m, "")
    .replace(NOTE, "")
    .split(/\{\{lookover\}\}|\{\{powershell\}\}|\n/)
    .filter((part) => part.trim() !== "");

/** Whether `text` holds every one of `parts`, in order. */
function inOrder(text: string, parts: string[]): boolean {
  let at = 0;
  for (const part of parts) {
    const found = text.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}

test("the command line: forward slashes as given, a word with a space quoted, the same line both shells read", () => {
  expect(BINARY).toBe("'C:/Users/Your Name/Downloads/lookover.exe'");
  expect(skillCommandLine(["C:/tools/lookover.exe"])).toBe("C:/tools/lookover.exe");
  expect(HOME).toBe("'C:/Users/Your Name/Downloads/lookover.exe' '--home=D:/lookover data'");
  // A `'` in a word: double quotes, which neither shell reads differently when nothing in it expands.
  expect(skillCommandLine(["/home/o'brien/lookover"])).toBe(`"/home/o'brien/lookover"`);
});

test("a word no one line holds for both shells: refused, saying what in it and what to do", () => {
  // A `'` with what double quotes expand: PowerShell misreads a POSIX shell's `'\''`.
  expect(() => skillCommandLine(["/home/o'brien/$tools/lookover"])).toThrow(
    `The skill can't be installed: Lookover's command holds a ' and a $ ("/home/o'brien/$tools/lookover"), which no one line writes for both Git Bash and PowerShell. Move Lookover, or its data folder, to a folder without them.`,
  );
  expect(() => skillCommandLine(["C:/Users/Your Name/lookover.exe", "--home=D:/it's `here`"])).toThrow(
    `The skill can't be installed: Lookover's command holds a backtick ("--home=D:/it's \`here\`"), which no one line writes for both Git Bash and PowerShell. Move Lookover, or its data folder, to a folder without them.`,
  );
  expect(() => skillCommandLine(["/home/ada/two\nlines/lookover"])).toThrow(/holds a line break/);
  expect(() => skillCommandLine(["/home/ada/two\rlines/lookover"])).toThrow(/holds a line break/);
});

test("a binary with a space in its path: every spot filled with its command, PowerShell's with `&`", () => {
  const text = renderSkill({ name: "lookover-review-loop", command: BINARY, version: "0.1.0" });
  expect(text).not.toContain("{{");
  expect(text).toContain(`\n${BINARY} wait --json\n`);
  expect(text).toContain(`\`& ${BINARY} status\``);
  expect(text).toContain(`run \`${BINARY} status\`. Stopped`);
  expect(text).toContain(`\n${BINARY} reply F3 wont-fix `);
  // The rest as written: the template's own `lookover` words untouched.
  expect(inOrder(text, fixedParts())).toBe(true);
  expect(text).toContain("/lookover review");
  expect(text).toContain("LOOKOVER_APP");
  // No bare `lookover <verb>` for an agent to copy: it would run whatever `lookover` its PATH finds, or nothing.
  expect(text).not.toMatch(/`lookover (wait|feedback|reply|status|open|start|stop)\b/);
  expect(text.startsWith("---\nname: lookover-review-loop\ndescription: Get a pull request through")).toBe(
    true,
  );
});

test("the template's note gives way to the stamp: the version and the command the skill was written for", () => {
  const text = renderSkill({ name: "lookover-review-loop", command: BINARY, version: "0.1.0" });
  expect(text).not.toMatch(NOTE);
  expect(text).not.toContain("In this repository");
  expect(skillStampOf(text)).toEqual({ version: "0.1.0", command: BINARY });
  expect(text).toMatch(/^---\n[\s\S]*?\n---\n<!-- lookover-skill \{/);
});

const O = { name: "lookover-review-loop", command: BINARY, version: "0.1.0" };
/** The template as a checkout with CRLF line ends reads it from disk. */
const CRLF = SKILL_TEMPLATE.replaceAll("\n", "\r\n");

test("a template checked out with CRLF line ends: read as LF, so the stamp goes in", () => {
  expect(SKILL_TEMPLATE).not.toContain("\r");
  expect(skillTemplateOf(CRLF)).toBe(SKILL_TEMPLATE);
  expect(renderSkill(O, skillTemplateOf(CRLF))).toBe(renderSkill(O));
});

test("a template the stamp can't go in: refused, never written unstamped", () => {
  expect(() => renderSkill(O, CRLF)).toThrow(/stamp/);
  expect(() => renderSkill(O, SKILL_TEMPLATE.replace(NOTE, ""))).toThrow(/stamp/);
});

test("a clone: its Bun and main.ts by absolute paths; --home: the data folder in the command", () => {
  const clone = renderSkill({ name: "lookover-review-loop", command: CLONE, version: "0.1.0" });
  expect(clone).toContain(
    "\n'C:/Users/Your Name/.bun/bin/bun.exe' 'D:/code/my lookover/apps/service/src/main.ts' wait --json\n",
  );
  expect(inOrder(clone, fixedParts())).toBe(true);
  const home = renderSkill({ name: "lookover-review-loop", command: HOME, version: "0.1.0" });
  expect(home).toContain(`\n${HOME} feedback --json `);
  expect(home).toContain(`\`& ${HOME} status\``);
  expect(inOrder(home, fixedParts())).toBe(true);
});

test("the dev name: the front matter's `name:` renamed, nothing else", () => {
  const ours = renderSkill({ name: "lookover-review-loop", command: BINARY, version: "0.1.0" });
  const dev = renderSkill({ name: "lookover-dev-review-loop", command: BINARY, version: "0.1.0" });
  expect(dev).toContain("\nname: lookover-dev-review-loop\n");
  expect(dev).not.toContain("name: lookover-review-loop");
  expect(dev.replace("name: lookover-dev-review-loop", "name: lookover-review-loop")).toBe(ours);
});

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-skill-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Git's own bash on Windows (never WSL's `bash.exe` in System32), any `bash` elsewhere; null when there is none. */
function bashOf(): string | null {
  if (process.platform !== "win32") return Bun.which("bash");
  const exec = Bun.spawnSync(["git", "--exec-path"]);
  if (exec.exitCode !== 0) return null;
  // <git>/mingw64/libexec/git-core → <git>/bin/bash.exe
  const bash = join(dirname(dirname(dirname(exec.stdout.toString().trim()))), "bin", "bash.exe");
  return Bun.file(bash).size > 0 ? bash : null;
}

/** PowerShell 7, else Windows PowerShell; null when there is neither. */
const powershellOf = (): string | null => Bun.which("pwsh") ?? Bun.which("powershell");

/**
 * A harmless program in `folder` under the scratch folder: Bun, hard-linked there (copied when it can't be: a fresh
 * file, never written over the link, which is the running Bun itself), and a script beside it printing its arguments
 * as JSON. Built once, before any test: its words in forward slashes, as the skill writes them.
 */
function harmlessIn(...folder: string[]): string[] {
  const at = join(scratch, ...folder);
  mkdirSync(at, { recursive: true });
  const bun = join(at, process.platform === "win32" ? "bun.exe" : "bun");
  try {
    linkSync(process.execPath, bun);
  } catch {
    copyFileSync(process.execPath, bun);
  }
  const script = join(at, "print args.ts");
  writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  return [bun, script].map((word) => word.replaceAll("\\", "/"));
}

/** The program's folders: one whose name has a space only (single quotes), one an apostrophe too (double quotes). */
const PROGRAMS = {
  space: harmlessIn("Sam tools", "my lookover"),
  apostrophe: harmlessIn("Sam's tools", "my lookover"),
};

/** What `line` printed, run by `shell` reading it on its standard input or as PowerShell's encoded command. */
async function ranIn(shell: string, line: string): Promise<{ code: number; out: string; err: string }> {
  const powershell = !/bash(\.exe)?$/i.test(shell);
  const argv = powershell
    ? [
        shell,
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(line, "utf16le").toString("base64"),
      ]
    : [shell, "-s"];
  const proc = Bun.spawn(argv, {
    stdin: powershell ? "ignore" : new Blob([`${line}\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err };
}

const bash = bashOf();
const powershell = powershellOf();

for (const [kind, words] of Object.entries(PROGRAMS)) {
  const line = `${skillCommandLine([...words, "--home=D:/lookover data"])} wait --json`;

  test(`a folder with ${kind === "space" ? "a space only: its program in single quotes" : "an apostrophe: its program in double quotes"}`, () => {
    expect(line.startsWith(kind === "space" ? "'" : '"')).toBe(true);
  });

  test.skipIf(bash === null)(
    `the line as written runs in a POSIX shell (Git Bash on Windows), a folder with ${kind === "space" ? "a space" : "an apostrophe"}`,
    async () => {
      const ran = await ranIn(bash ?? "", line);
      expect(ran.err).toBe("");
      expect(JSON.parse(ran.out)).toEqual(["--home=D:/lookover data", "wait", "--json"]);
    },
  );

  test.skipIf(powershell === null)(
    `the line with \`&\` before it runs in PowerShell, a folder with ${kind === "space" ? "a space" : "an apostrophe"}`,
    async () => {
      const ran = await ranIn(powershell ?? "", `& ${line}`);
      expect(ran.err).toBe("");
      expect(JSON.parse(ran.out)).toEqual(["--home=D:/lookover data", "wait", "--json"]);
    },
  );
}
