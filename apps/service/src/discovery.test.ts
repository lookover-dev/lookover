// The App, its installation and the repositories it lists (ADR 0053), through the service's door on the held demo
// clock and the fake GitHub, which owns the App and its installation: the install waited for every 4 s while the setup
// waits for it, "nothing granted" until it lists a repository; the installation's repositories followed every 5
// minutes, one added arriving switched on, one removed leaving with its waiting and running jobs cancelled and its
// unsent posts dropped, and back again with no waiting job; the allow-list cutting what is listed; the App kept in the
// data folder giving the owner, the bot and the key's protection, and a key that no longer opens shown at once.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  changeId,
  commitSha,
  type Event,
  type HostChange,
  type Listing,
  type Repository,
  type RepositoryRef,
  repositoryId,
  type Setup,
} from "@lookover/contracts";
import { openStore } from "@lookover/store";
import { DemoClock, type FakeChange, FakeGitHost } from "@lookover/testkit";
import { appStore, memoryKeychain, type Room } from "./index.ts";
import {
  ACME,
  ACME_WEB,
  api,
  BOT,
  fakeEngines,
  HeldReviews,
  home,
  messages,
  OWNER,
  onAcmeWeb,
  onFakeGitHub,
  onOrganisationApp,
  openApp,
  organisationHost,
  personalApp,
  post,
  pr1,
  pr2,
  SANDBOX,
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

/** The owner on the GitHub step, their App made and given, its install waited for. */
const WAITING: Setup = {
  done: false,
  step: "github",
  reached: "github",
  github: "waiting-for-install",
  githubRefused: null,
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

/** A fake GitHub that counts each repository's listings, and how often the installation is read. */
class Counting extends FakeGitHost {
  lists = new Map<string, number>();
  reads = 0;
  override listOpenChanges(repo: RepositoryRef): Promise<Listing<HostChange>> {
    this.lists.set(repo.name, (this.lists.get(repo.name) ?? 0) + 1);
    return super.listOpenChanges(repo);
  }
  override installation(...args: Parameters<FakeGitHost["installation"]>) {
    this.reads++;
    return super.installation(...args);
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
  const host = new Counting({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, installed: false });
  const { service } = await start({ host, time, setup: WAITING });
  const cookie = await openApp(service);
  const before = await snapshot(service, cookie);
  expect(before.setup.github).toBe("waiting-for-install");
  expect(before.connection).toMatchObject({ state: "not-connected", installationId: null });
  expect(before.repos).toEqual([]);

  // Installed with no repository: "nothing granted", connected, still checked.
  const installation = host.install([]);
  await time.advance(4_000);
  const nothing = await snapshot(service, cookie);
  expect(nothing.setup).toMatchObject({ github: "nothing-granted", step: "github" });
  expect(nothing.connection).toMatchObject({ state: "connected", installationId: installation });
  expect(nothing.repos).toEqual([]);

  // The owner grants the sandbox on GitHub: within 4 s it is listed and switched on; the step waits for Continue.
  host.addRepository(SANDBOX);
  await time.advance(4_000);
  const granted = await snapshot(service, cookie);
  expect(granted.setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
  expect(granted.repos.map((r: Repository) => [r.id, r.enabled])).toEqual([[idOf(SANDBOX), true]]);
  expect(granted.changes[changeId("lookover-sandbox#1")]).toMatchObject({ author: "you" });
  // What was open before is listed, not reviewed.
  expect(granted.reviews[changeId("lookover-sandbox#1")]?.job ?? null).toBeNull();

  // Granted: no more reads every 4 s; the installation is next read by the discovery, 5 minutes on.
  const reads = host.reads;
  await time.advance(MIN);
  expect(host.reads).toBe(reads);
  await time.advance(4 * MIN);
  expect(host.reads).toBe(reads + 1);
});

test("uninstalled and installed again while nothing is granted: the new installation is shown at once, and kept once a repository is granted", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, installed: false });
  const { service } = await start({ host, time, setup: WAITING });
  const cookie = await openApp(service);
  const first = host.install([]);
  await time.advance(4_000);
  expect((await snapshot(service, cookie)).connection).toMatchObject({ installationId: first });

  // The owner uninstalls the App and installs it again, still granting nothing: the links lead to the new one.
  host.uninstall();
  await time.advance(4_000);
  const second = host.install([]);
  expect(second).not.toBe(first);
  await time.advance(4_000);
  const again = await snapshot(service, cookie);
  expect(again.setup.github).toBe("nothing-granted");
  expect(again.connection).toMatchObject({ state: "connected", installationId: second });

  host.addRepository(SANDBOX);
  await time.advance(4_000);
  const granted = await snapshot(service, cookie);
  expect(granted.setup.github).toBe("done");
  expect(granted.connection).toMatchObject({ state: "connected", installationId: second });
});

test("a repository added to the installation and one removed appear and leave within one listing; the removed one's jobs are cancelled and its unsent posts dropped", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new HeldReviews({
    repo: SANDBOX,
    repositories: [LEDGER],
    bot: BOT,
    changes: [],
    clock: time,
  });
  const store = openStore({ home: home(), durable: false });
  const engines = fakeEngines({ reviews: 2, time });
  const { service } = await start({ host, time, store, repos: [SANDBOX, LEDGER, WEB], engines });
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
  expect((await post(service, cookie, { type: "review.request", changeId: "ledger-api#2" })).status).toBe(
    200,
  );
  const first = changeId("ledger-api#1");
  const second = changeId("ledger-api#2");
  expect(store.jobs.latest(first)?.job.state).toBe("running");
  expect(store.jobs.pending(second)).toBe(true);
  const runId = (await snapshot(service, cookie)).reviews[first]?.run?.id;
  if (runId === undefined) throw new Error("ledger-api#1 has a run");
  expect(store.posts.of(runId)?.posts.filter((p) => p.hostId === null).length).toBeGreaterThan(0);

  // On GitHub: ledger-api leaves the installation, ledger-web joins it. One listing, at most 5 minutes on.
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
  expect(Object.keys(state.changes)).toEqual(["ledger-web#4"]);
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
  expect(store.jobs.pendingIn("ledger-api#")).toBe(false);
  expect(Object.keys(back.changes)).toEqual(["ledger-web#4", "ledger-api#1", "ledger-api#2"]);
});

test("with an allow-list, a repository the installation lists outside it never appears and is never polled", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, repositories: [LEDGER], bot: BOT, changes: [pr1], clock: time });
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

test("the App kept in the data folder: its owner and bot, its installation's repositories, its key's protection in Run checks", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const dir = home();
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  const { key } = host.credentials();
  const app = personalApp(1, "lookover-spike-sasensi");
  await apps.write(app, key);
  const { given: _, ...side } = onFakeGitHub(host);
  const { service } = await start({ home: dir, host, time, github: { ...side, apps } });
  const cookie = await openApp(service);
  const state = await snapshot(service, cookie);
  expect(state.connection).toMatchObject({
    state: "connected",
    bot: BOT.login,
    app: personalApp(1, "lookover-spike-sasensi"),
    installationId: 60_000_001,
  });
  expect(state.changes[changeId("lookover-sandbox#1")]).toMatchObject({ author: "you" });
  expect((await post(service, cookie, { type: "service.runChecks" })).status).toBe(200);
  const checked = await snapshot(service, cookie);
  expect(checked.service.checks?.items).toContainEqual(
    expect.objectContaining({ check: "connection", key: "keychain" }),
  );
});

test("an organisation's App kept: its account shown apart from the person, whose changes and requests alone are theirs", async () => {
  const time = new DemoClock({ at: T0 });
  // ACME's `web`: #1 is the owner's, #2 a teammate's (octocat's).
  const host = organisationHost(time, [onAcmeWeb(pr1), onAcmeWeb(pr2)]);
  const dir = home();
  const { service } = await start({
    home: dir,
    host,
    time,
    github: await onOrganisationApp(host, dir),
    engines: fakeEngines({ reviews: 1 }),
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const state = await snapshot(service, cookie);
  expect(state.connection.app).toEqual({
    id: 1,
    slug: "lookover-spike-sasensi",
    account: ACME,
    person: OWNER,
  });
  expect(state.changes[changeId("web#1")]).toMatchObject({ author: "you" });
  expect(state.changes[changeId("web#2")]).toMatchObject({ author: "other" });

  await time.advance(5_000);
  host.seedComment({ repo: ACME_WEB, number: 2 }, { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  const finished = (await until(stream, "round.finished")).find((e) => e.type === "round.finished");
  expect(finished).toMatchObject({ changeId: changeId("web#2") });
});

test("live.json naming an organisation's App: the start refuses it, never keeping the organisation as the person", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const side = onFakeGitHub(host);
  const github = {
    ...side,
    installations: {
      ...side.installations,
      app: async (credentials: Parameters<typeof side.installations.app>[0]) => ({
        ...(await side.installations.app(credentials)),
        owner: ACME,
      }),
    },
  };
  // The test's own store: the start refused never ran, so nothing else closes it.
  const dir = home();
  const store = openStore({ home: dir, durable: false });
  await expect(startRoom({ home: dir, host, time, github, store })).rejects.toThrow("acme");
  store.close();
});

test("the App kept with a key that no longer opens: shown disconnected at start, its cause the key lost; nothing listed", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const dir = home();
  const keychain = memoryKeychain();
  const apps = appStore({ home: dir, keychain, userOnly: async () => {} });
  await apps.write(personalApp(1, "lookover-spike-sasensi"), host.credentials().key);
  for (const name of keychain.names()) await keychain.delete(name);
  const { given: _, ...side } = onFakeGitHub(host);
  const { service } = await start({ home: dir, host, time, github: { ...side, apps } });
  const cookie = await openApp(service);
  const state = await snapshot(service, cookie);
  expect(state.connection).toMatchObject({ state: "disconnected", cause: { kind: "key-lost" } });
  expect(host.lists.size).toBe(0);
});

test("with no App at all, the setup shows and nothing is listed", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const dir = home();
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  const { given: _, ...side } = onFakeGitHub(host);
  const { service } = await start({ home: dir, host, time, github: { ...side, apps } });
  const cookie = await openApp(service);
  await time.advance(10 * MIN);
  const state = await snapshot(service, cookie);
  expect(state.setup).toMatchObject({ done: false, github: "start" });
  expect(state.connection).toMatchObject({ state: "not-connected", bot: null, app: null });
  expect(host.lists.size).toBe(0);
});

test("a repository removed from the installation while its listing is under way stays gone: the listing's answer adds nothing", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new HeldListing({ repo: SANDBOX, repositories: [LEDGER], bot: BOT, changes: [], clock: time });
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
  expect(store.jobs.pendingIn("ledger-api#")).toBe(false);
  expect(lines).toEqual([]);
});

test("a key lost while the setup waits for the install: the App store read again at each check, and a key back goes on with the install", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, installed: false });
  const dir = home();
  const keychain = memoryKeychain();
  const apps = appStore({ home: dir, keychain, userOnly: async () => {} });
  await apps.write(personalApp(1, "lookover-spike-sasensi"), host.credentials().key);
  const kept = await Promise.all(
    keychain.names().map(async (name) => [name, await keychain.get(name)] as const),
  );
  for (const [name] of kept) await keychain.delete(name);
  const { given: _, ...side } = onFakeGitHub(host);
  const { room } = await startRoom({ home: dir, host, time, setup: WAITING, github: { ...side, apps } });

  // The key back in the keychain, the App installed on GitHub: the next check finds both (the App store's reads
  // are the disk's, not the clock's).
  for (const [name, value] of kept) if (value !== null) await keychain.set(name, value);
  host.install();
  const events = heard(room.events);
  await time.advance(4_000);
  await events.first("setup.changed");
  events.stop();
  expect(room.snapshot().setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
  expect(room.snapshot().connection).toMatchObject({ state: "connected" });
});

/** The App the fake made, as GitHub describes it and Lookover keeps it. */
const describedApp = async (room: Room, host: FakeGitHost) => {
  const { id, slug, owner } = await room.github.installations.app(host.credentials());
  return personalApp(id, slug, { id: owner.id, login: owner.login });
};

test("an App adopted while the setup waits for it: kept, its bot shown once, then its install waited for every 4 s", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, installed: false });
  const dir = home();
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  const { given: _, ...side } = onFakeGitHub(host);
  const { room } = await startRoom({ home: dir, host, time, github: { ...side, apps } });
  expect(room.snapshot().setup).toMatchObject({ github: "start" });
  const app = await describedApp(room, host);

  const events = heard(room.events);
  await room.github.adopt(app, host.credentials().key);
  expect(await apps.read()).toMatchObject({ state: "kept", app });
  expect(room.github.app()).toEqual(app);
  expect(room.snapshot().setup).toMatchObject({ github: "waiting-for-install", githubRefused: null });
  expect(room.snapshot().connection).toMatchObject({
    state: "not-connected",
    bot: BOT.login,
    app: { id: app.id },
  });
  expect(events.sent.filter((e) => e.type === "connection.changed")).toHaveLength(1);

  host.install();
  await time.advance(4_000);
  events.stop();
  // The room started set up: the step stays where the owner is, the furthest reached is kept (ADR 0058).
  expect(room.snapshot().setup).toMatchObject({ github: "done", step: "github", reached: "background" });
  expect(room.snapshot().connection).toMatchObject({ state: "connected" });
  expect(room.snapshot().changes[changeId("lookover-sandbox#1")]).toBeDefined();
});

test("a new key adopted for the App kept, installed already, whose key was lost: reconnected and listed", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const dir = home();
  const keychain = memoryKeychain();
  const apps = appStore({ home: dir, keychain, userOnly: async () => {} });
  await apps.write(personalApp(1, "lookover-spike-sasensi"), host.credentials().key);
  for (const name of keychain.names()) await keychain.delete(name);
  const { given: _, ...side } = onFakeGitHub(host);
  const { room } = await startRoom({ home: dir, host, time, github: { ...side, apps } });
  expect(room.snapshot().connection).toMatchObject({ state: "disconnected", cause: { kind: "key-lost" } });

  const key = host.generateKey();
  await room.github.adopt(await describedApp(room, host), key);
  expect(await apps.read()).toMatchObject({ state: "kept", privateKey: key });
  expect(room.snapshot().connection).toMatchObject({ state: "connected", cause: null });
  expect(room.snapshot().changes[changeId("lookover-sandbox#1")]).toMatchObject({ author: "you" });
});

test("another App adopted while live.json names one: refused, and nothing changes", async () => {
  const time = new DemoClock({ at: T0 });
  const { room } = await startRoom({ time });
  const before = room.snapshot();
  const events = heard(room.events);
  const other = personalApp(99, "another-app");
  await expect(room.github.adopt(other, "-----BEGIN RSA PRIVATE KEY-----")).rejects.toThrow("live.json");
  await time.advance(MIN);
  events.stop();
  expect(events.sent.filter((e) => e.type !== "clock")).toEqual([]);
  expect(room.github.app()).not.toEqual(other);
  expect(room.snapshot().connection).toEqual(before.connection);
  expect(room.snapshot().setup).toEqual(before.setup);
});

/** A first start on `dir` with the App store and no App: the App adopted, so the event log says its install is waited for. */
const waitedFor = async (dir: string, host: FakeGitHost, time: DemoClock) => {
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  const { given: _, ...side } = onFakeGitHub(host);
  const { room } = await startRoom({ home: dir, host, time, github: { ...side, apps } });
  await room.github.adopt(await describedApp(room, host), host.credentials().key);
  expect(room.snapshot().setup).toMatchObject({ done: false, github: "waiting-for-install" });
  await room.stop();
  return side;
};

test("restarted with live.json's App on an unfinished setup: the setup set up at once is sent, not the one the events last said", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, installed: false });
  const dir = home();
  await waitedFor(dir, host, time);
  host.install();

  const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, setUpAtOnce: true, log: () => {} });
  expect(room.snapshot().setup).toMatchObject({ done: true });
});

for (const github of ["start", "waiting-for-app"] as const) {
  test(`stopped once the App was kept and before the setup moved on (${github}): the restart waits for its install`, async () => {
    const time = new DemoClock({ at: T0 });
    const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, installed: false });
    const dir = home();
    const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
    const { given: _, ...side } = onFakeGitHub(host);
    const setup: Setup = { ...WAITING, github };
    const first = await startRoom({ home: dir, host, time, setup, github: { ...side, apps } });
    const app = await describedApp(first.room, host);
    await first.room.stop();
    // "Create it on GitHub" or "Use an existing App" wrote the App store, and the service stopped before the setup.
    await apps.write(app, host.credentials().key);

    const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, github: { ...side, apps } });
    expect(room.snapshot().setup).toMatchObject({ github: "waiting-for-install", githubRefused: null });
    host.install();
    await time.advance(4_000);
    expect(room.snapshot().setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
    expect(room.snapshot().connection).toMatchObject({ state: "connected", app: { id: app.id } });
    expect(room.snapshot().changes[changeId("lookover-sandbox#1")]).toBeDefined();
  });
}

test("restarted with the App gone from the data folder:the setup shows again, whatever the events last said", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, installed: false });
  const dir = home();
  const side = await waitedFor(dir, host, time);
  rmSync(join(dir, "github", "app.json"));

  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  const { room } = await startRoom({
    home: dir,
    host,
    time,
    idsFrom: 100,
    github: { ...side, apps },
    log: () => {},
  });
  expect(room.snapshot().setup).toMatchObject({ done: false, step: "github", github: "start" });
});
