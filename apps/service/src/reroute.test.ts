// "Send the waiting reviews to the other AI" (ADR 0047, I-167), through the service's door on the demo driver: a
// signed-out Claude, two reviews waiting on it (the owner's own, and a colleague's the owner asked for), Codex
// ready. The snapshot says on each deferred job which engine may step in (`stepIn`, `core`'s rule: never Codex on
// another author's change); `engine.reroute` moves only the owner's, which Codex then reviews; a rerouted job
// defers on Codex when Codex isn't ready either; and the next job of the change plans as usual.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, commitSha, type Event, jobId, type ReviewJob } from "@lookover/contracts";
import {
  inject,
  send,
  snapshotOf,
  startScenario,
  stopAll,
  stream,
  T0,
  until,
} from "./demo/demo.test-support.ts";
import type { Scenario } from "./index.ts";
import { TEST_LIMIT_MS } from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const OWNER = { id: 1, login: "sasensi" };
const MIRA = { id: 7, login: "mira" };
const MINE = changeId("lookover-sandbox#1");
const MIRAS = changeId("lookover-sandbox#2");

/** A one-line change to `path`, as git prints it. */
const diffOf = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,2 @@",
    " export const a = 1;",
    "+export const b = 2;",
    "",
  ].join("\n");

/** Claude signed out, Codex ready; the owner's #1 opens, then mira's #2, which the owner asks a review of. */
const scenario: Scenario = {
  id: "T116",
  title: "Two reviews wait on Claude",
  what: "Claude is signed out; the owner's review and a colleague's wait on it.",
  steps: [],
  later: "",
  path: "/",
  world: {
    repo: { owner: "sasensi", name: "lookover-sandbox" },
    bot: { id: 2, login: "lookover-spike-sasensi[bot]" },
    owner: OWNER,
    engines: {
      claude: { installed: true, version: "2.4.1", signedIn: false },
      codex: { installed: true, version: "0.162.1", signedIn: true },
    },
    main: { ref: "main", sha: commitSha("5a1e9c0d7b2f4e6a8c0d1e2f3a4b5c6d7e8f9a0b") },
  },
  changes: [
    {
      number: 1,
      title: "Add b",
      branch: "add-b",
      author: OWNER,
      commits: [
        {
          sha: commitSha("b1f2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4"),
          message: "Add b",
          diff: diffOf("src/a.ts"),
          find: { findings: [], emptyReason: "One constant added." },
        },
      ],
    },
    {
      number: 2,
      title: "Add b elsewhere",
      branch: "mira/add-b",
      author: MIRA,
      commits: [
        {
          sha: commitSha("c2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5"),
          message: "Add b elsewhere",
          diff: diffOf("src/c.ts"),
        },
      ],
    },
  ],
  script: [
    { at: 1 * MIN, move: { kind: "open", change: 1 } },
    { at: 2 * MIN, move: { kind: "open", change: 2 } },
    { at: 3 * MIN, move: { kind: "ask", change: 2 } },
  ],
  seed: 4 * MIN,
};

const onClaude: Pick<ReviewJob, "state" | "deferral"> = {
  state: "deferred",
  deferral: { reason: "engine-signed-out", engine: "claude" },
};
/** The start, the repository, #1 opened, queued and deferred, #2 opened and skipped, the ask queued and deferred. */
const SEEDED_EVENTS = 9;

/** Reads events until a `job.changed` of `change` whose job is in `state`; the events read. */
async function untilJob(
  events: AsyncGenerator<{ event: string | null; data: string }>,
  change: string,
  state: ReviewJob["state"],
): Promise<Event[]> {
  const seen: Event[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) throw new Error("The event stream ended");
    if (value.event !== "event") continue;
    const event: Event = JSON.parse(value.data);
    seen.push(event);
    if (event.type === "job.changed" && event.changeId === change && event.job.state === state) return seen;
  }
}

test("each deferred job says which engine may step in; a reroute moves only the owner's, which Codex reviews; the next job of that change plans as usual", async () => {
  const door = await startScenario(scenario);
  const before = await snapshotOf(door);
  expect(before.engines.claude.state).toBe("signed-out");
  expect(before.engines.codex.state).toBe("ready");
  // The owner's change: Codex may step in. Mira's: nobody may (Codex never reviews another author's change).
  expect(before.reviews[MINE]?.job).toMatchObject({
    id: jobId("1"),
    trigger: "opened",
    ...onClaude,
    stepIn: "codex",
  });
  expect(before.reviews[MIRAS]?.job).toMatchObject({
    id: jobId("3"),
    trigger: "comment",
    ...onClaude,
    stepIn: null,
  });
  expect(before.seq).toBe(SEEDED_EVENTS);

  const events = await stream(door, SEEDED_EVENTS);
  expect((await send(door, { type: "engine.reroute", from: "claude" })).status).toBe(200);
  const moved = await until(events, "round.finished");
  // The owner's review runs on Codex, which confirms too since Claude is signed out; mira's stays as it was.
  expect(
    moved
      .filter((e) => e.type !== "run.step" && e.type !== "run.posting")
      .map((e) => `${e.type} ${"changeId" in e ? e.changeId : ""}`),
  ).toEqual([`run.started ${MINE}`, `round.finished ${MINE}`]);
  expect(moved[0]).toMatchObject({
    type: "run.started",
    job: { id: jobId("1"), state: "running", deferral: null, stepIn: null },
    run: {
      reviewer: "codex",
      confirmer: "codex",
      confirmFallback: { reason: "not-ready", engine: "claude", state: "signed-out" },
    },
  });
  const after = await snapshotOf(door);
  expect(after.reviews[MINE]?.job).toMatchObject({ id: jobId("1"), state: "done" });
  expect(after.reviews[MINE]?.rounds).toMatchObject([{ n: 1, reviewer: "codex", raised: 0 }]);
  expect(after.reviews[MIRAS]?.job).toMatchObject({ id: jobId("3"), ...onClaude, stepIn: null });

  // "Review now" on the owner's change again: the rule plans Claude, and the new job waits on it, as before the
  // reroute. The owner's one click steered one job, not every later review of the change.
  expect((await send(door, { type: "review.request", changeId: MINE })).status).toBe(200);
  const again = await untilJob(events, MINE, "deferred");
  expect(again.at(-1)).toMatchObject({ job: { trigger: "manual", ...onClaude, stepIn: "codex" } });
  expect((await snapshotOf(door)).reviews[MINE]?.job).toMatchObject({ trigger: "manual", ...onClaude });
});

test("a job sent to Codex while Codex is signed out too waits on Codex now, and says Claude may step in", async () => {
  const door = await startScenario(scenario);
  expect(await inject(door, "codex-signed-out")).toBe(200);
  const events = await stream(door, (await snapshotOf(door)).seq);
  expect((await send(door, { type: "engine.reroute", from: "claude" })).status).toBe(200);
  const moved = await untilJob(events, MINE, "deferred");
  expect(moved.map((e) => e.type)).toEqual(["job.changed"]);
  expect(moved[0]).toMatchObject({
    changeId: MINE,
    job: {
      id: jobId("1"),
      state: "deferred",
      deferral: { reason: "engine-signed-out", engine: "codex" },
      stepIn: "claude",
    },
  });
  const after = await snapshotOf(door);
  expect(after.reviews[MINE]?.job).toMatchObject({
    deferral: { reason: "engine-signed-out", engine: "codex" },
    stepIn: "claude",
  });
  // Mira's review still waits on Claude: Codex may not take it.
  expect(after.reviews[MIRAS]?.job).toMatchObject({ id: jobId("3"), ...onClaude, stepIn: null });
  // The demo clock stands at T0 and nothing moved it: the reroute's own take deferred the job on Codex, not a
  // tick a minute later.
  expect(after.now).toBe(T0);
});
