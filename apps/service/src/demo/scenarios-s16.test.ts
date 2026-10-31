// S16 through the drawer's door (ADR 0046, ADR 0066): the person signed in to the shared App on their own account and
// on an organisation, ledger-dev, each with a repository named ledger-api and a pull request #151 of the person's on
// each, both reviewed and posted as them, a member of ledger-dev. The drawer signs them out of GitHub (Sign in again
// brings them back), has ledger-dev ask for SSO (its account alone waits; the person's own goes on), or has an owner
// suspend the App on ledger-dev (its account names who). Their `gh` names two organisations without the App:
// ledger-labs, theirs to install on, and ledger-hq, where asking to install waits for an owner until the drawer's
// owner installs it there.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { changeId, type FaultId, githubLinks, repositoryId, type State } from "@lookover/contracts";
import { scenarioOf } from "../index.ts";
import { eventually, TEST_LIMIT_MS } from "../service.test-support.ts";
import {
  advance,
  following,
  inject,
  load,
  onGitHub,
  send,
  snapshotOf,
  startScenario,
  stopAll,
  T0,
} from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);

const MIN = 60_000;
const PERSON = { id: 1, login: "sasensi" };
const OWN = changeId("sasensi/ledger-api#151");
const ORG = changeId("ledger-dev/ledger-api#151");
const AGENT = changeId("sasensi/ledger-api#152");

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

/** Who filed each review GitHub's fake page of a pull request lists, in order. */
const reviewersOf = (page: string): string[] =>
  [...page.matchAll(/Reviewed by ([^<]+)\./g)].map((m) => m[1] ?? "");

test("S16, signed in on two accounts: each account's ledger-api, its #151 the person's, reviewed and posted as them", async () => {
  const state = await loaded("S16");
  expect(state.setup.done).toBe(true);
  expect(state.connection).toMatchObject({
    way: "shared",
    state: "connected",
    cause: null,
    id: "github:sasensi",
    person: PERSON,
    bot: null,
    app: null,
  });
  expect(state.connection.accounts.map((a) => [a.account.login, a.account.type, a.cause])).toEqual([
    ["sasensi", "User", null],
    ["ledger-dev", "Organization", null],
  ]);
  expect(state.repos.map((r) => r.id)).toEqual(
    ["sasensi/ledger-api", "ledger-dev/ledger-api", "ledger-dev/ledger-web"].map(repositoryId),
  );
  for (const id of [OWN, ORG]) {
    expect(state.changes[id]).toMatchObject({ number: 151, author: "you" });
    expect(state.reviews[id]?.job).toMatchObject({ state: "done" });
    expect(state.reviews[id]?.rounds).toHaveLength(1);
    expect(state.reviews[id]?.rounds[0]).toMatchObject({ raised: 1, open: 1 });
  }
  expect(state.changes[OWN]?.title).not.toBe(state.changes[ORG]?.title);
  // Posted as them on both accounts (ADR 0066): GitHub's page of each #151 names the person, no App's bot.
  for (const owner of ["sasensi", "ledger-dev"])
    expect(reviewersOf(await onGitHub(door, `/${owner}/ledger-api/pull/151`))).toEqual(["sasensi"]);
});

test("S16's drawer says the person is a member of ledger-dev, and leaves nothing for later", () => {
  const s16 = scenarioOf("S16");
  expect(s16.steps.join(" ")).toContain("a member of ledger-dev");
  expect(s16.later).toBe("");
});

test("the drawer signs the person out of GitHub: the connection says so, and Sign in again with its code brings it back", async () => {
  await loaded("S16");
  expect(await inject(door, "github-signed-out")).toBe(200);
  expect((await snapshotOf(door)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "signed-out" },
  });

  expect((await send(door, { type: "connection.signIn" })).status).toBe(200);
  expect((await snapshotOf(door)).connection.signIn?.userCode).toBeString();
  expect(await inject(door, "sign-in-entered")).toBe(200);
  await advance(door, 5_000);
  const back = await eventually(
    () => snapshotOf(door),
    (s) => s.connection.state === "connected",
  );
  expect(back.connection).toMatchObject({
    state: "connected",
    cause: null,
    signIn: null,
    way: "shared",
    person: PERSON,
  });
});

test("the drawer has ledger-dev ask for SSO: its account holds the cause, the connection stays up, and the person's own reviews go on", async () => {
  await loaded("S16");
  expect(await inject(door, "sso-asked")).toBe(200);
  const sso = await snapshotOf(door);
  expect(sso.connection).toMatchObject({ state: "connected", cause: null });
  expect(sso.connection.accounts.map((a) => [a.account.login, a.cause])).toEqual([
    ["sasensi", null],
    ["ledger-dev", { kind: "sso", organisation: "ledger-dev", url: null }],
  ]);
  // Kept watched, not departed: its repositories come back with the SSO session.
  expect(sso.repos).toHaveLength(3);
  expect(sso.departed).toEqual([]);
  expect((await after(MIN)).connection.state).toBe("connected");

  // The person's agent opens a pull request on their own ledger-api: reviewed and posted as them, ledger-dev still
  // asking for SSO.
  expect(await inject(door, "agent-opens-change")).toBe(200);
  const reviewed = await after(5 * MIN);
  expect(reviewed.changes[AGENT]).toMatchObject({ number: 152, author: "you", writtenBy: "claude" });
  expect(reviewed.reviews[AGENT]?.job).toMatchObject({ state: "done" });
  expect(reviewed.reviews[AGENT]?.rounds).toHaveLength(1);
  expect(reviewersOf(await onGitHub(door, "/sasensi/ledger-api/pull/152"))).toEqual(["sasensi"]);
  expect(reviewed.connection.accounts.map((a) => [a.account.login, a.cause?.kind ?? null])).toEqual([
    ["sasensi", null],
    ["ledger-dev", "sso"],
  ]);
});

/** S16 loaded, once the person's `gh` (read after the start) has named their organisations without the App. */
async function named(): Promise<State> {
  await loaded("S16");
  return eventually(
    () => snapshotOf(door),
    (s) => s.connection.unreached.length === 2,
  );
}

/** Each organisation without the App as a row: login, owner, asked. */
const unreachedOf = (state: State) =>
  state.connection.unreached.map((u) => [u.account.login, u.owner, u.askedAt !== null]);

/** The drawer's fault refused: why, as the console says it. */
const refused = async (fault: FaultId) => {
  const res = await send(door, { type: "demo.inject", fault });
  return { status: res.status, body: await res.json() };
};

test("S16's gh names two organisations without the App: ledger-labs, which the person owns, and ledger-hq, where a member", async () => {
  const state = await named();
  expect(unreachedOf(state)).toEqual([
    ["ledger-labs", true, false],
    ["ledger-hq", false, false],
  ]);
  // ledger-dev reached, the person a member there.
  expect(state.connection.accounts.map((a) => [a.account.login, a.owner])).toEqual([
    ["sasensi", true],
    ["ledger-dev", false],
  ]);
});

test("asked to install on ledger-hq, it waits for an owner; the drawer's owner installs it, and it is reached, the ask forgotten", async () => {
  await named();
  expect(await refused("owner-installs")).toEqual({
    status: 409,
    body: { error: "no organisation waits for an owner" },
  });

  expect((await send(door, { type: "connection.askToInstall", account: "ledger-hq" })).status).toBe(200);
  expect(unreachedOf(await snapshotOf(door))).toEqual([
    ["ledger-labs", true, false],
    ["ledger-hq", false, true],
  ]);

  expect(await inject(door, "owner-installs")).toBe(200);
  const installed = await eventually(
    () => snapshotOf(door),
    (s) => s.connection.accounts.some((a) => a.account.login === "ledger-hq"),
  );
  expect(installed.connection.accounts.map((a) => [a.account.login, a.cause])).toEqual([
    ["sasensi", null],
    ["ledger-dev", null],
    ["ledger-hq", null],
  ]);
  expect(unreachedOf(installed)).toEqual([["ledger-labs", true, false]]);
  expect(installed.repos.map((r) => r.id)).toContain(repositoryId("ledger-hq/ledger-app"));
});

test("the drawer has an owner suspend the App on ledger-dev: its account says so, naming who", async () => {
  await named();
  expect(await inject(door, "organisation-suspended")).toBe(200);
  const suspended = await snapshotOf(door);
  expect(suspended.connection).toMatchObject({ state: "connected", cause: null });
  expect(suspended.connection.accounts.map((a) => [a.account.login, a.cause])).toEqual([
    ["sasensi", null],
    ["ledger-dev", { kind: "uninstalled", suspended: true, suspendedBy: "mira" }],
  ]);
});

/** An account reached, by its login. */
const reachedOf = (state: State, login: string) => {
  const found = state.connection.accounts.find((a) => a.account.login === login);
  if (found === undefined) throw new Error(`${login} is not reached`);
  return found;
};

test("each account's fix lands on GitHub's fake: Ask an owner, Sign in with SSO and the person's own installation", async () => {
  const state = await named();
  const { web } = state.connection;

  // Waiting for an owner of ledger-hq: its fix is its owners, mira among them, the person not (a member).
  expect((await send(door, { type: "connection.askToInstall", account: "ledger-hq" })).status).toBe(200);
  const hq = await following(door, githubLinks.owners(web, "ledger-hq"));
  expect(hq).toContain("<li>mira</li>");
  expect(hq).not.toContain("sasensi");

  // Suspended on ledger-dev, where the person is a member: Ask an owner of ledger-dev, mira.
  expect(await inject(door, "organisation-suspended")).toBe(200);
  expect(await following(door, githubLinks.owners(web, "ledger-dev"))).toContain("<li>mira</li>");

  // The person's own account, installed and theirs: its repositories are chosen on its installation's settings.
  const own = reachedOf(state, "sasensi");
  const settings = await following(door, githubLinks.installation(web, own.account, own.installationId));
  expect(settings).toContain("sasensi/ledger-api");
});

test("ledger-dev asking for SSO: Sign in with SSO's page starts the session, and its account is fine again", async () => {
  await named();
  expect(await inject(door, "sso-asked")).toBe(200);
  const asked = reachedOf(await snapshotOf(door), "ledger-dev");
  expect(asked.cause).toMatchObject({ kind: "sso", url: null });
  const sso = githubLinks.sso((await snapshotOf(door)).connection.web, "ledger-dev");

  expect(await following(door, sso)).toContain("Continue");
  expect(await following(door, sso, [["action", "continue"]])).toContain("Signed in with SSO");
  expect((await send(door, { type: "connection.reconnect" })).status).toBe(200);

  const fine = await eventually(
    () => snapshotOf(door),
    (s) => reachedOf(s, "ledger-dev").cause === null,
  );
  expect(fine.connection.state).toBe("connected");
});

test("the shared App's faults ask for a sign-in or an organisation reached: S10 runs on its own App", async () => {
  await loaded("S10");
  expect(await refused("github-signed-out")).toEqual({
    status: 409,
    body: { error: "nobody is signed in to the shared App" },
  });
  for (const fault of ["sso-asked", "organisation-suspended"] as const)
    expect(await refused(fault)).toEqual({
      status: 409,
      body: { error: "no organisation is reached through the shared App" },
    });
  expect(await refused("owner-installs")).toEqual({
    status: 409,
    body: { error: "no organisation waits for an owner" },
  });
});
