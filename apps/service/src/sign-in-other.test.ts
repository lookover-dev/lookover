// Another person signing in makes the choice of repositories again (ADR 0090, #579), through the service's door on
// the held demo clock and the fake GitHub's shared App. While the service runs, chosen yet or not: setup back at the
// GitHub step, then Repositories once the new person's installation is listed; every review the earlier person left
// unfinished cancelled "the sign-in changed", nothing written to GitHub for it, and nothing asked by itself until
// Continue on Repositories. At start: another person held than the setup's makes the choice again too; a setup that
// names nobody takes the first person seen. The same person signing in again changes nothing.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  changeId,
  commitSha,
  type Engines,
  HostError,
  type HostIntake,
  type HostLogin,
  type HostWriter,
  type Setup,
  type SignIn,
  type State,
} from "@lookover/contracts";
import { openStore } from "@lookover/store";
import { DemoClock, type FakeChange, FakeGitHost } from "@lookover/testkit";
import { type GitHubSide, memoryKeychain, type RunningService, signInStore } from "./index.ts";
import {
  eventually,
  fakeEngines,
  heldRuns,
  home,
  ONE_FINDING,
  OWNER,
  openApp,
  PLANTED,
  post,
  pr1,
  review,
  SANDBOX,
  SHA1_PUSHED,
  SHARED_BOT,
  setupOn,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const PR1 = { repo: SANDBOX, number: 1 };
const SANDBOX_ID = `${SANDBOX.owner}/${SANDBOX.name}`;
const idOf = (number: number) => changeId(`${SANDBOX_ID}#${number}`);
/** Another person, who signs in on the same machine in place of the owner and reaches the same repository. */
const BOB: HostLogin = { id: 5678, login: "bob" };
const userOnly = async () => {};

/** A pass that answers nothing. */
const NOTHING = { outcome: "ok", text: '```json\n{"findings": []}\n```' } as const;

/** `person`'s sign-in, as GitHub gives it: a token for 8 hours. */
const signInOf = (person: HostLogin): SignIn => ({
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: T0 + 8 * 3_600_000,
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: T0 + 180 * 86_400_000,
  person: { ...person },
});

/** Bob's pull request on the sandbox, on commits of its own: his to have reviewed by itself, once chosen. */
const bobs = (number: number): FakeChange => ({
  ...pr1,
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/${SANDBOX_ID}/pull/${number}`,
  author: { ...BOB },
  head: { ref: `branch-${number}`, sha: commitSha(`${number}`.padStart(7, "e").padEnd(40, "0")) },
});

/**
 * The shared App on `host`, `dir` signed in as `as`; the device flow's next sign-in names `next.person`. Its posts go
 * through `writer`: the host's own unless given.
 */
async function onShared(
  host: FakeGitHost,
  dir: string,
  next: { person: HostLogin },
  as: HostLogin = OWNER,
  writer: HostWriter = host,
  intake: HostIntake = host,
): Promise<GitHubSide> {
  const signIns = signInStore({ home: dir, keychain: memoryKeychain(), userOnly });
  await signIns.write(signInOf(as));
  return {
    shared: {
      signIn: {
        startSignIn: () => host.startSignIn(),
        pollSignIn: (grant) => host.pollSignIn(grant),
        person: async (token) => {
          await host.person(token);
          return { ...next.person };
        },
        refreshSignIn: (s) => host.refreshSignIn(s),
      },
      signIns,
      accounts: () => host,
      connect: () => ({ intake, writer }),
    },
  };
}

/** The owner's folder on the sandbox, the service running; reviews after every push on. */
async function ownersFolder(
  o: {
    engines?: Engines;
    host?: FakeGitHost;
    time?: DemoClock;
    setup?: Setup;
    dir?: string;
    writer?: (host: FakeGitHost) => HostWriter;
    intake?: (host: FakeGitHost) => HostIntake;
  } = {},
) {
  const dir = o.dir ?? home();
  const time = o.time ?? new DemoClock({ at: T0 });
  const host =
    o.host ?? new FakeGitHost({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const next = { person: BOB };
  const { service } = await start({
    home: dir,
    host,
    time,
    github: await onShared(host, dir, next, OWNER, o.writer?.(host) ?? host, o.intake?.(host) ?? host),
    repositorySettings: { onPush: true },
    ...(o.engines === undefined ? {} : { engines: o.engines }),
    ...(o.setup === undefined ? {} : { setup: o.setup }),
  });
  const cookie = await openApp(service);
  return { dir, time, host, service, cookie, next };
}

/** Signs in from the app as whoever the device flow names: the code entered, the poll answered. */
async function signsIn(
  service: RunningService,
  cookie: string,
  host: FakeGitHost,
  time: DemoClock,
  who: HostLogin,
) {
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("D054-61DC");
  await time.advance(5_000);
  return eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.person?.id === who.id && s.connection.signIn === null,
  );
}

/** A push on pull request #1 while Claude is signed out: its review waits. */
async function pushWaiting(service: RunningService, cookie: string, host: FakeGitHost, time: DemoClock) {
  host.push(PR1, SHA1_PUSHED, []);
  await time.advance(MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "deferred",
  );
}

test("Bob signs in on the owner's chosen folder: setup at the GitHub step, then Repositories once his installation is listed; the owner's queued review cancelled, nothing sent for it", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, signedIn: false });
  engines.answer(NOTHING);
  const { service, cookie, host } = await ownersFolder({ time, engines });
  await pushWaiting(service, cookie, host, time);
  const mark = host.posts.length;

  await signsIn(service, cookie, host, time, BOB);
  const atGitHub = await snapshot(service, cookie);
  expect(atGitHub.setup).toMatchObject({ done: false, step: "github", firstReviewChange: null });
  expect(atGitHub.reviews[PLANTED]?.job).toMatchObject({ state: "cancelled", cancel: "sign-in-changed" });
  const listed: State = await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  expect(listed.setup).toMatchObject({ done: false, step: "github", reached: "repos" });
  expect(listed.connection).toMatchObject({ id: "github:bob", state: "connected", person: BOB });

  // Claude back: a few polls on, nothing of the owner's review runs or posts as Bob.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(engines.runs).toEqual([]);
  expect(host.posts.slice(mark)).toEqual([]);
});

test("after Bob's sign-in, an opening and a push ask nothing until Continue on Repositories; then they are reviewed", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, reviews: 3 });
  const { service, cookie, host } = await ownersFolder({ time, engines });
  await signsIn(service, cookie, host, time, BOB);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  const mark = host.posts.length;

  host.open(bobs(7));
  await time.advance(MIN);
  host.push(PR1, SHA1_PUSHED, pr1.diff);
  await time.advance(MIN);
  await time.advance(MIN);
  const before = await snapshot(service, cookie);
  expect(before.changes[idOf(7)]).toBeDefined();
  expect(before.changes[PLANTED]?.headSha).toBe(SHA1_PUSHED);
  expect(before.reviews[idOf(7)]?.job ?? null).toBeNull();
  expect(before.reviews[PLANTED]?.job ?? null).toBeNull();
  expect(engines.runs).toEqual([]);
  expect(host.posts.slice(mark)).toEqual([]);

  expect((await post(service, cookie, { type: "setup.chooseRepos", enabled: [SANDBOX_ID] })).status).toBe(
    200,
  );
  host.open(bobs(8));
  await time.advance(MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[idOf(8)]?.job?.trigger === "opened",
  );
});

test("a review running when Bob signs in posts nothing as Bob: cut, cancelled as the sign-in changed", async () => {
  const time = new DemoClock({ at: T0 });
  const scripted = fakeEngines({ time });
  scripted.answer({ outcome: "ok", text: ONE_FINDING }, NOTHING);
  // The find pass answers only once cut, or released.
  const held = heldRuns(scripted);
  const { service, cookie, host } = await ownersFolder({ time, engines: held.engines });
  await review(service, cookie);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "running",
  );
  const mark = host.posts.length;

  await signsIn(service, cookie, host, time, BOB);
  held.release();
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  const after = await snapshot(service, cookie);
  expect(after.reviews[PLANTED]?.job).toMatchObject({ state: "cancelled", cancel: "sign-in-changed" });
  expect(after.reviews[PLANTED]?.run ?? null).toBeNull();
  expect(host.posts.slice(mark)).toEqual([]);
});

test("Bob signs in before the owner chose: the owner's queue is gone, nothing posts as Bob", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, signedIn: false });
  engines.answer(NOTHING);
  const { service, cookie, host } = await ownersFolder({ time, engines, setup: setupOn("repos") });
  // Review now, in person, is asked before the choice: it waits for Claude.
  expect((await review(service, cookie)).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "deferred",
  );
  const mark = host.posts.length;

  await signsIn(service, cookie, host, time, BOB);
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  const listed: State = await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(listed.setup).toMatchObject({ done: false, step: "github", reached: "repos" });
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.job).toMatchObject({
    state: "cancelled",
    cancel: "sign-in-changed",
  });
  expect(engines.runs).toEqual([]);
  expect(host.posts.slice(mark)).toEqual([]);
});

test("the owner signing in again changes nothing: setup, queue and screen stay", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, signedIn: false });
  engines.answer(NOTHING);
  const { service, cookie, host, next } = await ownersFolder({ time, engines });
  await pushWaiting(service, cookie, host, time);
  const before = await snapshot(service, cookie);

  next.person = OWNER;
  await signsIn(service, cookie, host, time, OWNER);
  await time.advance(MIN);
  const after = await snapshot(service, cookie);
  expect(after.setup).toEqual(before.setup);
  expect(after.setup).toMatchObject({ done: true, step: "background" });
  expect(after.reviews[PLANTED]?.job).toEqual(before.reviews[PLANTED]?.job);
});

test("a folder that names nobody takes the first person seen and changes nothing else; another person held at the next start makes the choice again", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, signedIn: false });
  engines.answer(NOTHING);
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const first = await ownersFolder({ dir, time, engines, host });
  await pushWaiting(first.service, first.cookie, host, time);
  await first.service.stop();
  // A folder kept before the setup named its person.
  const kept = openStore({ home: dir, durable: false });
  kept.setup.keepPerson(null);
  kept.close();

  // Started with Bob's sign-in, kept meanwhile by another process: the setup is his now, nothing else moved.
  const asBob = await start({
    home: dir,
    host,
    time,
    engines,
    github: await onShared(host, dir, { person: BOB }, BOB),
    repositorySettings: { onPush: true },
  });
  const bobsState = await snapshot(asBob.service, await openApp(asBob.service));
  expect(bobsState.setup).toMatchObject({ done: true, step: "background" });
  expect(bobsState.reviews[PLANTED]?.job).toMatchObject({ state: "deferred", trigger: "push" });
  await asBob.service.stop();

  // The owner's sign-in held at the next start: not the setup's person, so the choice is made again.
  const mark = host.posts.length;
  const asOwner = await start({
    home: dir,
    host,
    time,
    engines,
    github: await onShared(host, dir, { person: OWNER }),
    repositorySettings: { onPush: true },
  });
  const cookie = await openApp(asOwner.service);
  const again = await snapshot(asOwner.service, cookie);
  expect(again.setup).toMatchObject({ done: false, step: "github", firstReviewChange: null });
  expect(again.reviews[PLANTED]?.job).toMatchObject({ state: "cancelled", cancel: "sign-in-changed" });
  const listed: State = await eventually(
    () => snapshot(asOwner.service, cookie),
    (s) => s.setup.github === "done",
  );
  expect(listed.setup).toMatchObject({ done: false, step: "github", reached: "repos" });
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(engines.runs).toEqual([]);
  expect(host.posts.slice(mark)).toEqual([]);
});

/**
 * The host's writer with every check write held while `hold()` is on: each waits until `release`, in the order
 * asked; `asked` counts the check writes asked so far, held or not. While `refuseStatus()` is on, every status block
 * is written and then answered as refused for a moment, so it stays owed. While `holdStatus()` is on, each status
 * block's answer waits for `release` too, after the block is written.
 */
function heldChecks() {
  const waiting: (() => void)[] = [];
  let holding = false;
  let refusing = false;
  let holdingStatus = false;
  let refusingEnds = false;
  let asked = 0;
  const writes: ReadonlySet<PropertyKey> = new Set(["createCheck", "updateCheck", "completeCheck"]);
  const writerOf = (host: FakeGitHost): HostWriter =>
    new Proxy(host, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key === "upsertStatus")
          return async (...args: unknown[]) => {
            await value.apply(target, args);
            if (holdingStatus) await new Promise<void>((resolve) => waiting.push(resolve));
            if (refusing) throw new HostError("unavailable", "GitHub is busy");
          };
        if (!writes.has(key)) return value.bind(target);
        return async (...args: unknown[]) => {
          asked++;
          if (holding) await new Promise<void>((resolve) => waiting.push(resolve));
          if (refusingEnds && key !== "createCheck") throw new HostError("unavailable", "GitHub is busy");
          return value.apply(target, args);
        };
      },
    });
  return {
    writerOf,
    hold: () => {
      holding = true;
    },
    refuseStatus: () => {
      refusing = true;
    },
    /** Each check's update and end is refused for a moment, until `refuseEnds(false)`; its creation goes on. */
    refuseEnds: (on = true) => {
      refusingEnds = on;
    },
    /** Each status block is written, then its answer held until `release`. */
    holdStatus: () => {
      holdingStatus = true;
    },
    /** The writes held go on, and none is held any more. */
    release: () => {
      holding = false;
      holdingStatus = false;
      for (const go of waiting.splice(0)) go();
    },
    held: () => waiting.length,
    asked: () => asked,
  };
}

/** Bob's sign-in asked from the app, the code entered, the poll answered: the choice made again, held or not yet. */
async function bobAsks(service: RunningService, cookie: string, host: FakeGitHost, time: DemoClock) {
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  host.enterCode("D054-61DC");
  await time.advance(5_000);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.step === "github" && !s.setup.done,
  );
}

/** Waits for `holds` to hold, polled every 10 ms for 3 s. */
async function until(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !holds(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(holds()).toBe(true);
}

/** A few turns of the service's own: what was going to run in between has. */
const aMoment = () => new Promise((resolve) => setTimeout(resolve, 50));

/** The owner's folder, Claude signed out, a push's review waiting and its check's write held by `checks`. */
async function checkWriteHeld(checks: ReturnType<typeof heldChecks>) {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, signedIn: false });
  engines.answer(NOTHING);
  const folder = await ownersFolder({ time, engines, writer: checks.writerOf });
  checks.hold();
  folder.host.push(PR1, SHA1_PUSHED, []);
  await time.advance(MIN);
  await until(() => checks.held() === 1);
  return folder;
}

test("a check write under way as Bob signs in lands before his sign-in is held", async () => {
  const checks = heldChecks();
  const { service, cookie, host, time } = await checkWriteHeld(checks);

  // The choice is made again, and Bob's sign-in waits for the owner's write to land.
  await bobAsks(service, cookie, host, time);
  await aMoment();
  expect((await snapshot(service, cookie)).connection.person).toEqual(OWNER);

  checks.release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.person?.id === BOB.id,
  );
});

test("Review now while Bob's sign-in is on its way to be held waits for it: nothing written as the owner", async () => {
  const checks = heldChecks();
  const { service, cookie, host, time } = await checkWriteHeld(checks);
  await bobAsks(service, cookie, host, time);
  const before = checks.asked();

  const asked = review(service, cookie);
  await aMoment();
  expect(checks.asked()).toBe(before);
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.job).toMatchObject({
    state: "cancelled",
    cancel: "sign-in-changed",
  });

  // Bob held: the request is his, its check written then.
  checks.release();
  expect((await asked).status).toBe(200);
  const after = await snapshot(service, cookie);
  expect(after.connection.person).toEqual(BOB);
  expect(after.reviews[PLANTED]?.job).toMatchObject({ trigger: "manual" });
});

test("a status block the host refused for a moment before Bob signs in is not written again for the owner's cancelled review", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, reviews: 1 });
  const writer = heldChecks();
  const { service, cookie, host } = await ownersFolder({ time, engines, writer: writer.writerOf });
  await review(service, cookie);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  // Claude signed out: the push's review waits, and its block, written, is answered as refused, every time.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: false });
  writer.refuseStatus();
  const waiting = host.posts.length;
  host.push(PR1, SHA1_PUSHED, []);
  await time.advance(MIN);
  await until(() => host.posts.slice(waiting).some((p) => p.kind === "status.written"));
  await aMoment();
  const mark = host.posts.length;

  await signsIn(service, cookie, host, time, BOB);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(host.posts.slice(mark)).toEqual([]);
});

test("Bob signs in while the owner's run is slow to end once cut: the repositories are unchosen at once, his sign-in held and his install waited for once it has", async () => {
  const time = new DemoClock({ at: T0 });
  const scripted = fakeEngines({ time });
  scripted.answer(NOTHING, NOTHING);
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A run that ends only once released, cut or not.
  const engines: Engines = {
    run: async (spec, signal) => {
      await released;
      return scripted.run(spec, signal);
    },
    health: (engine) => scripted.health(engine),
  };
  const { service, cookie, host } = await ownersFolder({ time, engines });
  await review(service, cookie);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "running",
  );

  await bobAsks(service, cookie, host, time);
  await aMoment();
  const between = await snapshot(service, cookie);
  expect(between.setup).toMatchObject({ done: false, step: "github", reached: "github", github: "start" });
  expect(between.reviews[PLANTED]?.job).toMatchObject({ state: "cancelled", cancel: "sign-in-changed" });
  expect(between.connection.person).toEqual(OWNER);

  release();
  const listed: State = await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  expect(listed.connection.person).toEqual(BOB);
  expect(listed.setup).toMatchObject({ done: false, step: "github", reached: "repos" });
});

/** The host's writer with its first reaction held until `release`; `asked` lists every reaction asked, held or not. */
function heldReaction() {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked: string[] = [];
  const writerOf = (host: FakeGitHost): HostWriter =>
    new Proxy(host, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key !== "react") return value.bind(target);
        return async (...args: unknown[]) => {
          asked.push(`${args[2]} ${args[1]}`);
          if (asked.length === 1) await released;
          return value.apply(target, args);
        };
      },
    });
  return { writerOf, release: () => release(), asked: () => asked };
}

test("two reactions owed, the first held at the host as Bob signs in: the second is never sent, by anyone", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, signedIn: false });
  const reactions = heldReaction();
  const { service, cookie, host } = await ownersFolder({ time, engines, writer: reactions.writerOf });
  await time.advance(5_000);
  const first = host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  const second = host.seedComment(PR1, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  await until(() => reactions.asked().length === 1);

  await bobAsks(service, cookie, host, time);
  reactions.release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);

  expect(reactions.asked()).toEqual([`eyes ${first}`]);
  const counts = (id: string) => host.view(PR1).comments.find((c) => c.id === id)?.reactions;
  expect(counts(first)).toEqual({ eyes: 1, rocket: 0 });
  expect(counts(second)).toEqual({ eyes: 0, rocket: 0 });
});

test("a status block under way as Bob signs in, then refused for a moment, is not written again for the owner's cancelled review", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, reviews: 1 });
  const writer = heldChecks();
  const { service, cookie, host } = await ownersFolder({ time, engines, writer: writer.writerOf });
  await review(service, cookie);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  // Claude signed out: the push's review waits; its block is written, and the host's answer held, then refused.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: false });
  writer.refuseStatus();
  writer.holdStatus();
  host.push(PR1, SHA1_PUSHED, []);
  await time.advance(MIN);
  await until(() => writer.held() === 1);
  const mark = host.posts.length;

  // The choice is made again while the block's answer is held; the refusal comes once the owed blocks were dropped.
  await bobAsks(service, cookie, host, time);
  writer.release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(host.posts.slice(mark)).toEqual([]);
});

/** The host's intake with every listing of open changes held while `hold()` is on, until `release`. */
function heldListings() {
  const waiting: (() => void)[] = [];
  let holding = false;
  const intakeOf = (host: FakeGitHost): HostIntake =>
    new Proxy(host, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key !== "listOpenChanges") return value.bind(target);
        return async (...args: unknown[]) => {
          if (holding) await new Promise<void>((resolve) => waiting.push(resolve));
          return value.apply(target, args);
        };
      },
    });
  return {
    intakeOf,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const go of waiting.splice(0)) go();
    },
    held: () => waiting.length,
  };
}

test("the owner's Review now, its listing under way as Bob signs in, asks nothing: Bob hasn't asked", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time });
  engines.answer(NOTHING);
  const listings = heldListings();
  const { service, cookie, host } = await ownersFolder({ time, engines, intake: listings.intakeOf });
  const before = (await snapshot(service, cookie)).reviews[PLANTED]?.job ?? null;
  listings.hold();
  const asked = review(service, cookie);
  await until(() => listings.held() >= 1);
  const mark = host.posts.length;

  await bobAsks(service, cookie, host, time);
  listings.release();
  // Answered, by the choice made again: the owner's ask is cancelled as the queued ones were.
  expect((await asked).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);

  const after = await snapshot(service, cookie);
  expect(after.connection.person).toEqual(BOB);
  expect(after.reviews[PLANTED]?.job ?? null).toEqual(before);
  expect(host.posts.slice(mark)).toEqual([]);
});

test("the owner's first review, its listing under way as Bob signs in, asks nothing and leaves Bob's setup without one", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time });
  engines.answer(NOTHING);
  const listings = heldListings();
  const { service, cookie, host } = await ownersFolder({
    time,
    engines,
    setup: setupOn("first-review"),
    intake: listings.intakeOf,
  });
  listings.hold();
  const asked = post(service, cookie, { type: "setup.firstReview", changeId: PLANTED, preview: false });
  await until(() => listings.held() >= 1);
  const mark = host.posts.length;

  await bobAsks(service, cookie, host, time);
  listings.release();
  expect((await asked).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);

  const after = await snapshot(service, cookie);
  expect(after.setup).toMatchObject({ done: false, step: "github", firstReviewChange: null });
  expect(after.reviews[PLANTED]?.job ?? null).toBeNull();
  expect(engines.runs).toEqual([]);
  expect(host.posts.slice(mark)).toEqual([]);
});

test("a status block refused for a moment on a pull request with a posted round is never written for the owner's cancelled review: not at Bob's first take, nor once he chose repositories", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, reviews: 1 });
  const writer = heldChecks();
  const { service, cookie, host } = await ownersFolder({ time, engines, writer: writer.writerOf });
  await review(service, cookie);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  // The push's review waits, Claude signed out; its block's update is refused for a moment, every time: owed.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: false });
  writer.refuseStatus();
  const waiting = host.posts.length;
  host.push(PR1, SHA1_PUSHED, []);
  await time.advance(MIN);
  await until(() => host.posts.slice(waiting).some((p) => p.kind === "status.written"));
  await aMoment();
  const mark = host.posts.length;

  // Bob's sign-in held: the take after it sends what is owed again; then he chooses, and the polls take again.
  await signsIn(service, cookie, host, time, BOB);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  await time.advance(MIN);
  expect((await post(service, cookie, { type: "setup.chooseRepos", enabled: [SANDBOX_ID] })).status).toBe(
    200,
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.job).toMatchObject({
    state: "cancelled",
    cancel: "sign-in-changed",
  });
  expect(host.posts.slice(mark)).toEqual([]);
});

test("a dismissal's post under way as Bob signs in lands before his sign-in is held; its posts after it are never sent", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time });
  engines.answer({ outcome: "ok", text: ONE_FINDING }, NOTHING);
  const writer = heldChecks();
  const { service, cookie, host } = await ownersFolder({ time, engines, writer: writer.writerOf });
  await review(service, cookie);
  const posted = await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  const finding = posted.reviews[PLANTED]?.findings[0];
  if (finding === undefined) throw new Error("round 1 posted no finding");
  // The dismissal's status block is written, and GitHub's answer held.
  writer.holdStatus();
  const mark = host.posts.length;
  const dismissed = await post(service, cookie, {
    type: "noise.apply",
    choice: { kind: "wrong", changeId: PLANTED, findingId: finding.id },
  });
  expect(dismissed.status).toBe(200);
  await until(() => writer.held() === 1);

  // The choice is made again, and Bob's sign-in waits for the owner's post to land.
  await bobAsks(service, cookie, host, time);
  await aMoment();
  expect((await snapshot(service, cookie)).connection.person).toEqual(OWNER);

  writer.release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(host.posts.slice(mark).map((p) => p.kind)).toEqual(["status.written"]);
});

/** What a dismissal posts: its reply, its status block, its minimize; none for a dismissal refused. */
const DISMISSAL_POSTS: ReadonlySet<string> = new Set(["reply", "status.written", "minimized"]);

/** The owner's round on pull request #1 posted with one finding: what "This finding is wrong" dismisses. */
async function findingPosted(service: RunningService, cookie: string) {
  await review(service, cookie);
  const posted = await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );
  const finding = posted.reviews[PLANTED]?.findings[0];
  if (finding === undefined) throw new Error("round 1 posted no finding");
  return finding;
}

const dismissing = (service: RunningService, cookie: string, findingId: string) =>
  post(service, cookie, { type: "noise.apply", choice: { kind: "wrong", changeId: PLANTED, findingId } });

test("the owner's finding dismissed once their dismissal sends are cut, a check write still under way as Bob signs in, asks nothing: refused once he is held, nothing posted", async () => {
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time });
  engines.answer({ outcome: "ok", text: ONE_FINDING }, NOTHING);
  const checks = heldChecks();
  const { service, cookie, host } = await ownersFolder({ time, engines, writer: checks.writerOf });
  const finding = await findingPosted(service, cookie);
  // Claude signed out: the push's review waits, its check's write held.
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: false });
  checks.hold();
  host.push(PR1, SHA1_PUSHED, []);
  await time.advance(MIN);
  await until(() => checks.held() === 1);
  await bobAsks(service, cookie, host, time);
  await aMoment();
  const mark = host.posts.length;

  const dismissed = dismissing(service, cookie, finding.id);
  await aMoment();
  checks.release();
  expect((await dismissed).status).toBe(409);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(host.posts.slice(mark).filter((p) => DISMISSAL_POSTS.has(p.kind))).toEqual([]);
});

test("the owner's finding dismissed while the owner's run on another pull request is slow to end as Bob signs in asks nothing: refused once he is held, nothing posted, nothing owed at the next start, even a status block held at the host", async () => {
  const time = new DemoClock({ at: T0 });
  const scripted = fakeEngines({ time });
  scripted.answer({ outcome: "ok", text: ONE_FINDING }, NOTHING, NOTHING, NOTHING);
  let slow = false;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Once slow, a run ends only once released, cut or not.
  const engines: Engines = {
    run: async (spec, signal) => {
      if (slow) await released;
      return scripted.run(spec, signal);
    },
    health: (engine) => scripted.health(engine),
  };
  const two: FakeChange = { ...bobs(2), author: OWNER };
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1, two],
    clock: time,
  });
  const writer = heldChecks();
  const { dir, service, cookie } = await ownersFolder({ time, engines, host, writer: writer.writerOf });
  const finding = await findingPosted(service, cookie);
  slow = true;
  expect((await post(service, cookie, { type: "review.request", changeId: idOf(2) })).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[idOf(2)]?.job?.state === "running",
  );
  await bobAsks(service, cookie, host, time);
  const mark = host.posts.length;

  // A status block written from now on is answered only once released: a send begun would be under way at the cut.
  writer.holdStatus();
  const dismissed = dismissing(service, cookie, finding.id);
  await aMoment();
  expect(host.posts.slice(mark).filter((p) => DISMISSAL_POSTS.has(p.kind))).toEqual([]);
  release();
  await aMoment();
  writer.release();
  expect((await dismissed).status).toBe(409);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(host.posts.slice(mark).filter((p) => DISMISSAL_POSTS.has(p.kind))).toEqual([]);
  await service.stop();
  const store = openStore({ home: dir, durable: false });
  expect(store.dismissals.owing()).toEqual([]);
  store.close();
});

test("a preview joining the owner's waiting review while its check is being made, Bob signing in then: the check made late is never ended as Bob", async () => {
  const checks = heldChecks();
  const { service, cookie, host, time } = await checkWriteHeld(checks);
  expect(
    (await post(service, cookie, { type: "setup.firstReview", changeId: PLANTED, preview: true })).status,
  ).toBe(200);
  await bobAsks(service, cookie, host, time);
  const mark = host.posts.length;

  checks.release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.setup.github === "done",
  );
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(host.posts.slice(mark).map((p) => p.kind)).toEqual(["check.created"]);
});

test("a preview done while its check is being made, Bob signing in then, its end refused as the owner's writes drain: nothing is ever written for it as Bob", async () => {
  const checks = heldChecks();
  const time = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time, signedIn: false });
  engines.answer(NOTHING);
  const { service, cookie, host } = await ownersFolder({ time, engines, writer: checks.writerOf });
  // A push's review waits, its check's creation held at the host; a preview joins it, and is done meanwhile.
  checks.hold();
  host.push(PR1, SHA1_PUSHED, []);
  await time.advance(MIN);
  await until(() => checks.held() === 1);
  expect(
    (await post(service, cookie, { type: "setup.firstReview", changeId: PLANTED, preview: true })).status,
  ).toBe(200);
  engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: true });
  await time.advance(MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.reviews[PLANTED]?.job?.state === "done",
  );

  // Bob signs in; the check lands as the owner's writes drain, and its end, "a preview", is refused for a moment.
  checks.refuseEnds();
  await bobAsks(service, cookie, host, time);
  const mark = host.posts.length;
  checks.release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.person?.id === BOB.id && s.setup.github === "done",
  );
  checks.refuseEnds(false);
  for (let polls = 0; polls < 3; polls++) await time.advance(MIN);
  expect(host.posts.slice(mark).map((p) => p.kind)).toEqual(["check.created"]);
});
