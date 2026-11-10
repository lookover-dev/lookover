// Home's rows leave and arrive (ADR 0087, design-system.md "Motion"), in a real DOM: a review that moved to another
// section leaves the old one through the presence and arrives in the new one as a new row does; the section of the
// last row to leave goes with it, as it last was; one that comes back while it leaves plays its entry again; a search
// or a change of scope swaps rows with no motion at all; j and k skip what leaves.
//
// happy-dom builds no CSS animation: each test starts a long animation on the element that would run its exit
// (`dom.exiting`), as the leaving class's CSS would, and ends it by hand. The DOM is `withDom`'s, this file's only; Home
// and the shell are imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import {
  type Change,
  changeId,
  commitSha,
  emptyReview,
  jobId,
  type Review,
  type ReviewJob,
  repositoryId,
  runId,
  type State,
} from "@lookover/contracts";
import type { ReactNode } from "react";
import type { Store } from "../store.tsx";
import { withDom } from "../ui/dom.test-support.tsx";
import { app, Providers, world } from "./repositories.test-support.tsx";

const dom = withDom();
const { render, act, exiting } = dom;
let home: (store: Store, state: State) => ReactNode;

beforeAll(async () => {
  const { FirstPaint } = await import("../ui/presence.tsx");
  const { Home } = await import("./home.tsx");
  const { useGlobalKeys } = await import("../shell.tsx");
  // The app's global keys, as the shell registers them around every screen.
  const Keys = () => {
    useGlobalKeys(
      () => undefined,
      () => undefined,
    );
    return null;
  };
  // The app's tree around Home: the gate is passed once its first commit is on the page, as in the app.
  home = (store, state) => (
    <Providers store={store} state={state}>
      <FirstPaint>
        <Keys />
        <Home />
      </FirstPaint>
    </Providers>
  );
});

const SHA = commitSha("a1f9c2e");
const MIN = 60_000;

/** Where a review stands: running now, waiting in the queue, or done and settled a few minutes ago (Earlier today). */
type Stands = "running" | "queued" | "settled";

function reviewOf(id: Change["id"], stands: Stands, at: number): Review {
  const job = (state: ReviewJob["state"]): ReviewJob => ({
    id: jobId(`job-${id}`),
    sha: SHA,
    trigger: "opened",
    state,
    deferral: null,
    stepIn: null,
    askedBy: null,
    skip: null,
    cancel: null,
    failure: null,
    turn: null,
  });
  const base = emptyReview(id, at);
  if (stands === "queued") return { ...base, job: job("queued") };
  if (stands === "running")
    return {
      ...base,
      job: job("running"),
      run: {
        id: runId(`run-${id}`),
        reviewer: "claude",
        secondFinder: null,
        confirmer: null,
        confirmFallback: null,
        sha: SHA,
        preview: false,
        startedAt: at - MIN,
        step: "finding",
        stepAt: at,
        steps: [],
        activities: [],
        posting: null,
      },
    };
  const round = {
    n: 1,
    sha: SHA,
    base: null,
    reviewer: "claude" as const,
    secondFind: null,
    confirmer: null,
    confirmFallback: null,
    confirmFailure: null,
    ruledOut: [],
    startedAt: at - 3 * MIN,
    endedAt: at,
    raised: 0,
    verifiedFixed: 0,
    open: 0,
    steps: [],
    sessions: [],
  };
  return { ...base, job: job("done"), loop: "settled", rounds: [round] };
}

/** The world with pull requests `n` of sasensi/ledger-api, each standing as given; `other` marks one of another's. */
function withReviews(reviews: Record<number, Stands | { stands: Stands; other: true }>): State {
  const base = world();
  const state: State = { ...base, changes: {}, reviews: {} };
  for (const [n, how] of Object.entries(reviews)) {
    const { stands, other } = typeof how === "string" ? { stands: how, other: false } : how;
    const id = changeId(`sasensi/ledger-api#${n}`);
    state.changes[id] = {
      id,
      repoId: repositoryId("sasensi/ledger-api"),
      number: Number(n),
      title: `Change ${n}`,
      openedBy: other ? "someone" : "sasensi",
      author: other ? "other" : "you",
      writtenBy: null,
      headSha: SHA,
      openedAt: base.now - 60 * MIN,
      draft: false,
      fork: false,
      newCommits: 0,
    };
    state.reviews[id] = reviewOf(id, stands, base.now - 5 * MIN);
  }
  return state;
}

/** A section of Home by its title, or null. */
const section = (title: string) =>
  [...dom.host().querySelectorAll<HTMLElement>("section.grp")].find(
    (s) => s.querySelector("h4")?.textContent === title,
  ) ?? null;

/** The row of pull request `n` in `title`'s section, or null. */
const rowIn = (title: string, n: number) =>
  [...(section(title)?.querySelectorAll<HTMLElement>(".rowi") ?? [])].find(
    (r) => r.querySelector(".ti")?.textContent === `Change ${n}`,
  ) ?? null;

/** Ends an animation as the browser would at its last frame, and lets the presence hear of it. */
const end = (animation: Animation) => act(() => animation.finish());

test("a review moving sections leaves its old section, marked leaving, and arrives in the new one as a new row", async () => {
  const store = app();
  await render(home(store, withReviews({ 1: "running", 2: "running" })));
  // There from the first paint: still.
  expect(rowIn("Reviewing now", 1)?.classList.contains("new")).toBe(false);
  const exit = exiting(rowIn("Reviewing now", 1));

  await render(home(store, withReviews({ 1: "settled", 2: "running" })));
  const leaving = rowIn("Reviewing now", 1);
  expect(leaving?.classList.contains("leaving")).toBe(true);
  expect(leaving?.hasAttribute("data-leaving")).toBe(true);
  expect(leaving?.hasAttribute("inert")).toBe(true);
  expect(leaving?.getAttribute("aria-hidden")).toBe("true");
  expect(rowIn("Reviewing now", 2)?.classList.contains("leaving")).toBe(false);
  const arrived = rowIn("Earlier today", 1);
  expect(arrived?.classList.contains("new")).toBe(true);
  expect(arrived?.hasAttribute("data-arrived")).toBe(true);
  expect(arrived?.classList.contains("leaving")).toBe(false);

  await end(exit);
  expect(rowIn("Reviewing now", 1)).toBeNull();
  expect(rowIn("Reviewing now", 2)).not.toBeNull();
  // The next render keeps the row that arrived as it is: it rose in once.
  await render(home(store, withReviews({ 1: "settled", 2: "running" })));
  expect(rowIn("Earlier today", 1)).not.toBeNull();
  await dom.unmount();
});

test("the section whose last row leaves goes with it, and its row is not marked on its own", async () => {
  const store = app();
  await render(home(store, withReviews({ 1: "running", 2: "settled" })));
  const exit = exiting(section("Reviewing now"));

  await render(home(store, withReviews({ 1: "settled", 2: "settled" })));
  const gone = section("Reviewing now");
  expect(gone?.classList.contains("leaving")).toBe(true);
  expect(gone?.hasAttribute("data-leaving")).toBe(true);
  expect(gone?.hasAttribute("inert")).toBe(true);
  expect(gone?.getAttribute("aria-hidden")).toBe("true");
  // The section leaves whole, as it last was: its row inside it, not leaving on its own.
  expect(rowIn("Reviewing now", 1)?.classList.contains("leaving")).toBe(false);
  expect(rowIn("Earlier today", 1)?.classList.contains("new")).toBe(true);

  await end(exit);
  expect(section("Reviewing now")).toBeNull();
  await dom.unmount();
});

test("a review that comes straight back while it leaves is the same row, and plays its entry again", async () => {
  const store = app();
  await render(home(store, withReviews({ 1: "running", 2: "running" })));
  const first = rowIn("Reviewing now", 1);
  // There from the first paint: no entry yet.
  expect(first?.hasAttribute("data-arrived")).toBe(false);
  const exit = exiting(first);

  await render(home(store, withReviews({ 1: "settled", 2: "running" })));
  expect(rowIn("Reviewing now", 1)?.classList.contains("leaving")).toBe(true);
  const away = exiting(rowIn("Earlier today", 1));

  await render(home(store, withReviews({ 1: "running", 2: "running" })));
  const back = rowIn("Reviewing now", 1);
  expect(back).toBe(first);
  expect(back?.classList.contains("leaving")).toBe(false);
  expect(back?.hasAttribute("inert")).toBe(false);
  expect(back?.classList.contains("new")).toBe(true);
  expect(back?.hasAttribute("data-arrived")).toBe(true);
  exit.finish();
  await end(away);
  expect(rowIn("Earlier today", 1)).toBeNull();
  await dom.unmount();
});

test("a section that comes straight back while it leaves is the same section, and plays its entry again", async () => {
  const store = app();
  await render(home(store, withReviews({ 1: "running", 2: "settled" })));
  const first = section("Reviewing now");
  expect(first?.hasAttribute("data-arrived")).toBe(false);
  const exit = exiting(first);

  await render(home(store, withReviews({ 1: "settled", 2: "settled" })));
  expect(section("Reviewing now")?.classList.contains("leaving")).toBe(true);
  const away = exiting(rowIn("Earlier today", 1));

  await render(home(store, withReviews({ 1: "running", 2: "settled" })));
  const back = section("Reviewing now");
  expect(back).toBe(first);
  expect(back?.classList.contains("leaving")).toBe(false);
  expect(back?.classList.contains("new")).toBe(true);
  expect(back?.hasAttribute("data-arrived")).toBe(true);
  exit.finish();
  await end(away);
  await dom.unmount();
});

test("Earlier today leaving whole keeps its search, as it last was, so its rows stay where they were", async () => {
  const store = app();
  const five = { 1: "settled", 2: "settled", 3: "settled", 4: "settled", 5: "settled" } as const;
  await render(home(store, withReviews(five)));
  const exit = exiting(section("Earlier today"));

  await render(
    home(store, withReviews({ 1: "running", 2: "running", 3: "running", 4: "running", 5: "running" })),
  );
  const gone = section("Earlier today");
  expect(gone?.classList.contains("leaving")).toBe(true);
  expect(gone?.querySelector(`input[aria-label="Search today's reviews"]`)).not.toBeNull();
  await end(exit);
  expect(section("Earlier today")).toBeNull();
  await dom.unmount();
});

test("j and k move the focus over the rows that stay, never onto a leaving copy", async () => {
  const store = app();
  await render(home(store, withReviews({ 1: "running", 2: "running" })));
  const exit = exiting(rowIn("Reviewing now", 1));

  await render(home(store, withReviews({ 1: "settled", 2: "running" })));
  expect(rowIn("Reviewing now", 1)?.classList.contains("leaving")).toBe(true);
  const press = (key: string) => act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key })));
  await press("j");
  expect(document.activeElement).toBe(rowIn("Reviewing now", 2));
  await press("j");
  expect(document.activeElement).toBe(rowIn("Earlier today", 1));
  await press("k");
  expect(document.activeElement).toBe(rowIn("Reviewing now", 2));
  await press("k");
  expect(document.activeElement).toBe(rowIn("Reviewing now", 2));
  await end(exit);
  await dom.unmount();
});

test("a change of scope adds and removes rows with no motion: none arrives new, none is kept leaving", async () => {
  const store = app();
  await render(home(store, withReviews({ 1: "running", 2: { stands: "running", other: true } })));
  expect(rowIn("Reviewing now", 2)).toBeNull();

  await act(() => store.scope.choose("everyone"));
  const theirs = rowIn("Reviewing now", 2);
  expect(theirs).not.toBeNull();
  expect(theirs?.classList.contains("new")).toBe(false);
  const exit = exiting(theirs);

  await act(() => store.scope.choose("mine"));
  expect(rowIn("Reviewing now", 2)).toBeNull();
  expect(dom.host().querySelector("[data-leaving]")).toBeNull();
  exit.finish();
  await dom.unmount();
});

test("a search swaps Earlier today's rows with no motion, and a world change after it moves again", async () => {
  const store = app();
  const five = { 1: "settled", 2: "settled", 3: "settled", 4: "settled", 5: "settled" } as const;
  await render(home(store, withReviews(five)));
  const exit = exiting(rowIn("Earlier today", 1));

  const search = dom.host().querySelector<HTMLInputElement>('input[aria-label="Search today\'s reviews"]');
  if (!search) throw new Error("no search");
  const type = (words: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, words);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await type("Change 2");
  expect(rowIn("Earlier today", 1)).toBeNull();
  expect(dom.host().querySelector("[data-leaving]")).toBeNull();
  exit.finish();

  // Cleared: the rows come back as they were, none new.
  await type("");
  expect(rowIn("Earlier today", 1)?.classList.contains("new")).toBe(false);

  // A review that starts again moves: it leaves Earlier today and arrives in Reviewing now.
  const again = exiting(rowIn("Earlier today", 3));
  await render(home(store, withReviews({ ...five, 3: "running" })));
  expect(rowIn("Earlier today", 3)?.classList.contains("leaving")).toBe(true);
  expect(rowIn("Reviewing now", 3)?.classList.contains("new")).toBe(true);
  await end(again);
  expect(rowIn("Earlier today", 3)).toBeNull();
  await dom.unmount();
});

const six = { 1: "settled", 2: "settled", 3: "settled", 4: "settled", 5: "settled", 6: "settled" } as const;

/** Types `words` into Earlier today's search, as the person would. */
const typeInSearch = (words: string) =>
  act(() => {
    const search = dom.host().querySelector<HTMLInputElement>('input[aria-label="Search today\'s reviews"]');
    if (!search) throw new Error("no search");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, words);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });

/** Whether Earlier today says its search keeps nothing. */
const saysNothing = () =>
  [...(section("Earlier today")?.querySelectorAll("p") ?? [])].some((p) =>
    p.textContent?.startsWith("Nothing from today matches"),
  );

test("the world taking a search's last match away plays its exit, and only then says nothing matches", async () => {
  const store = app();
  await render(home(store, withReviews(six)));
  await typeInSearch("Change 2");
  expect(rowIn("Earlier today", 2)).not.toBeNull();
  const exit = exiting(rowIn("Earlier today", 2));

  // The review starts again: Earlier today keeps five reviews, none of them a match. The match leaves with its exit.
  await render(home(store, withReviews({ ...six, 2: "running" })));
  const leaving = rowIn("Earlier today", 2);
  expect(leaving?.classList.contains("leaving")).toBe(true);
  expect(leaving?.hasAttribute("data-leaving")).toBe(true);
  expect(rowIn("Reviewing now", 2)?.classList.contains("new")).toBe(true);
  // The message waits for the row to have gone, so the two never stand together.
  expect(saysNothing()).toBe(false);

  await end(exit);
  expect(rowIn("Earlier today", 2)).toBeNull();
  expect(saysNothing()).toBe(true);
  expect(section("Earlier today")?.querySelector(".list")).toBeNull();
  await dom.unmount();
});

test("a search of the person's own that keeps no match says so at once, with nothing leaving", async () => {
  const store = app();
  await render(home(store, withReviews(six)));
  const exit = exiting(rowIn("Earlier today", 1));
  await typeInSearch("nowhere");
  expect(dom.host().querySelector("[data-leaving]")).toBeNull();
  expect(section("Earlier today")?.querySelector(".list")).toBeNull();
  expect(section("Earlier today")?.textContent).toContain("Nothing from today matches “nowhere”.");
  await end(exit);
  await dom.unmount();
});

/** The world of `withReviews`, each review last moved at the minute given (higher is newer: Home lists it first). */
function movedAt(reviews: Record<number, Stands>, minutes: Record<number, number>): State {
  const state = withReviews(reviews);
  for (const [n, minute] of Object.entries(minutes)) {
    const review = state.reviews[changeId(`sasensi/ledger-api#${n}`)];
    if (review) review.updatedAt = state.now - 30 * MIN + minute * MIN;
  }
  return state;
}

/** The pull requests of `title`'s section, in the order the page shows them. */
const order = (title: string) =>
  [...(section(title)?.querySelectorAll<HTMLElement>(".rowi") ?? [])].map(
    (r) => r.querySelector(".ti")?.textContent,
  );

test("a row that arrived plays its entry once: moved in the page after it, it rises in no more", async () => {
  const entry = dom.entries(".rowi.new[data-arrived]");
  const store = app();
  await render(home(store, movedAt({ 1: "running" }, { 1: 1 })));
  // A second review starts after the page painted: it arrives on top, and rises in.
  await render(home(store, movedAt({ 1: "running", 2: "running" }, { 1: 1, 2: 2 })));
  const arrived = rowIn("Reviewing now", 2);
  expect(order("Reviewing now")).toEqual(["Change 2", "Change 1"]);
  expect(arrived?.classList.contains("new")).toBe(true);
  await end(entry(arrived));
  expect(arrived?.classList.contains("new")).toBe(false);

  // The older one takes a step: it goes on top, and React moves the other row's element. It carries no entry.
  await render(home(store, movedAt({ 1: "running", 2: "running" }, { 1: 3, 2: 2 })));
  expect(order("Reviewing now")).toEqual(["Change 1", "Change 2"]);
  expect(rowIn("Reviewing now", 2)).toBe(arrived);
  expect(arrived?.classList.contains("new")).toBe(false);
  expect(() => entry(arrived)).toThrow("it runs no entry");
  await dom.unmount();
});

test("an entry cancelled before its end is over too: the row keeps no entry to replay", async () => {
  const entry = dom.entries(".rowi.new[data-arrived]");
  const store = app();
  await render(home(store, movedAt({ 1: "running" }, { 1: 1 })));
  await render(home(store, movedAt({ 1: "running", 2: "running" }, { 1: 1, 2: 2 })));
  const arrived = rowIn("Reviewing now", 2);
  await act(() => entry(arrived).cancel());
  expect(arrived?.classList.contains("new")).toBe(false);
  await dom.unmount();
});

test("a section that arrived fades in once: after its entry it carries none", async () => {
  const entry = dom.entries(".grp.new[data-arrived]");
  const store = app();
  await render(home(store, movedAt({ 1: "settled" }, { 1: 1 })));
  await render(home(store, movedAt({ 1: "settled", 2: "running" }, { 1: 1, 2: 2 })));
  const arrived = section("Reviewing now");
  expect(arrived?.classList.contains("new")).toBe(true);
  await end(entry(arrived));
  expect(arrived?.classList.contains("new")).toBe(false);
  await dom.unmount();
});

test("a row whose entry ended plays it again when it comes back while leaving", async () => {
  const entry = dom.entries(".rowi.new[data-arrived]");
  const store = app();
  await render(home(store, movedAt({ 1: "running" }, { 1: 1 })));
  await render(home(store, movedAt({ 1: "running", 2: "running" }, { 1: 1, 2: 2 })));
  const arrived = rowIn("Reviewing now", 2);
  await end(entry(arrived));
  const exit = exiting(arrived);

  await render(home(store, movedAt({ 1: "running", 2: "settled" }, { 1: 1, 2: 2 })));
  expect(arrived?.classList.contains("leaving")).toBe(true);
  const away = exiting(rowIn("Earlier today", 2));
  await render(home(store, movedAt({ 1: "running", 2: "running" }, { 1: 1, 2: 2 })));
  expect(rowIn("Reviewing now", 2)).toBe(arrived);
  expect(arrived?.classList.contains("new")).toBe(true);
  expect(entry(arrived).playState).toBe("running");
  exit.finish();
  await end(away);
  await dom.unmount();
});
