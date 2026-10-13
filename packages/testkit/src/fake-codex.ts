// The fake `codex` program as `engines` runs it (ADR 0039, ADR 0044): bun running `fake-codex/codex.ts` on one
// recording of the real CLI from `fake-codex/recordings/<name>/`, one per outcome of the `Engines` port.
// Refresh the recordings from the real `codex` with `bun run record:codex` (`scripts/record-codex.ts`).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FakeProgram, SelfTestRecording } from "./fake-claude.ts";

/**
 * The recordings, named after the outcome the real module reads from each; `review` is `ok` on a real review
 * of the planted sandbox's pull request #1 (`plantSandbox`), the one demo mode replays when Codex reviews.
 * `quota_exhausted` is a real run's stream, copied by hand (a plan's limit can't be hit on demand): the limit's
 * message with its reset time ("try again at Oct 14th, 2026 10:11 AM"). `input_too_large` is a real run's,
 * copied by hand: a prompt over the CLI's input limit, refused before any turn (`invalid_output`). `confirm` and
 * `confirm-round-2` are real confirm passes on what the fake claude's `review` and `review-round-2` find, chosen by
 * the commit and the confirm pass their prompt names; `confirm-mixed` is derived from `confirm` (its second
 * candidate unsure, its third refuted): what demo mode replays when Codex confirms Claude's round 1.
 * `self-test-named` is derived from `self-test-untried`: a command only names the file to write (`Test-Path`), no
 * write is tried, so the wall isn't tested.
 */
export type CodexRecording =
  | "ok"
  | "self-test-named"
  | "input_too_large"
  | "review"
  | "confirm"
  | "confirm-mixed"
  | "confirm-round-2"
  | "invalid_output"
  | "auth_required"
  | "quota_exhausted"
  | "timeout"
  | "crashed"
  | "cancelled"
  | SelfTestRecording;

/** What the fake program received on one run, read back from the working directory it ran in. */
export interface CodexReceived {
  /** Codex's own arguments, the fake's `--recording` left out. */
  args: string[];
  /** The whole stdin: the prompt. */
  stdin: string;
  /** The name of every variable of its environment, sorted: never a value. */
  env: string[];
}

const FAKE = resolve(import.meta.dir, "..", "fake-codex");

/**
 * The fake on these recordings. With several, a run replays the first whose `meta.json` `when` is a text the
 * prompt holds, else the first with no `when`. Version and sign-in come from the first.
 */
export function fakeCodex(...recordings: [CodexRecording, ...CodexRecording[]]): FakeProgram {
  return {
    executable: process.execPath,
    args: [
      join(FAKE, "codex.ts"),
      ...recordings.flatMap((r) => ["--recording", join(FAKE, "recordings", r)]),
    ],
  };
}

/** What the fake program received on its last run in `cwd`. */
export function codexReceived(cwd: string): CodexReceived {
  return JSON.parse(readFileSync(join(cwd, "codex.received.json"), "utf8"));
}
