// Another person's sign-in replacing the last on the shared App (ADR 0066): what was read for the person before is
// never applied as the new one's, and what was decided by who the person is is decided again. A discovery that
// started under the last sign-in and answers after the new one is held changes nothing; the pull requests already
// shown are the new person's or another's as the new person sees them, in the snapshot and in the events a tab
// replays. The service runs in this process on the fake host, its accounts held by a probe where a test needs it.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type HostAccount,
  type HostChange,
  type HostConversationComment,
  HostError,
  type HostIntake,
  type HostLogin,
  type HostSignIn,
  type Listing,
  type ReachedAccount,
  type RepositoryRef,
  type SignIn,
  type State,
  sameRepository,
} from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import { type GitHubSide, memoryKeychain, signInStore } from "./index.ts";
import {
  eventually,
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
const SHARED_BOT = { id: 2020, login: "lookover-dev[bot]" };
/** Another person, who signs in on the same machine in place of the owner and reaches the same repository. */
const BOB: HostLogin = { id: 5678, login: "bob" };
const userOnly = async () => {};

/** The owner's sign-in, as GitHub gives it: a token for 8 hours. */
const signInAt = (at: number): SignIn => ({
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: at + 8 * 3_600_000,
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: at + 180 * 86_400_000,
  person: { ...OWNER },
});

const stateOf = (service: Parameters<typeof snapshot>[0], cookie: string): Promise<State> =>
  snapshot(service, cookie);

/** A listing of the accounts held until the test answers it. */
interface Held {
  answer(reached: ReachedAccount[]): void;
}

/** A listing of a repository's pull requests (or its comments) held until the test answers or refuses it. */
interface HeldListing<T = HostChange> {
  answer(listing: Listing<T>): void;
  refuse(error: HostError): void;
}

/**
 * The shared App on the fake, signed in as the owner in `dir`; the device flow's next sign-in names Bob. With `hold`,
 * every listing of the accounts waits for the test to answer it (`held`, in the order they were asked); with
 * `holdListings` on, every listing of the pull requests of `o.listing` waits for the test (`listings`), and with
 * `holdComments` on, every listing of its comments (`comments`).
 */
async function sharedFor(host: FakeGitHost, dir: string, o: { hold: boolean; listing?: RepositoryRef }) {
  const signIns = signInStore({ home: dir, keychain: memoryKeychain(), userOnly });
  await signIns.write(signInAt(T0));
  const held: Held[] = [];
  let holding = false;
  const signIn: HostSignIn = {
    startSignIn: () => host.startSignIn(),
    pollSignIn: (grant) => host.pollSignIn(grant),
    person: async (token) => {
      await host.person(token);
      return { ...BOB };
    },
    refreshSignIn: (s) => host.refreshSignIn(s),
  };
  const accounts = () => ({
    person: () => host.person(),
    accounts: (): Promise<ReachedAccount[]> =>
      holding ? new Promise((resolve) => held.push({ answer: resolve })) : host.accounts(),
  });
  const listings: HeldListing[] = [];
  let holdingListings = false;
  const listOpenChanges = (repo: RepositoryRef): Promise<Listing<HostChange>> =>
    holdingListings && o.listing !== undefined && sameRepository(repo, o.listing)
      ? new Promise((resolve, reject) => listings.push({ answer: resolve, refuse: reject }))
      : host.listOpenChanges(repo);
  const comments: HeldListing<HostConversationComment>[] = [];
  let holdingComments = false;
  const listComments = (repo: RepositoryRef, since: number): Promise<Listing<HostConversationComment>> =>
    holdingComments && o.listing !== undefined && sameRepository(repo, o.listing)
      ? new Promise((resolve, reject) => comments.push({ answer: resolve, refuse: reject }))
      : host.listComments(repo, since);
  const intake: HostIntake = {
    listOpenChanges,
    listComments,
    getChange: (...a) => host.getChange(...a),
    threads: (...a) => host.threads(...a),
    poster: (...a) => host.poster(...a),
    countCommits: (...a) => host.countCommits(...a),
    fetchSpec: (...a) => host.fetchSpec(...a),
  };
  const github: GitHubSide = {
    installations: host,
    connect: () => ({ intake: host, writer: host }),
    shared: { signIn, signIns, accounts, connect: () => ({ intake, writer: host }) },
  };
  return {
    github,
    signIns,
    held,
    hold: (on: boolean) => (holding = on && o.hold),
    listings,
    holdListings: (on: boolean) => (holdingListings = on),
    comments,
    holdComments: (on: boolean) => (holdingComments = on),
  };
}

/** Waits for `holds` to hold, polled every 10 ms for 3 s. */
async function until(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !holds(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(holds()).toBe(true);
}

/** Bob signs in from the app in place of the owner: the code entered, the poll answered. */
async function bobSignsIn(
  service: Parameters<typeof post>[0],
  cookie: string,
  host: FakeGitHost,
  time: DemoClock,
) {
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("FAKE-0001");
  await time.advance(5_000);
  return eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.person?.id === BOB.id && s.connection.signIn === null,
  );
}

test("a discovery begun under the last sign-in that answers once another person is signed in changes nothing", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const shared = await sharedFor(host, dir, { hold: true });
  const { service } = await start({ home: dir, host, time, github: shared.github });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).repos.map((r) => String(r.id))).toEqual([
    "sasensi/lookover-sandbox",
  ]);

  // The five minutes' discovery asks the accounts as the owner, and GitHub hasn't answered yet.
  shared.hold(true);
  await time.advance(5 * MIN);
  await until(() => shared.held.length === 1);
  const asBob: State = await bobSignsIn(service, cookie, host, time);
  expect(asBob.connection).toMatchObject({ way: "shared", person: BOB });

  // The owner's listing answers now, reaching nothing: it is the last sign-in's, and nothing departs for it.
  shared.held[0]?.answer([]);
  await until(() => shared.held.length === 2);
  const after: State = await snapshot(service, cookie);
  expect(after.connection).toMatchObject({ id: "github:bob", way: "shared", person: BOB });
  expect(after.connection.cause).toBeNull();
  expect(after.repos.map((r) => String(r.id))).toEqual(["sasensi/lookover-sandbox"]);
  expect(Object.keys(after.changes)).toEqual([PLANTED]);

  // Bob's own listing, behind it, is the one followed.
  shared.hold(false);
  shared.held[1]?.answer(await host.accounts());
  const listed = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.accounts.length === 1,
  );
  expect(listed.repos.map((r) => String(r.id))).toEqual(["sasensi/lookover-sandbox"]);
});

test("another person signed in on a repository both reach: the pull requests shown are theirs or another's as they see it", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const shared = await sharedFor(host, dir, { hold: false });
  const { service } = await start({ home: dir, host, time, github: shared.github });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).changes[PLANTED]?.author).toBe("you");

  const asBob: State = await bobSignsIn(service, cookie, host, time);
  // The owner's pull request is another's for Bob, at once and in the events a tab replays (the snapshot is them).
  expect(asBob.changes[PLANTED]?.author).toBe("other");
  expect(asBob.changes[PLANTED]?.openedBy).toBe(OWNER.login);
  await service.stop();

  // A start on the same folder reads Bob's sign-in and the events: still another's.
  const again = await start({ home: dir, host, time, github: shared.github });
  const restarted: State = await snapshot(again.service, await openApp(again.service));
  expect(restarted.connection).toMatchObject({ id: "github:bob", person: BOB });
  expect(restarted.changes[PLANTED]?.author).toBe("other");
});

test("a sign-in replaced while the service was stopped: the connection names the new person at start", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const shared = await sharedFor(host, dir, { hold: false });
  const { service } = await start({ home: dir, host, time, github: shared.github });
  const cookie = await openApp(service);
  // Bob signs in from the app: the events name him.
  await bobSignsIn(service, cookie, host, time);
  await service.stop();

  // Another process on the folder kept the owner's sign-in meanwhile: the events replayed name Bob.
  await shared.signIns.write(signInAt(T0));
  const again = await start({ home: dir, host, time, github: shared.github });
  const restarted: State = await snapshot(again.service, await openApp(again.service));
  expect(restarted.connection).toMatchObject({ id: "github:sasensi", way: "shared", person: OWNER });
});

/** An organisation both people reach, and its repository. */
const ORG: HostAccount = { id: 9001, login: "lookover-dev", type: "Organization" };
const ORG_SANDBOX = { owner: ORG.login, name: SANDBOX.name };

test("a poll begun under the last sign-in that GitHub refuses for SSO once another person is signed in gives their account no cause", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    reaches: [{ account: ORG, repositories: [ORG_SANDBOX] }],
  });
  const shared = await sharedFor(host, dir, { hold: false, listing: ORG_SANDBOX });
  const { service } = await start({ home: dir, host, time, github: shared.github });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).connection.accounts.map((a) => a.cause)).toEqual([null, null]);

  // The minute's poll lists the organisation's pull requests as the owner, and GitHub hasn't answered yet.
  shared.holdListings(true);
  await time.advance(MIN);
  await until(() => shared.listings.length === 1);
  await bobSignsIn(service, cookie, host, time);

  // The owner's listing is refused for the owner's SSO session: it says nothing of Bob's.
  const sso = { kind: "sso", organisation: ORG.login, url: null } as const;
  shared.listings[0]?.refuse(
    new HostError("unauthorized", "Resource protected by organization SAML enforcement (403)", {
      connectionCause: sso,
    }),
  );
  // Bob's own poll of it, behind it, stays unanswered while the snapshot is read.
  await until(() => shared.listings.length === 2);
  const after: State = await stateOf(service, cookie);
  expect(after.connection).toMatchObject({ id: "github:bob", state: "connected", cause: null });
  expect(after.connection.accounts.map((a) => a.cause)).toEqual([null, null]);
  // Bob's answered at last, so the service can stop.
  shared.holdListings(false);
  shared.listings[1]?.refuse(new HostError("unavailable", "GitHub is busy"));
});

/** An organisation only the owner reaches, and its repository. */
const OWNERS_ORG: HostAccount = { id: 9002, login: "owners-labs", type: "Organization" };
const OWNERS_REPO = { owner: OWNERS_ORG.login, name: "tools" };

test("an install's check begun under the last sign-in that answers once another person is signed in is not their install", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    installed: false,
  });
  const shared = await sharedFor(host, dir, { hold: true });
  // Every listing of the accounts held from the start: the setup's first check of the install waits on GitHub.
  shared.hold(true);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: shared.github,
    setup: {
      done: false,
      step: "github",
      reached: "github",
      github: "waiting-for-install",
      githubRefused: null,
      firstReviewChange: null,
    },
  });
  const cookie = await openApp(service);
  await until(() => shared.held.length === 1);
  await bobSignsIn(service, cookie, host, time);

  // The owner's check answers now with the owner's organisation: it is not Bob's, and nothing is installed for him.
  shared.held[0]?.answer([
    {
      installation: { id: 70_000_001, account: OWNERS_ORG, suspended: false },
      repositories: [OWNERS_REPO],
      cause: null,
    },
  ]);
  await until(() => shared.held.length === 2);
  const after: State = await stateOf(service, cookie);
  expect(after.connection).toMatchObject({ id: null, person: BOB, accounts: [] });
  expect(after.setup.github).toBe("waiting-for-install");
  expect(after.repos).toEqual([]);
  // Bob's own check, behind it: nothing installed for him yet.
  shared.hold(false);
  shared.held[1]?.answer([]);
});

test("a repository's first poll begun under the last sign-in that answers once another person is signed in installs nothing for them", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    installed: false,
  });
  const shared = await sharedFor(host, dir, { hold: true, listing: OWNERS_REPO });
  shared.hold(true);
  shared.holdListings(true);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: shared.github,
    setup: {
      done: false,
      step: "github",
      reached: "github",
      github: "waiting-for-install",
      githubRefused: null,
      firstReviewChange: null,
    },
  });
  const cookie = await openApp(service);
  // The owner's check of the install reaches the owner's organisation; its new repository's first poll waits on GitHub.
  await until(() => shared.held.length === 1);
  shared.held[0]?.answer([
    {
      installation: { id: 70_000_001, account: OWNERS_ORG, suspended: false },
      repositories: [OWNERS_REPO],
      cause: null,
    },
  ]);
  await until(() => shared.listings.length === 1);
  await bobSignsIn(service, cookie, host, time);

  // The owner's poll answers now: what the owner's check read is not Bob's install, and nothing is installed for him.
  shared.listings[0]?.answer({ unchanged: false, items: [], at: time.now() });
  await until(() => shared.held.length === 2);
  const after: State = await stateOf(service, cookie);
  expect(after.connection).toMatchObject({ id: null, person: BOB, accounts: [] });
  expect(after.setup.github).toBe("waiting-for-install");

  // Bob's own check, behind it, is the one followed: his accounts and repositories alone.
  shared.hold(false);
  shared.holdListings(false);
  host.install();
  shared.held[1]?.answer(await host.accounts());
  const installed = await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  expect(installed.connection.accounts.map((a) => a.account.login)).toEqual(["sasensi"]);
  expect(installed.repos.map((r) => String(r.id))).toEqual(["sasensi/lookover-sandbox"]);
});

/** The owner's poll of the sandbox begun, its listing of the pull requests held, then Bob signed in. */
async function pollHeldThenBob() {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const shared = await sharedFor(host, dir, { hold: false, listing: SANDBOX });
  const { service } = await start({ home: dir, host, time, github: shared.github });
  const cookie = await openApp(service);
  shared.holdListings(true);
  await time.advance(MIN);
  await until(() => shared.listings.length === 1);
  await bobSignsIn(service, cookie, host, time);
  return { host, shared, service, cookie };
}

test("a poll begun under the last sign-in that GitHub refuses as signed out once another person is signed in leaves them connected", async () => {
  const { host, shared, service, cookie } = await pollHeldThenBob();

  // The owner's sign-in is refused now: it says nothing of Bob's.
  shared.listings[0]?.refuse(
    new HostError("unauthorized", "Bad credentials (401)", { connectionCause: { kind: "signed-out" } }),
  );
  await until(() => shared.listings.length === 2);
  const after: State = await stateOf(service, cookie);
  expect(after.connection).toMatchObject({ id: "github:bob", state: "connected", cause: null });
  // Bob's own poll, behind it, answered so the service can stop.
  shared.holdListings(false);
  shared.listings[1]?.answer(await host.listOpenChanges(SANDBOX));
});

test("a poll begun under the last sign-in that lists nothing once another person is signed in closes nothing", async () => {
  const { host, shared, service, cookie } = await pollHeldThenBob();

  // The owner's listing answers empty now: it is not what Bob sees, and the pull request stays open.
  shared.listings[0]?.answer({ unchanged: false, items: [], at: T0 + MIN });
  await until(() => shared.listings.length === 2);
  const after: State = await stateOf(service, cookie);
  expect(Object.keys(after.changes)).toEqual([PLANTED]);
  shared.holdListings(false);
  shared.listings[1]?.answer(await host.listOpenChanges(SANDBOX));
});

test("a poll whose comments were read under the last sign-in, answered once another person is signed in, hands over no request", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const shared = await sharedFor(host, dir, { hold: false, listing: SANDBOX });
  const { service } = await start({ home: dir, host, time, github: shared.github });
  const cookie = await openApp(service);
  host.seedComment({ repo: SANDBOX, number: 1 }, { author: BOB, body: "/lookover review" });

  // The owner's poll listed the pull requests; its listing of the comments waits on GitHub while Bob signs in.
  shared.holdComments(true);
  await time.advance(MIN);
  await until(() => shared.comments.length === 1);
  await bobSignsIn(service, cookie, host, time);

  // The owner's read answers now, Bob's request in it: it is the last sign-in's, and nothing is handed over.
  shared.comments[0]?.answer(await host.listComments(SANDBOX, T0));
  await until(() => shared.comments.length === 2);
  const after: State = await stateOf(service, cookie);
  expect(after.reviews[PLANTED]?.job ?? null).toBeNull();

  // Bob's own read, behind it, hands it over.
  shared.holdComments(false);
  shared.comments[1]?.answer(await host.listComments(SANDBOX, T0));
  const asked = await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job != null,
  );
  expect(asked.reviews[PLANTED]?.job).toMatchObject({ trigger: "comment" });
});
