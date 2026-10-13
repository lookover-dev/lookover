// Your coding agent (ADR 0058): what lets the user's own coding agent run the review loop. Whether `lookover` on the
// PATH reaches this Lookover, whether Lookover offers to make it so, and, for each agent Lookover found, whether the
// `lookover-review-loop` skill is in that agent's folder and whose it is. Facts only: the app words them.
import type { EngineId } from "./engine.ts";

/**
 * Whether a terminal's `lookover` reaches this Lookover, read from the PATH as saved (the user's and the machine's),
 * not the service's own: `yes`; `no`; `linked`, Lookover's link is in its folder but that folder isn't on the PATH
 * (macOS and Linux's `~/.local/bin`), so a terminal still doesn't find it; `stale`, Lookover's own launcher comes
 * first but runs another copy of Lookover (an earlier download, moved or renamed), which "Add to my PATH" points at
 * this one; `other`, a `lookover` that isn't Lookover's comes first on the PATH (an older install, another
 * executable), whether Lookover's folder is on it or not, so a terminal runs that one.
 */
export type PathReach = "yes" | "no" | "linked" | "stale" | "other";

/**
 * Whether `lookover` reaches this Lookover, and the folder of Lookover's own that holds its launcher or link; with
 * `other`, the `lookover` a terminal runs instead; with `stale`, the copy Lookover's launcher runs.
 */
export type CommandPathState = LookoverFolder &
  (
    | { reach: Exclude<PathReach, "other" | "stale"> }
    | {
        reach: "other" | "stale";
        /**
         * In full, which the app names in mono: with `other`, the `lookover` first on the PATH
         * (`C:\Users\<name>\AppData\Roaming\npm\lookover.cmd`); with `stale`, the executable Lookover's launcher runs.
         */
        other: string;
      }
  );

interface LookoverFolder {
  /** Where "Add to my PATH" puts the launcher (Windows) or the link (macOS, Linux), and what it puts on the PATH. */
  folder: string;
}

/**
 * Whether Lookover offers to put `lookover` on the PATH, by how it runs: `binary`, offered (the one executable,
 * reached through a folder of Lookover's own); `clone`, not offered (no one executable: the skill calls the clone's
 * `bun` and `main.ts`, and needs no PATH); `npm`, not offered, the npm install already put `lookover` on the PATH
 * (ADR 0061): its reach is `yes` when the first `lookover` on the PATH is npm's shim of this install, `no` when none
 * is (npm's folder, the state's `folder`, isn't on the PATH), `other` otherwise.
 */
export type PathOffer = "binary" | "clone" | "npm";

/**
 * The skill in an agent's folder: `none`, not installed; `ours`, stamped by this Lookover (its command); `another`,
 * stamped by another Lookover (another executable or data folder), shown with Replace; `foreign`, a skill of that
 * name Lookover didn't write (no stamp), shown with Replace and never removed.
 */
export type SkillState = "none" | "ours" | "another" | "foreign";

/** The skill as one agent's folder holds it. */
export interface AgentSkill {
  /** The agent, named by its program: Claude Code is `claude`, Codex `codex`, as the engines are. */
  agent: EngineId;
  state: SkillState;
  /** The skill's folder, in full (`~/.claude/skills/lookover-review-loop`), which the app names in mono. */
  folder: string;
}

/**
 * Why an `agent.*` command did nothing, said as `agent` in its refusal beside the error: no PATH offer here (a
 * clone, an npm install), an agent Lookover didn't find, or a skill to remove that Lookover didn't write. A write the
 * machine refuses is no code: a 500 whose error says why.
 */
export type AgentRefusal = "not_offered" | "no_such_agent" | "not_ours";

/** Your coding agent's state, as `Service.agent` carries it. */
export interface CodingAgent {
  path: CommandPathState;
  offer: PathOffer;
  /** One per agent Lookover found installed (its engine not `missing`), Claude Code first; an agent not found isn't offered. */
  skills: AgentSkill[];
}
