// The fake `claude` program as `engines` runs it (ADR 0039): bun running `fake-claude/claude.ts` on one
// recording of the real CLI from `fake-claude/recordings/<name>/`, one per outcome of the `Engines` port.
// Refresh the recordings from the real `claude` with `bun run record:claude` (`scripts/record-claude.ts`).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The recordings, named after the outcome the real module reads from each; `review` is `ok` on a real review
 * of the planted sandbox's pull request #1 (`plantSandbox`), the one demo mode replays, and `review-round-2`
 * the real round 2 on its fix commit (`pushSandboxFix`), with round 1's open findings in the prompt; `confirm` and
 * `confirm-round-2` the real confirm pass on each round's new candidates (ADR 0044), chosen by the commit and the
 * confirm pass the prompt names, so listed before `review-round-2`, whose commit the round-2 confirm names too;
 * `confirm-mixed` is `confirm` with its second verdict unsure and its third refuted, derived for demo mode.
 * `auth_refresh` is `auth_required` too: signed in, but the sign-in couldn't be refreshed (another Claude
 * process was refreshing it). Claude's own self-test recordings, derived from `self-test`: its init line naming a
 * planted agent, skill, a plugin not built in or a project MCP server, or a skill or slash command of the user's own
 * (`self-test-init-*`, I-080, #235: each fails), a
 * listing of the self-test's own folder refused by the wall (`self-test-parent-listed`, #129: it passes), a search
 * naming no bait file whose output shows a canary the answer quotes (`self-test-bait-searched`: loaded), and a
 * canary in the answer's block outside its `instructions` or in a second json block (`self-test-answer-key`,
 * `self-test-second-block`: followed).
 */
export type ClaudeRecording =
  | "ok"
  | "self-test-init-agent"
  | "self-test-init-skill"
  | "self-test-init-user-skill"
  | "self-test-init-command"
  | "self-test-init-plugin"
  | "self-test-init-mcp"
  | "self-test-parent-listed"
  | "self-test-bait-searched"
  | "self-test-answer-key"
  | "self-test-second-block"
  | "review"
  | "review-round-2"
  | "confirm"
  | "confirm-mixed"
  | "confirm-round-2"
  | "invalid_output"
  | "auth_required"
  | "auth_refresh"
  | "quota_exhausted"
  | "timeout"
  | "crashed"
  | "cancelled"
  | SelfTestRecording;

/**
 * The self-test's recordings (ADR 0044, #91): `self-test` is the real CLI's passing run (its prompt's first line is
 * its `when`, so a fake given it besides a review replays it for the self-test only); the others are derived from
 * it by hand, one per rule a self-test can break: a denial in the stream, a planted instruction obeyed, the wall
 * crossed, an answer with no json block, the wall's step never tried, a help without one of the flags Lookover
 * passes (its own `help.txt`), and a planted instruction quoted that no tool read (`self-test-loaded`, #137); and
 * one that passes, a planted instruction read with a tool and quoted, not obeyed (`self-test-bait-read`).
 */
export type SelfTestRecording =
  | "self-test"
  | "self-test-denied"
  | "self-test-loaded"
  | "self-test-obeyed"
  | "self-test-wall"
  | "self-test-unreadable"
  | "self-test-untried"
  | "self-test-bait-read"
  | "self-test-old-help";

/** A program as `engines` takes it: an absolute executable and the arguments that come before claude's own. */
export interface FakeProgram {
  executable: string;
  args: string[];
}

/** What the fake program received on one run, read back from the working directory it ran in. */
export interface ClaudeReceived {
  /** Claude's own arguments, the fake's `--recording` left out. */
  args: string[];
  /** The whole stdin: the prompt. */
  stdin: string;
  /** The name of every variable of its environment, sorted: never a value. */
  env: string[];
}

const FAKE = resolve(import.meta.dir, "..", "fake-claude");

/**
 * The fake on these recordings. With several, a run replays the first whose `meta.json` `when` is a text
 * the prompt holds (a review recorded on one commit names it: `Head commit: <sha>`), else the first with no
 * `when`: `fakeClaude("review", "review-round-2")` answers round 1 on the planted commit and round 2 on the
 * fix commit. Version and sign-in come from the first.
 */
export function fakeClaude(...recordings: [ClaudeRecording, ...ClaudeRecording[]]): FakeProgram {
  return {
    executable: process.execPath,
    args: [
      join(FAKE, "claude.ts"),
      ...recordings.flatMap((r) => ["--recording", join(FAKE, "recordings", r)]),
    ],
  };
}

/** What the fake program received on its last run in `cwd`. */
export function claudeReceived(cwd: string): ClaudeReceived {
  return JSON.parse(readFileSync(join(cwd, "claude.received.json"), "utf8"));
}
