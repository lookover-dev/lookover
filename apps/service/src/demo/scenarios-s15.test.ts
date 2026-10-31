// S15 through the drawer's door (ADR 0046, ADR 0059): the person's code lives in an organisation, ledger-dev, where
// they are an admin. The setup's GitHub step lists it beside their own account, as their `gh` (demo mode's, in
// memory) says it; the App is made on the organisation's pages of GitHub's fake, installed on its repositories, and
// the person's pull requests are reviewed while a teammate's are skipped as not theirs.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, DEMO_API, repositoryId, type State } from "@lookover/contracts";
import { memoryGh } from "@lookover/testkit/demo";
import { MADE_APP, scenarioOf } from "../index.ts";
import { TEST_LIMIT_MS } from "../service.test-support.ts";
import {
  advance,
  inject,
  installApp,
  load,
  makeApp,
  send,
  snapshotOf,
  startScenario,
  stopAll,
  T0,
} from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);

const MIN = 60_000;
const id = (n: number) => changeId(`ledger-dev/ledger-api#${n}`);
const ORGANISATION = { id: 338, login: "ledger-dev" };
const PERSON = { id: 1, login: "sasensi" };

let door: Awaited<ReturnType<typeof startScenario>>;
beforeAll(async () => {
  door = await startScenario(scenarioOf("S10"));
});
afterAll(stopAll);

async function loaded(scenario: string): Promise<State> {
  const { status, body } = await load(door, scenario);
  expect({ status, body }).toEqual({ status: 200, body: { ok: true } });
  const state = await snapshotOf(door);
  expect(state.now).toBe(T0);
  return state;
}

async function after(ms: number): Promise<State> {
  await advance(door, ms);
  return snapshotOf(door);
}

async function sent(body: Parameters<typeof send>[1]): Promise<number> {
  return (await send(door, body)).status;
}

test("S15, an organisation's App: gh lists ledger-dev, the App made and installed there, the person's pull request reviewed, a teammate's skipped", async () => {
  const start = await loaded("S15");
  expect(start.setup).toMatchObject({ done: false, step: "github", github: "start" });
  expect(start.connection).toMatchObject({ state: "not-connected", app: null, web: DEMO_API.github });

  // The step reads the person's gh: signed in as them, an admin of ledger-dev.
  expect(await sent({ type: "gh.check" })).toBe(200);
  expect((await snapshotOf(door)).connection.gh).toEqual({
    person: { kind: "signed-in", account: PERSON },
    organisations: { kind: "listed", organisations: [ORGANISATION] },
  });

  // Made on the organisation's "new App" page of GitHub's fake, then installed on its repositories.
  expect(await sent({ type: "connection.createApp", organisation: "ledger-dev" })).toBe(200);
  const installPage = await makeApp(door);
  const made = await snapshotOf(door);
  expect(made.setup).toMatchObject({ github: "waiting-for-install", githubRefused: null });
  expect(made.connection.app).toMatchObject({
    account: { ...ORGANISATION, type: "Organization" },
    person: PERSON,
  });
  expect(await installApp(door, installPage)).toContain("Lookover is installed");
  const installed = await after(4_000);
  expect(installed.connection.state).toBe("connected");
  expect(installed.repos.map((r) => r.id)).toEqual(
    ["ledger-dev/ledger-api", "ledger-dev/ledger-web"].map(repositoryId),
  );
  expect(installed.changes[id(148)]).toMatchObject({ author: "you", writtenBy: "claude" });

  // Set up with ledger-api, #148 reviewed first; then teammates open theirs, skipped as not the person's.
  expect(await sent({ type: "setup.goto", step: "repos" })).toBe(200);
  expect(await sent({ type: "setup.chooseRepos", enabled: [repositoryId("ledger-dev/ledger-api")] })).toBe(
    200,
  );
  expect(await sent({ type: "setup.firstReview", changeId: id(148), preview: false })).toBe(200);
  const reviewed = await after(5 * MIN);
  expect(reviewed.reviews[id(148)]?.job).toMatchObject({ trigger: "first-review", state: "done" });
  const teammates = await after(10 * MIN);
  for (const [n, by] of [
    [151, "mira"],
    [153, "tomas"],
  ] as const) {
    expect(teammates.changes[id(n)]).toMatchObject({ author: "other", openedBy: by, fork: false });
    expect(teammates.reviews[id(n)]?.job).toMatchObject({ state: "skipped", skip: "not-yours" });
  }
});

test("S15, the App an admin of ledger-dev made before: Use an existing App takes it, gh saying the person is a member, and it connects", async () => {
  await loaded("S15");
  const res = await send(door, { type: "connection.useApp", appId: MADE_APP.id, key: MADE_APP.key });
  expect(res.status).toBe(200);
  expect((await snapshotOf(door)).connection.app).toMatchObject({
    account: { ...ORGANISATION, type: "Organization" },
    person: PERSON,
  });
  const connected = await after(4_000);
  expect(connected.connection.state).toBe("connected");
  expect(connected.repos.map((r) => r.id)).toEqual(
    ["ledger-dev/ledger-api", "ledger-dev/ledger-web"].map(repositoryId),
  );
});

/** S15 set up on ledger-dev with the App an admin made before: Use an existing App, then its install found. */
async function connectedOnLedgerDev(): Promise<void> {
  await loaded("S15");
  expect(await sent({ type: "connection.useApp", appId: MADE_APP.id, key: MADE_APP.key })).toBe(200);
  expect((await after(4_000)).connection.state).toBe("connected");
}

test("the drawer removes the person from ledger-dev: reviews stop, the connection says why, and Check again keeps it so", async () => {
  await connectedOnLedgerDev();
  expect(await inject(door, "not-a-member")).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "not-a-member", organisation: "ledger-dev" },
  });
  // A teammate's pull request opened meanwhile is not even listed.
  expect((await after(12 * MIN)).changes[id(151)]).toBeUndefined();

  // Check again while gh still says the person isn't a member: the cause stays.
  expect(await sent({ type: "gh.check" })).toBe(200);
  expect((await snapshotOf(door)).connection.cause).toEqual({
    kind: "not-a-member",
    organisation: "ledger-dev",
  });
});

test("the drawer signs gh out: the membership can't be checked, the last answer stands and reviews go on", async () => {
  await connectedOnLedgerDev();
  expect(await inject(door, "gh-signed-out")).toBe(200);
  const later = await after(12 * MIN);
  expect(later.connection).toMatchObject({ state: "connected", cause: null });
  expect(later.changes[id(151)]).toMatchObject({ author: "other", openedBy: "mira" });
});

test("not a member asks for an organisation's App: S1's is personal, S15 before setup has no App yet", async () => {
  /** The drawer's fault refused: why, as the console says it. */
  const refused = async () => {
    const res = await send(door, { type: "demo.inject", fault: "not-a-member" });
    return { status: res.status, body: await res.json() };
  };
  await loaded("S1");
  expect(await refused()).toEqual({
    status: 409,
    body: { error: "the App lives on no organisation in this scenario" },
  });
  await loaded("S15");
  expect(await refused()).toEqual({ status: 409, body: { error: "no App kept yet" } });
});

test("the drawer's gh is uninstalled: the step's next read says gh is missing", async () => {
  await loaded("S15");
  expect(await inject(door, "gh-uninstalled")).toBe(200);
  expect(await sent({ type: "gh.check" })).toBe(200);
  expect((await snapshotOf(door)).connection.gh).toMatchObject({ person: { kind: "missing" } });
});

test("a test's own gh is emptied at each load: S1 after S15 lists no organisation once gh is signed in", async () => {
  const gh = memoryGh();
  const own = await startScenario(scenarioOf("S15"), { gh });
  expect(await gh.memberships()).toMatchObject({
    kind: "listed",
    organisations: [{ organisation: ORGANISATION, role: "owner" }],
  });
  expect((await load(own, "S1")).status).toBe(200);
  expect(await gh.person()).toEqual({ kind: "signed-out" });
  expect(await inject(own, "gh-signed-in")).toBe(200);
  expect(await gh.memberships()).toMatchObject({ kind: "listed", organisations: [] });
  expect(await gh.membership("ledger-dev")).toEqual({ kind: "absent" });
});
