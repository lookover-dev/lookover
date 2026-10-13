// The round plan (ADR 0044): who reviews a change, decided when its job is taken and held for the whole run.
// The finder: the engine the repository allows that didn't write the change, Claude when nobody knows or when only
// Claude may review it. Codex never reviews another author's change while its reads aren't confined to the review
// folder (a pull request's text could make it quote a secret from the owner's disk): Claude finds it instead, and
// where only Codex may review, the change is skipped, `codex-not-yours`. The owner's coding agent pushes as the
// owner (ADR 0016): its change is the owner's. Codex never confirms another author's change either. A fork change
// (its head in another repository) is barred to Codex the same way, whoever wrote it (ADR 0048): Claude alone.
// The finder never depends on the engines' states: a finder that isn't ready defers the job, it is never swapped
// for the other engine (ADR 0029); the owner may send a waiting job to the other engine (`engine.reroute`, ADR
// 0047), and that engine then finds, whoever wrote the change, unless it may not review it (refused, the rule picks).
// The confirmer does depend on the states: the other engine when it may review the change and is ready,
// else the finder in a new session, with why (`ConfirmFallback`: the settings or the author bar the other engine,
// said first whatever its state; or it isn't ready, in that state). Whether the other engine is busy is the take's
// to weigh: a busy engine is given here as ready, and the job waits its turn rather than confirm on the finder.
// Depth (ADR 0044) sets how many sessions: Quick, one find pass and no confirmer (nothing falls back, so the other
// engine is neither held nor asked); Standard, one find pass and the confirmer; Deep, a second find pass by the
// engine that confirms (the other engine when it may review the change and is ready, else the finder again: so
// Codex never finds another author's change in either pass), then the confirmer. A run so never holds an engine
// beyond its finder and its confirmer.
import type {
  Change,
  ConfirmFallback,
  Depth,
  EngineId,
  EngineState,
  Reviewers,
  SkipReason,
} from "@lookover/contracts";

/** What decides who reviews a change. */
export interface RoundPlanFacts {
  /** The engines the repository reviews with. */
  reviewers: Reviewers;
  /** Whose change it is, whether it comes from a fork, and which engine's coding agent wrote it, if known. */
  change: Pick<Change, "author" | "writtenBy" | "fork">;
  /** How many sessions a review spends: the repository's setting. */
  depth: Depth;
  /** Each engine's state, as last known: the confirmer's say. */
  engines: Record<EngineId, EngineState>;
  /**
   * The engine the owner sent the job to (`engine.reroute`, ADR 0047), which finds whoever wrote the change; null
   * for the rule's finder. One that may not review the change (the settings changed since, or the author bars it) is
   * refused, and the rule picks as if nobody chose.
   */
  finder: EngineId | null;
}

/** Who confirms, and why it is the finder when it is. */
interface ConfirmPlan {
  /** The engine whose session confirms the round's new candidates; null at depth Quick. */
  confirmer: EngineId | null;
  /** Why `confirmer` is the finder, in a new session, rather than the other engine; null when it isn't. */
  confirmFallback: ConfirmFallback | null;
}

/** A change reviewed: by which finder (and which second finder, Deep), and who confirms. */
export interface ReviewPlan extends ConfirmPlan {
  kind: "review";
  finder: EngineId;
  /** Deep's second find pass: always the confirmer. Null for one find pass (Quick, Standard). */
  secondFinder: EngineId | null;
}

/** Reviewed, by which finder and confirmer; or skipped, and why. */
export type RoundPlan = ReviewPlan | { kind: "skipped"; reason: Extract<SkipReason, "codex-not-yours"> };

/** Both engines, Claude first: the finder when nothing tells them apart. */
export const ENGINES = Object.values({ claude: "claude", codex: "codex" } as const satisfies Record<
  EngineId,
  EngineId
>);

/** Each engine's other one: who confirms or steps in for it. */
export const OTHER: Record<EngineId, EngineId> = { claude: "codex", codex: "claude" };

/**
 * Why `engine` may not review the change: `settings`, the repository's reviewers leave it out; `not-own`, Codex on a
 * change not the owner's own from the repository: another author's, or a fork's whoever wrote it (ADR 0048). Null
 * when it may. The reasons are `ConfirmFallback`'s. The one rule of who may review a change: the round plan and
 * `stepIn` (`reviewer.ts`) both ask it.
 */
export function barred(
  engine: EngineId,
  reviewers: Reviewers,
  change: Pick<Change, "author" | "fork">,
): "settings" | "not-own" | null {
  if (reviewers !== "both" && reviewers !== engine) return "settings";
  if (engine === "codex" && (change.author === "other" || change.fork)) return "not-own";
  return null;
}

/** Who confirms what `finder` found: the other engine when it may review the change and is ready, else the finder. */
function confirmPlan(finder: EngineId, facts: RoundPlanFacts): ConfirmPlan & { confirmer: EngineId } {
  const other = OTHER[finder];
  const reason = barred(other, facts.reviewers, facts.change);
  if (reason !== null) return { confirmer: finder, confirmFallback: { reason, engine: other } };
  const state = facts.engines[other];
  if (state !== "ready") {
    return { confirmer: finder, confirmFallback: { reason: "not-ready", engine: other, state } };
  }
  return { confirmer: other, confirmFallback: null };
}

/** Who reviews the change, or why it is skipped. One call decides. */
export function roundPlan(facts: RoundPlanFacts): RoundPlan {
  const allowed = ENGINES.filter((engine) => barred(engine, facts.reviewers, facts.change) === null);
  const sentTo = facts.finder !== null && allowed.includes(facts.finder) ? facts.finder : undefined;
  const finder = sentTo ?? allowed.find((engine) => engine !== facts.change.writtenBy) ?? allowed[0];
  // Only Codex may review here, and it may not review this change.
  if (finder === undefined) return { kind: "skipped", reason: "codex-not-yours" };
  if (facts.depth === "quick") {
    return { kind: "review", finder, secondFinder: null, confirmer: null, confirmFallback: null };
  }
  const confirm = confirmPlan(finder, facts);
  const secondFinder = facts.depth === "deep" ? confirm.confirmer : null;
  return { kind: "review", finder, secondFinder, ...confirm };
}
