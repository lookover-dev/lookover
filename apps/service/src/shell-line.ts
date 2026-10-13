// Lookover's command as a shell reads it back (ADR 0058): one module for every line Lookover writes for a shell. The
// line a person types (`commandLine`): PowerShell's on Windows, where a quoted executable needs the call operator
// `&`, a POSIX shell's elsewhere. The line the installed skill calls (`skillCommandLine`): one both shells a coding
// agent runs read the same, a POSIX shell's (Claude Code's on Windows is Git Bash) as it is, PowerShell's (Codex's on
// Windows) with `&` before it, which a quoted program needs there and which POSIX shells refuse, so the skill says
// it. No one line runs in both when the program's path has a space.

/**
 * The characters a word may hold unquoted: PowerShell's on Windows, where `\` separates a path's folders; a POSIX
 * shell's elsewhere, where `\` escapes; both shells' for the skill's line, which is the POSIX one. Never `,`, which
 * PowerShell reads as an array, `~`, `$` or a quote.
 */
const PLAIN = { windows: /^[A-Za-z0-9_\-.:/\\=+]+$/, posix: /^[A-Za-z0-9_\-.:/=+]+$/ };
/** What a POSIX shell or PowerShell reads inside double quotes: a word holding one can't be double-quoted. */
const EXPANDS = /[$`"\\!]/;

/**
 * `word` as the shell of `platform` reads it back whole: as it is when plain; else in single quotes, which keep `$`
 * and backticks as they are. A `'` inside is doubled in PowerShell, and closed, escaped and reopened in a POSIX shell.
 */
export function quoted(word: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return PLAIN.windows.test(word) ? word : `'${word.replaceAll("'", "''")}'`;
  return PLAIN.posix.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** `words` as one command line a person types: each quoted where it needs it, a quoted executable run by PowerShell's `&`. */
export function commandLine([executable = "", ...rest]: string[], platform: NodeJS.Platform): string {
  const first = quoted(executable, platform);
  const call = platform === "win32" && first !== executable ? "& " : "";
  return [`${call}${first}`, ...rest.map((word) => quoted(word, platform))].join(" ");
}

/**
 * What in `word` no one line holds for both shells, said for the user; null when nothing: a line break (the line
 * would be two), a backtick (it would end the skill's inline code), a `'` with what double quotes expand (a POSIX
 * shell's `'\''` is the only way left, and PowerShell misreads it).
 */
function unwritable(word: string): string | null {
  if (/[\r\n]/.test(word)) return "a line break";
  if (word.includes("`")) return "a backtick";
  const expands = EXPANDS.exec(word)?.[0];
  return word.includes("'") && expands !== undefined ? `a ' and a ${expands}` : null;
}

/**
 * `word` as both shells read it back whole: as it is when plain; else in single quotes, which neither shell reads
 * inside; a word with a `'` in double quotes, as nothing in it expands (`unwritable` refused the others).
 */
function bothQuoted(word: string): string {
  if (PLAIN.posix.test(word)) return word;
  return word.includes("'") ? `"${word}"` : `'${word}'`;
}

/**
 * The command line the skill calls, from its words (the program's absolute path, its arguments), each given as the
 * skill writes it (on Windows, with forward slashes, which both shells and Lookover read): a POSIX shell runs it as
 * it is, PowerShell with `&` before it. Throws, saying why for the user, for a word no such line holds: no skill is
 * better than one whose line runs something else.
 */
export function skillCommandLine(words: string[]): string {
  for (const word of words) {
    const what = unwritable(word);
    if (what !== null)
      throw new Error(
        `The skill can't be installed: Lookover's command holds ${what} (${JSON.stringify(word)}), which no one line writes for both Git Bash and PowerShell. Move Lookover, or its data folder, to a folder without them.`,
      );
  }
  return words.map(bothQuoted).join(" ");
}
