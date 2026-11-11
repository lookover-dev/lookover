// The accounts list's rows arrive with motion (ADR 0087, design-system.md "Motion"), in a real DOM: an account that
// comes after the list first painted (installed elsewhere, an owner's approval) is marked `new` and `data-arrived`,
// which its CSS entry is keyed on, and plays it once; the rows the list opened with are still; the person's own row
// is one row whatever it says; a row that moves while focus is in it hands focus on. Reduced motion is the
// stylesheet's one global rule (`styles/system.test.ts`), which happy-dom doesn't run.
//
// happy-dom builds no CSS animation: `dom.entries` stands in for the stylesheet's entry rule, as on Home. The DOM is
// `withDom`'s, this file's only; the list is imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import type { State } from "@lookover/contracts";
import type { ReactNode } from "react";
import type { Store } from "../store.tsx";
import { withDom } from "../ui/dom.test-support.tsx";
import { accountRows } from "../view-model/accounts.ts";
import { app, Providers, repo, world } from "./repositories.test-support.tsx";

const dom = withDom();
const { render, act } = dom;
let list: (store: Store, state: State) => ReactNode;

beforeAll(async () => {
  const { AccountsList } = await import("./github-app.tsx");
  list = (store, state) => (
    <Providers store={store} state={state}>
      <AccountsList list={accountRows(state, { timeZone: "UTC" })} />
    </Providers>
  );
});

/** The world, with ledger-labs (an organisation the person owns) installed on too when `installed`. */
function accounts(installed: boolean): State {
  const state = world();
  const unreached = [
    { account: { id: 31, login: "ledger-labs" }, kind: "organisation" as const, owner: true, askedAt: null },
  ];
  if (!installed) return { ...state, connection: { ...state.connection, unreached } };
  return {
    ...state,
    connection: {
      ...state.connection,
      unreached: [],
      accounts: [
        ...state.connection.accounts,
        {
          account: { id: 31, login: "ledger-labs", type: "Organization" },
          installationId: 41,
          cause: null,
          owner: true,
          granted: [],
        },
      ],
    },
  };
}

/** The row of `login` in the list, or null. */
const rowOf = (login: string) =>
  [...dom.host().querySelectorAll<HTMLElement>(".account-row")].find(
    (r) => r.querySelector(".account-name b")?.textContent === login,
  ) ?? null;

test("the rows the list first painted with are still: none is new, none arrived", async () => {
  const entry = dom.entries(".account-row.new[data-arrived]");
  await render(list(app(), accounts(true)));
  for (const row of dom.host().querySelectorAll(".account-row")) {
    expect(row.classList.contains("new")).toBe(false);
    expect(row.hasAttribute("data-arrived")).toBe(false);
    expect(() => entry(row)).toThrow("it runs no entry");
  }
  await dom.unmount();
});

test("an account installed after the list painted arrives: its row plays its entry once, the others none", async () => {
  const entry = dom.entries(".account-row.new[data-arrived]");
  const store = app();
  const before = world();
  await render(list(store, before));
  const own = rowOf("sasensi");
  await render(list(store, accounts(true)));
  const arrived = rowOf("ledger-labs");
  expect(arrived?.classList.contains("new")).toBe(true);
  expect(arrived?.hasAttribute("data-arrived")).toBe(true);
  expect(rowOf("sasensi")).toBe(own);
  expect(own?.classList.contains("new")).toBe(false);
  await act(() => entry(arrived).finish());
  expect(arrived?.classList.contains("new")).toBe(false);
  expect(() => entry(arrived)).toThrow("it runs no entry");
  await dom.unmount();
});

test("a row changing state in its part of the list changes in place: suspended, it is the same row, not new", async () => {
  dom.entries(".account-row.new[data-arrived]");
  const store = app();
  const installed = accounts(true);
  await render(list(store, installed));
  const row = rowOf("ledger-labs");
  const suspended: State = {
    ...installed,
    connection: {
      ...installed.connection,
      accounts: installed.connection.accounts.map((a) =>
        a.account.login === "ledger-labs"
          ? { ...a, cause: { kind: "uninstalled", suspended: true, suspendedBy: "mira" } }
          : a,
      ),
    },
  };
  await render(list(store, suspended));
  expect(rowOf("ledger-labs")).toBe(row);
  expect(row?.getAttribute("data-state")).toBe("needs-you");
  expect(row?.classList.contains("new")).toBe(false);
  await dom.unmount();
});

test("an account the person owns, installed after it was listed not installed, arrives in the reached part", async () => {
  dom.entries(".account-row.new[data-arrived]");
  const store = app();
  await render(list(store, accounts(false)));
  const before = rowOf("ledger-labs");
  await render(list(store, accounts(true)));
  const arrived = rowOf("ledger-labs");
  expect(arrived).not.toBe(before);
  expect(arrived?.classList.contains("new")).toBe(true);
  await dom.unmount();
});

test("an account an owner approves arrives in the reached part, where it now shows, as a new row", async () => {
  const entry = dom.entries(".account-row.new[data-arrived]");
  const store = app();
  const asked = world();
  const waiting = {
    ...asked,
    connection: {
      ...asked.connection,
      unreached: [
        {
          account: { id: 32, login: "ledger-hq" },
          kind: "organisation" as const,
          owner: false,
          askedAt: asked.now,
        },
      ],
    },
  };
  await render(list(store, waiting));
  const before = rowOf("ledger-hq");
  expect(before?.getAttribute("data-state")).toBe("waiting");
  const approved = {
    ...asked,
    connection: {
      ...asked.connection,
      accounts: [
        ...asked.connection.accounts,
        {
          account: { id: 32, login: "ledger-hq", type: "Organization" as const },
          installationId: 42,
          cause: null,
          owner: false,
          granted: [],
        },
      ],
    },
  };
  await render(list(store, approved));
  const arrived = rowOf("ledger-hq");
  expect(arrived).not.toBe(before);
  expect(arrived?.classList.contains("new")).toBe(true);
  expect(arrived?.hasAttribute("data-arrived")).toBe(true);
  expect(entry(arrived).playState).toBe("running");
  // Only the one row: the waiting one went at once, none is kept leaving beside it.
  expect(dom.host().querySelectorAll(".account-row")).toHaveLength(4);
  expect(dom.host().querySelectorAll(".account-row.leaving")).toHaveLength(0);
  await dom.unmount();
});

/** The world with the person's accounts not listed yet (their own row looking), or listed with none installed. */
function own(listed: boolean): State {
  const state = world();
  const unreached = [
    { account: { id: 1, login: "sasensi" }, kind: "user" as const, owner: true, askedAt: null },
  ];
  return {
    ...state,
    connection: { ...state.connection, listed, accounts: [], unreached: listed ? unreached : [] },
  };
}

test("the person's own row stays one row from looking to not installed: the same element, no entry", async () => {
  dom.entries(".account-row.new[data-arrived]");
  const store = app();
  await render(list(store, own(false)));
  const looking = rowOf("sasensi");
  expect(looking?.getAttribute("data-state")).toBe("looking");
  await render(list(store, own(true)));
  const listed = rowOf("sasensi");
  expect(listed).toBe(looking);
  expect(listed?.getAttribute("data-state")).toBe("not-installed");
  expect(listed?.classList.contains("new")).toBe(false);
  await dom.unmount();
});

test("the person's own row stays one row from not installed to installed: the same element, no entry", async () => {
  dom.entries(".account-row.new[data-arrived]");
  const store = app();
  await render(list(store, own(true)));
  const before = rowOf("sasensi");
  await render(list(store, world()));
  expect(rowOf("sasensi")).toBe(before);
  expect(before?.classList.contains("new")).toBe(false);
  await dom.unmount();
});

/** The fix a row shows, never one of its place's floors (hidden, holding its width only): what focus may land on. */
const shownFix = (login: string) =>
  rowOf(login)?.querySelector<HTMLElement>(".account-action-link a") ?? null;

/** ledger-hq, a member's, asked for nothing yet; then installed by an owner, with `repos` its repositories. */
function approval(repos: string[]): { asking: State; approved: State } {
  const state = world();
  const ledgerHq = { account: { id: 32, login: "ledger-hq" }, kind: "organisation" as const, owner: false };
  const asking = {
    ...state,
    connection: { ...state.connection, unreached: [{ ...ledgerHq, askedAt: null }] },
  };
  const approved: State = {
    ...state,
    repos: [...state.repos, ...repos.map((name) => repo("ledger-hq", name))],
    connection: {
      ...state.connection,
      accounts: [
        ...state.connection.accounts,
        {
          account: { id: 32, login: "ledger-hq", type: "Organization" },
          installationId: 42,
          cause: null,
          owner: false,
          granted: [],
        },
      ],
    },
  };
  return { asking, approved };
}

test("a row moving part while its fix held focus hands focus to the fix the arrived row shows", async () => {
  dom.entries(".account-row.new[data-arrived]");
  const store = app();
  const { asking, approved } = approval([]);
  await render(list(store, asking));
  const fix = shownFix("ledger-hq");
  expect(fix?.textContent).toContain("Ask to install on ledger-hq");
  fix?.focus();
  expect(document.activeElement).toBe(fix);
  await render(list(store, approved));
  // Choose repositories, the one the row shows: never a floor of its place, which can't take focus in a browser.
  const chosen = shownFix("ledger-hq");
  expect(chosen?.textContent).toContain("Choose repositories");
  expect(document.activeElement).toBe(chosen);
  await dom.unmount();
});

test("a row moving part while its fix held focus, arriving with no fix shown, hands focus to the row itself", async () => {
  dom.entries(".account-row.new[data-arrived]");
  const store = app();
  const { asking, approved } = approval(["ledger-web"]);
  await render(list(store, asking));
  shownFix("ledger-hq")?.focus();
  await render(list(store, approved));
  // Installed and used: Installed in the fix's place, nothing to press, so the row takes focus.
  expect(shownFix("ledger-hq")).toBeNull();
  expect(document.activeElement).toBe(rowOf("ledger-hq"));
  await dom.unmount();
});

test("a row moving part while focus is elsewhere takes no focus", async () => {
  dom.entries(".account-row.new[data-arrived]");
  const store = app();
  await render(list(store, accounts(false)));
  await render(list(store, accounts(true)));
  expect(rowOf("ledger-labs")?.contains(document.activeElement)).toBe(false);
  await dom.unmount();
});
