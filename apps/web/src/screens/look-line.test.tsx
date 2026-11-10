// The look line in a real DOM (ADR 0088): Check again sends the look in every state, the time to the second in
// tabular figures, the eyes reading only while a look runs, their place held otherwise, and the status line saying the
// state, but for an arrival, which its toast says once. The DOM is `withDom`'s, this file's only; the screen is imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import type { Command, InstallLook, State } from "@lookover/contracts";
import { withDom } from "../ui/dom.test-support.tsx";
import { ToastProvider } from "../ui/layers.tsx";
import { lookLine } from "../view-model/look-line.ts";
import { app, Providers, world } from "./repositories.test-support.tsx";

const dom = withDom();
const { render, act } = dom;
let screen: typeof import("./look-line.tsx");

beforeAll(async () => {
  screen = await import("./look-line.tsx");
});

/** The world with `look` as the connection's. */
function looked(look: InstallLook | null): State {
  const state = world();
  return { ...state, connection: { ...state.connection, look } };
}

/** The line on `state`, every command it sends kept in the list returned. */
async function shown(state: State): Promise<Command[]> {
  const sent: Command[] = [];
  await render(
    <Providers store={app()} state={state} send={(c) => sent.push(c)}>
      <screen.LookLine look={lookLine(state, { timeZone: "UTC" })} />
    </Providers>,
  );
  return sent;
}

const host = () => dom.host();
const checkAgain = () => {
  const button = [...host().querySelectorAll("button")].find((b) => b.textContent === "Check again");
  if (button === undefined) throw new Error("No Check again");
  return button;
};

test("Check again sends the look, idle, looking and once a look ended", async () => {
  const now = world().now;
  const running = {
    since: now,
    until: now + 180_000,
    lookedAt: null,
    ended: null,
    arrived: null,
    stopped: null,
  };
  for (const look of [null, running, { ...running, ended: now }]) {
    const sent = await shown(looked(look));
    await act(() => checkAgain().click());
    expect(sent).toEqual([{ type: "connection.look" }]);
  }
});

test("while a look runs the eyes read and the time is in tabular figures; ended, the eyes rest in the same place", async () => {
  const now = world().now;
  const running = {
    since: now,
    until: now + 180_000,
    lookedAt: now,
    ended: null,
    arrived: null,
    stopped: null,
  };
  await shown(looked(running));
  expect(host().querySelector(".look-line-said .eyes .read")).not.toBeNull();
  expect(host().querySelector(".look-line-said .clock-s")?.textContent).toMatch(/^\d\d:\d\d:\d\d$/);
  expect(host().querySelector("[role=status]")?.textContent).toBe("Looking on GitHub every few seconds.");
  await shown(
    looked({ ...running, ended: now, arrived: { accounts: ["ledger-labs"], back: [], repositories: 3 } }),
  );
  expect(host().querySelector(".look-line-said .eyes")).not.toBeNull();
  expect(host().querySelector(".look-line-said .eyes .read")).toBeNull();
  // What arrived is the toast's to say.
  expect(host().querySelector("[role=status]")?.textContent).toBe("");
});

test("an arrival is said once to a screen reader, by its toast, where the line shows it too", async () => {
  const now = world().now;
  const running = {
    since: now,
    until: now + 180_000,
    lookedAt: now,
    ended: null,
    arrived: null,
    stopped: null,
  };
  const arrived = {
    ...running,
    ended: now,
    arrived: { accounts: ["ledger-labs"], back: [], repositories: 3 },
  };
  const store = app();
  const at = (look: InstallLook) => {
    const state = looked(look);
    return render(
      <Providers store={store} state={state}>
        <ToastProvider>
          <screen.ArrivalToast />
          <screen.LookLine look={lookLine(state, { timeZone: "UTC" })} />
        </ToastProvider>
      </Providers>,
    );
  };
  await at(running);
  await at(arrived);
  const said = [...host().querySelectorAll("[role=status], [aria-live]")]
    .map((region) => region.textContent ?? "")
    .filter((text) => text.includes("arrived"));
  expect(said).toEqual(["ledger-labs arrived: 3 repositories."]);
  expect(host().querySelector(".look-line-said")?.textContent).toBe("ledger-labs arrived: 3 repositories.");
  await dom.unmount();
});

test("an arrival is toasted once, wherever the person is: not for the state the app opened on, nor said again", async () => {
  const now = world().now;
  const running = {
    since: now,
    until: now + 180_000,
    lookedAt: now,
    ended: null,
    arrived: null,
    stopped: null,
  };
  const arrived = {
    ...running,
    ended: now,
    arrived: { accounts: ["ledger-labs"], back: [], repositories: 3 },
  };
  const store = app();
  const at = (look: InstallLook | null, more: Partial<State> = {}) =>
    render(
      <Providers store={store} state={{ ...looked(look), ...more }}>
        <ToastProvider>
          <screen.ArrivalToast />
        </ToastProvider>
      </Providers>,
    );
  const toasts = () => [...host().querySelectorAll(".toast:not(.leaving)")].map((t) => t.textContent);
  // Opened on a look that had arrived already: nothing new to say.
  await at(arrived);
  expect(toasts()).toEqual([]);
  await dom.unmount();
  await at(running);
  expect(toasts()).toEqual([]);
  await at(arrived);
  expect(toasts()).toEqual(["ledger-labs arrived: 3 repositories."]);
  // The next state, the same look: said once.
  await at(arrived, { now: now + 1_000 });
  expect(toasts()).toEqual(["ledger-labs arrived: 3 repositories."]);
  await dom.unmount();
});

test("Settings' line says nothing new in its fuller form: that Lookover keeps checking, and the step", async () => {
  const now = world().now;
  await shown(looked({ since: now, until: now, lookedAt: now, ended: now, arrived: null, stopped: null }));
  expect(host().querySelector(".look-line-said")?.textContent).toBe(
    "Nothing new yet. Lookover checks every 2 minutes; on GitHub, install it and choose a repository.",
  );
});
