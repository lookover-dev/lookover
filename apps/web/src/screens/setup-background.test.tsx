// Setup's last card, "Reviews keep running in the background" (design-system.md "Your coding agent"), and the line
// of what start at login does, under the step's footer: the footer's "Don't start at login" changes that line, so it
// sits where its growth moves nothing, the step's end, and no card holds a hidden copy of another line (ADR 0086).
import { expect, test } from "bun:test";
import type { State } from "@lookover/contracts";
import { app, screen, world } from "./repositories.test-support.tsx";
import { AgentActs, BackgroundCard } from "./setup.tsx";

const on: State = { ...world(), service: { ...world().service, startAtLogin: true } };
const off: State = { ...world(), service: { ...world().service, startAtLogin: false } };

test("the card says reviews keep running, once, with no line of start at login and no hidden copy", () => {
  const html = screen(app(), on, () => <BackgroundCard />);
  // Titled at the cards' title size, as Try it and the installs' rows are (round 6).
  expect(html).toStartWith(
    '<div class="card background-note"><h4 class="card-title">Reviews keep running in the background</h4>',
  );
  expect(html.split("background-note").length).toBe(2);
  expect(html).not.toContain("aria-hidden");
  expect(html).not.toContain("start at login");
  expect(html).not.toContain("log in to this computer");
});

test("what start at login does is said under the footer's buttons, the line of the choice shown only", () => {
  const said = (state: State) => screen(app(), state, AgentActs).split("Go to my reviews")[1] ?? "";
  expect(said(on)).toContain("It starts each time you log in to this computer.");
  expect(said(on)).not.toContain("won&#x27;t start at login");
  expect(said(off)).toContain("It won&#x27;t start at login");
  expect(said(off)).not.toContain("It starts each time");
});
