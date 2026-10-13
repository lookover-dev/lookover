// Whether a change that asks for a review gets a review job, or is skipped and why (ADR 0016, ADR 0026).
// v1 has a few switches, no rule list. Whether the job can start now is the scheduler's question, not this one.
// Owner-only means "authored or requested by the owner" (ADR 0016, ADR 0043): the owner's request (a review request
// comment, "Review now" in the app) is reviewed on anyone's change; what nobody asked in person is skipped there.
// A fork change (its head in another repository than its base) is never reviewed unless asked by hand, whoever
// wrote it (ADR 0048): its code could try to steer the reviewer. Checked before the author rule, so a fork says so.
import type { Change, SettingValues, SkipReason, Trigger } from "@lookover/contracts";

/**
 * `job`: a review job is asked for. `skipped`: the job is recorded as skipped, with the reason on the check.
 * `not-asked`: a push with reviews after every push switched off. Nobody asked, so there is no job: the new
 * commits wait for a review request.
 */
export type Intake = { kind: "job" } | { kind: "skipped"; reason: SkipReason } | { kind: "not-asked" };

/**
 * Who asks, by trigger. `automatic`: nobody in person (the pull request opened or pushed). `request`: the owner in
 * person (a review request comment, only the owner's count; "Review now" in the app), on anyone's change. `setup`:
 * setup's first review, on one of the owner's changes. Asking (a request or setup) also works on drafts.
 */
const ASKED_BY = {
  opened: "automatic",
  push: "automatic",
  comment: "request",
  manual: "request",
  "first-review": "setup",
} as const satisfies Record<Trigger, "automatic" | "request" | "setup">;

const automatic = (trigger: Trigger): boolean => ASKED_BY[trigger] === "automatic";

export function intake(
  change: Pick<Change, "author" | "draft" | "fork">,
  repository: { enabled: boolean; settings: Pick<SettingValues, "onOpen" | "onPush"> },
  trigger: Trigger,
): Intake {
  const skip = (reason: SkipReason): Intake => ({ kind: "skipped", reason });
  // A push with the switch off asks nothing, so there is nothing to skip, whoever's change it is (ADR 0043).
  if (trigger === "push" && !repository.settings.onPush) return { kind: "not-asked" };
  if (!repository.enabled) return skip("repo-off");
  // Setup's first review is no request: it never offers a fork change, and skips one it is given (ADR 0048).
  if (change.fork && ASKED_BY[trigger] !== "request") return skip("fork");
  // Owner-only in v1: the owner's coding agents push as the owner, so "agent" is the owner too (ADR 0016); the
  // owner's own request reviews another author's change.
  if (change.author === "other" && ASKED_BY[trigger] !== "request") return skip("not-yours");
  if (change.draft && automatic(trigger)) return skip("draft");
  if (trigger === "opened" && !repository.settings.onOpen) return skip("on-open-off");
  return { kind: "job" };
}

/**
 * What a skip leads to. `record`: a job skipped with its reason, its check saying why (ADR 0043). `join`: the
 * request is asked as a review, joining the change's job waiting or running as any request does (ADR 0047).
 * `nothing`: nobody asked, so no job and no check.
 */
export type SkipOutcome = "record" | "join" | "nothing";

/** The skips an automatic trigger records, its check saying why: a fixed rule, not a switch the owner set. */
const TOLD = {
  "not-yours": true,
  fork: true,
  draft: false,
  "repo-off": false,
  "on-open-off": false,
  "codex-not-yours": false,
} as const satisfies Record<SkipReason, boolean>;

/**
 * What a skip leads to, given whether the change has a job waiting or running (`pending`). An automatic trigger that
 * meets a switch that is off or a draft asked nothing. Another author's change and a fork change are told why
 * (ADR 0016, ADR 0048), unless a job is pending, which someone asked for: the skip, newer, would be the job the
 * change shows and its check would say "not yours" beside a review to come. A request is always answered: recorded as
 * a skip (a repository switched off), or, beside a pending job, joining it, so a review to come is never hidden
 * (ADR 0047).
 */
export function skipOutcome(trigger: Trigger, reason: SkipReason, pending: boolean): SkipOutcome {
  if (!automatic(trigger)) return pending ? "join" : "record";
  return TOLD[reason] && !pending ? "record" : "nothing";
}
