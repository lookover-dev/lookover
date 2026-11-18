// The tray's states, held in one place (ADR 0105 §9): `TrayState` is declared by `@lookover/web/tray`, beside the
// words that pick it, and the brand's icons (`@lookover/brand`, which imports nothing) are drawn for its own list of
// them. The service, which imports both, holds them equal: a state either side adds without the other fails to
// compile here.
import { expect, test } from "bun:test";
import { type TrayState as DrawnState, TRAY_STATES } from "@lookover/brand";
import type { TrayState } from "@lookover/web/tray";

/** `true` when `A` and `B` are the same union, else `false`. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test("the brand draws an icon for each state the tray's words pick, and for no other", () => {
  const same: Same<TrayState, DrawnState> = true;
  const words: readonly TrayState[] = TRAY_STATES;
  expect(same).toBe(true);
  expect(words).toEqual(["problem", "paused", "needs-you", "reviewing", "idle"]);
});
