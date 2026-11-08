// Repositories' groups folded or opened from their heads (design-system.md "Sticky, collapsible group heads", ADR 0082,
// 0083): held for the app while it is open, so leaving the page and coming back keeps them, and never stored, so a
// reload starts each group again as its rule says (`repositoriesList`: past ten repositories, a large group folded).
// Each group's first fold is held too, the first time the page shows it, so the rule decides it once.
import { HeldValue } from "./held.ts";

/**
 * The groups the person folded or opened from their chevron, or as Repositories first showed them, by the group's key:
 * `true` folded, `false` open. A group not in it is as its rule starts it, on Repositories and, for one visit of it,
 * on setup's Repositories step alike (round 6).
 */
export class CollapsedGroups extends HeldValue<ReadonlyMap<string, boolean>> {
  constructor() {
    super(new Map());
  }

  /**
   * Opens the group if it is `collapsed` now, folds it if it is open; kept so until it is toggled again. `collapsed`:
   * how the group shows, which only the page knows of a group its rule folds (else as this holds it, open by default).
   */
  toggle = (key: string, collapsed: boolean = this.get().get(key) ?? false): void => {
    const next = new Map(this.get());
    next.set(key, !collapsed);
    this.set(next);
  };

  /**
   * Holds each group's first fold, as its rule started it the first time the page showed it (`repositoriesList`'s
   * `firstFolds`), so a group growing past ten while the app is open stays as it was first shown. A group already held,
   * folded or opened by hand or seen before, is kept; nothing new, nothing changes.
   */
  remember = (firstFolds: ReadonlyMap<string, boolean>): void => {
    const held = this.get();
    const fresh = [...firstFolds].filter(([key]) => !held.has(key));
    if (fresh.length > 0) this.set(new Map([...held, ...fresh]));
  };
}
