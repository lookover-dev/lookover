// Mine and Everyone (ADR 0078): the list starts at the person's pull requests. Mine is theirs and their agent's, and
// any other the person asked Lookover to review; Everyone adds every other open one Lookover has seen. One choice for
// Home and All reviews, held while the page is open, its tabs shown once another author's pull request is listed and
// never taken away after, so they don't come and go under the reader.
import type { Review, SkipReason, Trigger } from "@lookover/contracts";
import type { ChangeReview } from "./select.ts";

export type Scope = "mine" | "everyone";

/**
 * Whether a trigger is the person putting the change in their list: a request (a comment, Review now) or setup's
 * first review, which the person picked; not opening or a push. Core's `ASKED_BY` tells setup from a request, for
 * what intake asks; Mine asks only whether the person chose the change.
 */
const PUT_IN_LIST: Record<Trigger, boolean> = {
  comment: true,
  manual: true,
  "first-review": true,
  opened: false,
  push: false,
};

/**
 * The skips setup's first review recorded on another author's change before ADR 0078 (`not-yours`, or `fork` on a
 * teammate's fork): nothing was reviewed and nothing asked since, so it is not Mine. The one case this guards: a
 * request never records them, and the person's own change is Mine whatever its job.
 */
const NOBODY_ASKED: ReadonlySet<SkipReason> = new Set<SkipReason>(["not-yours", "fork"]);

/** Whether the person asked for this review: a round ran, or the job came from the person putting it in the list. */
function asked(review: Review): boolean {
  if (review.rounds.length > 0) return true;
  const { job } = review;
  if (job === null || !PUT_IN_LIST[job.trigger]) return false;
  return !(job.state === "skipped" && job.skip !== null && NOBODY_ASKED.has(job.skip));
}

/** The person's: theirs or their agent's, or another's they asked about. An old skip of another's isn't asked. */
export function isMine(it: ChangeReview): boolean {
  return it.change.author !== "other" || asked(it.review);
}

/** Another author's pull request the person never asked about: no request, no round. */
export function neverAsked(it: ChangeReview): boolean {
  return !isMine(it);
}

function inScope(scope: Scope, it: ChangeReview): boolean {
  return scope === "everyone" || isMine(it);
}

/** The list's rows within the tab: Home's groups and All reviews read them. */
export function inTab(scope: Scope, items: readonly ChangeReview[]): ChangeReview[] {
  return items.filter((i) => inScope(scope, i));
}

/** One tab of a list's split, as the design system's `Tabs` takes it. */
export interface ScopeTab {
  value: Scope;
  label: string;
  count: number;
}

/** Whether a list has a reason for the tabs: another author's pull request is listed. */
const othersListed = (items: readonly ChangeReview[]): boolean =>
  items.some((i) => i.change.author === "other");

/** Mine and Everyone with their counts, or null while only the person's are listed and the tabs were never shown. */
export function scopeTabs(items: readonly ChangeReview[], shown: boolean): ScopeTab[] | null {
  if (!shown && !othersListed(items)) return null;
  return [
    { value: "mine", label: "Mine", count: items.filter(isMine).length },
    { value: "everyone", label: "Everyone", count: items.length },
  ];
}

/** The list's choice and whether its tabs were shown. */
export interface ScopeChoice {
  scope: Scope;
  shown: boolean;
}

/**
 * What holds the choice for the app while it is open: Mine at first; `see` shows the tabs once another author's pull
 * request is listed, and nothing hides them again. The value is replaced only when it changes, for
 * `useSyncExternalStore`.
 */
export class ListScope {
  private value: ScopeChoice = { scope: "mine", shown: false };
  private listeners = new Set<() => void>();

  get = (): ScopeChoice => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  see(items: readonly ChangeReview[]): void {
    if (!this.value.shown && othersListed(items)) this.set({ ...this.value, shown: true });
  }

  choose = (scope: Scope): void => {
    if (scope !== this.value.scope) this.set({ ...this.value, scope });
  };

  private set(value: ScopeChoice): void {
    this.value = value;
    for (const l of this.listeners) l();
  }
}
