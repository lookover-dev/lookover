// Setup's last card, "Reviews keep running in the background" (design-system.md "Your coding agent"): the step's
// footer under it never moves when its line changes ("Don't start at login"), and the card itself ends at the same
// padding as its siblings: the room for its taller line is held by a hidden copy of the card beside it, never by
// empty room inside it.
import { expect, test } from "bun:test";
import type { State } from "@lookover/contracts";
import { app, screen, world } from "./repositories.test-support.tsx";
import { BackgroundCard } from "./setup.tsx";

const card = (state: State) => screen(app(), state, () => <BackgroundCard />);

/** Each `.background-note` card's markup, in order. */
const cards = (html: string) => html.split('class="card background-note').slice(1);

test("the card shown holds only its own line; the other line it can say is a hidden copy of the card", () => {
  const on: State = { ...world(), service: { ...world().service, startAtLogin: true } };
  const html = card(on);
  const all = cards(html);
  expect(all.length).toBe(2);
  const [shown, held] = all;
  // Titled at the cards' title size, as Try it and the installs' rows are (round 6).
  expect(shown).toStartWith('"><h4 class="card-title">Reviews keep running in the background</h4>');
  expect(shown).toContain("It starts each time you log in to this computer.");
  expect(shown).not.toContain("won&#x27;t start at login");
  expect(held).toStartWith(' held-room" aria-hidden="true"><h4');
  expect(held).toContain("won&#x27;t start at login");
});
