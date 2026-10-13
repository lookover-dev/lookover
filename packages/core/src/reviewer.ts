// Which engine may step in for one that can't review (ADR 0029, ADR 0047, I-137). Who finds is the round plan's
// (`plan.ts`, ADR 0044). `stepIn` asks the plan's one rule of who may review a change (`barred`): the other engine
// steps in only when the repository's reviewers allow it and it may review that change, so Codex never steps in on
// another author's change, nor on a fork change (ADR 0048).
import type { Change, EngineId, Reviewers } from "@lookover/contracts";
import { barred, OTHER } from "./plan.ts";

/**
 * The engine that may take over a review deferred on `from`, when the owner asks: the other engine, if the owner
 * uses it and it may review the change (Codex never another author's, ADR 0044, nor a fork's, ADR 0048). Null when
 * the owner uses only `from`, or the other engine is barred from the change. Never automatic (ADR 0029).
 */
export function stepIn(
  from: EngineId,
  reviewers: Reviewers,
  change: Pick<Change, "author" | "fork">,
): EngineId | null {
  const other = OTHER[from];
  return barred(other, reviewers, change) === null ? other : null;
}
