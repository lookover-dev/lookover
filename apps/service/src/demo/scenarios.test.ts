// The scenarios through the drawer's door (ADR 0046), on the real service and the scripted fakes, the clock
// standing still at `T0`: the invariants demo mode keeps (every event applied, determinism, the rest of a script
// armed on the clock) and the catalogue as the drawer lists it. Each scenario's milestones are in
// `scenarios-s1-s7.test.ts` and `scenarios-s8-s14.test.ts`.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { apply, changeId, FAULTS } from "@lookover/contracts";
import { SCENARIOS, type Scenario, scenarioOf } from "../index.ts";
import { SANDBOX, TEST_LIMIT_MS } from "../service.test-support.ts";
import {
  advance,
  inject,
  listing,
  logOf,
  snapshotOf,
  startScenario,
  stopAll,
  stream,
  T0,
  until,
} from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
// Stopped once the file is done: the quiet day below is shared, and the few rooms a test starts wait until then.
afterAll(stopAll);

const MIN = 60_000;
const id = (n: number) => changeId(`sasensi/lookover-sandbox#${n}`);
/**
 * S10's seed: sixty-four events (the start, the account the sign-in reaches, the repository, six pull requests and their reviews, their outboxes as
 * they posted, main's rules read and counted three times).
 */
const SEEDED = 64;

/**
 * S10 loaded once for the file (its seed is two and a half hours of polls), and the drawer's listing of it read as
 * it loaded, before any test moves it: "every event applied" then moves it.
 */
let door: Awaited<ReturnType<typeof startScenario>>;
let listed: Awaited<ReturnType<typeof listing>>;
beforeAll(async () => {
  door = await startScenario(scenarioOf("S10"));
  listed = await listing(door);
}, TEST_LIMIT_MS);

test("every event applied: the snapshot after a move is the snapshot before it with the move's events applied", async () => {
  const before = await snapshotOf(door);
  expect(before.seq).toBe(SEEDED);
  const events = await stream(door, SEEDED);
  // A push on #141 (the drawer's "You push to a reviewed pull request"), then a minute on: the push is seen,
  // nothing is asked with the switch off, and the clock event ends the move.
  expect(await inject(door, "you-push")).toBe(200);
  await advance(door, MIN);
  const moved = await until(events, "clock");
  expect(moved.map((e) => [e.seq, e.type])).toEqual([
    [SEEDED + 1, "change.pushed"],
    [SEEDED + 2, "clock"],
  ]);
  const after = await snapshotOf(door);
  expect(after).toEqual(moved.reduce(apply, before));
  expect(after.changes[id(141)]).toMatchObject({ newCommits: 1 });
});

test("determinism: two loads of a scenario at the same instant give the same snapshot and the same event log, through a round driven after", async () => {
  const one = await startScenario(scenarioOf("S10"));
  const two = await startScenario(scenarioOf("S10"));
  const before = await snapshotOf(one);
  expect(await snapshotOf(two)).toEqual(before);
  // A round driven after the seed (#149's: its steps, its findings) and the clock event that ends the move.
  const streams = [await stream(one, SEEDED), await stream(two, SEEDED)];
  for (const door of [one, two]) {
    expect(await inject(door, "agent-opens-change")).toBe(200);
    await advance(door, 200_000);
  }
  const [first, second] = await Promise.all(streams.map((s) => until(s, "clock")));
  expect(first?.map((e) => e.type)).toContain("round.finished");
  expect(second).toEqual(first);
  // The whole log of each room, the seed's events included (a tab from before a start can't replay them: the
  // door says reload, ADR 0038, so the store's log is read), numbered 1 to the end, the same in both.
  const log = logOf(one);
  expect(log.map((e) => e.seq)).toEqual(Array.from({ length: SEEDED + 13 }, (_, i) => i + 1));
  expect(logOf(two)).toEqual(log);
  // A round's events reproduce the snapshot, like any: the one before the move with the move's events applied.
  expect(await snapshotOf(one)).toEqual((first ?? []).reduce(apply, before));
});

test("the moves after the seed are armed on the clock: a pause the owner sets, then a pull request opened, waits on it", async () => {
  const quiet = scenarioOf("S10");
  // A story of its own: #141 reviewed in the seed; a minute after it, the owner pauses for an hour; a minute
  // after that, #146 opens.
  const later: Scenario = {
    ...quiet,
    id: "T-later",
    script: [
      { at: 1 * MIN, move: { kind: "open", change: { repo: SANDBOX, number: 141 } } },
      { at: 6 * MIN, move: { kind: "command", command: { type: "service.pause", for: "hour" } } },
      { at: 7 * MIN, move: { kind: "open", change: { repo: SANDBOX, number: 146 } } },
    ],
    seed: 5 * MIN,
  };
  const door = await startScenario(later);
  const seeded = await snapshotOf(door);
  expect(Object.keys(seeded.changes)).toEqual([id(141)]);
  expect(seeded.reviews[id(141)]?.rounds).toHaveLength(1);
  expect(seeded.service.paused).toBeNull();

  await advance(door, 2 * MIN);
  const state = await snapshotOf(door);
  expect(state.service.paused).toEqual({ since: T0 + MIN, until: T0 + MIN + 60 * MIN });
  expect(state.changes[id(146)]).toMatchObject({ openedAt: T0 + 2 * MIN });
  expect(state.reviews[id(146)]?.job).toMatchObject({ state: "deferred", deferral: { reason: "paused" } });
});

test("every scenario starts signed in on the shared App, posting as the owner, but S1, at the setup's GitHub step; S15 is retired", async () => {
  const people: Record<string, string | null> = {};
  for (const scenario of SCENARIOS) {
    const at = scenario.id === "S10" ? door : await startScenario(scenario);
    const { connection } = await snapshotOf(at);
    people[scenario.id] = connection.person?.login ?? null;
  }
  expect(people).toEqual({
    S1: null,
    S2: "sasensi",
    S3: "sasensi",
    S4: "sasensi",
    S5: "sasensi",
    S6: "sasensi",
    S7: "sasensi",
    S8: "sasensi",
    S9: "sasensi",
    S10: "sasensi",
    S11: "sasensi",
    S12: "sasensi",
    S13: "sasensi",
    S14: "sasensi",
    S16: "sasensi",
    S17: "sasensi",
  });
});

test("the listing: every scenario as the drawer shows it, the one loaded, the clock standing still, the faults", async () => {
  const { status, body } = listed;
  expect(status).toBe(200);
  // Every scenario of the catalogue, in its order; S10's and S14's spelt out.
  expect(body.scenarios.map((s: { id: string }) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
  expect(body.scenarios.filter((s: { id: string }) => s.id === "S10" || s.id === "S14")).toEqual([
    {
      id: "S10",
      title: "A quiet day",
      what: expect.stringContaining("Six pull requests seen since early morning"),
      steps: expect.arrayContaining([expect.stringContaining("#146")]),
      later: "",
      path: "/",
    },
    {
      id: "S14",
      title: "The planted sandbox",
      what: "The planted bugs of the sandbox's #1, in the words Claude and Codex really gave: round 1, the fix pushed, round 2.",
      steps: [
        "Round 1 runs on #1: Claude finds, Codex double-checks.",
        "Open #1: one confirmed, one unsure, one ruled out (How this review ran).",
        "The fix is pushed; you ask again; round 2 finds the eval.",
        "#2 closes on GitHub; then reviews pause and “Review now” waits.",
        "Inject “Codex fails its self-test” from the drawer.",
      ],
      later: "",
      path: "/reviews/sasensi/lookover-sandbox/1",
    },
  ]);
  expect(body.current).toBe("S10");
  expect(body.clock).toMatchObject({ now: T0, running: false, speed: 1 });
  // The next timer: the poll's wake, within its minute.
  expect(body.clock.nextIn).toBeGreaterThan(0);
  expect(body.clock.nextIn).toBeLessThanOrEqual(MIN);
  expect(body.faults).toEqual(FAULTS);
});
