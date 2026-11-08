// The accounts list (design-system.md "Accounts list", ADR 0067) as it renders: every row's actions are one place,
// the fix's, centred on the row's login and detail, with Ask again inside it on a row waiting for an owner, so every
// row is as tall whatever its state; each detail leads with its state's mark; an account installed and used says so
// where its fix would be. The list is rendered to markup on a service that never answers.
import { expect, test } from "bun:test";
import type { State } from "@lookover/contracts";
import { accountRows } from "../view-model/accounts.ts";
import { AccountsList, CodeActions } from "./github-app.tsx";
import { app, screen, world } from "./repositories.test-support.tsx";

const NOW = world().now;

/** sasensi and fernhill reached and used; ledger-labs theirs, not installed; ledger-hq a member's, asked. */
function accounts(): State {
  const state = world();
  return {
    ...state,
    connection: {
      ...state.connection,
      unreached: [
        { account: { id: 31, login: "ledger-labs" }, kind: "organisation", owner: true, askedAt: null },
        { account: { id: 32, login: "ledger-hq" }, kind: "organisation", owner: false, askedAt: NOW },
      ],
    },
  };
}

const list = (state: State) =>
  screen(app(), state, () => <AccountsList list={accountRows(state, { timeZone: "UTC" })} />);

/** Each row's markup, in the list's order. */
const rowsOf = (html: string) => html.split('class="account-row"').slice(1);

test("a row's actions are its fix's one place: no second place held under it, so it can sit centred on the row", () => {
  const html = list(accounts());
  expect(rowsOf(html)).toHaveLength(5);
  expect(rowsOf(html).map((row) => row.match(/class="account-action( |")/g)?.length ?? 0)).toEqual([
    1, 1, 1, 1, 1,
  ]);
});

test("Ask again shows on the row waiting for an owner only, inside its fix's place, beside the fix", () => {
  const html = list(accounts());
  expect(rowsOf(html).map((row) => row.match(/class="anchor account-again"/g)?.length ?? 0)).toEqual([
    0, 0, 0, 1, 0,
  ]);
  const waiting = rowsOf(html)[3] ?? "";
  // One link place holds the fix and Ask again, named by its words.
  expect(waiting).toMatch(
    /class="account-action-link"[\s\S]*Ask an owner of ledger-hq[\s\S]*aria-label="Ask again"/,
  );
});

test("each row's detail leads with its state's mark", () => {
  const html = list(accounts());
  expect(rowsOf(html).map((row) => row.match(/class="account-mark" data-mark="([a-z-]+)"/)?.[1])).toEqual([
    "repositories",
    "repositories",
    "not-installed",
    "waiting",
    "another",
  ]);
});

test("an account installed and used says Installed in its fix's place; no other row does", () => {
  const html = list(accounts());
  expect(html.match(/class="account-status"/g)?.length).toBe(2);
  expect(html).toContain("Installed");
});

test("the fix says its whole label on hover on its own button; Ask again says its own, never both at once", () => {
  const waiting = rowsOf(list(accounts()))[3] ?? "";
  expect(waiting).not.toMatch(/class="account-action-link"[^>]* title=/);
  expect(waiting).toMatch(/<a class="btn btn-secondary btn-sm [^"]*" title="Ask an owner of ledger-hq"/);
  expect(waiting.match(/ title="/g)?.length).toBe(1);
});

test("the fix's place holds Ask again's room beside a waiting row's fix on a 16-character login", () => {
  const login = "ledger-hq-europe";
  expect(login).toHaveLength(16);
  const state = accounts();
  const asked: State = {
    ...state,
    connection: {
      ...state.connection,
      unreached: [{ account: { id: 33, login }, kind: "organisation", owner: false, askedAt: NOW }],
    },
  };
  const waiting = rowsOf(list(asked)).find((row) => row.includes(`Ask an owner of ${login}`)) ?? "";
  expect(waiting).toContain('aria-label="Ask again"');
  // A floor as wide as that fix's own label with Ask again's square beside it, so the label isn't cut.
  const floors = waiting.split('class="account-action-floor"').slice(1);
  const held = floors.find((f) => f.includes(`Ask an owner of ${login}<`));
  expect(held).toContain('class="account-again-floor"');
});

test("each row's fix place holds its own labels only, so its button is as wide as its own label", () => {
  const floors = rowsOf(list(accounts())).map((row) =>
    [...row.matchAll(/class="account-action-floor"[^>]*><a [^>]*>(?:<[^>]*>)*([^<]+)</g)].map((m) => m[1]),
  );
  expect(floors[2]).toEqual(["Install on ledger-labs"]);
  expect(floors[4]).toEqual(["Install on another account"]);
});

test("a code's two actions are small, as a sub-step's and a row's are: its line as tall as either (round 6)", () => {
  const code = { userCode: "D054-61DC", verificationUri: "https://github.com/login/device", expiresAt: NOW };
  const html = screen(app(), world(), () => <CodeActions code={code} onCancel={() => undefined} />);
  const actions = html.slice(html.indexOf('<span class="code-actions">'));
  expect(actions.match(/class="btn btn-[a-z]+ btn-sm/g)?.length).toBe(2);
});
