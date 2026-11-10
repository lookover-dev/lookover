// The shared App's installations and the repositories they list (ADR 0053, ADR 0066), through the service's door on
// the held demo clock and the fake GitHub, the owner signed in: the install waited for every 4 s while the setup
// waits for it, "nothing granted" until it lists a repository; the installation's repositories followed every 2
// minutes (a minute on after a refused listing), one added arriving switched on, one removed leaving with its waiting
// and running jobs cancelled and its unsent posts dropped, and back again with no waiting job; the allow-list cutting
// what is listed; nobody signed in showing the setup, and a restart's setup following the sign-in kept (ADR 0073).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  changeId,
  commitSha,
  type Event,
  type HostChange,
  HostError,
  type Listing,
  type Repository,
  type RepositoryRef,
  repositoryId,
  type Setup,
} from "@lookover/contracts";
import { openStore } from "@lookover/store";
import { DemoClock, type FakeChange, FakeGitHost } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  HeldReviews,
  home,
  messages,
  ONE_FINDING,
  OWNER,
  onTheDiff,
  openApp,
  post,
  pr1,
  SANDBOX,
  SHARED_BOT,
  signedInOn,
  signedOutOn,
  snapshot,
  start,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const LEDGER: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-api" };
const WEB: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-web" };
const idOf = (repo: RepositoryRef) => repositoryId(`${repo.owner}/${repo.name}`);

/** A pass that answers nothing. */
const NOTHING = { outcome: "ok", text: '```json\n{"findings": []}\n```' } as const;

/** The owner on the GitHub step, signed in, the shared App's install waited for. */
const WAITING: Setup = {
  done: false,
  step: "github",
  reached: "github",
  github: "waiting-for-install",
  firstReviewChange: null,
};

/** A pull request the owner opens in `repo`, on a commit of its own. */
const opened = (repo: RepositoryRef, number: number): FakeChange => ({
  ...pr1,
  repo,
  number,
  title: `Pull request ${number} of ${repo.name}`,
  url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
  head: {
    ref: `branch-${number}`,
    sha: commitSha(`${repo.name.length}${number}`.padStart(7, "d").padEnd(40, "0")),
  },
});

/**
 * A fake GitHub that counts each repository's listings, and how often the installation is read; `listingRefused`
 * refuses only the installation's reads as unreachable, the repositories still answering.
 */
class Counting extends FakeGitHost {
  lists = new Map<string, number>();
  reads = 0;
  listingRefused = false;
  override listOpenChanges(repo: RepositoryRef): Promise<Listing<HostChange>> {
    this.lists.set(repo.name, (this.lists.get(repo.name) ?? 0) + 1);
    return super.listOpenChanges(repo);
  }
  override accounts(...args: Parameters<FakeGitHost["accounts"]>) {
    this.reads++;
    if (this.listingRefused)
      return Promise.reject(new HostError("unavailable", "GitHub could not be reached"));
    return super.accounts(...args);
  }
}

/**
 * A fake GitHub whose next listing of one repository, once answered, is held until `release`: a poll under way
 * while the installation moves.
 */
class HeldListing extends FakeGitHost {
  private holding: RepositoryRef | null = null;
  private heard = () => {};
  private let = () => {};
  /** Settles once the listing held has its answer. */
  answered: Promise<void> = Promise.resolve();
  private released: Promise<void> = Promise.resolve();

  hold(repo: RepositoryRef): void {
    this.holding = repo;
    this.answered = new Promise((resolve) => {
      this.heard = resolve;
    });
    this.released = new Promise((resolve) => {
      this.let = resolve;
    });
  }

  release(): void {
    this.let();
  }

  override async listOpenChanges(repo: RepositoryRef): Promise<Listing<HostChange>> {
    const listing = await super.listOpenChanges(repo);
    if (this.holding?.name === repo.name) {
      this.holding = null;
      this.heard();
      await this.released;
    }
    return listing;
  }
}

/** The events the room sends from now on, and the first of `type` once sent. */
function heard(events: { subscribe(listener: (event: Event) => void): () => void }) {
  const sent: Event[] = [];
  const stop = events.subscribe((e) => {
    sent.push(e);
  });
  const first = (type: Event["type"]) =>
    new Promise<Event>((resolve) => {
      const found = sent.find((e) => e.type === type);
      if (found !== undefined) return resolve(found);
      const off = events.subscribe((e) => {
        if (e.type !== type) return;
        off();
        resolve(e);
      });
    });
  return { sent, first, stop };
}

test("the App installed after the start: the install read every 4 s, nothing granted, then a repository granted marks the step done and the reads stop", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    installed: false,
  });
  const { service } = await start({
    host,
    time,
    setup: WAITING,
  });
  const cookie = await openApp(service);
  const before = await snapshot(service, cookie);
  expect(before.setup.github).toBe("waiting-for-install");
  expect(before.connection).toMatchObject({ state: "not-connected", accounts: [] });
  expect(before.repos).toEqual([]);

  // Installed with no repository: "nothing granted", connected, still checked.
  const installation = host.install([]);
  await time.advance(4_000);
  const nothing = await snapshot(service, cookie);
  expect(nothing.setup).toMatchObject({ github: "nothing-granted", step: "github" });
  expect(nothing.connection).toMatchObject({
    state: "connected",
    accounts: [{ installationId: installation }],
  });
  expect(nothing.repos).toEqual([]);

  // The owner grants the sandbox on GitHub: within 4 s it is listed and switched on; the step waits for Continue.
  host.addRepository(SANDBOX);
  await time.advance(4_000);
  const granted = await snapshot(service, cookie);
  expect(granted.setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
  expect(granted.repos.map((r: Repository) => [r.id, r.enabled])).toEqual([[idOf(SANDBOX), true]]);
  expect(granted.changes[changeId("sasensi/lookover-sandbox#1")]).toMatchObject({ author: "you" });
  // What was open before is listed, not reviewed.
  expect(granted.reviews[changeId("sasensi/lookover-sandbox#1")]?.job ?? null).toBeNull();

  // Granted: no more reads every 4 s; the installation is next read by the discovery, 2 minutes on.
  const reads = host.reads;
  await time.advance(2 * MIN - 1_000);
  expect(host.reads).toBe(reads);
  await time.advance(1_000);
  expect(host.reads).toBe(reads + 1);
});

test("set up, the installations are listed every 2 minutes; one refused is listed again a minute on, then every 2 again", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  await start({ host, time });
  const reads = host.reads;

  await time.advance(2 * MIN - 1_000);
  expect(host.reads).toBe(reads);
  await time.advance(1_000);
  expect(host.reads).toBe(reads + 1);
  await time.advance(2 * MIN);
  expect(host.reads).toBe(reads + 2);

  // GitHub can't list the installations: the next listing refused, the one after a minute on.
  host.listingRefused = true;
  await time.advance(2 * MIN);
  expect(host.reads).toBe(reads + 3);
  host.listingRefused = false;
  await time.advance(MIN - 1_000);
  expect(host.reads).toBe(reads + 3);
  await time.advance(1_000);
  expect(host.reads).toBe(reads + 4);

  // Answered: 2 minutes again.
  await time.advance(2 * MIN - 1_000);
  expect(host.reads).toBe(reads + 4);
  await time.advance(1_000);
  expect(host.reads).toBe(reads + 5);
});

test("uninstalled and installed again while nothing is granted: the new installation is shown at once, and kept once a repository is granted", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    installed: false,
  });
  const { service } = await start({
    host,
    time,
    setup: WAITING,
  });
  const cookie = await openApp(service);
  const first = host.install([]);
  await time.advance(4_000);
  expect((await snapshot(service, cookie)).connection).toMatchObject({
    accounts: [{ installationId: first }],
  });

  // The owner uninstalls the App and installs it again, still granting nothing: the links lead to the new one.
  host.uninstall();
  await time.advance(4_000);
  const second = host.install([]);
  expect(second).not.toBe(first);
  await time.advance(4_000);
  const again = await snapshot(service, cookie);
  expect(again.setup.github).toBe("nothing-granted");
  expect(again.connection).toMatchObject({ state: "connected", accounts: [{ installationId: second }] });

  host.addRepository(SANDBOX);
  await time.advance(4_000);
  const granted = await snapshot(service, cookie);
  expect(granted.setup.github).toBe("done");
  expect(granted.connection).toMatchObject({ state: "connected", accounts: [{ installationId: second }] });
});

test("a repository added to the installation and one removed appear and leave within one listing; the removed one's jobs are cancelled and its unsent posts dropped", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new HeldReviews({
    repo: SANDBOX,
    repositories: [LEDGER],
    bot: SHARED_BOT,
    person: OWNER,
    changes: [],
    clock: time,
  });
  const store = openStore({ home: home(), durable: false });
  // Each round finds a line of the diff, so it owes a review (ADR 0074), the one GitHub holds; its confirm pass
  // answers nothing more.
  const engines = fakeEngines({ time });
  for (const _ of [1, 2]) engines.answer({ outcome: "ok", text: ONE_FINDING }, NOTHING);
  const retrieval = onTheDiff();
  const { service } = await start({ host, time, store, repos: [SANDBOX, LEDGER, WEB], engines, retrieval });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await snapshot(service, cookie)).repos.map((r: Repository) => r.id)).toEqual([
    idOf(SANDBOX),
    idOf(LEDGER),
  ]);

  // In ledger-api: #1 reviewed, held at posting its review, its posts owed; #2 asked for, waiting or running.
  host.open(opened(LEDGER, 1));
  host.open(opened(LEDGER, 2));
  await time.advance(MIN);
  await host.asked;
  expect(
    (await post(service, cookie, { type: "review.request", changeId: "sasensi/ledger-api#2" })).status,
  ).toBe(200);
  const first = changeId("sasensi/ledger-api#1");
  const second = changeId("sasensi/ledger-api#2");
  expect(store.jobs.latest(first)?.job.state).toBe("running");
  expect(store.jobs.pending(second)).toBe(true);
  const runId = (await snapshot(service, cookie)).reviews[first]?.run?.id;
  if (runId === undefined) throw new Error("sasensi/ledger-api#1 has a run");
  expect(store.posts.of(runId)?.posts.filter((p) => p.hostId === null).length).toBeGreaterThan(0);

  // On GitHub: ledger-api leaves the installation, ledger-web joins it. One listing, at most 2 minutes on.
  host.removeRepository(LEDGER);
  host.addRepository(WEB);
  host.open(opened(WEB, 4));
  await time.advance(5 * MIN);
  const events = await until(stream, "repo.added");
  expect(
    events.filter((e) => e.type === "repo.removed" || e.type === "repo.added").map((e) => e.type),
  ).toEqual(["repo.removed", "repo.added"]);
  const state = await snapshot(service, cookie);
  expect(state.repos.map((r: Repository) => [r.id, r.enabled])).toEqual([
    [idOf(SANDBOX), true],
    [idOf(WEB), true],
  ]);
  expect(Object.keys(state.changes)).toEqual(["sasensi/ledger-web#4"]);
  // Its jobs cancelled, the running one stopped, and the UI told; no post of its round left owed.
  for (const id of [first, second]) {
    expect(store.jobs.latest(id)?.job).toMatchObject({ state: "cancelled", cancel: "closed" });
    expect(state.reviews[id]).toMatchObject({ job: { state: "cancelled" }, run: null });
  }
  expect(store.jobs.leftRunning()).toEqual([]);
  expect(store.posts.of(runId)?.posts.filter((p) => p.hostId === null)).toEqual([]);
  host.release();

  // Back in the installation: new again, switched on, nothing waiting for it.
  host.addRepository(LEDGER);
  await time.advance(5 * MIN);
  await until(stream, "repo.added");
  const back = await snapshot(service, cookie);
  expect(back.repos.map((r: Repository) => r.id)).toEqual([idOf(SANDBOX), idOf(WEB), idOf(LEDGER)]);
  expect(store.jobs.pendingIn("sasensi/ledger-api#")).toBe(false);
  expect(Object.keys(back.changes)).toEqual([
    "sasensi/ledger-web#4",
    "sasensi/ledger-api#1",
    "sasensi/ledger-api#2",
  ]);
});

test("with an allow-list, a repository the installation lists outside it never appears and is never polled", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({
    repo: SANDBOX,
    repositories: [LEDGER],
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const { service } = await start({ host, time, repos: [SANDBOX] });
  const cookie = await openApp(service);
  host.addRepository(WEB);
  await time.advance(11 * MIN);
  const state = await snapshot(service, cookie);
  expect(state.repos.map((r: Repository) => r.id)).toEqual([idOf(SANDBOX)]);
  expect(host.lists.get(SANDBOX.name)).toBeGreaterThan(1);
  expect(host.lists.get(LEDGER.name)).toBeUndefined();
  expect(host.lists.get(WEB.name)).toBeUndefined();
});

test("with nobody signed in, the setup shows and nothing is listed", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const dir = home();
  const { service } = await start({ home: dir, host, time, github: signedOutOn(host, dir) });
  const cookie = await openApp(service);
  await time.advance(10 * MIN);
  const state = await snapshot(service, cookie);
  expect(state.setup).toMatchObject({ done: false, github: "start" });
  expect(state.connection).toMatchObject({ state: "not-connected", person: null });
  expect(host.lists.size).toBe(0);
});

test("a repository removed from the installation while its listing is under way stays gone: the listing's answer adds nothing", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new HeldListing({
    repo: SANDBOX,
    repositories: [LEDGER],
    bot: SHARED_BOT,
    person: OWNER,
    changes: [],
    clock: time,
  });
  const store = openStore({ home: home(), durable: false });
  const lines: string[] = [];
  const { room } = await startRoom({
    host,
    time,
    store,
    repos: [SANDBOX, LEDGER],
    log: (l) => lines.push(l),
  });
  host.open(opened(LEDGER, 3));
  host.hold(LEDGER);
  await time.advance(MIN);
  await host.answered;

  // Its listing answered and held, ledger-api leaves the installation; "Reconnect" finds it gone.
  host.removeRepository(LEDGER);
  const events = heard(room.events);
  const reconnected = room.reconnect().catch(() => {});
  await events.first("repo.removed");
  host.release();
  await reconnected;
  await time.advance(MIN);
  events.stop();

  expect(events.sent.filter((e) => e.type === "repo.added" || e.type === "change.opened")).toEqual([]);
  expect(room.snapshot().repos.map((r: Repository) => r.id)).toEqual([idOf(SANDBOX)]);
  expect(room.snapshot().changes).toEqual({});
  expect(store.repos.listed()).toEqual([SANDBOX]);
  expect(store.jobs.pendingIn("sasensi/ledger-api#")).toBe(false);
  expect(lines).toEqual([]);
});

test("restarted with live mode's sign-in on an unfinished setup: the setup set up at once is sent, not the one the events last said", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
  });
  const dir = home();
  const first = await startRoom({ home: dir, host, time, setup: WAITING, log: () => {} });
  expect(first.room.snapshot().setup).toMatchObject({ done: false });
  await first.room.stop();

  const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, setUpAtOnce: true, log: () => {} });
  expect(room.snapshot().setup).toMatchObject({ done: true });
});

test("stopped once a sign-in was kept and before the setup moved on: the restart waits for its install", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    installed: false,
  });
  const dir = home();
  const setup: Setup = { ...WAITING, github: "start" };
  const first = await startRoom({ home: dir, host, time, setup, github: signedOutOn(host, dir) });
  expect(first.room.snapshot().setup).toMatchObject({ github: "start" });
  await first.room.stop();
  // The sign-in kept, and the service stopped before the setup heard of it.
  const github = await signedInOn(host, dir);

  const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, github });
  expect(room.snapshot().setup).toMatchObject({ github: "waiting-for-install" });
  host.install();
  await time.advance(4_000);
  expect(room.snapshot().setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
  expect(room.snapshot().connection).toMatchObject({ state: "connected", person: OWNER });
  expect(room.snapshot().changes[changeId("sasensi/lookover-sandbox#1")]).toBeDefined();
});

test("restarted with the sign-in gone from the data folder: the setup shows again, whatever the events last said", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    installed: false,
  });
  const dir = home();
  const first = await startRoom({ home: dir, host, time, setup: WAITING, log: () => {} });
  expect(first.room.snapshot().setup).toMatchObject({ github: "waiting-for-install" });
  await first.room.stop();
  rmSync(join(dir, "github", "sign-in.json"));

  const { room } = await startRoom({
    home: dir,
    host,
    time,
    idsFrom: 100,
    github: signedOutOn(host, dir),
    log: () => {},
  });
  expect(room.snapshot().setup).toMatchObject({ done: false, step: "github", github: "start" });
  expect(room.snapshot().connection.person).toBeNull();
});
