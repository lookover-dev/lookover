// S18 and S19 through the drawer's door (row 46, ADR 0082): the person signed in on four accounts, 40 repositories in
// all. S18, set up: in the seed fernhill's owner takes ten of its 30 off the App and ledger-labs uninstalls it, so
// twelve depart, ledger-labs' as an account gone; others have 22 pull requests open, the person's three are reviewed
// clean, and Review now on mira's #412 finds nothing. S19: the same world at setup's Repositories step, nothing gone.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, type State } from "@lookover/contracts";
import { type Scenario, scenarioOf } from "../index.ts";
import { eventually, TEST_LIMIT_MS } from "../service.test-support.ts";
import {
  advance,
  brief,
  inject,
  load,
  send,
  snapshotOf,
  startScenario,
  stopAll,
  T0,
} from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);

const MIN = 60_000;

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

/** How many repositories each account holds, in the listing's order. */
const perAccount = (repos: { owner: string }[]) => {
  const counts: Record<string, number> = {};
  for (const r of repos) counts[r.owner] = (counts[r.owner] ?? 0) + 1;
  return counts;
};

test("S18, a large organisation: 28 repositories watched in three accounts, ten gone from fernhill and ledger-labs gone with its two", async () => {
  const state = await loaded("S18");
  expect(state.setup.done).toBe(true);
  expect(state.connection).toMatchObject({ state: "connected", cause: null });
  // ledger-labs, uninstalled, is no longer among the accounts reached; the three others are, with no cause.
  expect(state.connection.accounts.map((a) => [a.account.login, a.cause])).toEqual([
    ["sasensi", null],
    ["fernhill", null],
    ["ledger-dev", null],
  ]);
  expect(perAccount(state.repos)).toEqual({ sasensi: 5, fernhill: 20, "ledger-dev": 3 });
  expect(perAccount(state.departed)).toEqual({ fernhill: 10, "ledger-labs": 2 });
  expect(state.departed.map((d) => `${d.owner}/${d.name}`)).toEqual([
    "fernhill/legacy-portal",
    "fernhill/ml-models",
    "fernhill/data-pipeline",
    "fernhill/status-page",
    "fernhill/sdk-python",
    "fernhill/terraform",
    "fernhill/importer",
    "fernhill/exporter",
    "fernhill/emails",
    "fernhill/onboarding",
    "ledger-labs/ledger-cli",
    "ledger-labs/ledger-sdk",
  ]);
  // Departed in the seed's first minute.
  for (const d of state.departed) expect(d.at).toBeLessThanOrEqual(T0 - 2 * MIN);
});

test("S18's repository-back: each departed repository comes back on its own account's installation, ledger-labs' installing the App there again on it alone", async () => {
  await loaded("S18");
  const named = (repos: { owner: string; name: string }[]) => repos.map((r) => `${r.owner}/${r.name}`);
  const accounts = (state: State) => state.connection.accounts.map((a) => [a.account.login, a.cause]);

  // The last to leave, ledger-labs/ledger-sdk: the App, uninstalled there, is installed again on it alone.
  expect(await inject(door, "repository-back")).toBe(200);
  const sdk = await snapshotOf(door);
  expect(named(sdk.departed).at(-1)).toBe("ledger-labs/ledger-cli");
  expect(named(sdk.repos)).toContain("ledger-labs/ledger-sdk");
  expect(accounts(sdk)).toEqual([
    ["sasensi", null],
    ["fernhill", null],
    ["ledger-dev", null],
    ["ledger-labs", null],
  ]);

  // Then ledger-cli joins it on that installation, and fernhill's onboarding comes back on fernhill's, not sasensi's.
  expect(await inject(door, "repository-back")).toBe(200);
  expect(await inject(door, "repository-back")).toBe(200);
  const back = await snapshotOf(door);
  expect(named(back.departed).at(-1)).toBe("fernhill/emails");
  expect(perAccount(back.departed)).toEqual({ fernhill: 9 });
  expect(perAccount(back.repos)).toEqual({ sasensi: 5, fernhill: 21, "ledger-dev": 3, "ledger-labs": 2 });
  expect(accounts(back)).toEqual([
    ["sasensi", null],
    ["fernhill", null],
    ["ledger-dev", null],
    ["ledger-labs", null],
  ]);
});

test("S18's pull requests: 22 by others (Everyone's), not reviewed; the person's three, reviewed clean", async () => {
  const state = await loaded("S18");
  const changes = Object.values(state.changes);
  const others = changes.filter((c) => c.author === "other");
  const mine = changes.filter((c) => c.author !== "other");
  expect(others).toHaveLength(22);
  for (const c of others) expect(state.reviews[c.id]?.job ?? null).toBeNull();
  expect(mine.map((c) => c.id).sort()).toEqual(
    ["fernhill/cli#21", "ledger-dev/ledger-docs#12", "sasensi/ledger-api#164"].map(changeId),
  );
  for (const c of mine) {
    expect(state.reviews[c.id]?.job).toMatchObject({ state: "done" });
    expect(state.reviews[c.id]?.rounds[0]).toMatchObject({ raised: 0, open: 0 });
  }
});

test("S18's Review now on mira's fernhill/api #412: reviewed, nothing to raise", async () => {
  await loaded("S18");
  const asked = changeId("fernhill/api#412");
  expect((await send(door, { type: "review.request", changeId: asked })).status).toBe(200);
  await advance(door, 2 * MIN);
  const state = await eventually(
    () => snapshotOf(door),
    (s) => s.reviews[asked]?.job?.state === "done",
  );
  expect(state.reviews[asked]?.rounds[0]).toMatchObject({ raised: 0, open: 0 });
});

test("S19 stands at setup's Repositories step on the same world: 40 repositories in four accounts, nothing departed", async () => {
  const state = await loaded("S19");
  expect(state.setup).toMatchObject({ done: false, step: "repos", github: "done" });
  expect(state.connection.accounts.map((a) => a.account.login)).toEqual([
    "sasensi",
    "fernhill",
    "ledger-dev",
    "ledger-labs",
  ]);
  expect(perAccount(state.repos)).toEqual({ sasensi: 5, fernhill: 30, "ledger-dev": 3, "ledger-labs": 2 });
  expect(state.departed).toEqual([]);
  // The same pull requests open, none reviewed: nothing asks by itself before the repositories are chosen.
  expect(Object.keys(state.changes)).toHaveLength(25);
  expect(Object.values(state.reviews).filter((r) => r.job !== null)).toEqual([]);
});

test("a repository departs only once listed: a scenario's move naming one the room never watched fails its seed", async () => {
  const broken: Scenario = {
    ...scenarioOf("S18"),
    id: "T-unlisted",
    script: [{ at: 20_000, move: { kind: "leave", repos: [{ owner: "fernhill", name: "nowhere" }] } }],
  };
  await expect(startScenario(broken)).rejects.toThrow("fernhill/nowhere was never listed: it can't depart");
});
