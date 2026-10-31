// Every account at once on the shared App (ADR 0066): signed in, Lookover watches the repositories of every
// installation the person reaches together, each account with its installation and its own cause. Two repositories
// of one name on two accounts are reviewed side by side; one account suspended, or asking for SSO, keeps its
// repositories watched and refused while the other keeps reviewing; one no longer reached departs with its
// repositories. The service runs in this process on the fake host, which plays the accounts and the ports as the
// person.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type ChangeId,
  changeId,
  commitSha,
  type HostAccount,
  type Repository,
  type SignIn,
  type State,
} from "@lookover/contracts";
import { DemoClock, type FakeChange, FakeGitHost } from "@lookover/testkit";
import { type GitHubSide, memoryKeychain, type RunningService, signInStore } from "./index.ts";
import {
  eventually,
  fakeEngines,
  home,
  OWNER,
  openApp,
  PLANTED,
  post,
  pr1,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
/** The shared App's bot on the fake: on `shared` it never posts, the person does. */
const SHARED_BOT = { id: 2020, login: "lookover-dev[bot]" };
/** The person's own account as the fake names it, where its App is installed first. */
const SASENSI: HostAccount = { ...OWNER, type: "User" };
/** An organisation the person reaches, its sandbox named as the person's own. */
const ORG: HostAccount = { id: 9001, login: "lookover-dev", type: "Organization" };
const ORG_SANDBOX = { owner: ORG.login, name: SANDBOX.name };
/** Pull request #1 on the organisation's sandbox: the same number in a repository of the same name. */
const orgPr1: FakeChange = {
  ...pr1,
  repo: ORG_SANDBOX,
  url: "https://github.com/lookover-dev/lookover-sandbox/pull/1",
  head: { ref: "org-change", sha: commitSha("d4e5f60718293a4b5c6d7e8f9012345678a1b2c3") },
};
const ORG_PLANTED = changeId("lookover-dev/lookover-sandbox#1");
const userOnly = async () => {};

/** The person's sign-in, as GitHub gives it: a token for 8 hours. */
const signInAt = (at: number): SignIn => ({
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: at + 8 * 3_600_000,
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: at + 180 * 86_400_000,
  person: { ...OWNER },
});

/** A data folder signed in to the shared App, on the fake: its accounts and its ports the fake's. */
async function signedIn(host: FakeGitHost, dir: string): Promise<GitHubSide> {
  const signIns = signInStore({ home: dir, keychain: memoryKeychain(), userOnly });
  await signIns.write(signInAt(T0));
  return {
    installations: host,
    connect: () => ({ intake: host, writer: host }),
    shared: {
      signIn: host,
      signIns,
      accounts: () => host,
      connect: () => ({ intake: host, writer: host }),
    },
  };
}

/** The service signed in to the shared App on the person's account and on the organisation, a pull request on each. */
async function onTwoAccounts(reviews = 0) {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1, orgPr1],
    clock: time,
    reaches: [{ account: ORG, repositories: [ORG_SANDBOX] }],
  });
  const engines = fakeEngines({ reviews, time });
  const { service } = await start({ home: dir, host, time, engines, github: await signedIn(host, dir) });
  const cookie = await openApp(service);
  return { service, cookie, host, time };
}

const reviewOf = (service: RunningService, cookie: string, change: ChangeId) =>
  post(service, cookie, { type: "review.request", changeId: change });

const idsOf = (state: State): string[] => state.repos.map((r: Repository) => String(r.id));

test("signed in on two accounts, both are the connection's, and their two same-named repositories are reviewed at once", async () => {
  const { service, cookie, host } = await onTwoAccounts(2);
  const state: State = await snapshot(service, cookie);
  expect(state.connection).toMatchObject({ id: "github:sasensi", way: "shared", state: "connected" });
  expect(state.connection.accounts).toEqual([
    { account: SASENSI, installationId: 60_000_001, cause: null, owner: true },
    { account: ORG, installationId: 60_000_002, cause: null, owner: null },
  ]);
  expect(idsOf(state)).toEqual(["sasensi/lookover-sandbox", "lookover-dev/lookover-sandbox"]);
  expect(Object.keys(state.changes).sort()).toEqual([ORG_PLANTED, PLANTED].sort());

  expect((await reviewOf(service, cookie, PLANTED)).status).toBe(200);
  expect((await reviewOf(service, cookie, ORG_PLANTED)).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done" && s.reviews[ORG_PLANTED]?.job?.state === "done",
  );
  for (const repo of [SANDBOX, ORG_SANDBOX]) {
    const shown = host.view({ repo, number: 1 });
    expect(shown.reviews).toHaveLength(1);
    expect(shown.checks.map((c) => `${c.status} ${c.conclusion}`)).toEqual(["completed success"]);
  }
});

test("the organisation suspended: its account shows it, naming who suspended it, its repository stays watched, and the person's own keeps reviewing", async () => {
  const { service, cookie, host, time } = await onTwoAccounts(2);
  host.suspend(ORG.login, "rhea-k");
  // The next listing of the accounts, five minutes on.
  await time.advance(5 * MIN);
  const suspended = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.accounts[1]?.cause !== null && s.connection.accounts[1] !== undefined,
  );
  expect(suspended.connection).toMatchObject({ state: "connected", cause: null });
  expect(suspended.connection.accounts).toEqual([
    { account: SASENSI, installationId: 60_000_001, cause: null, owner: true },
    {
      account: ORG,
      installationId: 60_000_002,
      cause: { kind: "uninstalled", suspended: true, suspendedBy: "rhea-k" },
      owner: null,
    },
  ]);
  // Kept, not departed: what it waited for is there when it is lifted.
  expect(idsOf(suspended)).toEqual(["sasensi/lookover-sandbox", "lookover-dev/lookover-sandbox"]);
  expect(suspended.departed).toEqual([]);

  // "Review now" on the organisation's waits on its account, as under SSO; the person's own goes on.
  expect((await reviewOf(service, cookie, ORG_PLANTED)).status).toBe(200);
  expect((await reviewOf(service, cookie, PLANTED)).status).toBe(200);
  const reviewed = await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  expect(reviewed.reviews[ORG_PLANTED]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "connection" },
  });
  expect(host.view({ repo: SANDBOX, number: 1 }).reviews).toHaveLength(1);

  // Lifted just before the next listing of the accounts: that listing clears the cause, and what waited is done.
  await time.advance(4 * MIN);
  host.unsuspend(ORG.login);
  await time.advance(MIN);
  const back = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.accounts[1]?.cause === null && s.reviews[ORG_PLANTED]?.job?.state === "done",
  );
  expect(back.connection.state).toBe("connected");
  expect(idsOf(back)).toEqual(["sasensi/lookover-sandbox", "lookover-dev/lookover-sandbox"]);
  expect(host.view({ repo: ORG_SANDBOX, number: 1 }).reviews).toHaveLength(1);
});

test("an organisation asking for SSO refuses its repository alone: the poll gives its account the cause, never the connection", async () => {
  const { service, cookie, host, time } = await onTwoAccounts(2);
  host.askSso(ORG.login, "https://github.com/orgs/lookover-dev/sso");
  // The next poll of each repository, a minute on: the organisation's refused, the person's answered.
  await time.advance(MIN);
  const sso = {
    kind: "sso",
    organisation: ORG.login,
    url: "https://github.com/orgs/lookover-dev/sso",
  } as const;
  const refused = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.accounts[1]?.cause !== null,
  );
  expect(refused.connection).toMatchObject({ state: "connected", cause: null });
  expect(refused.connection.accounts[1]).toEqual({
    account: ORG,
    installationId: 60_000_002,
    cause: sso,
    owner: null,
  });
  // "Refresh" says nothing of it: the account does.
  expect((await post(service, cookie, { type: "refresh" })).status).toBe(200);
  // A review of the organisation's waits on its account; the person's own goes on.
  expect((await reviewOf(service, cookie, ORG_PLANTED)).status).toBe(200);
  expect((await reviewOf(service, cookie, PLANTED)).status).toBe(200);
  const reviewed = await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  expect(reviewed.reviews[ORG_PLANTED]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "connection" },
  });

  // Signed in again: the cause cleared, the review that waited on it is done.
  host.signInSso(ORG.login);
  await time.advance(MIN);
  const back = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.accounts[1]?.cause === null && s.reviews[ORG_PLANTED]?.job?.state === "done",
  );
  expect(back.connection.accounts[1]).toEqual({
    account: ORG,
    installationId: 60_000_002,
    cause: null,
    owner: null,
  });
  expect(host.view({ repo: ORG_SANDBOX, number: 1 }).reviews).toHaveLength(1);
});

/** A second organisation the person reaches, polled after the first. */
const LABS: HostAccount = { id: 9002, login: "lookover-labs", type: "Organization" };
const LABS_TOOLS = { owner: LABS.login, name: "tools" };
/** A pull request the person opens on the second organisation's repository while the first asks for SSO. */
const labsPr1: FakeChange = {
  ...pr1,
  repo: LABS_TOOLS,
  url: "https://github.com/lookover-labs/tools/pull/1",
  head: { ref: "labs-change", sha: commitSha("e5f60718293a4b5c6d7e8f9012345678a1b2c3d4") },
};
const LABS_PLANTED = changeId("lookover-labs/tools#1");

test("an organisation asking for SSO, polled first, never keeps the accounts after it from being polled and reviewed", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  // The shared App not on the person's own account: the organisation asking for SSO is the first repository polled.
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    installed: false,
    changes: [orgPr1],
    clock: time,
    reaches: [
      { account: ORG, repositories: [ORG_SANDBOX] },
      { account: LABS, repositories: [LABS_TOOLS] },
    ],
  });
  const engines = fakeEngines({ reviews: 1, time });
  const { service } = await start({ home: dir, host, time, engines, github: await signedIn(host, dir) });
  const cookie = await openApp(service);
  expect(idsOf(await snapshot(service, cookie))).toEqual([
    "lookover-dev/lookover-sandbox",
    "lookover-labs/tools",
  ]);

  host.askSso(ORG.login);
  // Its review waits on its account, so its repository is polled often, and refused each time.
  expect((await reviewOf(service, cookie, ORG_PLANTED)).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.accounts[0]?.cause !== null,
  );
  host.open(labsPr1);
  // Only the loop polls from here: no "Refresh", no "Review now".
  for (let i = 0; i < 3; i++) await time.advance(MIN);
  const reviewed = await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[LABS_PLANTED]?.job?.state === "done",
  );
  expect(reviewed.connection).toMatchObject({ state: "connected", cause: null });
  expect(reviewed.reviews[ORG_PLANTED]?.job).toMatchObject({
    state: "deferred",
    deferral: { reason: "connection" },
  });
  expect(host.view({ repo: LABS_TOOLS, number: 1 }).reviews).toHaveLength(1);
});

test("an organisation no longer reached at all departs with its repository; the person's own stays", async () => {
  const { service, cookie, host, time } = await onTwoAccounts();
  host.uninstall(ORG.login);
  await time.advance(5 * MIN);
  const gone = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.accounts.length === 1,
  );
  expect(gone.connection).toMatchObject({ state: "connected", cause: null });
  expect(gone.connection.accounts).toEqual([
    { account: SASENSI, installationId: 60_000_001, cause: null, owner: true },
  ]);
  expect(idsOf(gone)).toEqual(["sasensi/lookover-sandbox"]);
  expect(gone.departed.map((r) => String(r.id))).toEqual(["lookover-dev/lookover-sandbox"]);
  expect(Object.keys(gone.changes)).toEqual([PLANTED]);
});

test("no account reached any more: every one departs with its repositories, and installing again brings them back", async () => {
  const { service, cookie, host, time } = await onTwoAccounts();
  host.uninstall(ORG.login);
  host.uninstall();
  await time.advance(5 * MIN);
  const gone = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.accounts.length === 0 && s.repos.length === 0,
  );
  expect(gone.connection.cause).toEqual({ kind: "uninstalled", suspended: false });
  expect(gone.connection.state).not.toBe("connected");
  expect(gone.departed.map((r) => String(r.id)).sort()).toEqual([
    "lookover-dev/lookover-sandbox",
    "sasensi/lookover-sandbox",
  ]);
  expect(gone.changes).toEqual({});

  // Installed again from the shared App's page: the next listing, a minute on, brings the account back.
  const installationId = host.install();
  await time.advance(MIN);
  const back = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.state === "connected" && s.repos.length === 1,
  );
  expect(back.connection.cause).toBeNull();
  expect(back.connection.accounts).toEqual([{ account: SASENSI, installationId, cause: null, owner: true }]);
  expect(idsOf(back)).toEqual(["sasensi/lookover-sandbox"]);
  expect(back.departed.map((r) => String(r.id))).toEqual(["lookover-dev/lookover-sandbox"]);
});
