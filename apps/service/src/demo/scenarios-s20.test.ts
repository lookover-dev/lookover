// S20 and S21 through the drawer's door (row 52, ADR 0086): real-looking names, so `proof`'s layout pass sees what
// the owner's own accounts show. The person's own short login and two organisations: one as long as GitHub allows (39
// characters), asking for SAML SSO once its repositories are listed, one long-named and fine; each reached with a few
// repositories and pull requests.
// S20 is set up; S21 is the same world at setup's GitHub step.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, type State } from "@lookover/contracts";
import { eventually, TEST_LIMIT_MS } from "../service.test-support.ts";
import { brief, load, snapshotOf, startScenario, stopAll, T0 } from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);

/** The organisation as long as a GitHub login can be, and the long-named one with no problem. */
const LONGEST = "northwind-platform-infrastructure-group";
const LONG = "meridian-health-analytics";

let door: Awaited<ReturnType<typeof startScenario>>;
beforeAll(async () => {
  // The door the scenarios load through: S10's world on its first five minutes, the story behind it unused.
  door = await startScenario(brief());
});
afterAll(stopAll);

async function loaded(scenario: string): Promise<State> {
  const { status, body } = await load(door, scenario);
  expect({ status, body }).toEqual({ status: 200, body: { ok: true } });
  const state = await snapshotOf(door);
  expect(state.now).toBe(T0);
  return state;
}

const accountsOf = (state: State) =>
  state.connection.accounts.map((a) => [a.account.login, a.cause?.kind ?? null]);

/** How many repositories each account holds, in the listing's order. */
const perAccount = (repos: { owner: string }[]) => {
  const counts: Record<string, number> = {};
  for (const r of repos) counts[r.owner] = (counts[r.owner] ?? 0) + 1;
  return counts;
};

test("the longest organisation's login is as long as GitHub allows", () => {
  expect(LONGEST).toHaveLength(39);
});

test("S20, real-looking names: set up on three accounts, the 39-character one asking for SSO, the others fine", async () => {
  const state = await loaded("S20");
  expect(state.setup.done).toBe(true);
  expect(state.connection).toMatchObject({ state: "connected", person: { login: "sasensi" } });
  expect(accountsOf(state)).toEqual([
    ["sasensi", null],
    [LONGEST, "sso"],
    [LONG, null],
  ]);
  expect(perAccount(state.repos)).toEqual({ sasensi: 2, [LONGEST]: 3, [LONG]: 3 });
});

test("S20's pull requests: the person's own, one per account, reviewed clean; others' open, not reviewed", async () => {
  const state = await eventually(
    () => loaded("S20"),
    (s) => Object.keys(s.changes).length > 0,
  );
  const changes = Object.values(state.changes);
  const mine = changes.filter((c) => c.author !== "other");
  expect(mine.map((c) => c.id).sort()).toEqual(
    [`${LONG}/claims-service#88`, "sasensi/ledger-api#171"].map(changeId).sort(),
  );
  // meridian's is titled in Chinese, with no space to break at: First review must still wrap it on a phone.
  expect(state.changes[changeId(`${LONG}/claims-service#88`)]?.title).toMatch(/^[^ ]{20,}$/);
  for (const c of mine) expect(state.reviews[c.id]?.job).toMatchObject({ state: "done" });
  const others = changes.filter((c) => c.author === "other");
  expect(perAccount(others.map((c) => ({ owner: String(c.repoId).split("/")[0] ?? "" })))).toEqual({
    sasensi: 1,
    [LONGEST]: 2,
    [LONG]: 3,
  });
  for (const c of others) expect(state.reviews[c.id]?.job ?? null).toBeNull();
});

test("S21 stands at setup's GitHub step on S20's world, signed in, the same three accounts", async () => {
  const state = await loaded("S21");
  expect(state.setup).toMatchObject({ done: false, step: "github", github: "done" });
  expect(accountsOf(state)).toEqual([
    ["sasensi", null],
    [LONGEST, "sso"],
    [LONG, null],
  ]);
});
