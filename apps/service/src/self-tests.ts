// The engines' self-tests as the service runs them (ADR 0044, #91): which state an engine shows once its program
// has been self-tested, and when a self-test runs.
// - An engine whose health says ready is ready only once its program (the engines' `program`, with the version its
//   health gave) has passed: a result kept in the store is read; a version never tested is tested now, in the
//   background, its folder under `<home>/self-tests`; while that runs the engine is busy (the take treats it as
//   reviewing: the jobs it would take wait their turn) and shows what it showed. A failed version shows
//   `failed-self-test`, so the jobs waiting on it are deferred with that reason (`core`); it isn't tested again by
//   itself, a restart included, unless "Check again" asks (`again`). A new version is a new test.
// - When a self-test ends, its result is kept (passed or failed) and the queue is told the state it leads to:
//   `ready` or `failed-self-test`. A version the program didn't print is never kept: its result holds in memory,
//   for this start only. An inconclusive one keeps nothing and holds a state in memory, after which a take tests
//   it again; "Check again" tests it at once: signed out in the run (while `auth status` said signed in, a sign-in
//   being refreshed, say) shows `signed-out` until the next tick (`SIGNED_OUT_MS`), so Claude isn't left on "Sign
//   in" for nothing; at its limit, `limit`, until the reset its run read (ADR 0055), else for `HELD_MS`, the queue
//   told what the run said of it (`ended`'s `LimitMet`) so it holds the engine as a review's run would; anything
//   else (the help not answering, the bait not planted, the wall never tried) `failed-self-test`, for `HELD_MS`.
//   The log line of an inconclusive one says why. One cancelled (the service stopping) keeps and says nothing.
// - One self-test per engine at a time, and none while the engine reviews (one run per engine, ADR 0015).
// Once stopped, a self-test that ends writes and says nothing; `stop` cancels those running and waits for them.
// It must never know: how a self-test runs or what it checks (the engines'), or the queue's rules.

import { join } from "node:path";
import {
  type Clock,
  type EngineHealth,
  type EngineId,
  type EngineState,
  type LimitMet,
  limitMet,
} from "@lookover/contracts";
import type { SelfTestReport, SelfTests } from "@lookover/engines";
import type { Store, TestedProgram } from "@lookover/store";
import { said } from "./said.ts";
import { engineStateOf } from "./snapshot.ts";

/** How long an inconclusive self-test's state holds before a take tests again. */
const HELD_MS = 15 * 60_000;
/** How long "signed out" from a self-test's run holds: until the queue's next tick (60 s) asks again. */
const SIGNED_OUT_MS = 60_000;

/** The states an engine's own run can show, its health saying ready: signed out, or at its limit. */
export type RanInto = Extract<EngineState, "signed-out" | "limit">;

/**
 * How long each holds, from a self-test's run or a review's (the queue's `ranInto`), before a health that says
 * ready is believed again.
 */
export const RAN_INTO_MS = { "signed-out": SIGNED_OUT_MS, limit: HELD_MS } as const satisfies Record<
  RanInto,
  number
>;

export interface GateDeps {
  tester: SelfTests;
  store: Pick<Store, "selfTests">;
  clock: Clock;
  /** Where each self-test gets its folder: `<home>/self-tests`. */
  dir: string;
  /**
   * A self-test ended: the state it leads to (null: nothing to say), for the queue to show and take on; at the
   * limit, what its run said of it.
   */
  ended(engine: EngineId, state: EngineState | null, met: LimitMet): void;
  log(line: string): void;
}

/** What the take needs to know of an engine besides its health. */
interface StateAsked {
  /** What the UI shows of it now. */
  shown: EngineState;
  /** It reviews a job now: no self-test starts. */
  reviewing: boolean;
  /** "Check again": a failed or inconclusive version is tested again. */
  again: boolean;
}

export interface Gate {
  /** The state `engine` shows given `health` (see the header); starts its self-test when one is due. */
  stateOf(engine: EngineId, health: EngineHealth, asked: StateAsked): EngineState;
  /** The engines whose self-test runs now: busy. */
  testing(): ReadonlySet<EngineId>;
  /** Cancels the self-tests running and waits for them; nothing more is written or said. */
  stop(): Promise<void>;
}

/**
 * The state an inconclusive self-test leads to and until when, at `now`; null for a cancelled one, which says
 * nothing. At the limit, until its reset when the run read one (ADR 0055).
 */
function inconclusiveHold(report: SelfTestReport, now: number): { state: EngineState; until: number } | null {
  switch (report.outcome) {
    case "cancelled":
      return null;
    case "auth_required":
      return { state: "signed-out", until: now + RAN_INTO_MS["signed-out"] };
    case "quota_exhausted":
      return { state: "limit", until: report.limitUntil ?? now + RAN_INTO_MS.limit };
    default:
      return { state: "failed-self-test", until: now + HELD_MS };
  }
}

/**
 * Why a self-test couldn't say, from its run's outcome: the run wasn't made, the program was signed out or at its
 * limit, or the run broke no rule but never tried the wall (`engines`' `SelfTestReport`).
 */
function inconclusiveWhy(outcome: SelfTestReport["outcome"]): string {
  switch (outcome) {
    case null:
      return "not run";
    case "auth_required":
      return "signed out";
    case "quota_exhausted":
      return "at its limit";
    case "ok":
      return "the wall not tried";
    default:
      return outcome;
  }
}

/**
 * A self-test's line in the log: the program, the verdict (an inconclusive one with why), the rules it broke, the
 * flags missing, the time.
 */
function logLine(tested: TestedProgram, report: SelfTestReport): string {
  const why = report.verdict === "inconclusive" ? ` (${inconclusiveWhy(report.outcome)})` : "";
  const broke = report.failures.length > 0 ? ` (${report.failures.join(", ")})` : why;
  const missing = report.missingFlags.length > 0 ? `, missing ${report.missingFlags.join(" ")}` : "";
  return `self-test of ${tested.engine} ${tested.version}: ${report.verdict}${broke}${missing}, ${report.tookMs} ms`;
}

/** The version a program that printed none is tested under: its result is never kept (see the header). */
const UNVERSIONED = "unknown";

/** What is known of a program: it passed, or the state its result shows (failed, or held after an inconclusive one). */
type Known = { passed: true } | { passed: false; state: EngineState };

export function createGate(d: GateDeps): Gate {
  const running = new Map<EngineId, { cancel: AbortController; done: Promise<void> }>();
  /**
   * What is known in memory only, by engine: for which program, what (an inconclusive result's state, or the result
   * of a version the program didn't print) and until when (null: until the service stops).
   */
  const held = new Map<EngineId, { key: string; known: Known; until: number | null }>();
  let stopped = false;
  let made = 0;
  const keyOf = (t: TestedProgram) => JSON.stringify([t.engine, t.program, t.version]);

  /** The result kept for `tested`, or the state an inconclusive one still holds; null when nothing is known. */
  function known(tested: TestedProgram): Known | null {
    const kept = d.store.selfTests.result(tested);
    if (kept !== null) return kept.passed ? { passed: true } : { passed: false, state: "failed-self-test" };
    const hold = held.get(tested.engine);
    if (hold === undefined || hold.key !== keyOf(tested)) return null;
    if (hold.until !== null && hold.until <= d.clock.now()) return null;
    return hold.known;
  }

  function begin(tested: TestedProgram): void {
    const { engine } = tested;
    const cancel = new AbortController();
    const dir = join(d.dir, `${engine}-${d.clock.now()}-${++made}`);
    const entry = {
      cancel,
      done: d.tester
        .selfTest(engine, dir, cancel.signal)
        .then((report) => {
          running.delete(engine);
          end(tested, report);
        })
        .catch((error: unknown) => {
          // The port promises it never throws: one that does is logged, and the engine is tested again later.
          running.delete(engine);
          d.log(`the self-test of ${engine} threw: ${said(error)}`);
        }),
    };
    running.set(engine, entry);
  }

  function end(tested: TestedProgram, report: SelfTestReport): void {
    if (stopped) return;
    const { engine } = tested;
    d.log(logLine(tested, report));
    const key = keyOf(tested);
    if (report.verdict === "inconclusive") {
      const hold = inconclusiveHold(report, d.clock.now());
      if (hold !== null) {
        const known: Known = { passed: false, state: hold.state };
        held.set(engine, { key, known, until: hold.until });
      }
      d.ended(engine, hold?.state ?? null, limitMet(report));
      return;
    }
    const passed = report.verdict === "passed";
    const known: Known = passed ? { passed: true } : { passed: false, state: "failed-self-test" };
    if (tested.version === UNVERSIONED) held.set(engine, { key, known, until: null });
    else {
      d.store.selfTests.ran(tested, passed);
      held.delete(engine);
    }
    d.ended(engine, passed ? "ready" : "failed-self-test", {});
  }

  /** The state of a ready engine's program, `tested`: what is known of it, or its self-test begun. */
  function gated(tested: TestedProgram, asked: StateAsked): EngineState {
    // While its self-test runs, the engine shows what it showed.
    const meanwhile = asked.shown === "failed-self-test" ? "failed-self-test" : "ready";
    if (running.has(tested.engine)) return meanwhile;
    const result = known(tested);
    if (result?.passed) return "ready";
    const due = result === null || asked.again;
    if (!due || asked.reviewing || stopped) return result?.state ?? meanwhile;
    begin(tested);
    return meanwhile;
  }

  return {
    stateOf(engine, health, asked) {
      const state = engineStateOf(health);
      if (state !== "ready") return state;
      const program = d.tester.program(engine);
      if (program === null) return "missing";
      return gated({ engine, program, version: health.version ?? UNVERSIONED }, asked);
    },
    testing: () => new Set(running.keys()),
    async stop() {
      stopped = true;
      const all = [...running.values()];
      for (const r of all) r.cancel.abort();
      await Promise.all(all.map((r) => r.done));
    },
  };
}

/**
 * No self-test: every engine shows its health's state, and none is ever busy testing. For a service whose tests
 * are of another concern (`ServiceOptions.selfTests` null); demo and live mode always self-test.
 */
export const UNGATED: Gate = {
  stateOf: (_engine, health) => engineStateOf(health),
  testing: () => new Set(),
  stop: () => Promise.resolve(),
};
