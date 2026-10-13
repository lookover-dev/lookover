// The small helpers several packages share instead of writing them each: a waiting job, a deferral's engine,
// a run's steps with the current one closed, a repository compared as GitHub does.
import { describe, expect, test } from "bun:test";
import {
  changeId,
  commitSha,
  deferralEngine,
  furthestReached,
  isWaiting,
  jobId,
  type ReviewJob,
  repositoryName,
  sameRepository,
  sameTurn,
  stepsDone,
  type Turn,
  utf8Bytes,
} from "./index.ts";

const job: ReviewJob = {
  id: jobId("j1"),
  sha: commitSha("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"),
  trigger: "manual",
  state: "queued",
  deferral: null,
  stepIn: null,
  skip: null,
  cancel: null,
  failure: null,
  turn: null,
};

describe("jobs", () => {
  test("a job waits while queued or deferred, and no longer once it ran or ended", () => {
    expect(isWaiting(job)).toBe(true);
    expect(isWaiting({ ...job, state: "deferred", deferral: { reason: "paused" } })).toBe(true);
    for (const state of ["running", "done", "skipped", "cancelled", "failed"] as const)
      expect(isWaiting({ ...job, state })).toBe(false);
    expect(isWaiting(null)).toBe(false);
  });

  test("a deferral names its engine only for an engine's reason", () => {
    expect(deferralEngine({ reason: "engine-limit", engine: "codex" })).toBe("codex");
    expect(deferralEngine({ reason: "paused" })).toBeNull();
    expect(deferralEngine(null)).toBeNull();
  });

  test("two turns are the same when they wait behind the same engines, changes and self-test, in order", () => {
    const behind: Turn = {
      behind: "engines",
      engines: ["claude"],
      changes: [changeId("o/r#1")],
      testing: false,
    };
    expect(sameTurn(behind, { ...behind, engines: ["claude"] })).toBe(true);
    expect(sameTurn({ behind: "change" }, { behind: "change" })).toBe(true);
    expect(sameTurn(null, null)).toBe(true);
    expect([
      sameTurn(behind, { ...behind, engines: ["claude", "codex"] }),
      sameTurn(behind, { ...behind, changes: [changeId("o/r#2")] }),
      sameTurn(behind, { ...behind, testing: true }),
      sameTurn(behind, { behind: "change" }),
      sameTurn(behind, null),
      sameTurn(null, { behind: "change" }),
    ]).toEqual([false, false, false, false, false, false]);
  });
});

test("a run's steps with its current one closed: the steps done, then the current one and how long it took", () => {
  const run = { step: "finding" as const, stepAt: 1_000, steps: [{ step: "preparing" as const, ms: 400 }] };
  expect(stepsDone(run, 4_500)).toEqual([
    { step: "preparing", ms: 400 },
    { step: "finding", ms: 3_500 },
  ]);
});

test("a repository is the same however its case is written, as on GitHub, and keeps how it was written", () => {
  const written = { owner: "Lookover-Dev", name: "Lookover-Private" };
  expect(sameRepository(written, { owner: "lookover-dev", name: "lookover-private" })).toBe(true);
  expect(sameRepository(written, { owner: "lookover-dev", name: "lookover-sandbox" })).toBe(false);
  expect(repositoryName(written)).toBe("Lookover-Dev/Lookover-Private");
});

test("a text is measured as GitHub counts its limits: UTF-8 bytes, not characters", () => {
  expect(utf8Bytes("abc")).toBe(3);
  expect(utf8Bytes("é")).toBe(2);
  expect(utf8Bytes("👀")).toBe(4);
});

test("the furthest step reached is the later of two, in the setup's order: going back loses nothing", () => {
  expect(furthestReached("repos", "github")).toBe("repos");
  expect(furthestReached("ai", "first-review")).toBe("first-review");
  // Your coding agent comes after the first review (ADR 0058).
  expect(furthestReached("first-review", "agent")).toBe("agent");
  expect(furthestReached("agent", "background")).toBe("background");
  expect(furthestReached("background", "background")).toBe("background");
});
