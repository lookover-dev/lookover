// S14's live log is the recordings' (ADR 0055): each session's activities, as the scenario scripts them, are what
// the real `engines` module reads from the recording the scenario transcribes, run on the fake `claude` and `codex`.
// Only the moments are the scenario's own, and Claude's `Read` path, which the recording gives in the recorder's
// worktree, is written relative to it as a review's own worktree would give it.
import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { EngineActivity, EngineId } from "@lookover/contracts";
import type { ClaudeRecording, CodexRecording } from "@lookover/testkit";
import { scenarioOf } from "../index.ts";
import { home, onFake, TEST_LIMIT_MS } from "../service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);

/** What `engine` reports on replaying its recording (the other engine's is never run), in order. */
async function readFrom(
  engine: EngineId,
  claude: ClaudeRecording,
  codex: CodexRecording,
): Promise<EngineActivity[]> {
  const dir = home();
  const engines = onFake(dir, [claude], { codex: [codex] });
  const heard: EngineActivity[] = [];
  await engines.run(
    {
      engine,
      prompt: "Review the change.",
      cwd: dir,
      timeoutMs: 10_000,
      artefactsDir: join(dir, "run"),
      onActivity: (a) => heard.push(a),
    },
    new AbortController().signal,
  );
  return heard;
}

/** The recorder's worktree, as Claude's recordings name it: what a review's own worktree leaves out. */
const RECORDER_WORKTREE = /^.*[\\/]worktrees[\\/]record[\\/]/;

const relative = (a: EngineActivity): EngineActivity =>
  a.kind === "read" ? { kind: "read", path: a.path.replace(RECORDER_WORKTREE, "").replaceAll("\\", "/") } : a;

/** What a scripted pass did, its moments left out. */
const scripted = (activity: { activity: EngineActivity }[] | undefined) =>
  (activity ?? []).map((a) => a.activity);

/** The planted #1's two commits in S14: round 1's and the fix's. */
function plantedCommits() {
  const planted = scenarioOf("S14").changes.find((c) => c.number === 1);
  if (planted === undefined) throw new Error("S14 has no #1");
  return planted.commits;
}

test.each([
  [0, "review", "confirm-mixed"],
  [1, "review-round-2", "confirm-round-2"],
] as const)(
  "S14's commit %i: Claude's find is %s's activities, Codex's confirm %s's",
  async (i, find, confirm) => {
    const commit = plantedCommits()[i];
    expect(scripted(commit?.find?.activity)).toEqual((await readFrom("claude", find, "ok")).map(relative));
    expect(scripted(commit?.confirm?.activity)).toEqual(await readFrom("codex", "ok", confirm));
  },
);
