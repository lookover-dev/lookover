// The connection's causes (ADR 0053), through the room on the held demo clock and the fake GitHub, which owns the App
// and its installation: each fault the owner can meet shows as the connection's cause (GitHub down, the App
// uninstalled or its installation suspended, its key revoked), "Reconnect" clears it once the fault is gone, a
// reinstall heals by itself, and a service that starts while GitHub refuses it stays up and says why. A repository
// whose token is refused (it left the installation) has the installation listed again at once.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type ConnectionCause,
  changeId,
  type Event,
  type HostChange,
  HostError,
  type Listing,
  type Repository,
  type RepositoryRef,
  repositoryId,
} from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import { appStore, memoryKeychain, type Room } from "./index.ts";
import {
  BOT,
  fakeEngines,
  home,
  onFakeGitHub,
  personalApp,
  pr1,
  SANDBOX,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const LEDGER: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-api" };
const idOf = (repo: RepositoryRef) => repositoryId(`${repo.owner}/${repo.name}`);
const APP = personalApp(1, "lookover-spike-sasensi");
const PLANTED = changeId("lookover-sandbox#1");

/**
 * A fake GitHub that counts each repository's listings, and how often the installation is read; a repository named in
 * `refusing` has its listing refused so, the installation listing it all the same.
 */
class Counting extends FakeGitHost {
  lists = new Map<string, number>();
  reads = 0;
  refusing = new Map<string, HostError>();
  override listOpenChanges(repo: RepositoryRef): Promise<Listing<HostChange>> {
    this.lists.set(repo.name, (this.lists.get(repo.name) ?? 0) + 1);
    const refusal = this.refusing.get(repo.name);
    return refusal === undefined ? super.listOpenChanges(repo) : Promise.reject(refusal);
  }
  override installation(...args: Parameters<FakeGitHost["installation"]>) {
    this.reads++;
    return super.installation(...args);
  }
}

/** What "Reconnect" answers: null when it listed, else what it was refused with. */
const reconnected = (room: Room): Promise<unknown> =>
  room.reconnect().then(
    () => null,
    (error: unknown) => error,
  );

/** The events the room sends from now on. */
function heard(room: Room) {
  const sent: Event[] = [];
  const stop = room.events.subscribe((e) => {
    sent.push(e);
  });
  return { sent, stop };
}

/** One fault the owner meets on GitHub, the cause the connection shows for it, and the owner's fix there. */
interface Fault {
  name: string;
  meet(host: FakeGitHost): void;
  cause: ConnectionCause;
  fix(host: FakeGitHost): void;
}

const FAULTS: Fault[] = [
  {
    name: "GitHub down",
    meet: (host) => host.refuse("unavailable"),
    cause: { kind: "unreachable" },
    fix: (host) => host.refuse(null),
  },
  {
    name: "the App uninstalled",
    meet: (host) => host.uninstall(),
    cause: { kind: "uninstalled", suspended: false },
    fix: (host) => host.install(),
  },
  {
    name: "its installation suspended",
    meet: (host) => host.suspend(),
    cause: { kind: "uninstalled", suspended: true },
    fix: (host) => host.unsuspend(),
  },
];

for (const fault of FAULTS)
  test(`${fault.name}: the connection shows its cause; Reconnect keeps it while the fault lasts, and clears it once fixed`, async () => {
    const time = new DemoClock({ at: T0 });
    const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
    const { room } = await startRoom({ host, time, log: () => {} });

    fault.meet(host);
    await time.advance(MIN);
    expect(room.snapshot().connection).toMatchObject({
      state: "disconnected",
      cause: fault.cause,
      since: T0 + MIN,
    });

    expect(await reconnected(room)).not.toBeNull();
    expect(room.snapshot().connection).toMatchObject({ state: "disconnected", cause: fault.cause });

    fault.fix(host);
    expect(await reconnected(room)).toBeNull();
    expect(room.snapshot().connection).toMatchObject({
      state: "connected",
      cause: null,
      installationId: host.onGitHub().installation?.id,
    });
  });

const INSTALLATION_FAULTS: Fault[] = [
  ...FAULTS.filter((fault) => fault.cause.kind !== "unreachable"),
  {
    name: "the key revoked",
    meet: (host) => host.revokeKey(),
    cause: { kind: "key-refused", why: "revoked" },
    fix: () => {},
  },
];

for (const fault of INSTALLATION_FAULTS)
  test(`${fault.name} with no repository watched: the installation's listing disconnects the connection`, async () => {
    const time = new DemoClock({ at: T0 });
    const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
    // The allow-list leaves out every repository the installation grants: nothing for the loop to poll.
    const github = onFakeGitHub(host, { allowed: [LEDGER] });
    const { room } = await startRoom({ host, time, github, log: () => {} });
    expect(room.snapshot().connection).toMatchObject({ state: "connected", cause: null });
    expect(room.snapshot().repos).toEqual([]);

    fault.meet(host);
    await time.advance(5 * MIN);
    await time.advance(0);
    expect(room.snapshot().connection).toMatchObject({
      state: "disconnected",
      cause: fault.cause,
      since: T0 + 5 * MIN,
    });
  });

test("the key revoked on GitHub: the connection says so, and a new key for the App kept clears it", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const dir = home();
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  await apps.write(APP, host.credentials().key);
  const { given: _, ...side } = onFakeGitHub(host);
  const { room } = await startRoom({ home: dir, host, time, github: { ...side, apps }, log: () => {} });

  host.revokeKey();
  await time.advance(MIN);
  const refused = { kind: "key-refused", why: "revoked" };
  expect(room.snapshot().connection).toMatchObject({ state: "disconnected", cause: refused, app: APP });
  expect(await reconnected(room)).not.toBeNull();
  expect(room.snapshot().connection).toMatchObject({ state: "disconnected", cause: refused });

  await room.github.adopt(APP, host.generateKey());
  expect(room.snapshot().connection).toMatchObject({ state: "connected", cause: null });
});

test("a reinstall heals without a restart: the loop's next listing shows the connection back, with the new installation", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const { room } = await startRoom({ host, time, log: () => {} });

  host.uninstall();
  await time.advance(MIN);
  expect(room.snapshot().connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "uninstalled", suspended: false },
  });

  const installation = host.install();
  await time.advance(MIN);
  await time.advance(0);
  expect(room.snapshot().connection).toMatchObject({
    state: "connected",
    cause: null,
    installationId: installation,
  });
});

test("uninstalled and installed again while the service was stopped: the restart shows the new installation, not the one its events last said", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const dir = home();
  const first = await startRoom({ home: dir, host, time, log: () => {} });
  // A reinstall healed while running: the event log now says the second installation.
  host.uninstall();
  await time.advance(MIN);
  const healed = host.install();
  await time.advance(MIN);
  await time.advance(0);
  expect(first.room.snapshot().connection).toMatchObject({ state: "connected", installationId: healed });
  await first.room.stop();

  host.uninstall();
  const fresh = host.install();
  expect(fresh).not.toBe(healed);
  const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, log: () => {} });
  expect(room.snapshot().connection).toMatchObject({
    state: "connected",
    cause: null,
    app: APP,
    installationId: fresh,
  });
});

test("started with the key refused: the service is up and says so, the repositories kept from the last start, nothing listed", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  host.revokeKey();
  const { room } = await startRoom({ host, time, log: () => {} });

  expect(room.snapshot().connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "key-refused", why: "revoked" },
    since: T0,
  });
  expect(host.lists.size).toBe(0);
  await time.advance(10 * MIN);
  expect(room.snapshot().connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "key-refused", why: "revoked" },
  });
  expect(await reconnected(room)).not.toBeNull();
});

test("started with the key kept refused: up, the App shown with its cause; a new key lists", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const dir = home();
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  await apps.write(APP, host.credentials().key);
  host.revokeKey();
  const { given: _, ...side } = onFakeGitHub(host);
  const { room } = await startRoom({ home: dir, host, time, github: { ...side, apps }, log: () => {} });

  expect(room.snapshot().connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "key-refused", why: "revoked" },
    app: APP,
    bot: BOT.login,
  });
  await room.github.adopt(APP, host.generateKey());
  expect(room.snapshot().connection).toMatchObject({ state: "connected", cause: null });
  expect(room.snapshot().changes[PLANTED]).toMatchObject({ author: "you" });
});

test("started while GitHub is down: up and unreachable; once GitHub answers, the loop describes the App and lists by itself", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  host.refuse("unavailable");
  const { room } = await startRoom({ host, time, log: () => {} });
  expect(room.snapshot().connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "unreachable" },
  });

  host.refuse(null);
  await time.advance(MIN);
  await time.advance(0);
  expect(room.snapshot().connection).toMatchObject({
    state: "connected",
    cause: null,
    bot: BOT.login,
    app: APP,
    installationId: host.onGitHub().installation?.id,
  });
  expect(room.snapshot().changes[PLANTED]).toMatchObject({ author: "you" });
});

test("started with the App uninstalled: up and uninstalled; installed again, the loop lists by itself", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, installed: false });
  const { room } = await startRoom({ host, time, log: () => {} });
  expect(room.snapshot().connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "uninstalled", suspended: false },
  });

  const installation = host.install();
  await time.advance(MIN);
  await time.advance(0);
  expect(room.snapshot().connection).toMatchObject({
    state: "connected",
    cause: null,
    installationId: installation,
  });
  expect(room.snapshot().changes[PLANTED]).toBeDefined();
});

test("a repository's token refused (it left the installation): the installation is listed again at once, and it leaves", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, repositories: [LEDGER], bot: BOT, changes: [], clock: time });
  const lines: string[] = [];
  const { room } = await startRoom({
    host,
    time,
    repos: [SANDBOX, LEDGER],
    engines: fakeEngines({ time }),
    log: (line) => lines.push(line),
  });
  const events = heard(room);

  host.removeRepository(LEDGER);
  await time.advance(MIN);
  await time.advance(0);
  events.stop();
  expect(events.sent.filter((e) => e.type === "repo.removed")).toMatchObject([{ repoId: idOf(LEDGER) }]);
  expect(room.snapshot().repos.map((r: Repository) => r.id)).toEqual([idOf(SANDBOX)]);
  // The connection is the installation's: one repository refused never shows it down.
  expect(events.sent.filter((e) => e.type === "connection.changed")).toEqual([]);

  // Gone: never asked again.
  const asked = host.lists.get(LEDGER.name);
  await time.advance(3 * MIN);
  expect(host.lists.get(LEDGER.name)).toBe(asked);
  expect(lines.filter((l) => l.includes("leaves out")).length).toBeLessThanOrEqual(1);
});

/** "Refresh", what it throws kept back: the poll it ran is what counts here. */
const refreshed = (room: Room): Promise<void> => room.refresh().catch(() => {});

test("a repository refused as not found while the installation still lists it: the installation is listed again once a minute at most", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, repositories: [LEDGER], bot: BOT, changes: [], clock: time });
  const { room } = await startRoom({ host, time, repos: [SANDBOX, LEDGER], log: () => {} });
  const before = host.reads;

  host.refusing.set(LEDGER.name, new HostError("not_found", "Not Found (404)"));
  for (let i = 0; i < 3; i++) {
    await refreshed(room);
    await time.advance(0);
  }
  expect(host.reads).toBe(before + 1);
  expect(room.snapshot().repos.map((r: Repository) => r.id)).toEqual([idOf(SANDBOX), idOf(LEDGER)]);

  // A minute on, it may be listed again.
  await time.advance(MIN);
  await refreshed(room);
  await time.advance(0);
  expect(host.reads).toBeGreaterThan(before + 1);
});

test("a repository refused unavailable, then not found, no longer counts toward GitHub unreachable", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, repositories: [LEDGER], bot: BOT, changes: [], clock: time });
  const { room } = await startRoom({ host, time, repos: [SANDBOX, LEDGER], log: () => {} });

  host.refusing.set(LEDGER.name, new HostError("unavailable", "Bad Gateway (502)"));
  await refreshed(room);
  host.refusing.set(LEDGER.name, new HostError("not_found", "Not Found (404)"));
  await refreshed(room);
  host.refusing.set(SANDBOX.name, new HostError("unavailable", "Bad Gateway (502)"));
  await refreshed(room);
  expect(room.snapshot().connection).toMatchObject({ state: "connected", cause: null });
});
