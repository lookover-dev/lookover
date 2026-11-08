// The state square at the start of a setup row, an AI's or Your coding agent's (design-system.md "State square"): a
// real mark in every state. Before, the icon of what is not done yet (to install, to sign in, to wait for, to fix) in
// `--ink-2` with no tile behind it, so it reads as a state and never as a control (an empty tile, a ring and a dot on
// a grey tile each read as disabled); the eyes while waiting; a check once done; the again arrow when something else
// is there; a cross once a write was refused. No state draws a tile (round 5; system.test.ts pins the CSS). Each icon is pinned by its own drawing, written out here, so a mark
// swapped for another icon fails.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StateSquare, SubStep } from "./common.tsx";

const square = (state: Parameters<typeof StateSquare>[0]["state"]) =>
  renderToStaticMarkup(<StateSquare state={state} />);

const CHECK = 'd="M3 8.5l3 3 7-7"';
const AGAIN = 'd="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6"';
const CROSS = 'd="M4 4l8 8M12 4l-8 8"';
const INSTALL = 'd="M8 2.5v7.5M4.5 6.5L8 10l3.5-3.5M3 13.5h10"';
const SIGN_IN =
  'd="M9.5 2.5H12a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9.5M2.5 8h7.5M7 4.5L10.5 8 7 11.5"';
const TIME = 'd="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 5v3.5l2 1.5"';
const ALERT = 'd="M8 4.75v3.75M8 11.25v.01"';

test("before, the icon of what is not done yet in a square of the todo class, no dot, no ring", () => {
  for (const [state, drawing] of [
    ["install", INSTALL],
    ["sign-in", SIGN_IN],
    ["wait", TIME],
    ["fix", ALERT],
  ] as const) {
    const html = square(state);
    expect(html).toStartWith('<span class="lg todo">');
    expect(html).toContain(drawing);
    expect(html.match(/<path /g)?.length).toBe(1);
    expect(html).not.toContain("state-dot");
    expect(html).not.toContain("state-ring");
  }
});

test("done draws the check, stale the again arrow, refused the cross, each in a square of its class", () => {
  expect(square("done")).toStartWith('<span class="lg done">');
  expect(square("done")).toContain(CHECK);
  expect(square("stale")).toStartWith('<span class="lg stale">');
  expect(square("stale")).toContain(AGAIN);
  expect(square("refused")).toStartWith('<span class="lg refused">');
  expect(square("refused")).toContain(CROSS);
  for (const state of ["done", "stale", "refused"] as const)
    expect(square(state).match(/<path /g)?.length).toBe(1);
});

test("waiting draws the eyes, no icon", () => {
  expect(square("busy")).toStartWith('<span class="lg busy">');
  expect(square("busy")).toContain('class="eyes');
  expect(square("busy")).not.toContain("<path ");
});

test("a sub-step's square, title, detail and action are its own grid's items, what it holds below last (round 6)", () => {
  const html = renderToStaticMarkup(
    <SubStep
      state="current"
      todo="sign-in"
      title="Sign in"
      action={<button type="button">Go</button>}
      below="list"
    >
      Detail
    </SubStep>,
  );
  expect(html).toMatch(
    /^<div class="engine substep current mark-sign-in"><span class="lg todo">.*?<\/span><b>Sign in<\/b><span class="substep-detail">Detail<\/span><div class="substep-act"><button type="button">Go<\/button><\/div><div class="substep-below">list<\/div><\/div>$/,
  );
  // With no action, no place for one.
  const none = renderToStaticMarkup(
    <SubStep state="done" todo="install" title="Accounts">
      Detail
    </SubStep>,
  );
  expect(none).not.toContain("substep-act");
});
