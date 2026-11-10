// Every link to GitHub's install page or an installation's settings starts a look as its tab opens (ADR 0088), in a
// real DOM, its commands to a fake `send`: the accounts list's fixes, the band's and the status menu's, Repositories'
// Add a repository; Ask to install sends its ask alone. While the look runs, a link fix in the band and the menu says
// "Looking…" in its place, the place as wide as the fix either way. The DOM is `withDom`'s, this file's only; the
// screens are imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import type { Command, InstallLook, State } from "@lookover/contracts";
import type { ReactNode } from "react";
import { withDom } from "../ui/dom.test-support.tsx";
import { accountRows } from "../view-model/accounts.ts";
import { RepositoriesChoice } from "../view-model/repositories.ts";
import { problems } from "../view-model/select.ts";
import { app, Providers, world } from "./repositories.test-support.tsx";

const dom = withDom();
const { render, act } = dom;
let screens: typeof import("./github-app.tsx");
let settings: typeof import("./settings.tsx");

beforeAll(async () => {
  screens = await import("./github-app.tsx");
  settings = await import("./settings.tsx");
});

const LOOK = { type: "connection.look" } as const;

/** `node` on `state`, every command it sends kept in `sent`. */
async function shown(state: State, node: () => ReactNode): Promise<Command[]> {
  const sent: Command[] = [];
  await render(
    <Providers store={app()} state={state} send={(c) => sent.push(c)}>
      {node()}
    </Providers>,
  );
  return sent;
}

/** The link named `label` that shows: never a place's floor, hidden, that only holds its width. */
function link(label: string): HTMLAnchorElement {
  const found = [...dom.host().querySelectorAll<HTMLAnchorElement>("a")].filter(
    (a) =>
      a.textContent?.includes(label) && a.closest(".account-action-floor, [aria-hidden='true']") === null,
  );
  const [only] = found;
  if (only === undefined || found.length !== 1) throw new Error(`${found.length} shown links say ${label}`);
  return only;
}

/** A click as the person gives it: the browser would open the tab; happy-dom's anchor goes nowhere. */
const click = (a: HTMLAnchorElement) =>
  act(() => {
    a.addEventListener("click", (e) => e.preventDefault(), { once: true });
    a.click();
  });

/**
 * The world with ledger-labs, which the person owns, and ledger-hq, a member's, both not installed; and ledger-ops,
 * installed with no repository chosen yet.
 */
function notInstalled(): State {
  const state = world();
  return {
    ...state,
    connection: {
      ...state.connection,
      accounts: [
        ...state.connection.accounts,
        {
          account: { id: 33, login: "ledger-ops", type: "Organization" },
          installationId: 43,
          cause: null,
          owner: true,
        },
      ],
      unreached: [
        { account: { id: 31, login: "ledger-labs" }, kind: "organisation", owner: true, askedAt: null },
        { account: { id: 32, login: "ledger-hq" }, kind: "organisation", owner: false, askedAt: null },
      ],
    },
  };
}

test("the accounts list's fixes start the look as GitHub's page opens; Ask to install sends its ask alone", async () => {
  const state = notInstalled();
  const sent = await shown(state, () => (
    <screens.AccountsList list={accountRows(state, { timeZone: "UTC" })} />
  ));
  await click(link("Choose repositories"));
  await click(link("Install on ledger-labs"));
  await click(link("Install on another account"));
  await click(link("Ask to install on ledger-hq"));
  expect(sent).toEqual([LOOK, LOOK, LOOK, { type: "connection.askToInstall", account: "ledger-hq" }]);
  await dom.unmount();
});

test("Repositories' Add a repository starts the look as GitHub's page opens", async () => {
  const sent = await shown(world(), () => <settings.RepositoriesOn choice={new RepositoriesChoice()} />);
  await click(link("Add a repository"));
  expect(sent).toEqual([LOOK]);
  await dom.unmount();
});

test("Repositories' foot ends on the look line, its Check again sending the look, the table and its line above it", async () => {
  const state = world();
  const running = {
    since: state.now,
    until: state.now + 180_000,
    lookedAt: null,
    ended: null,
    arrived: null,
    stopped: null,
  };
  const arrived = { ...running, ended: state.now, arrived: { accounts: [], back: [], repositories: 1 } };
  const said = [
    [null, "Lookover checks GitHub every 2 minutes."],
    [running, "Looking on GitHub every few seconds."],
    [arrived, "1 repository arrived."],
  ] as const;
  for (const [look, words] of said) {
    const sent = await shown({ ...state, connection: { ...state.connection, look } }, () => (
      <settings.RepositoriesOn choice={new RepositoriesChoice()} />
    ));
    const foot = dom.host().querySelector(".foot");
    expect(foot?.textContent).toStartWith("Signed in to GitHub as sasensi");
    const line = foot?.querySelector(".look-line");
    expect(line?.textContent).toContain(words);
    // Last on the page: nothing it says moves what is above it.
    expect(
      dom
        .host()
        .querySelector("main > :last-child")
        ?.contains(line ?? null),
    ).toBe(true);
    await act(() =>
      [...(line?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Check again")?.click(),
    );
    expect(sent).toEqual([LOOK]);
    await dom.unmount();
  }
});

/** Installed on none of the person's accounts any more, with a look running (`ended` null) or not. */
function uninstalled(look: Pick<InstallLook, "ended"> | null): State {
  const state = world();
  return {
    ...state,
    connection: {
      ...state.connection,
      state: "disconnected",
      cause: { kind: "uninstalled", suspended: false },
      accounts: [],
      unreached: [{ account: { id: 1, login: "sasensi" }, kind: "user", owner: true, askedAt: null }],
      look:
        look === null
          ? null
          : {
              since: state.now - 10_000,
              until: state.now + 170_000,
              lookedAt: state.now - 2_000,
              arrived: null,
              stopped: null,
              ...look,
            },
    },
  };
}

/** The band's or the menu's fix of the state's one problem. */
const fix = (state: State) => {
  const [problem] = problems(state);
  if (problem === undefined) throw new Error("no problem");
  return <screens.FixButton problem={problem} busyLabel="Waiting…" />;
};

/** The fix's place: what it shows and what it holds hidden. */
function place() {
  const slots = [...dom.host().querySelectorAll<HTMLElement>(".same-width-slot")];
  const seen = slots.filter((s) => s.getAttribute("aria-hidden") !== "true");
  return {
    slots: slots.length,
    seen: seen.map((s) => s.textContent),
    status: dom.host().querySelector("[role='status']")?.textContent,
  };
}

test("the band's link fix starts the look as GitHub's page opens, then says Looking… in its place until the look ends", async () => {
  const sent = await shown(uninstalled(null), () => fix(uninstalled(null)));
  expect(place()).toEqual({ slots: 2, seen: ["Install on sasensi"], status: "" });
  await click(link("Install on sasensi"));
  expect(sent).toEqual([LOOK]);
  // The look runs: Looking… with the reading eyes, the fix held hidden beside it so the place keeps its width.
  const running = uninstalled({ ended: null });
  await shown(running, () => fix(running));
  expect(place()).toEqual({ slots: 2, seen: ["Looking…"], status: "Looking…" });
  expect(dom.host().querySelector(".busy-status[data-tone='run'] .eyes")).not.toBeNull();
  expect(() => link("Install on sasensi")).toThrow("0 shown links");
  // Ended with nothing new: the fix again.
  const ended = uninstalled({ ended: running.now });
  await shown(ended, () => fix(ended));
  expect(place()).toEqual({ slots: 2, seen: ["Install on sasensi"], status: "" });
  await dom.unmount();
});

test("a fix pressed from the keyboard hands its focus to Looking… in its place, and Looking… back to the fix", async () => {
  await shown(uninstalled(null), () => fix(uninstalled(null)));
  const install = link("Install on sasensi");
  install.focus();
  // Enter on it: the look runs, the link hidden; the focus stays in the place, never dropped to the page.
  const running = uninstalled({ ended: null });
  await shown(running, () => fix(running));
  const status = dom.host().querySelector<HTMLElement>(".busy-status");
  expect(document.activeElement).toBe(status);
  expect(status?.tabIndex).toBe(-1);
  // Ended: the fix again, focused as it was.
  const ended = uninstalled({ ended: running.now });
  await shown(ended, () => fix(ended));
  expect(document.activeElement).toBe(install);
  await dom.unmount();
});

test("a look that starts while the focus is elsewhere leaves it there", async () => {
  await shown(uninstalled(null), () => fix(uninstalled(null)));
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  elsewhere.focus();
  const running = uninstalled({ ended: null });
  await shown(running, () => fix(running));
  expect(document.activeElement).toBe(elsewhere);
  elsewhere.remove();
  await dom.unmount();
});

test("a fix that installs nothing never says Looking…: SSO's page opens with nothing sent, whatever the look", async () => {
  const running = uninstalled({ ended: null });
  const sso: State = {
    ...running,
    connection: { ...running.connection, cause: { kind: "sso", organisation: "ledger-dev", url: null } },
  };
  const sent = await shown(sso, () => fix(sso));
  expect(place().slots).toBe(0);
  await click(link("Sign in with SSO"));
  expect(sent).toEqual([]);
  await dom.unmount();
});
