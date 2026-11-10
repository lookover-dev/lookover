// Notices and the alert band's lines leave (ADR 0087, design-system.md "Motion"), in a real DOM: a departed notice
// dismissed and a line of the band resolved stay, marked leaving, while their exit runs; the place that holds them
// (Repositories' notices, the band) leaves with its last one, whole.
//
// happy-dom builds no CSS animation: each test starts a long animation on the element that would run its exit
// (`dom.exiting`), as the leaving class's CSS would, and ends it by hand. The DOM is `withDom`'s, this file's only; the
// notices and the shell are imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import { type DepartedRepository, type EngineId, repositoryId, type State } from "@lookover/contracts";
import type { ReactNode } from "react";
import type { Store } from "../store.tsx";
import { withDom } from "../ui/dom.test-support.tsx";
import { app, Providers, world } from "./repositories.test-support.tsx";

const dom = withDom();
const { render, act, exiting } = dom;
let notices: (store: Store, state: State) => ReactNode;
let band: (store: Store, state: State) => ReactNode;

beforeAll(async () => {
  const { FirstPaint } = await import("../ui/presence.tsx");
  const { departedShown } = await import("../view-model/departed.ts");
  const { DepartedNotices } = await import("./departed.tsx");
  const { Alerts } = await import("../shell.tsx");
  const inApp = (store: Store, state: State, inside: ReactNode) => (
    <Providers store={store} state={state}>
      <FirstPaint>{inside}</FirstPaint>
    </Providers>
  );
  notices = (store, state) => {
    store.leftSummary.see(state);
    return inApp(
      store,
      state,
      <DepartedNotices
        shown={departedShown(state, store.leftSummary.get())}
        connection={state.connection}
        send={() => undefined}
      />,
    );
  };
  band = (store, state) => inApp(store, state, <Alerts />);
});

const departed = (owner: string, name: string): DepartedRepository => ({
  id: repositoryId(`${owner}/${name}`),
  owner,
  name,
  at: 0,
});

// ledger-labs is no account the App reaches: its repository is said in its No access notice.
const SDK = departed("ledger-labs", "ledger-sdk");
const DOCS = departed("fernhill", "docs");
const SITE = departed("fernhill", "site");

const at = (gone: DepartedRepository[]): State => ({ ...world(), departed: gone });

/** The notice whose label is `label`, or null. */
const notice = (label: string) =>
  [...dom.host().querySelectorAll<HTMLElement>(".banner")].find(
    (n) => n.querySelector(".lb")?.textContent === label,
  ) ?? null;

/** Ends an animation as the browser would at its last frame, and lets the presence hear of it. */
const end = (animation: Animation) => act(() => animation.finish());

test("a departed notice dismissed leaves, marked leaving, while the other notices stay as they are", async () => {
  const store = app();
  await render(notices(store, at([SDK, DOCS])));
  expect(notice("No access")).not.toBeNull();
  const exit = exiting(notice("Left"));

  // fernhill/docs dismissed: the state no longer holds it.
  await render(notices(store, at([SDK])));
  expect(notice("Left")?.classList.contains("leaving")).toBe(true);
  expect(notice("Left")?.hasAttribute("data-leaving")).toBe(true);
  expect(notice("No access")?.classList.contains("leaving")).toBe(false);
  expect(dom.host().querySelector(".departed")?.classList.contains("leaving")).toBe(false);

  await end(exit);
  expect(notice("Left")).toBeNull();
  expect(notice("No access")).not.toBeNull();
  await dom.unmount();
});

test("the last notice dismissed: the notices' place leaves whole, with it", async () => {
  const store = app();
  await render(notices(store, at([DOCS])));
  const exit = exiting(dom.host().querySelector(".departed"));

  await render(notices(store, at([])));
  const place = dom.host().querySelector(".departed");
  expect(place?.classList.contains("leaving")).toBe(true);
  // As it last was: its notice inside it, not leaving on its own.
  expect(notice("Left")?.classList.contains("leaving")).toBe(false);

  await end(exit);
  expect(dom.host().querySelector(".departed")).toBeNull();
  await dom.unmount();
});

test("a line dismissed from the summary leaves it, the summary kept down to one", async () => {
  const store = app();
  await render(notices(store, at([DOCS, SITE])));
  const line = () =>
    [...dom.host().querySelectorAll(".departed-list li")].find((li) => li.textContent?.includes("docs"));
  const exit = exiting(line());

  await render(notices(store, at([SITE])));
  expect(line()?.classList.contains("leaving")).toBe(true);
  await end(exit);
  expect(line()).toBeUndefined();
  expect(dom.host().querySelectorAll(".departed-list li")).toHaveLength(1);
  await dom.unmount();
});

// An account the App doesn't reach may be called `quiet`, as the summary's key once was.
const QUIET = departed("quiet", "tools");

test("an account called quiet dismissed leaves on its own, the summary beside it kept as it is", async () => {
  const store = app();
  await render(notices(store, at([QUIET, DOCS, SITE])));
  const summary = dom.host().querySelector(".departed-list")?.closest(".banner");
  expect(summary).not.toBeNull();
  const exit = exiting(notice("No access"));

  await render(notices(store, at([DOCS, SITE])));
  expect(notice("No access")?.classList.contains("leaving")).toBe(true);
  expect(dom.host().querySelector(".departed-list")?.closest(".banner")).toBe(summary);
  expect(summary?.classList.contains("leaving")).toBe(false);
  await end(exit);
  expect(notice("No access")).toBeNull();
  await dom.unmount();
});

/** The world with `ids`' AIs signed out: a line of the band each. */
const signedOut = (...ids: EngineId[]): State => {
  const state = world();
  const engines = { ...state.engines };
  for (const id of ids) engines[id] = { ...engines[id], state: "signed-out" };
  return { ...state, engines };
};

/** The band's line that names `words`, or null. */
const line = (words: string) =>
  [...dom.host().querySelectorAll<HTMLElement>(".alert")].find((l) => l.textContent?.includes(words)) ?? null;

test("a line of the band resolved leaves, the band and its other lines staying", async () => {
  const store = app();
  await render(band(store, signedOut("claude", "codex")));
  const exit = exiting(line("Codex"));

  await render(band(store, signedOut("claude")));
  expect(line("Codex")?.classList.contains("leaving")).toBe(true);
  expect(line("Claude")?.classList.contains("leaving")).toBe(false);
  expect(dom.host().querySelector(".alerts")?.classList.contains("leaving")).toBe(false);

  await end(exit);
  expect(line("Codex")).toBeNull();
  expect(line("Claude")).not.toBeNull();
  await dom.unmount();
});

test("the band's last line resolved: the band leaves whole, with it", async () => {
  const store = app();
  await render(band(store, signedOut("claude")));
  const exit = exiting(dom.host().querySelector(".alerts"));

  await render(band(store, world()));
  expect(dom.host().querySelector(".alerts")?.classList.contains("leaving")).toBe(true);
  expect(line("Claude")?.classList.contains("leaving")).toBe(false);

  await end(exit);
  expect(dom.host().querySelector(".alerts")).toBeNull();
  await dom.unmount();
});
