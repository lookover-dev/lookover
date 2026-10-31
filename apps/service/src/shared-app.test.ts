// The shared App, end to end on the fake (ADR 0065, ADR 0066): a person signs in from the setup with GitHub's device
// flow, their sign-in kept sealed in the data folder, and their pull requests are reviewed, Lookover posting as them;
// a crash mid-post resumes with one review; none of Lookover's posts, now the person's comments, is read as a request;
// a data folder with its own App stays on it, a sign-in beside it or not. The service runs in this process on the
// fake host, which plays GitHub's device flow, the accounts the sign-in reaches and the ports as the person.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { HostError, type SignIn, type State } from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import {
  appStore,
  type GitHubSide,
  type Keychain,
  memoryKeychain,
  type RunningService,
  signInStore,
} from "./index.ts";
import {
  BOT,
  eventually,
  fakeEngines,
  home,
  lastEvent,
  OWNER,
  openApp,
  PLANTED,
  personalApp,
  post,
  pr1,
  review,
  SANDBOX,
  SHA1,
  sinceStart,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const PR1 = { repo: SANDBOX, number: 1 };
/** The shared App's bot on the fake: on `shared` it never posts, the person does. */
const SHARED_BOT = { id: 2020, login: "lookover-dev[bot]" };
const userOnly = async () => {};
/** A setup at its GitHub step, nothing asked of GitHub yet: what a fresh data folder shows there. */
const AT_GITHUB = {
  done: false,
  step: "github",
  reached: "github",
  github: "start",
  githubRefused: null,
  firstReviewChange: null,
} as const;

/** The fake GitHub with the person signed in to the shared App, installed on their own account. */
const sharedHost = (time: DemoClock, o: { installed?: boolean } = {}) =>
  new FakeGitHost({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time, ...o });

/** The person's sign-in, as GitHub gives it: a token for 8 hours. */
const signInAt = (at: number): SignIn => ({
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: at + 8 * 3_600_000,
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: at + 180 * 86_400_000,
  person: { ...OWNER },
});

/**
 * GitHub as the fake plays it for a data folder that keeps its own App store and sign-in store on `keychain`: the
 * shared App offered, its device flow, its accounts and its ports the fake's; the own App's the fake's too.
 */
function onShared(host: FakeGitHost, dir: string, keychain: Keychain): GitHubSide {
  return {
    installations: host,
    connect: ({ key }) => {
      host.useKey(key);
      return { intake: host, writer: host };
    },
    apps: appStore({ home: dir, keychain, userOnly }),
    shared: {
      signIn: host,
      signIns: signInStore({ home: dir, keychain, userOnly }),
      accounts: () => host,
      connect: () => ({ intake: host, writer: host }),
    },
  };
}

/** The snapshot now. */
const stateOf = async (service: RunningService, cookie: string): Promise<State> => snapshot(service, cookie);

test("signed in from the setup, the person's pull request is reviewed on the shared App, posted as them", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time);
  const engines = fakeEngines({ reviews: 1, time });
  const { service } = await start({
    home: dir,
    host,
    time,
    engines,
    github: onShared(host, dir, keychain),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  const before: State = await snapshot(service, cookie);
  expect(before.connection).toMatchObject({ way: null, signIn: null, state: "not-connected", bot: null });

  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  const waiting: State = await snapshot(service, cookie);
  expect(waiting.connection.signIn).toEqual({
    userCode: "FAKE-0001",
    verificationUri: "https://github.com/login/device",
    expiresAt: T0 + 900_000,
  });
  // A second sign-in while one waits is refused.
  const again = await post(service, cookie, { type: "connection.signIn" });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ signIn: "pending" });

  host.enterCode("FAKE-0001");
  await time.advance(5_000);
  const connected = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.state === "connected",
  );
  expect(connected.connection).toMatchObject({
    id: "github:sasensi",
    way: "shared",
    signIn: null,
    bot: null,
    app: null,
  });
  expect(connected.setup.github).toBe("done");
  expect(Object.keys(connected.changes)).toEqual([PLANTED]);
  expect(connected.changes[PLANTED]?.author).toBe("you");
  // Kept sealed in the data folder: a start reads it again.
  const kept = await signInStore({ home: dir, keychain, userOnly }).read();
  expect(kept).toMatchObject({ state: "kept", signIn: { person: OWNER } });

  expect((await review(service, cookie)).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  const shown = host.view(PR1);
  expect(shown.reviews).toHaveLength(1);
  expect(shown.comments.map((c) => c.author.id)).toEqual([OWNER.id]);
  expect(shown.checks.map((c) => `${c.status} ${c.conclusion}`)).toEqual(["completed success"]);
});

test("a sign-in GitHub refuses, or whose code expires, shows no code any more; a cancelled one neither", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, memoryKeychain()),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  const signIn = () => post(service, cookie, { type: "connection.signIn" });

  await signIn();
  host.denyCode("FAKE-0001");
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );

  await signIn();
  // Never entered: polled every 5 s, then ended at the code's expiry, 15 minutes on.
  await time.advance(899_000);
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("FAKE-0002");
  await time.advance(1_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );

  await signIn();
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("FAKE-0003");
  expect((await post(service, cookie, { type: "connection.cancelSignIn" })).status).toBe(200);
  expect((await stateOf(service, cookie)).connection.signIn).toBeNull();
  // Entered after the cancel: nothing polls it any more.
  host.enterCode("FAKE-0003");
  await time.advance(10_000);
  const after: State = await snapshot(service, cookie);
  expect(after.connection).toMatchObject({ way: null, signIn: null, state: "not-connected" });
  expect(await signInStore({ home: dir, keychain: memoryKeychain(), userOnly }).read()).toEqual({
    state: "none",
  });
});

/**
 * A host that keeps the first review it is asked to post, then holds its answer until `stopped`, and fails it then:
 * the service stopped after GitHub accepted the review and before Lookover marked it sent (ADR 0056).
 */
class KeptThenStopped extends FakeGitHost {
  private armed = true;
  private heard = () => {};
  readonly kept = new Promise<void>((resolve) => {
    this.heard = resolve;
  });
  private stop = () => {};
  private readonly stoppedYet = new Promise<void>((resolve) => {
    this.stop = resolve;
  });

  stopped(): void {
    this.stop();
  }

  override async publishReview(...args: Parameters<FakeGitHost["publishReview"]>): Promise<string> {
    const id = await super.publishReview(...args);
    if (!this.armed) return id;
    this.armed = false;
    this.heard();
    await this.stoppedYet;
    throw new Error("the service stopped while GitHub answered the review");
  }
}

test("a service stopped mid-post on the shared App resumes after the restart: one review, posted as the person", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const host = new KeptThenStopped({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const engines = fakeEngines({ reviews: 1, time });
  const github = onShared(host, dir, keychain);
  const first = await start({ home: dir, host, time, engines, github });
  const cookie = await openApp(first.service);
  expect((await stateOf(first.service, cookie)).connection).toMatchObject({
    id: "github:sasensi",
    way: "shared",
    state: "connected",
    bot: null,
  });
  await review(first.service, cookie);
  await host.kept;
  await first.service.stop();
  host.stopped();
  await time.advance(0);
  expect(host.view(PR1).reviews).toHaveLength(1);

  const last = lastEvent(dir);
  const second = await start({
    home: dir,
    host,
    time,
    engines,
    github: onShared(host, dir, keychain),
    idsFrom: 100,
  });
  const seen = await until(
    await sinceStart(second.service, await openApp(second.service), last),
    "round.finished",
  );
  expect(seen.at(-1)).toMatchObject({ job: { state: "done" }, round: { n: 1, sha: SHA1 } });
  expect(engines.runs).toHaveLength(1);
  const shown = host.view(PR1);
  expect(shown.reviews).toHaveLength(1);
  expect(shown.comments.map((c) => c.author.id)).toEqual([OWNER.id]);
  expect(shown.checks.map((c) => `${c.status} ${c.conclusion}`)).toEqual(["completed success"]);
});

test("none of Lookover's posts, the person's comments on the shared App, is read as a request; the person's own is", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const host = sharedHost(time);
  const engines = fakeEngines({ reviews: 2, time });
  const { service } = await start({ home: dir, host, time, engines, github: onShared(host, dir, keychain) });
  const cookie = await openApp(service);
  await review(service, cookie);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  // The summary is the person's comment, through the App: polled for an hour, it asks for nothing.
  expect(host.view(PR1).comments.map((c) => c.author.id)).toEqual([OWNER.id]);
  for (let i = 0; i < 60; i++) await time.advance(60_000);
  expect(engines.runs).toHaveLength(1);
  expect((await stateOf(service, cookie)).reviews[PLANTED]?.rounds).toHaveLength(1);

  // The person's own request, by hand, is one.
  host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  await time.advance(60_000);
  const asked = await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.trigger === "comment" && s.reviews[PLANTED]?.job?.state === "done",
  );
  expect(asked.reviews[PLANTED]?.rounds).toHaveLength(2);
  expect(engines.runs).toHaveLength(2);
});

test("a data folder with its own App stays on it, a sign-in kept beside it: the bot posts (as bun dev --live needs)", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  await appStore({ home: dir, keychain, userOnly }).write(
    personalApp(1, "lookover-spike-sasensi"),
    host.credentials().key,
  );
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const engines = fakeEngines({ reviews: 1, time });
  const { service } = await start({ home: dir, host, time, engines, github: onShared(host, dir, keychain) });
  const cookie = await openApp(service);
  const state: State = await snapshot(service, cookie);
  expect(state.connection).toMatchObject({
    way: "own",
    bot: BOT.login,
    id: `github:${BOT.login}`,
    state: "connected",
  });
  // A sign-in is refused while the own App is used.
  const refused = await post(service, cookie, { type: "connection.signIn" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ signIn: "own-app" });
  await review(service, cookie);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  expect(host.view(PR1).comments.map((c) => c.author.id)).toEqual([BOT.id]);
  // The sign-in beside it is left as it was.
  expect((await signInStore({ home: dir, keychain, userOnly }).read()).state).toBe("kept");
});

test("signed in with the shared App installed nowhere yet, the connection names the person at once; a start reads them again; your own App clears them", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time, { installed: false });
  const github = onShared(host, dir, keychain);
  const { service } = await start({ home: dir, host, time, github, setup: AT_GITHUB });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).connection.person).toBeNull();

  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("FAKE-0001");
  await time.advance(5_000);
  const signedIn = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.way === "shared",
  );
  // No account reached, so no id yet: who signed in is said all the same.
  expect(signedIn.connection).toMatchObject({ id: null, accounts: [], person: OWNER });

  const { id, key } = host.credentials();
  expect((await post(service, cookie, { type: "connection.useApp", appId: id, key })).status).toBe(200);
  const own = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.way === "own",
  );
  expect(own.connection.person).toBeNull();
});

test("a folder signed in to the shared App starts with its person on the connection", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const host = sharedHost(time);
  const { service } = await start({ home: dir, host, time, github: onShared(host, dir, keychain) });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).connection).toMatchObject({ way: "shared", person: OWNER });
});

test("asking to install on an account Lookover doesn't name is refused, saying so; on your own App, as not shared", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const host = sharedHost(time);
  const { service } = await start({ home: dir, host, time, github: onShared(host, dir, keychain) });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).connection).toMatchObject({ way: "shared", unreached: [] });
  const notNamed = await post(service, cookie, { type: "connection.askToInstall", account: "ledger-dev" });
  expect(notNamed.status).toBe(409);
  expect(await notNamed.json()).toMatchObject({ askToInstall: "not-named" });

  const ownDir = home();
  const own = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  await appStore({ home: ownDir, keychain, userOnly }).write(
    personalApp(1, "lookover-spike-sasensi"),
    own.credentials().key,
  );
  const onOwn = await start({ home: ownDir, host: own, time, github: onShared(own, ownDir, keychain) });
  const ownCookie = await openApp(onOwn.service);
  const notShared = await post(onOwn.service, ownCookie, {
    type: "connection.askToInstall",
    account: "ledger-dev",
  });
  expect(notShared.status).toBe(409);
  expect(await notShared.json()).toMatchObject({ askToInstall: "not-shared" });
  expect((await stateOf(onOwn.service, ownCookie)).connection.unreached).toEqual([]);
});

test("asking to install names an account: none is refused before it is read", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time);
  const { service } = await start({ home: dir, host, time, github: onShared(host, dir, memoryKeychain()) });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "connection.askToInstall", account: "" })).status).toBe(400);
  expect((await post(service, cookie, { type: "connection.askToInstall" })).status).toBe(400);
});

test("Use your own App on a folder signed in to the shared App moves it to own without a restart: the bot's connection", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const host = sharedHost(time);
  const { service } = await start({ home: dir, host, time, github: onShared(host, dir, keychain) });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).connection).toMatchObject({ way: "shared", id: "github:sasensi" });
  const { id, key } = host.credentials();
  expect((await post(service, cookie, { type: "connection.useApp", appId: id, key })).status).toBe(200);
  const own = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.way === "own",
  );
  expect(own.connection).toMatchObject({
    id: `github:${SHARED_BOT.login}`,
    bot: SHARED_BOT.login,
    app: { id },
    state: "connected",
  });
  // The sign-in stays beside it; the own App wins at the next start too.
  expect((await signInStore({ home: dir, keychain, userOnly }).read()).state).toBe("kept");
});

test("a poll GitHub can't answer is polled again; Sign in again on a set-up folder keeps it connected, the new sign-in kept", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const host = sharedHost(time);
  const { service } = await start({ home: dir, host, time, github: onShared(host, dir, keychain) });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("FAKE-0001");
  host.refuse("unavailable");
  await time.advance(5_000);
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("FAKE-0001");
  host.refuse(null);
  await time.advance(5_000);
  const back = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );
  expect(back.connection).toMatchObject({ id: "github:sasensi", way: "shared", state: "connected" });
  const kept = await signInStore({ home: dir, keychain, userOnly }).read();
  // The fake's token, not the one written by hand: the new sign-in replaced the last.
  expect(kept).toMatchObject({ state: "kept", signIn: { person: OWNER } });
  expect(kept.state === "kept" ? kept.signIn.token : null).not.toBe(signInAt(T0).token);
});

test("GitHub failing to say who signed in keeps the tokens: asked again, never the code, and the person signs in", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, keychain),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("FAKE-0001");
  host.refuseSignInPerson("unavailable");
  await time.advance(5_000);
  // The code is spent; the sign-in waits on who the person is.
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("FAKE-0001");
  await time.advance(5_000);
  const connected = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.way === "shared",
  );
  expect(connected.connection).toMatchObject({ id: "github:sasensi", signIn: null });
  await time.advance(60_000);
  // One exchange: the code polled once, when it gave the tokens.
  expect(host.codePolls("FAKE-0001")).toEqual([T0 + 5_000]);
  expect(await signInStore({ home: dir, keychain, userOnly }).read()).toMatchObject({
    state: "kept",
    signIn: { person: OWNER },
  });
});

test("GitHub refusing the new token ends the sign-in: nothing kept, the code polled once", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, keychain),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  await post(service, cookie, { type: "connection.signIn" });
  host.enterCode("FAKE-0001");
  host.refuseSignInPerson("unauthorized");
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );
  await time.advance(60_000);
  expect(host.codePolls("FAKE-0001")).toEqual([T0 + 5_000]);
  expect((await stateOf(service, cookie)).connection.way).toBeNull();
  expect(await signInStore({ home: dir, keychain, userOnly }).read()).toEqual({ state: "none" });
});

test("GitHub asking to slow down: 5 s more kept for every later poll, none at the old interval", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, memoryKeychain()),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  await post(service, cookie, { type: "connection.signIn" });
  host.slowDownCode("FAKE-0001");
  for (let i = 0; i < 5; i++) await time.advance(5_000);
  expect(host.codePolls("FAKE-0001")).toEqual([T0 + 5_000, T0 + 15_000, T0 + 25_000]);
});

test("a code never entered ends exactly at its expiry, never polled then", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, memoryKeychain()),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  await post(service, cookie, { type: "connection.signIn" });
  const expiresAt = (await stateOf(service, cookie)).connection.signIn?.expiresAt ?? 0;
  expect(expiresAt).toBe(T0 + 900_000);
  await time.advance(expiresAt - T0 - 1);
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("FAKE-0001");
  await time.advance(1);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );
  expect(Math.max(...host.codePolls("FAKE-0001"))).toBeLessThan(expiresAt);
});

/** A host whose polls of the code are held until `letGo`: GitHub slow to answer one (or a rate limit held there). */
class SlowPoll extends FakeGitHost {
  private release = () => {};
  private readonly answered = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  letGo(): void {
    this.release();
  }

  override async pollSignIn(
    grant: Parameters<FakeGitHost["pollSignIn"]>[0],
  ): ReturnType<FakeGitHost["pollSignIn"]> {
    await this.answered;
    return super.pollSignIn(grant);
  }
}

test("a code never entered ends at its expiry even while GitHub hasn't answered its last poll", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new SlowPoll({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, memoryKeychain()),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  await post(service, cookie, { type: "connection.signIn" });
  // The first poll, at 5 s, is held: nothing answers it until long after the code's 15 minutes.
  await time.advance(5_000);
  await time.advance(900_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );
  host.letGo();
  await time.advance(60_000);
  expect((await stateOf(service, cookie)).connection).toMatchObject({ signIn: null, way: null });
});

/** A host whose device code is asked of it and held until `letGo`: GitHub slow to give one. */
class SlowCode extends FakeGitHost {
  private release = () => {};
  private readonly answered = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  letGo(): void {
    this.release();
  }

  override async startSignIn(): ReturnType<FakeGitHost["startSignIn"]> {
    await this.answered;
    return super.startSignIn();
  }
}

test("a sign-in cancelled while GitHub gives its code shows no code once it comes, and never polls it", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new SlowCode({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, memoryKeychain()),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  const started = post(service, cookie, { type: "connection.signIn" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await post(service, cookie, { type: "connection.cancelSignIn" })).status).toBe(200);
  host.letGo();
  expect((await started).status).toBe(200);
  expect((await stateOf(service, cookie)).connection.signIn).toBeNull();
  host.enterCode("FAKE-0001");
  await time.advance(30_000);
  expect(host.codePolls("FAKE-0001")).toEqual([]);
  expect((await stateOf(service, cookie)).connection.way).toBeNull();
});

/** A host that holds its answer describing an App until `letGo`: "Use your own App" checking it, slowly. */
class SlowApp extends FakeGitHost {
  private release = () => {};
  private readonly answered = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private heard = () => {};
  readonly asked = new Promise<void>((resolve) => {
    this.heard = resolve;
  });

  letGo(): void {
    this.release();
  }

  override async app(...args: Parameters<FakeGitHost["app"]>): ReturnType<FakeGitHost["app"]> {
    this.heard();
    await this.answered;
    return super.app(...args);
  }
}

test("a sign-in entered while your own App is being adopted: the own App wins, nothing kept, the code gone", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const host = new SlowApp({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, keychain),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  const { id, key } = host.credentials();
  const used = post(service, cookie, { type: "connection.useApp", appId: id, key });
  await host.asked;
  host.enterCode("FAKE-0001");
  await time.advance(5_000);
  expect(host.codePolls("FAKE-0001")).toEqual([T0 + 5_000]);
  host.letGo();
  expect((await used).status).toBe(200);
  const own = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.way === "own" && s.connection.signIn === null,
  );
  expect(own.connection).toMatchObject({ app: { id }, bot: SHARED_BOT.login });
  await time.advance(10_000);
  expect((await stateOf(service, cookie)).connection.way).toBe("own");
  expect(await signInStore({ home: dir, keychain, userOnly }).read()).toEqual({ state: "none" });
});

test("your own App adopted while a sign-in waits ends the sign-in: its code gone, never polled again", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, memoryKeychain()),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  await post(service, cookie, { type: "connection.signIn" });
  const { id, key } = host.credentials();
  expect((await post(service, cookie, { type: "connection.useApp", appId: id, key })).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.way === "own" && s.connection.signIn === null,
  );
  host.enterCode("FAKE-0001");
  await time.advance(30_000);
  expect(host.codePolls("FAKE-0001")).toEqual([]);
});

/**
 * GitHub as `onShared` plays it, the accounts read through the sign-in `keeper` keeps, as the real adapter reads
 * them: none kept (lost, or never kept), every call refused signed out.
 */
function keeperChecked(host: FakeGitHost, dir: string, keychain: Keychain): GitHubSide {
  const side = onShared(host, dir, keychain);
  const { shared } = side;
  if (shared === undefined) throw new Error("onShared offers the shared App");
  const signedOut = () =>
    new HostError("unauthorized", "Nobody is signed in to the shared App", {
      connectionCause: { kind: "signed-out" },
    });
  return {
    ...side,
    shared: {
      ...shared,
      accounts: (keeper) => ({
        person: async () => {
          if ((await keeper.read()) === null) throw signedOut();
          return host.person();
        },
        accounts: async () => {
          if ((await keeper.read()) === null) throw signedOut();
          return host.accounts();
        },
      }),
    },
  };
}

/** Signed in from the setup before the shared App is installed, then the service stopped. */
async function signedInNotInstalled(dir: string, time: DemoClock, host: FakeGitHost): Promise<void> {
  const first = await start({
    home: dir,
    host,
    time,
    github: keeperChecked(host, dir, memoryKeychain()),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(first.service);
  await post(first.service, cookie, { type: "connection.signIn" });
  host.enterCode("FAKE-0001");
  await time.advance(5_000);
  await eventually(
    () => snapshot(first.service, cookie),
    (s) => s.connection.way === "shared" && s.connection.signIn === null,
  );
  await first.service.stop();
}

test("signed in before the install, then the keychain lost: the setup says signed out, and a new sign-in replaces it", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time, { installed: false });
  await signedInNotInstalled(dir, time, host);

  // Another keychain: the sign-in kept no longer opens.
  const keychain = memoryKeychain();
  const { service } = await start({
    home: dir,
    host,
    time,
    github: keeperChecked(host, dir, keychain),
    idsFrom: 100,
  });
  const cookie = await openApp(service);
  await time.advance(5_000);
  const out = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.cause?.kind === "signed-out",
  );
  expect(out.connection).toMatchObject({ way: "shared", person: OWNER });
  expect(out.setup.github).toBe("waiting-for-install");

  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  const code = (await stateOf(service, cookie)).connection.signIn?.userCode ?? "";
  host.enterCode(code);
  await time.advance(5_000);
  const back = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null && s.connection.cause === null,
  );
  expect(back.connection).toMatchObject({ way: "shared", person: OWNER });
  expect((await signInStore({ home: dir, keychain, userOnly }).read()).state).toBe("kept");

  host.install();
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done" && s.connection.state === "connected",
  );
});

test("signed in before the install, then the keychain lost: Use your own App moves it to own", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time, { installed: false });
  await signedInNotInstalled(dir, time, host);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: keeperChecked(host, dir, memoryKeychain()),
    idsFrom: 100,
  });
  const cookie = await openApp(service);
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.cause?.kind === "signed-out",
  );
  const { id, key } = host.credentials();
  expect((await post(service, cookie, { type: "connection.useApp", appId: id, key })).status).toBe(200);
  const own = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.way === "own",
  );
  expect(own.connection).toMatchObject({ app: { id }, person: null });
});
