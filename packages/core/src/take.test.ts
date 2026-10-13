// What the take does with a waiting job (ADR 0042, ADR 0043, ADR 0044): start it with the round plan (who finds,
// who confirms), defer it with `mayStart`'s reason for its finder, leave it waiting its turn while its finder or its
// confirmer reviews another (one run per engine, ADR 0015), skip it when only Codex may review another author's
// change, or cancel it once its change is gone.
import { expect, test } from "bun:test";
import {
  type ConfirmFallback,
  changeId,
  type EngineId,
  type EngineState,
  type Turn,
} from "@lookover/contracts";
import { type EngineHold, type TakeDecision, type TakeFacts, takeDecision } from "./index.ts";

const READY: Record<EngineId, EngineState> = { claude: "ready", codex: "ready" };
const NONE: ReadonlyMap<EngineId, EngineHold> = new Map();
const A = changeId("sasensi/ledger-api#149");
const B = changeId("sasensi/ledger-api#150");
/** The engines reviewing another change, A. */
const on = (...engines: EngineId[]): ReadonlyMap<EngineId, EngineHold> =>
  new Map(engines.map((engine) => [engine, { by: "review", changeId: A }]));
/** Behind these engines reviewing A. */
const behind = (...engines: EngineId[]): Turn => ({
  behind: "engines",
  engines,
  changes: [A],
  testing: false,
});
const CHANGE: Turn = { behind: "change" };
const start = (
  finder: EngineId,
  confirmer: EngineId,
  confirmFallback: ConfirmFallback | null = null,
): TakeDecision => ({
  kind: "start",
  plan: { kind: "review", finder, secondFinder: null, confirmer, confirmFallback },
});
const facts: TakeFacts = {
  paused: false,
  trigger: "manual",
  change: { author: "you", writtenBy: null, fork: false },
  reviewers: "both",
  depth: "standard",
  finder: null,
  engines: READY,
  unusable: { claude: null, codex: null },
  busy: NONE,
  changeBusy: false,
  connection: "connected",
};

test("a job whose engines are ready and free starts, with the round plan: who finds and who confirms", () => {
  expect(takeDecision(facts)).toEqual(start("claude", "codex"));
  expect(takeDecision({ ...facts, change: { author: "you", writtenBy: "claude", fork: false } })).toEqual(
    start("codex", "claude"),
  );
  expect(takeDecision({ ...facts, reviewers: "codex" })).toEqual(
    start("codex", "codex", { reason: "settings", engine: "claude" }),
  );
});

test("a job waits as deferred, with the reason: paused, its engine missing, signed out or at its limit", () => {
  const states: EngineState[] = ["missing", "signed-out", "limit"];
  expect([
    takeDecision({ ...facts, paused: true }),
    ...states.map((state) => takeDecision({ ...facts, engines: { ...READY, claude: state } })),
  ]).toEqual([
    { kind: "deferred", deferral: { reason: "paused" } },
    { kind: "deferred", deferral: { reason: "engine-missing", engine: "claude", unusable: null } },
    { kind: "deferred", deferral: { reason: "engine-signed-out", engine: "claude" } },
    { kind: "deferred", deferral: { reason: "engine-limit", engine: "claude" } },
  ]);
  // A program found but not usable: it waits as missing, saying why.
  const tooOld = { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  expect(
    takeDecision({
      ...facts,
      reviewers: "codex",
      engines: { ...READY, codex: "missing" },
      unusable: { claude: null, codex: tooOld },
    }),
  ).toEqual({ kind: "deferred", deferral: { reason: "engine-missing", engine: "codex", unusable: tooOld } });
  // Only the finder holds it: the confirmer not ready, the finder confirms, and the plan says why.
  expect(takeDecision({ ...facts, engines: { ...READY, codex: "signed-out" } })).toEqual(
    start("claude", "claude", { reason: "not-ready", engine: "codex", state: "signed-out" }),
  );
});

test("while its change's last job still runs or posts its round, a job waits its turn, queued (ADR 0044)", () => {
  // Its engines are free: it holds none of them from younger jobs.
  expect(takeDecision({ ...facts, changeBusy: true })).toEqual({ kind: "queued", holds: [], turn: CHANGE });
  // Paused holds it all the same, and so does its engine signed out.
  expect(takeDecision({ ...facts, changeBusy: true, paused: true })).toEqual({
    kind: "deferred",
    deferral: { reason: "paused" },
  });
  expect(takeDecision({ ...facts, changeBusy: true, engines: { ...READY, claude: "signed-out" } })).toEqual({
    kind: "deferred",
    deferral: { reason: "engine-signed-out", engine: "claude" },
  });
});

test("while its engine reviews another job, a job waits its turn, queued: the engine can review, it is busy", () => {
  const claudeBusy = on("claude");
  // Waiting for its engines, it holds both from younger jobs, so they never overtake it (first come, first served).
  expect(takeDecision({ ...facts, busy: claudeBusy })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: behind("claude"),
  });
  // Busy, its last known state doesn't hold the job: a running engine was ready when its run started.
  expect(takeDecision({ ...facts, busy: claudeBusy, engines: { ...READY, claude: "signed-out" } })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: behind("claude"),
  });
  // With only Claude allowed, it holds Claude alone.
  expect(takeDecision({ ...facts, reviewers: "claude", busy: claudeBusy })).toEqual({
    kind: "queued",
    holds: ["claude"],
    turn: behind("claude"),
  });
  // The other engine reviewing doesn't hold it when it doesn't confirm.
  expect(takeDecision({ ...facts, reviewers: "claude", busy: on("codex") })).toEqual(
    start("claude", "claude", { reason: "settings", engine: "codex" }),
  );
  // Paused holds it all the same.
  expect(takeDecision({ ...facts, busy: claudeBusy, paused: true })).toEqual({
    kind: "deferred",
    deferral: { reason: "paused" },
  });
});

test("while GitHub is disconnected a job waits as deferred 'connection': nothing can be fetched or posted (ADR 0047)", () => {
  const down = { ...facts, connection: "disconnected" as const };
  expect(takeDecision(down)).toEqual({ kind: "deferred", deferral: { reason: "connection" } });
  // Not connected yet (no bot) holds the same: there is no host to read.
  expect(takeDecision({ ...facts, connection: "not-connected" })).toEqual({
    kind: "deferred",
    deferral: { reason: "connection" },
  });
  // The pause and the finder's state come first: the owner's choice, then what the engine says.
  expect(takeDecision({ ...down, paused: true })).toEqual({
    kind: "deferred",
    deferral: { reason: "paused" },
  });
  expect(takeDecision({ ...down, engines: { ...READY, claude: "signed-out" } })).toEqual({
    kind: "deferred",
    deferral: { reason: "engine-signed-out", engine: "claude" },
  });
  // It holds a job whose engine is busy or whose change is busy too: neither can start without the host.
  expect(takeDecision({ ...down, busy: on("claude") })).toEqual({
    kind: "deferred",
    deferral: { reason: "connection" },
  });
  expect(takeDecision({ ...down, changeBusy: true })).toEqual({
    kind: "deferred",
    deferral: { reason: "connection" },
  });
  // Gone is still gone, and a skip is no review: neither waits for the host.
  expect(takeDecision({ ...down, change: null })).toEqual({ kind: "cancelled" });
  expect(
    takeDecision({ ...down, change: { author: "other", writtenBy: null, fork: false }, reviewers: "codex" }),
  ).toEqual({
    kind: "skipped",
    reason: "codex-not-yours",
  });
});

test("a job whose change is gone is cancelled, whatever else holds", () => {
  expect(takeDecision({ ...facts, change: null })).toEqual({ kind: "cancelled" });
  expect(takeDecision({ ...facts, change: null, paused: true })).toEqual({ kind: "cancelled" });
});

test("a fork change, even the owner's, is found by Claude, or skipped where only Codex may review (ADR 0048)", () => {
  const fork = { author: "you", writtenBy: "claude", fork: true } as const;
  expect(takeDecision({ ...facts, change: fork })).toEqual(
    start("claude", "claude", { reason: "not-own", engine: "codex" }),
  );
  expect(takeDecision({ ...facts, change: fork, finder: "codex" })).toEqual(
    start("claude", "claude", { reason: "not-own", engine: "codex" }),
  );
  expect(takeDecision({ ...facts, change: fork, reviewers: "codex" })).toEqual({
    kind: "skipped",
    reason: "codex-not-yours",
  });
});

test("another author's change is found by Claude, or skipped where only Codex may review", () => {
  const theirs = { author: "other", writtenBy: "claude", fork: false } as const;
  expect(takeDecision({ ...facts, change: theirs })).toEqual(
    start("claude", "claude", { reason: "not-own", engine: "codex" }),
  );
  expect(takeDecision({ ...facts, change: theirs, reviewers: "codex" })).toEqual({
    kind: "skipped",
    reason: "codex-not-yours",
  });
  // Skipped is no review: neither the pause nor a busy or missing engine holds it.
  expect(
    takeDecision({
      ...facts,
      change: theirs,
      reviewers: "codex",
      paused: true,
      busy: on("codex"),
      engines: { ...READY, codex: "missing" },
    }),
  ).toEqual({ kind: "skipped", reason: "codex-not-yours" });
  // Gone is still gone.
  expect(takeDecision({ ...facts, change: null, reviewers: "codex" })).toEqual({ kind: "cancelled" });
});

test("a job holds both engines (ADR 0044): while its confirmer reviews another job, it waits its turn, queued", () => {
  const codexBusy = on("codex");
  expect(takeDecision({ ...facts, busy: codexBusy })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: behind("codex"),
  });
  // Busy, the confirmer's last known state doesn't make the finder confirm: the same change gets the same review
  // whatever else runs, and once the confirmer is free the take asks again.
  expect(takeDecision({ ...facts, busy: codexBusy, engines: { ...READY, codex: "signed-out" } })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: behind("codex"),
  });
  // A finder that isn't ready still defers, the confirmer busy or not.
  expect(takeDecision({ ...facts, busy: codexBusy, engines: { ...READY, claude: "limit" } })).toEqual({
    kind: "deferred",
    deferral: { reason: "engine-limit", engine: "claude" },
  });
  // The other engine barred from the change, its being busy holds nothing.
  const theirs = { author: "other", writtenBy: null, fork: false } as const;
  expect(takeDecision({ ...facts, change: theirs, busy: codexBusy })).toEqual(
    start("claude", "claude", { reason: "not-own", engine: "codex" }),
  );
});

test("depth Quick holds the finder alone: the other engine busy or not ready changes nothing", () => {
  const quick: TakeDecision = {
    kind: "start",
    plan: { kind: "review", finder: "claude", secondFinder: null, confirmer: null, confirmFallback: null },
  };
  expect(takeDecision({ ...facts, depth: "quick", busy: on("codex") })).toEqual(quick);
  expect(takeDecision({ ...facts, depth: "quick", engines: { ...READY, codex: "signed-out" } })).toEqual(
    quick,
  );
  expect(takeDecision({ ...facts, depth: "quick", busy: on("claude") })).toEqual({
    kind: "queued",
    holds: ["claude"],
    turn: behind("claude"),
  });
});

test("depth Deep holds every engine its round uses: both finders, the second one confirming", () => {
  expect(takeDecision({ ...facts, depth: "deep" })).toEqual({
    kind: "start",
    plan: {
      kind: "review",
      finder: "claude",
      secondFinder: "codex",
      confirmer: "codex",
      confirmFallback: null,
    },
  });
  expect(takeDecision({ ...facts, depth: "deep", busy: on("codex") })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: behind("codex"),
  });
});

test("a job the owner sent to the other engine plans with it as the finder: it starts on it, waits for it, or waits its turn behind it (ADR 0047)", () => {
  const sent: TakeFacts = { ...facts, finder: "codex" };
  expect(takeDecision(sent)).toEqual(start("codex", "claude"));
  // Not ready, the job defers on the engine it was sent to, not on the one it left.
  expect(takeDecision({ ...sent, engines: { ...READY, codex: "signed-out" } })).toEqual({
    kind: "deferred",
    deferral: { reason: "engine-signed-out", engine: "codex" },
  });
  // The engine it left, still signed out, is no longer what it waits for: Codex finds and confirms, with why.
  expect(takeDecision({ ...sent, engines: { ...READY, claude: "signed-out" } })).toEqual(
    start("codex", "codex", { reason: "not-ready", engine: "claude", state: "signed-out" }),
  );
  expect(takeDecision({ ...sent, busy: on("codex") })).toEqual({
    kind: "queued",
    holds: ["codex", "claude"],
    turn: behind("codex"),
  });
  // Sent to an engine that may not review the change (the settings, the author): the rule picks.
  expect(takeDecision({ ...sent, reviewers: "claude" })).toEqual(
    start("claude", "claude", { reason: "settings", engine: "codex" }),
  );
  expect(takeDecision({ ...sent, change: { author: "other", writtenBy: null, fork: false } })).toEqual(
    start("claude", "claude", { reason: "not-own", engine: "codex" }),
  );
});

test("a job waiting its turn says what it waits behind (ADR 0055): the engines reviewing which changes, a self-test, an older job, or its own change", () => {
  // Its finder and its confirmer reviewing two other changes: both, and both changes.
  const two: ReadonlyMap<EngineId, EngineHold> = new Map([
    ["claude", { by: "review", changeId: A }],
    ["codex", { by: "review", changeId: B }],
  ]);
  expect(takeDecision({ ...facts, busy: two })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: { behind: "engines", engines: ["claude", "codex"], changes: [A, B], testing: false },
  });
  // Codex finding, the engines and their changes still read Claude first: one pair is said one way.
  expect(takeDecision({ ...facts, finder: "codex", busy: two })).toEqual({
    kind: "queued",
    holds: ["codex", "claude"],
    turn: { behind: "engines", engines: ["claude", "codex"], changes: [A, B], testing: false },
  });
  // Both on one change: it is named once.
  expect(takeDecision({ ...facts, busy: on("claude", "codex") })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: behind("claude", "codex"),
  });
  // An engine's self-test holds it: that engine, no change.
  const testing: ReadonlyMap<EngineId, EngineHold> = new Map([["codex", { by: "self-test" }]]);
  expect(takeDecision({ ...facts, busy: testing })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: { behind: "engines", engines: ["codex"], changes: [], testing: true },
  });
  // A review and a self-test: the review is named, the self-test said.
  const both: ReadonlyMap<EngineId, EngineHold> = new Map([
    ["claude", { by: "review", changeId: A }],
    ["codex", { by: "self-test" }],
  ]);
  expect(takeDecision({ ...facts, busy: both })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: { behind: "engines", engines: ["claude"], changes: [A], testing: true },
  });
  // Only an older job waiting for the engine holds it (first come, first served): the engine, no change.
  const older: ReadonlyMap<EngineId, EngineHold> = new Map([["claude", { by: "older" }]]);
  expect(takeDecision({ ...facts, busy: older })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: { behind: "engines", engines: ["claude"], changes: [], testing: false },
  });
  // Its own change's round still running or posting comes first, its engines busy or not.
  expect(takeDecision({ ...facts, busy: on("claude"), changeBusy: true })).toEqual({
    kind: "queued",
    holds: ["claude", "codex"],
    turn: CHANGE,
  });
});
