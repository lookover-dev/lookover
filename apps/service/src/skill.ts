// The skill's text (ADR 0058): the one renderer every install writes with, and whose a skill in an agent's folder is,
// read from its stamp. The text is `packages/agent-cli/skill/SKILL.md` (`SKILL_TEMPLATE`), its spots filled with the
// command the skill calls, its front matter's `name:` the one it is installed as, and its note to this repository's
// readers replaced by the stamp: one line naming the Lookover version and the command the skill was written for. The
// same command is this Lookover's (`ours`), another is another Lookover's (`another`), none is a skill Lookover didn't
// write (`foreign`).
// The command is `skillCommandLine`'s (`shell-line.ts`): one line Git Bash runs as it is and PowerShell with `&`.
import { SKILL_TEMPLATE } from "@lookover/agent-cli";
import type { SkillState } from "@lookover/contracts";
import { z } from "zod";

/** What the skill is written for: its name (folder and `name:`), the absolute command it calls, Lookover's version. */
export interface SkillFor {
  name: string;
  /** `skillCommandLine`'s: a POSIX shell's line, PowerShell's once `&` is put before it. */
  command: string;
  version: string;
  /** Why no skill can be written for this Lookover (`skillCommandLine`'s refusal): `renderSkill` refuses with it. */
  refused?: string;
}

/** The stamp's line: an HTML comment holding the version and the command as JSON. */
const STAMP = /^<!-- lookover-skill (\{.*\}) -->$/m;
const STAMPED = z.object({ version: z.string(), command: z.string() });

/** The stamp of a skill written for `o`; `>` escaped so the command never ends the comment. */
const stampOf = (o: SkillFor): string =>
  `<!-- lookover-skill ${JSON.stringify({ version: o.version, command: o.command }).replaceAll(">", "\\u003e")} -->`;

/** The template's note to this repository's readers, the first HTML comment after the front matter. */
const NOTE = /^(---\n[\s\S]*?\n---\n)<!--[\s\S]*?-->\n/;
/** The front matter's name. */
const NAME = /^name: .*$/m;

/**
 * The `SKILL.md` Lookover installs, for `o`: the template (`SKILL_TEMPLATE`, another in a test), every spot filled,
 * stamped, named. Throws when the stamp can't go in, a skill without it would read as not Lookover's forever, and
 * with `o.refused` when no line holds the command.
 */
export function renderSkill(o: SkillFor, template: string = SKILL_TEMPLATE): string {
  if (o.refused !== undefined) throw new Error(o.refused);
  if (!NOTE.test(template))
    throw new Error(
      "The skill's template has no note after its front matter for the stamp to replace: nothing was written.",
    );
  // Functions, not strings: a command's `$&` or `$1` is text, not a replacement pattern.
  return template
    .replace(NOTE, (_, front: string) => `${front}${stampOf(o)}\n`)
    .replace(NAME, () => `name: ${o.name}`)
    .replaceAll("{{powershell}}", () => `& ${o.command}`)
    .replaceAll("{{lookover}}", () => o.command);
}

/** The version and command a skill's stamp names; null without a stamp that reads. */
export function skillStampOf(text: string): { version: string; command: string } | null {
  const found = STAMP.exec(text)?.[1];
  if (found === undefined) return null;
  try {
    const stamp = STAMPED.safeParse(JSON.parse(found));
    return stamp.success ? stamp.data : null;
  } catch {
    // Not JSON: a stamp mangled by hand is no stamp.
    return null;
  }
}

/** Whose the skill `text` is (null: none there), for this Lookover's absolute `command`. */
export function skillStateOf(text: string | null, command: string): SkillState {
  if (text === null) return "none";
  const stamp = skillStampOf(text);
  if (stamp === null) return "foreign";
  return stamp.command === command ? "ours" : "another";
}

/** Whether the skill `text` is this Lookover's, written by another version: what a start refreshes (ADR 0058). */
export function staleSkill(text: string | null, o: SkillFor): boolean {
  if (text === null) return false;
  const stamp = skillStampOf(text);
  return stamp !== null && stamp.command === o.command && stamp.version !== o.version;
}
