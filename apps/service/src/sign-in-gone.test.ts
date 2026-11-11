// A start with the sign-in gone makes the choice of repositories again (ADR 0090, #578), through the service's door
// on the held demo clock and the fake GitHub's shared App: every review the earlier session left unfinished (waiting,
// running, at publishing) ends cancelled "the sign-in changed", nothing resumes, and nothing about it is written to
// GitHub (no check, status block, review, reaction or comment), before the next person's installation is found and
// after.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { changeId, type Engines, type SignIn, type State } from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import { type GitHubSide, type Keychain, memoryKeychain, type RunningService, signInStore } from "./index.ts";
import {
  eventually,
  fakeEngines,
  HeldReviews,
  heldRuns,
  home,
  ONE_FINDING,
  OWNER,
  onTheDiff,
  openApp,
  PLANTED,
  post,
  pr1,
  pr2,
  review,
  SANDBOX,
  SHA1_PUSHED,
  SHARED_BOT,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const PR1 = { repo: SANDBOX, number: 1 };
const MIN = 60_000;
const userOnly = async () => {};

/** A pass that answers nothing. */
const NOTHING = { outcome: "ok", text: '```json\n{"findings": []}\n```' } as const;

/** The person's sign-in, as GitHub gives it: a token for 8 hours. */
const signInAt = (at: number): SignIn => ({
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: at + 8 * 3_600_000,
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: at + 180 * 86_400_000,
  person: { ...OWNER },
});

/** The shared App on `host` for a data folder keeping its sign-in store on `keychain`. */
const onShared = (host: FakeGitHost, dir: string, keychain: Keychain): GitHubSide => ({
  shared: {
    signIn: host,
    signIns: signInStore({ home: dir, keychain, userOnly }),
    accounts: () => host,
    connect: () => ({ intake: host, writer: host }),
  },
});

/** A data folder signed in to the shared App, set up: the earlier session's. */
async function signedInFolder(): Promise<{ dir: string; keychain: Keychain }> {
  const dir = home();
  const keychain = memoryKeychain();
  await signInStore({ home: dir, keychain, userOnly }).write(signInAt(T0));
  return { dir, keychain };
}

/**
 * The service started again on `dir` with its sign-in gone, then the next person signing in from the setup, their
 * installation found: what the host was sent from the restart on, and the state once a few polls went by.
 */
async function nextPersonSignsIn(
  dir: string,
  o: { host: FakeGitHost; time: DemoClock; engines: Engines },
): Promise<{ sent: FakeGitHost["posts"]; state: State; service: RunningService }> {
  rmSync(join(dir, "github", "sign-in.json"));
  const mark = o.host.posts.length;
  const { service } = await start({
    engines: o.engines,
    home: dir,
    host: o.host,
    time: o.time,
    github: onShared(o.host, dir, memoryKeychain()),
    idsFrom: 100,
    repositorySettings: { onPush: true },
  });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).setup).toMatchObject({
    done: false,
    step: "github",
    github: "start",
  });
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  o.host.enterCode("D054-61DC");
  await o.time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  // A teammate's pull request opened, which asks nothing: the poll that lists it takes, and a review left waiting
  // would run and post. A few polls more, the queue taking after each.
  o.host.open(pr2);
  for (let polls = 0; polls < 3; polls++) await o.time.advance(MIN);
  return { sent: o.host.posts.slice(mark), state: await snapshot(service, cookie), service };
}

test("a review queued by a push in an earlier session, the sign-in gone at the restart: cancelled as the sign-in changed, nothing sent to GitHub once the next person's installation is found", async () => {
  const { dir, keychain } = await signedInFolder();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  // Claude signed out: the push's review waits.
  const engines = fakeEngines({ time, signedIn: false });
  engines.answer(NOTHING);
  const first = await start({
    home: dir,
    host,
    time,
    engines,
    github: onShared(host, dir, keychain),
    repositorySettings: { onPush: true },
  });
  const cookie = await openApp(first.service);
  host.push(PR1, SHA1_PUSHED, []);
  await time.advance(MIN);
  const waiting = await eventually(
    () => snapshot(first.service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "deferred",
  );
  expect(waiting.reviews[PLANTED]?.job).toMatchObject({ trigger: "push", sha: SHA1_PUSHED });
  await first.service.stop();
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });

  const { sent, state } = await nextPersonSignsIn(dir, { host, time, engines });
  expect(state.reviews[PLANTED]?.job).toMatchObject({ state: "cancelled", cancel: "sign-in-changed" });
  expect(state.setup).toMatchObject({
    done: false,
    step: "github",
    reached: "repos",
    firstReviewChange: null,
  });
  expect(engines.runs).toEqual([]);
  expect(sent).toEqual([]);
});

test("a review running at the restart, before publishing or at it, the sign-in gone: cancelled, not resumed, nothing posted", async () => {
  for (const at of ["reviewing", "publishing"] as const) {
    const { dir, keychain } = await signedInFolder();
    const time = new DemoClock({ at: T0 });
    const host = new HeldReviews({
      repo: SANDBOX,
      bot: SHARED_BOT,
      person: OWNER,
      changes: [pr1],
      clock: time,
    });
    const scripted = fakeEngines({ time });
    scripted.answer({ outcome: "ok", text: ONE_FINDING }, NOTHING);
    // Reviewing: the find pass never answers; publishing: it answers, and GitHub holds the review.
    const held = heldRuns(scripted);
    const engines = at === "reviewing" ? held.engines : scripted;
    const first = await start({
      home: dir,
      host,
      time,
      engines,
      retrieval: onTheDiff(),
      github: onShared(host, dir, keychain),
    });
    const cookie = await openApp(first.service);
    await review(first.service, cookie);
    if (at === "publishing") await host.asked;
    else
      await eventually(
        () => snapshot(first.service, cookie),
        (s) => s.reviews[PLANTED]?.job?.state === "running",
      );
    await first.service.stop();
    host.release();
    held.release();
    await time.advance(0);
    const ran = scripted.runs.length;

    const { sent, state } = await nextPersonSignsIn(dir, { host, time, engines });
    expect(state.reviews[PLANTED]?.job).toMatchObject({ state: "cancelled", cancel: "sign-in-changed" });
    expect(state.reviews[PLANTED]?.run ?? null).toBeNull();
    expect(scripted.runs).toHaveLength(ran);
    expect(sent).toEqual([]);
  }
});

test("a request whose 👀 was still owed at the restart, the sign-in gone: no reaction is sent later", async () => {
  const { dir, keychain } = await signedInFolder();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const engines = fakeEngines({ time, signedIn: false });
  engines.answer(NOTHING);
  const first = await start({ home: dir, host, time, engines, github: onShared(host, dir, keychain) });
  const cookie = await openApp(first.service);
  host.refuseNext("unavailable", { post: "reaction" });
  host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await eventually(
    () => snapshot(first.service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "deferred",
  );
  expect(host.view(PR1).comments.map((c) => c.reactions)).toEqual([{ eyes: 0, rocket: 0 }]);
  await first.service.stop();
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });

  const { sent, state } = await nextPersonSignsIn(dir, { host, time, engines });
  expect(state.reviews[changeId("sasensi/lookover-sandbox#1")]?.job).toMatchObject({
    state: "cancelled",
    cancel: "sign-in-changed",
  });
  expect(sent).toEqual([]);
  expect(host.view(PR1).comments.map((c) => c.reactions)).toEqual([{ eyes: 0, rocket: 0 }]);
});

test("a request whose round was done but whose 🚀 GitHub refused, the sign-in gone at the restart: no 🚀 is sent later", async () => {
  const { dir, keychain } = await signedInFolder();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const engines = fakeEngines({ time });
  engines.answer(NOTHING, NOTHING);
  const first = await start({ home: dir, host, time, engines, github: onShared(host, dir, keychain) });
  const cookie = await openApp(first.service);
  // The 👀 goes through, the 🚀 is refused: owed, sent again by the next poll had the service gone on.
  host.refuseNext("unavailable", { post: "reaction", skip: 1 });
  host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await eventually(
    () => snapshot(first.service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  expect(host.view(PR1).comments.map((c) => c.reactions)).toEqual([{ eyes: 1, rocket: 0 }]);
  await first.service.stop();

  const { sent } = await nextPersonSignsIn(dir, { host, time, engines });
  expect(sent.filter((p) => p.kind === "reaction")).toEqual([]);
  expect(host.view(PR1).comments.map((c) => c.reactions)).toEqual([{ eyes: 1, rocket: 0 }]);
});
