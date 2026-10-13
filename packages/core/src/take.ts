// What the take does with a waiting job (ADR 0042, ADR 0043, ADR 0044): the service's queue asks it for each
// waiting job, oldest first, inside `store`'s take. Answered here so the rule is one pure function: the job's change
// gone → cancelled; the round plan skipping it (only Codex may review here, and not another author's change) →
// skipped, which no pause or engine holds since nothing runs; otherwise the round plan (who finds, who confirms; the
// engine the owner sent the job to as the finder, ADR 0047), and
// `mayStart` with its finder; a job whose finder or confirmer is reviewing another waits its turn, queued, since one
// engine runs one review at a time (ADR 0015) and a job holds both its engines for its whole run (ADR 0044); so does
// a job whose change's last job still runs or posts its round (ADR 0044: the engines are freed when posting starts,
// the change is not). A busy engine was ready when its run started, so only the pause holds such a job: its last
// known state is not asked, and the plan is given it as ready, so a busy confirmer is waited for rather than
// replaced by the finder (the same change gets the same review whatever else runs). A job waiting for its engines
// says which (`holds`): the store's take counts them as reviewing for the younger jobs, so first come, first served.
// A job waiting its turn also says what it waits behind (`turn`, ADR 0055): its own change's round, else the engines
// reviewing other changes and which, else those running their self-test, else those an older job waits for.
// The engines a job holds are its plan's at its depth: the finder alone at Quick (no confirmer), the finder and the
// confirmer at Standard and Deep (Deep's second finder is the confirmer). While the host is not connected
// (disconnected, or no bot yet) nothing can be fetched or posted: a job the pause and its finder's state would let
// start waits as deferred `connection` instead, busy engines or not (ADR 0047); the service takes again once the
// poller reports the connection back.
import type {
  Change,
  ChangeId,
  Connection,
  Deferral,
  Depth,
  EngineId,
  EngineState,
  EngineUnusable,
  Reviewers,
  SkipReason,
  Trigger,
  Turn,
} from "@lookover/contracts";
import { ENGINES, type ReviewPlan, roundPlan } from "./plan.ts";
import { mayStart } from "./start.ts";

/**
 * What holds a busy engine: a review of a change, finding or confirming; its self-test (ADR 0044); or an older job
 * waiting for it (first come, first served).
 */
export type EngineHold = { by: "review"; changeId: ChangeId } | { by: "self-test" } | { by: "older" };

/** What decides what the take does with a waiting job. */
export interface TakeFacts {
  /** Whether the owner paused reviews. */
  paused: boolean;
  trigger: Trigger;
  /** The job's change, or null when it is no longer one to review. */
  change: Pick<Change, "author" | "writtenBy" | "fork"> | null;
  /** The engines the repository reviews with. */
  reviewers: Reviewers;
  /** The repository's depth: how many sessions the review spends, so which engines it holds. */
  depth: Depth;
  /** Each engine's state, as last known. */
  engines: Record<EngineId, EngineState>;
  /** Why each engine's program, found, can't be used (a Codex too old for its model): a job held on it says so. */
  unusable: Record<EngineId, EngineUnusable | null>;
  /** The engines busy now, and what holds each: a review, a self-test or an older job. */
  busy: ReadonlyMap<EngineId, EngineHold>;
  /**
   * Whether another job of the job's change still runs, its round posting included (ADR 0044): the engines are freed
   * once posting starts, but the next round must not overtake the last one.
   */
  changeBusy: boolean;
  /** The host's connection as last reported: only `connected` lets a job start. */
  connection: Connection["state"];
  /**
   * The engine the owner sent the job to (`engine.reroute`, ADR 0047), the finder its round plans with until the
   * job ends; null for the rule's. A job sent to an engine that isn't ready waits for that one.
   */
  finder: EngineId | null;
}

/**
 * Start it with this plan, its finder and its confirmer held for the whole run; it waits as deferred, and why; it
 * waits its turn, queued; it is skipped, and why; or it is cancelled.
 */
export type TakeDecision =
  | { kind: "start"; plan: ReviewPlan }
  | { kind: "deferred"; deferral: Deferral }
  /**
   * Waits its turn. `holds`: the engines it waits for, which the take then counts as reviewing for every younger
   * job, so a job needing both engines is never overtaken for ever by younger jobs needing one (first come, first
   * served); none when only its change is busy (its engines are free). `turn`: what it waits behind (ADR 0055).
   */
  | { kind: "queued"; holds: EngineId[]; turn: Turn }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "cancelled" };

/** What the take does with a waiting job now. One call decides. */
export function takeDecision(facts: TakeFacts): TakeDecision {
  if (facts.change === null) return { kind: "cancelled" };
  const { busy } = facts;
  const shown = (engine: EngineId): EngineState => (busy.has(engine) ? "ready" : facts.engines[engine]);
  const plan = roundPlan({
    reviewers: facts.reviewers,
    change: facts.change,
    depth: facts.depth,
    engines: { claude: shown("claude"), codex: shown("codex") },
    finder: facts.finder,
  });
  if (plan.kind === "skipped") return plan;
  const rule = mayStart({
    paused: facts.paused,
    trigger: facts.trigger,
    engine: { id: plan.finder, state: shown(plan.finder), unusable: facts.unusable[plan.finder] },
  });
  if (rule.kind === "deferred") return rule;
  if (facts.connection !== "connected") return { kind: "deferred", deferral: { reason: "connection" } };
  const engines = [...new Set([plan.finder, plan.secondFinder, plan.confirmer])].filter(
    (engine): engine is EngineId => engine !== null,
  );
  if (engines.some((engine) => busy.has(engine))) {
    return { kind: "queued", holds: engines, turn: facts.changeBusy ? CHANGE : turnOf(engines, busy) };
  }
  return facts.changeBusy ? { kind: "queued", holds: [], turn: CHANGE } : { kind: "start", plan };
}

const CHANGE: Turn = { behind: "change" };

/**
 * What a job needing `engines`, some busy, waits behind: those reviewing other changes, and which; else those running
 * their self-test; else those an older job waits for. `testing`: a self-test holds one of them. Claude first, whoever
 * finds, so one pair always reads the same way and the same turn compares equal.
 */
function turnOf(engines: EngineId[], busy: ReadonlyMap<EngineId, EngineHold>): Turn {
  const holds = ENGINES.filter((engine) => engines.includes(engine)).map(
    (engine) => [engine, busy.get(engine)] as const,
  );
  const reviewing = holds.flatMap(([engine, hold]) => (hold?.by === "review" ? [{ engine, hold }] : []));
  const held = (by: EngineHold["by"]) =>
    holds.filter(([, hold]) => hold?.by === by).map(([engine]) => engine);
  const testing = held("self-test");
  if (reviewing.length > 0) {
    return {
      behind: "engines",
      engines: reviewing.map(({ engine }) => engine),
      changes: [...new Set(reviewing.map(({ hold }) => hold.changeId))],
      testing: testing.length > 0,
    };
  }
  if (testing.length > 0) return { behind: "engines", engines: testing, changes: [], testing: true };
  return { behind: "engines", engines: held("older"), changes: [], testing: false };
}
