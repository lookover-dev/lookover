// A round's threads read and its claims answered, for the tests that drive them (`claims.test.ts`,
// `organisation.test.ts`): round 1 posted on a change with one blocking finding, the owner's `/lookover review`
// asking again, and the answers the engines give on each pass.
import { expect } from "bun:test";
import {
  type ChangeRef,
  type Depth,
  type ReviewResult,
  readResult,
  reviewResultV1,
} from "@lookover/contracts";
import {
  type DemoClock,
  type FakeChange,
  type FakeEngines,
  type FakeGitHost,
  ScriptedRetrieval,
  type ScriptedRun,
} from "@lookover/testkit";
import type { GitHubSide } from "./index.ts";
import { fakeEngines, OWNER, pr1, SANDBOX, start } from "./service.test-support.ts";

const MIN = 60_000;

/** A block as the engine writes it. */
export const answered = (block: unknown): ScriptedRun => ({
  outcome: "ok",
  text: ["```json", JSON.stringify(block), "```"].join("\n"),
});

/** Round 1's find pass: one blocking finding on line 12. */
export const FOUND = answered({
  findings: [
    {
      path: "src/total.ts",
      line: 12,
      severity: "blocking",
      category: "correctness",
      title: "The total skips the last invoice",
      body: "The loop stops one short, so the last invoice is never added.",
      defect_key: "total-skips-last-invoice",
    },
  ],
});

/** Round 1's confirm pass: the finding confirmed, still blocking. */
export const CONFIRMED = answered({
  verdicts: [
    {
      id: "C1",
      verdict: "confirmed",
      reason: "The loop's bound is length - 1.",
      evidence: ["src/total.ts:12"],
      severity: "blocking",
    },
  ],
});

/** A later round's find pass: nothing new, and what it says of F1. */
export const again = (present: boolean, why: string): ScriptedRun =>
  answered({ findings: [], earlier: [{ id: "F1", present, why }] });

/** `src/total.ts`, its 40 lines added: what `pr1`'s commentable range says. */
export const TOTAL_ADDED = [
  "diff --git a/src/total.ts b/src/total.ts",
  "--- /dev/null",
  "+++ b/src/total.ts",
  "@@ -0,0 +1,40 @@",
  ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
  "",
].join("\n");

export const STILL = "The last invoice is still left out of the total.";

/**
 * The world: the service on a fake GitHub, round 1 posted on `change` (in its own repository, the sandbox unless
 * said) as it opened, or once the owner asked when it is a fork's or another author's.
 */
export async function roundOne(
  options: {
    change?: FakeChange;
    host?: FakeGitHost;
    time?: DemoClock;
    depth?: Depth;
    /** The data folder, for a test that starts the service again on it. */
    home?: string;
    /** The App the service runs as: the fake's, as `live.json`'s, the owner's personal App, unless given. */
    github?: GitHubSide;
    /** Round 1's answers: the find pass's `FOUND`, then `CONFIRMED`, unless given. */
    script?: (engines: FakeEngines) => void;
  } = {},
) {
  // On the test's clock when it gives one, so a run that takes its time ends as the test moves it.
  const engines = fakeEngines(options.time ? { time: options.time } : {});
  if (options.script) options.script(engines);
  else engines.answer(FOUND, CONFIRMED);
  const change = options.change ?? pr1;
  // The diff the round reviews: `src/total.ts` added whole, so line 12 takes a comment.
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = TOTAL_ADDED;
  const { host, time, service } = await start({
    changes: [],
    engines,
    retrieval,
    ...(options.home ? { home: options.home } : {}),
    ...(options.github ? { github: options.github } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.time ? { time: options.time } : {}),
    ...(options.depth ? { repositorySettings: { depth: options.depth } } : {}),
  });
  const ref: ChangeRef = { repo: change.repo ?? SANDBOX, number: change.number };
  host.open(change);
  await time.advance(MIN);
  /** The owner's `/lookover review`, picked up by the poll; the round it leads to runs on `runs`. */
  const ask = async (...runs: ScriptedRun[]): Promise<void> => {
    engines.answer(...runs);
    host.seedComment(ref, { author: OWNER, body: "/lookover review" });
    await time.advance(MIN);
  };
  // A fork's change, or another author's, is reviewed only when the owner asks (ADR 0048, ADR 0026).
  if (change.fork || change.author.id !== OWNER.id) await ask();
  const [thread] = await host.threads(ref);
  if (!thread) throw new Error("round 1 posted no thread");
  return {
    engines,
    host,
    time,
    service,
    retrieval,
    ask,
    /** The change round 1 is on. */
    ref,
    root: thread.commentId,
    /** What the last find pass was asked. */
    prompt: () => engines.runs.at(-1)?.prompt ?? "",
    /** The result on the last check completed, valid against the schema. */
    result(): ReviewResult {
      const post = host.posts.findLast((p) => p.kind === "check.completed");
      if (post?.kind !== "check.completed") throw new Error("no check completed");
      const read = readResult(post.output.text);
      expect(reviewResultV1.safeParse(read).success).toBe(true);
      if (read === null) throw new Error("no result on the check");
      return read;
    },
  };
}
