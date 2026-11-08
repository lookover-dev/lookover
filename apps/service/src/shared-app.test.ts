// The shared App, end to end on the fake (ADR 0065, ADR 0066): a person signs in from the setup with GitHub's device
// flow, their sign-in kept sealed in the data folder, and their pull requests are reviewed, Lookover posting as them;
// a crash mid-post resumes with one review; none of Lookover's posts, now the person's comments, is read as a request;
// a data folder holding an App of its own from an earlier version and no sign-in starts at the setup's GitHub step. The service runs in this process on the
// fake host, which plays GitHub's device flow, the accounts the sign-in reaches and the ports as the person.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeId, HostError, type SignIn, type State } from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import { type GitHubSide, type Keychain, memoryKeychain, type RunningService, signInStore } from "./index.ts";
import {
  blockOn,
  eventually,
  fakeEngines,
  home,
  lastEvent,
  ONE_FINDING,
  OWNER,
  onTheDiff,
  openApp,
  PLANTED,
  post,
  pr1,
  review,
  SANDBOX,
  SHA1,
  SHARED_BOT,
  setupOn,
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

const userOnly = async () => {};
/** A setup at its GitHub step, nothing asked of GitHub yet: what a fresh data folder shows there. */
const AT_GITHUB = {
  done: false,
  step: "github",
  reached: "github",
  github: "start",
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
 * GitHub as the fake plays it for a data folder that keeps its sign-in store on `keychain`: the shared App offered, its
 * device flow, its accounts and its ports the fake's.
 */
function onShared(host: FakeGitHost, dir: string, keychain: Keychain): GitHubSide {
  return {
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

test("a test's service runs signed in to the shared App unless it says, the sandbox's pull request posted as the owner", async () => {
  const { service, host } = await start({ engines: fakeEngines({ reviews: 1 }) });
  const cookie = await openApp(service);
  expect((await review(service, cookie)).status).toBe(200);
  const state = await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  expect(state.connection).toMatchObject({
    state: "connected",
    person: { id: OWNER.id, login: OWNER.login },
  });
  // A round with no line comment posts no review (ADR 0074): its status block is the person's.
  expect(host.reviewers(PR1)).toEqual([]);
  expect(host.view(PR1).comments).toEqual([]);
  expect(blockOn(host, PR1)).toContain(" · Nothing to fix");
});

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
  expect(before.connection).toMatchObject({ person: null, signIn: null, state: "not-connected" });

  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  const waiting: State = await snapshot(service, cookie);
  expect(waiting.connection.signIn).toEqual({
    userCode: "D054-61DC",
    verificationUri: "https://github.com/login/device",
    expiresAt: T0 + 900_000,
  });
  // A second sign-in while one waits is refused.
  const again = await post(service, cookie, { type: "connection.signIn" });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ signIn: "pending" });

  host.enterCode("D054-61DC");
  await time.advance(5_000);
  const connected = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.state === "connected",
  );
  expect(connected.connection).toMatchObject({
    id: "github:sasensi",
    signIn: null,
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
  expect(shown.reviews).toEqual([]);
  expect(shown.comments).toEqual([]);
  expect(blockOn(host, PR1)).toContain(" · Nothing to fix");
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
  host.denyCode("D054-61DC");
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );

  await signIn();
  // Never entered: polled every 5 s, then ended at the code's expiry, 15 minutes on.
  await time.advance(899_000);
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("D054-61DD");
  await time.advance(1_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );

  await signIn();
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("D054-61DE");
  expect((await post(service, cookie, { type: "connection.cancelSignIn" })).status).toBe(200);
  expect((await stateOf(service, cookie)).connection.signIn).toBeNull();
  // Entered after the cancel: nothing polls it any more.
  host.enterCode("D054-61DE");
  await time.advance(10_000);
  const after: State = await snapshot(service, cookie);
  expect(after.connection).toMatchObject({ person: null, signIn: null, state: "not-connected" });
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
  const engines = fakeEngines({ time });
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const retrieval = onTheDiff();
  const github = onShared(host, dir, keychain);
  const first = await start({ home: dir, host, time, engines, retrieval, github });
  const cookie = await openApp(first.service);
  expect((await stateOf(first.service, cookie)).connection).toMatchObject({
    id: "github:sasensi",
    state: "connected",
  });
  await review(first.service, cookie);
  await host.kept;
  await first.service.stop();
  host.stopped();
  await time.advance(0);
  expect(host.view(PR1).reviews).toHaveLength(1);
  const ran = engines.runs.length;

  const last = lastEvent(dir);
  const second = await start({
    home: dir,
    host,
    time,
    engines,
    retrieval,
    github: onShared(host, dir, keychain),
    idsFrom: 100,
  });
  const seen = await until(
    await sinceStart(second.service, await openApp(second.service), last),
    "round.finished",
  );
  expect(seen.at(-1)).toMatchObject({ job: { state: "done" }, round: { n: 1, sha: SHA1 } });
  expect(engines.runs).toHaveLength(ran);
  const shown = host.view(PR1);
  expect(host.reviewers(PR1)).toEqual([OWNER.login]);
  expect(shown.reviews.map((r) => r.comments.length)).toEqual([1]);
  expect(shown.comments).toEqual([]);
  expect(blockOn(host, PR1)).toContain("The key is logged");
  expect(shown.checks.map((c) => c.status)).toEqual(["completed"]);
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
  // The status block is in the person's description, never a comment: polled for an hour, it asks for nothing.
  expect(host.view(PR1).comments).toEqual([]);
  expect(blockOn(host, PR1)).not.toBe("");
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

test("a folder holding an App of its own from an earlier version and no sign-in starts at the setup's GitHub step", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  // What an earlier version kept of its own App: read no more.
  mkdirSync(join(dir, "github"), { recursive: true });
  writeFileSync(
    join(dir, "github", "app.json"),
    JSON.stringify({ id: 1, slug: "lookover-spike-sasensi", key: { protection: "keychain" } }),
  );
  const host = sharedHost(time);
  const { service } = await start({ home: dir, host, time, github: onShared(host, dir, memoryKeychain()) });
  const cookie = await openApp(service);
  const state = await stateOf(service, cookie);
  expect(state.setup).toMatchObject({ done: false, step: "github", github: "start" });
  expect(state.connection).toMatchObject({ id: null, state: "not-connected", person: null });
  // The sign-in is offered: nothing else holds GitHub here.
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  // Read no more, and left where it was.
  expect(existsSync(join(dir, "github", "app.json"))).toBe(true);
});

test("a start with the sign-in gone sends setup back to the GitHub step, the furthest reached too: the repositories are chosen again before anything is asked (ADR 0079)", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time);
  const SEVEN = changeId("sasensi/lookover-sandbox#7");
  const { service } = await start({
    home: dir,
    host,
    time,
    github: onShared(host, dir, memoryKeychain()),
    setup: setupOn("agent"),
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).setup).toEqual(AT_GITHUB);

  // Whoever signs in next installs and is shown the Repositories step: a pull request opened meanwhile asks nothing.
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("D054-61DC");
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  host.open({ ...pr1, number: 7, head: { ref: "branch-7", sha: SHA1 } });
  // Listed within a few polls, seen open: asked nothing.
  for (let polls = 0; polls < 5 && !(await stateOf(service, cookie)).changes[SEVEN]; polls++)
    await time.advance(60_000);
  // One poll more: a job asked on listing would have run and posted by now.
  await time.advance(60_000);
  const state = await stateOf(service, cookie);
  expect(Object.keys(state.changes)).toContain(SEVEN);
  expect(state.reviews[SEVEN]?.job ?? null).toBeNull();
  expect(state.setup).toMatchObject({ done: false, reached: "repos" });
  expect(host.posts).toEqual([]);
});

test("signed in with the shared App installed nowhere yet, the connection names the person at once", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const host = sharedHost(time, { installed: false });
  const github = onShared(host, dir, keychain);
  const { service } = await start({ home: dir, host, time, github, setup: AT_GITHUB });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).connection.person).toBeNull();

  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("D054-61DC");
  await time.advance(5_000);
  const signedIn = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.person !== null,
  );
  // No account reached, so no id yet: who signed in is said all the same.
  expect(signedIn.connection).toMatchObject({ id: null, accounts: [], person: OWNER });
});

test("a folder signed in to the shared App starts with its person on the connection", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const host = sharedHost(time);
  const { service } = await start({ home: dir, host, time, github: onShared(host, dir, keychain) });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).connection).toMatchObject({ person: OWNER });
});

test("asking to install on an account Lookover doesn't name is refused, saying so; with nobody signed in, as signed out", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const host = sharedHost(time);
  const { service } = await start({ home: dir, host, time, github: onShared(host, dir, keychain) });
  const cookie = await openApp(service);
  expect((await stateOf(service, cookie)).connection).toMatchObject({ unreached: [] });
  const notNamed = await post(service, cookie, { type: "connection.askToInstall", account: "ledger-dev" });
  expect(notNamed.status).toBe(409);
  expect(await notNamed.json()).toMatchObject({ askToInstall: "not-named" });

  const outDir = home();
  const out = sharedHost(time);
  const signedOut = await start({ home: outDir, host: out, time, github: onShared(out, outDir, keychain) });
  const outCookie = await openApp(signedOut.service);
  const refused = await post(signedOut.service, outCookie, {
    type: "connection.askToInstall",
    account: "ledger-dev",
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ askToInstall: "signed-out" });
  expect((await stateOf(signedOut.service, outCookie)).connection.unreached).toEqual([]);
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

test("a poll GitHub can't answer is polled again; Sign in again on a set-up folder keeps it connected, the new sign-in kept", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  const host = sharedHost(time);
  const { service } = await start({ home: dir, host, time, github: onShared(host, dir, keychain) });
  const cookie = await openApp(service);
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("D054-61DC");
  host.refuse("unavailable");
  await time.advance(5_000);
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("D054-61DC");
  host.refuse(null);
  await time.advance(5_000);
  const back = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );
  expect(back.connection).toMatchObject({ id: "github:sasensi", state: "connected" });
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
  host.enterCode("D054-61DC");
  host.refuseSignInPerson("unavailable");
  await time.advance(5_000);
  // The code is spent; the sign-in waits on who the person is.
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("D054-61DC");
  await time.advance(5_000);
  const connected = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.person !== null,
  );
  expect(connected.connection).toMatchObject({ id: "github:sasensi", signIn: null });
  await time.advance(60_000);
  // One exchange: the code polled once, when it gave the tokens.
  expect(host.codePolls("D054-61DC")).toEqual([T0 + 5_000]);
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
  host.enterCode("D054-61DC");
  host.refuseSignInPerson("unauthorized");
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );
  await time.advance(60_000);
  expect(host.codePolls("D054-61DC")).toEqual([T0 + 5_000]);
  expect((await stateOf(service, cookie)).connection.person).toBeNull();
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
  host.slowDownCode("D054-61DC");
  for (let i = 0; i < 5; i++) await time.advance(5_000);
  expect(host.codePolls("D054-61DC")).toEqual([T0 + 5_000, T0 + 15_000, T0 + 25_000]);
});

test("after a slow down, the next poll comes at the interval GitHub's answer carries, never later (#476)", async () => {
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
  host.slowDownCode("D054-61DC", 7_000);
  for (let i = 0; i < 21; i++) await time.advance(1_000);
  expect(host.codePolls("D054-61DC")).toEqual([T0 + 5_000, T0 + 12_000, T0 + 19_000]);
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
  expect((await stateOf(service, cookie)).connection.signIn?.userCode).toBe("D054-61DC");
  await time.advance(1);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );
  expect(Math.max(...host.codePolls("D054-61DC"))).toBeLessThan(expiresAt);
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
  expect((await stateOf(service, cookie)).connection).toMatchObject({ signIn: null, person: null });
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
  host.enterCode("D054-61DC");
  await time.advance(30_000);
  expect(host.codePolls("D054-61DC")).toEqual([]);
  expect((await stateOf(service, cookie)).connection.person).toBeNull();
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
  host.enterCode("D054-61DC");
  await time.advance(5_000);
  await eventually(
    () => snapshot(first.service, cookie),
    (s) => s.connection.person !== null && s.connection.signIn === null,
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
  expect(out.connection).toMatchObject({ person: OWNER });
  expect(out.setup.github).toBe("waiting-for-install");

  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  const code = (await stateOf(service, cookie)).connection.signIn?.userCode ?? "";
  host.enterCode(code);
  await time.advance(5_000);
  const back = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null && s.connection.cause === null,
  );
  expect(back.connection).toMatchObject({ person: OWNER });
  expect((await signInStore({ home: dir, keychain, userOnly }).read()).state).toBe("kept");

  host.install();
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done" && s.connection.state === "connected",
  );
});
