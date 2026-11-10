// The layout pass's lists (ADR 0086): every screen it judges is a shot proof takes, every allowance names its ticket
// and screens it judges, and a failure is said with its screen, width, element and child. What it measures is proved
// in the browser, by its own bite pages, each time `bun run proof` runs: no test here lays out a page.
import { expect, test } from "bun:test";
import {
  ALLOWANCES,
  type Allowance,
  failureLine,
  LAYOUT_BITES,
  MEASURED,
  unneeded,
  widthsOf,
} from "./proof-layout.ts";
import { SHOTS } from "./proof-shots.ts";

test("every screen the pass judges is a shot proof takes, each once", () => {
  const names = new Set(SHOTS.map((s) => s.name));
  expect(MEASURED.filter((m) => !names.has(m.shot)).map((m) => m.shot)).toEqual([]);
  expect(new Set(MEASURED.map((m) => m.shot)).size).toBe(MEASURED.length);
});

test("the pass judges Repositories, Settings › GitHub and setup's GitHub step on the real-looking names", () => {
  const scenarios = (prefix: string) =>
    MEASURED.filter((m) => m.shot.startsWith(prefix)).map(
      (m) => SHOTS.find((s) => s.name === m.shot)?.scenario,
    );
  expect(scenarios("repositories")).toContain("S20");
  expect(scenarios("repositories")).toContain("S18");
  expect(scenarios("settings-github")).toContain("S20");
  expect(scenarios("setup-github")).toContain("S21");
});

test("a screen is laid out at 1024 and 1440 px, and at 390 px where it has a phone layout", () => {
  expect(widthsOf({ shot: "settings" })).toEqual([1024, 1440]);
  expect(widthsOf({ shot: "repositories-names", phone: true })).toEqual([1024, 1440, 390]);
});

test("each allowance names the ticket that removes it, why, and only screens the pass judges", () => {
  const judged = new Set(MEASURED.map((m) => m.shot));
  for (const a of ALLOWANCES) {
    expect(a.ticket).toBeGreaterThan(0);
    expect(a.why.length).toBeGreaterThan(0);
    expect((a.screens ?? []).filter((s) => !judged.has(s))).toEqual([]);
  }
});

test("no allowance is left: row 52 reworked every held place, so the pass judges every screen whole (ADR 0086)", () => {
  expect(ALLOWANCES).toEqual([]);
});

test("the pass judges setup's GitHub step while it is still looking for the accounts, at a phone's width too", () => {
  expect(MEASURED).toContainEqual({ shot: "setup-github-signed-in-looking", phone: true });
});

test("a failure is said with its screen, width, element and the child holding its room", () => {
  expect(
    failureLine("repositories-names", 1440, {
      measure: "held",
      element: "td.repos-prs > span.repos-group-fix > span.held-detail",
      child: 'span (hidden) "Asks you to sign in with SSO."',
      by: 20,
      allowedBy: null,
    }),
  ).toBe(
    'repositories-names at 1440 px: td.repos-prs > span.repos-group-fix > span.held-detail: a hidden copy makes it 20 px taller than what it shows, held by span (hidden) "Asks you to sign in with SSO."',
  );
  expect(
    failureLine("settings-agent", 1440, {
      measure: "room",
      element: "div.card",
      child: "p.try-next",
      by: 21,
      allowedBy: null,
    }),
  ).toBe("settings-agent at 1440 px: div.card: it ends 21 px below what it shows, held by p.try-next");
});

test("the self-test has a page for each of today's two cases, a centred hold, a taller card, a zero-tall chip on a line of its own, and one that must pass", () => {
  expect(LAYOUT_BITES.map((b) => b.fails)).toEqual(["held", "room", "room", "room", "held", null]);
});

test("the held cause's bite shows a one-line cause under the hidden one, so the hidden copy's wrapping is what fails", () => {
  const [held] = LAYOUT_BITES;
  expect(held?.html).toContain('<span class="t-small bite-cause"><span>Asks you to sign in with SSO.</span>');
});

test("an allowance nothing needed fails only a run that judged every screen", () => {
  const allowances: Allowance[] = [
    { ticket: 900, element: ".a", why: "A." },
    { ticket: 901, element: ".b > .held", why: "B." },
  ];
  expect(unneeded(new Set([0, 1]), true, allowances)).toEqual([]);
  expect(unneeded(new Set([0]), false, allowances)).toEqual([]);
  expect(unneeded(new Set([0]), true, allowances)).toEqual([
    "the allowance for #901 on .b > .held is no longer needed: remove it (scripts/proof-layout.ts)",
  ]);
  // None left, nothing to say.
  expect(unneeded(new Set(), true)).toEqual([]);
});

test("no allowance stands for a SameWidth place: its hidden labels hold no height", () => {
  expect(ALLOWANCES.filter((a) => `${a.element} ${a.child ?? ""}`.includes("same-width"))).toEqual([]);
});
