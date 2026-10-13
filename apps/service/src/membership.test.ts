// The person's membership of the organisation whose App it is (ADR 0059), through the room on the held demo clock, the
// fake GitHub (ACME's App, installed on ACME) and the fake `gh`: asked at start and every hour, for an organisation's
// App only. Only an answer from `gh` signed in as the person counts: absent or pending is the connection's cause
// `not-a-member`, and reviews stop; another account, signed out, not installed, offline, SSO or no `read:org` can't
// answer: the last answer stands and the log says why. The last answer is kept with the App, across a restart; an App
// adopted while the service runs is checked from then on; "Check again" brings a person added back.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  commitSha,
  type Event,
  type Gh,
  type GhMembership,
  type GhWhy,
  HostError,
} from "@lookover/contracts";
import { DemoClock, type FakeChange, FakeGitHost, type MemoryGh, memoryGh } from "@lookover/testkit";
import { type AppStore, appStore, type GitHubSide, memoryKeychain, type Room } from "./index.ts";
import {
  ACME,
  ACME_WEB,
  BOT,
  fakeEngines,
  home,
  OWNER,
  onFakeGitHub,
  onOrganisationApp,
  openApp,
  organisationHost,
  post,
  pr1,
  SANDBOX,
  snapshot,
  start,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOT_A_MEMBER = { kind: "not-a-member", organisation: "acme" } as const;
const CONNECTED = { state: "connected", cause: null } as const;
const DISCONNECTED = { state: "disconnected", cause: NOT_A_MEMBER } as const;
/** Another account `gh` may be signed in as: not the person Lookover works for. */
const OTHER = { id: 777, login: "otto" };
const NO_FINDINGS = { outcome: "ok", text: '```json\n{"findings": []}\n```' } as const;

/** A pull request of the person's on ACME's `web`, on a commit of its own. */
const opened = (number: number): FakeChange => ({
  ...pr1,
  repo: ACME_WEB,
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  head: { ref: `branch-${number}`, sha: commitSha(`${number}`.padStart(7, "f").padEnd(40, "0")) },
});

/** The person's `gh`, signed in as them, an active member of ACME unless said. */
function personsGh(state: "active" | "pending" | null = "active"): MemoryGh {
  const gh = memoryGh({ as: OWNER });
  if (state !== null) gh.join(ACME, OWNER, { state, admin: false });
  return gh;
}

/** A `gh` that records each organisation its membership is asked of. */
function counting(gh: Gh): Gh & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    person: () => gh.person(),
    adminOrganisations: () => gh.adminOrganisations(),
    membership: (organisation): Promise<GhMembership> => {
      asked.push(organisation);
      return gh.membership(organisation);
    },
  };
}

/** The runs started from now on. */
function runs(room: Room): Event[] {
  const started: Event[] = [];
  room.events.subscribe((e) => {
    if (e.type === "run.started") started.push(e);
  });
  return started;
}

/** Settles once the connection is connected again. */
function connected(room: Room): Promise<void> {
  return new Promise((resolve) => {
    room.events.subscribe(() => {
      if (room.snapshot().connection.state === "connected") resolve();
    });
  });
}

/** The engines, Claude answering every run with no finding. */
function claude(time: DemoClock) {
  const engines = fakeEngines({ time });
  engines.answerFor("claude", NO_FINDINGS);
  return engines;
}

/**
 * The room on ACME's App, kept in a data folder, working for the owner; a restart passes the first start's `dir`,
 * `time`, `host` and `github` (its App store, whose keychain holds the key), and ids of its own.
 */
async function onAcme(
  gh: Gh,
  o: { dir?: string; time?: DemoClock; host?: FakeGitHost; github?: GitHubSide; idsFrom?: number } = {},
) {
  const time = o.time ?? new DemoClock({ at: T0 });
  const host = o.host ?? organisationHost(time);
  const dir = o.dir ?? home();
  const github = o.github ?? (await onOrganisationApp(host, dir));
  const started = await startRoom({
    home: dir,
    host,
    time,
    gh,
    github,
    engines: claude(time),
    ...(o.idsFrom === undefined ? {} : { idsFrom: o.idsFrom }),
  });
  return { ...started, dir, github };
}

test("at start, gh says the person is not a member of the App's organisation: reviews stop, the connection says why", async () => {
  const { room, host, time, logged } = await onAcme(personsGh(null));
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
  expect(logged).toContain(
    "sasensi is no longer a member of acme: reviews stop until an admin adds them back",
  );

  const started = runs(room);
  host.open(opened(3));
  await time.advance(2 * MIN);
  expect(started).toEqual([]);
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
});

test("at start, gh says the person is a member: the log says the check answered, once, not at every hour", async () => {
  const { room, time, logged } = await onAcme(personsGh());
  const member = "sasensi is a member of acme, as their gh says";
  expect(room.snapshot().connection).toMatchObject(CONNECTED);
  expect(logged).toContain(member);
  await time.advance(HOUR);
  expect(logged.filter((line) => line === member)).toHaveLength(1);
});

test("the person leaves: reviews go on until the hour's check, then stop; added back, Check again has them reviewed", async () => {
  const gh = personsGh();
  const { room, host, time, logged } = await onAcme(gh);
  const started = runs(room);
  host.open(opened(3));
  await time.advance(MIN);
  expect(started).toHaveLength(1);

  gh.leave("acme", OWNER);
  await time.advance(HOUR - 2 * MIN);
  expect(room.snapshot().connection).toMatchObject(CONNECTED);
  await time.advance(2 * MIN);
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
  expect(logged).toContain(
    "sasensi is no longer a member of acme: reviews stop until an admin adds them back",
  );

  host.open(opened(4));
  await time.advance(5 * MIN);
  expect(started).toHaveLength(1);

  gh.join(ACME, OWNER, { state: "active", admin: false });
  await room.github.checkMembership();
  expect(room.snapshot().connection).toMatchObject(CONNECTED);
  expect(logged).toContain("sasensi is a member of acme again: reviews go on");
  await time.advance(MIN);
  expect(started).toHaveLength(2);
});

test("added back, the hour's check finds it: the connection is back at once and reviews go on, as Check again does", async () => {
  const gh = personsGh(null);
  const { room, host, time, logged } = await onAcme(gh);
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
  const started = runs(room);

  gh.join(ACME, OWNER, { state: "active", admin: false });
  // The hour's check, not the next listing (a minute on): GitHub is listed again with the clock still at the hour.
  const back = connected(room);
  await time.advance(HOUR);
  await back;
  expect(room.snapshot().connection).toMatchObject(CONNECTED);
  expect(logged).toContain("sasensi is a member of acme again: reviews go on");
  // ACME's repositories, never listed while the person wasn't a member, are watched from now on.
  host.open(opened(3));
  await time.advance(MIN);
  expect(started).toHaveLength(1);
});

test("an invitation not accepted yet is no membership: pending stops reviews as absent does", async () => {
  const gh = personsGh();
  const { room } = await onAcme(gh);
  gh.join(ACME, OWNER, { state: "pending", admin: false });
  await room.github.checkMembership();
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
});

const CANT_ANSWER: { name: string; make(gh: MemoryGh): void; why: string }[] = [
  {
    name: "gh signed in as another account",
    make: (gh) => gh.signIn(OTHER),
    why: "gh is signed in as otto, not sasensi",
  },
  { name: "gh signed out", make: (gh) => gh.signIn(null), why: "gh is signed out" },
  { name: "gh not installed", make: (gh) => gh.signIn("missing"), why: "gh is not installed" },
  ...(["offline", "sso", "scope"] satisfies GhWhy[]).map((why) => ({
    name: `gh unanswered: ${why}`,
    make: (gh: MemoryGh) => gh.fail(why, why === "sso" ? "acme" : undefined),
    why: `gh couldn't answer (${why})`,
  })),
];

for (const { name, make, why } of CANT_ANSWER)
  test(`${name}: the last answer stands, reviews go on or stay stopped, and the log says why`, async () => {
    const gh = personsGh();
    const { room, host, time, logged } = await onAcme(gh);
    const started = runs(room);
    make(gh);
    await time.advance(HOUR);
    expect(room.snapshot().connection).toMatchObject(CONNECTED);
    expect(logged.some((line) => line.startsWith(`the membership of acme was not checked, ${why}`))).toBe(
      true,
    );
    expect(logged.some((line) => line.endsWith("the last answer stands"))).toBe(true);
    host.open(opened(3));
    await time.advance(MIN);
    expect(started).toHaveLength(1);

    // No longer a member, then gh can't answer: still not one.
    const fresh = personsGh(null);
    const left = await onAcme(fresh);
    make(fresh);
    await left.room.github.checkMembership();
    await left.time.advance(HOUR);
    expect(left.room.snapshot().connection).toMatchObject(DISCONNECTED);
  });

test("at start, asking gh throws: the log says the membership was not checked, and reviews go on", async () => {
  const throwing: Gh = {
    ...personsGh(),
    membership: () => Promise.reject(new Error("gh crashed")),
  };
  const { room, logged } = await onAcme(throwing);
  expect(logged).toContain("the membership of acme was not checked, gh crashed: the last answer stands");
  expect(room.snapshot().connection).toMatchObject(CONNECTED);
});

test("removed while the service runs, then restarted with gh offline: the answer kept with the App stands, reviews stay stopped", async () => {
  const gh = personsGh();
  const first = await onAcme(gh);
  gh.leave("acme", OWNER);
  await first.time.advance(HOUR);
  expect(first.room.snapshot().connection).toMatchObject(DISCONNECTED);
  await first.room.stop();

  gh.fail("offline");
  const { room, host, time } = await onAcme(gh, { ...first, idsFrom: 100 });
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
  const started = runs(room);
  host.open(opened(3));
  await time.advance(2 * MIN);
  expect(started).toEqual([]);
});

test("removed while the service was stopped: the start asks, and the restarted service reviews nothing", async () => {
  const gh = personsGh();
  const first = await onAcme(gh);
  expect(first.room.snapshot().connection).toMatchObject(CONNECTED);
  await first.room.stop();

  gh.leave("acme", OWNER);
  const { room, host, time } = await onAcme(gh, { ...first, idsFrom: 100 });
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
  const started = runs(room);
  host.open(opened(3));
  await time.advance(2 * MIN);
  expect(started).toEqual([]);
});

test("added back while the service was stopped: the start asks, and reviews go on", async () => {
  const gh = personsGh(null);
  const first = await onAcme(gh);
  expect(first.room.snapshot().connection).toMatchObject(DISCONNECTED);
  await first.room.stop();

  gh.join(ACME, OWNER, { state: "active", admin: false });
  const { room, host, time } = await onAcme(gh, { ...first, idsFrom: 100 });
  expect(room.snapshot().connection).toMatchObject(CONNECTED);
  const started = runs(room);
  host.open(opened(3));
  await time.advance(MIN);
  expect(started).toHaveLength(1);
});

test("an organisation's App adopted while the service runs: the person removed later, the hour's check stops reviews", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: ACME_WEB,
    bot: BOT,
    changes: [],
    clock: time,
    app: { owner: ACME },
    installed: false,
  });
  const dir = home();
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  const { given: _, ...side } = onFakeGitHub(host);
  const gh = personsGh();
  const { service } = await start({
    home: dir,
    host,
    time,
    gh,
    engines: claude(time),
    // No App kept: the setup shows at its GitHub step.
    github: { ...side, installations: host, apps },
  });
  const cookie = await openApp(service);
  const { id, key } = host.credentials();
  const useApp = await post(service, cookie, { type: "connection.useApp", appId: id, key });
  expect(useApp.status).toBe(200);
  host.install();
  await time.advance(4_000);
  expect((await snapshot(service, cookie)).setup).toMatchObject({ github: "done" });
  expect((await snapshot(service, cookie)).connection).toMatchObject(CONNECTED);

  gh.leave("acme", OWNER);
  await time.advance(HOUR);
  expect((await snapshot(service, cookie)).connection).toMatchObject(DISCONNECTED);
});

test("a new key for the kept App of a person no longer a member: reviews stay stopped, across a restart too", async () => {
  const gh = personsGh(null);
  const first = await onAcme(gh);
  const kept = first.room.github.app();
  if (kept === null) throw new Error("ACME's App is kept");
  await first.room.github.adopt(kept, first.host.credentials().key);
  expect(first.room.snapshot().connection).toMatchObject(DISCONNECTED);
  await first.room.stop();

  gh.fail("offline");
  const { room } = await onAcme(gh, { ...first, idsFrom: 100 });
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
});

test("a new key for a person no longer a member is kept with the answer in one write: a later write failing, the restart stays stopped", async () => {
  const gh = personsGh(null);
  const first = await onAcme(gh);
  expect(first.room.snapshot().connection).toMatchObject(DISCONNECTED);
  const kept = first.room.github.app();
  const apps = first.github.apps;
  if (kept === null || apps === undefined) throw new Error("ACME's App is kept");
  await first.room.stop();
  // Only the new key's write lands: any membership write after it fails.
  const once: AppStore = {
    read: () => apps.read(),
    write: (app, key, membership) => apps.write(app, key, membership),
    keepMembership: () => Promise.reject(new Error("disk full")),
  };
  const restarted = await onAcme(gh, { ...first, github: { ...first.github, apps: once }, idsFrom: 100 });
  await restarted.room.github.adopt(kept, first.host.credentials().key);
  await restarted.room.stop();

  gh.fail("offline");
  const { room } = await onAcme(gh, { ...first, idsFrom: 200 });
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
});

/**
 * The App store `apps`, its keychain not answering while `locked.now` is true: the App read as lost for now (the
 * cause `unreachable`), its record and the answer kept with it read as they are.
 */
function lockable(apps: AppStore): { apps: AppStore; locked: { now: boolean } } {
  const locked = { now: true };
  return {
    locked,
    apps: {
      read: async () => {
        const read = await apps.read();
        if (!locked.now || read.state !== "kept") return read;
        const { privateKey: _, ...rest } = read;
        return { ...rest, state: "lost", why: "keychain" };
      },
      write: (app, key, membership) => apps.write(app, key, membership),
      keepMembership: (membership) => apps.keepMembership(membership),
    },
  };
}

/**
 * The room on ACME's App restarted with its keychain not answering, the person a member at the first start (the
 * answer kept with the App); `meanwhile` runs while it is stopped.
 */
async function restartedLocked(gh: MemoryGh, meanwhile: () => void) {
  const first = await onAcme(gh);
  expect(first.room.snapshot().connection).toMatchObject(CONNECTED);
  await first.room.stop();
  meanwhile();
  const { apps } = first.github;
  if (apps === undefined) throw new Error("ACME's App is kept");
  const { apps: locked, locked: lock } = lockable(apps);
  const restarted = await onAcme(gh, { ...first, github: { ...first.github, apps: locked }, idsFrom: 100 });
  expect(restarted.room.snapshot().connection).toMatchObject({ cause: { kind: "unreachable" } });
  return { ...restarted, lock };
}

test("the keychain not answering at start: the membership is asked all the same, and the key back opens nothing for a person no longer a member", async () => {
  const gh = personsGh();
  const { room, host, time, lock, logged } = await restartedLocked(gh, () => gh.leave("acme", OWNER));
  expect(logged).toContain(
    "sasensi is no longer a member of acme: reviews stop until an admin adds them back",
  );

  gh.fail("offline");
  lock.now = false;
  const started = runs(room);
  host.open(opened(3));
  await room.reconnect().catch(() => {});
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
  await time.advance(5 * MIN);
  expect(started).toEqual([]);
});

test("the keychain back after start: gh is asked before the App's ports open again, the last answer kept not trusted", async () => {
  const gh = personsGh();
  const { room, host, time, lock } = await restartedLocked(gh, () => gh.fail("offline"));

  // The person removed while the key couldn't be read, gh answering again only once it can.
  gh.fail(null);
  gh.leave("acme", OWNER);
  lock.now = false;
  const started = runs(room);
  host.open(opened(3));
  await room.reconnect().catch(() => {});
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
  await time.advance(5 * MIN);
  expect(started).toEqual([]);
});

test("the person leaves after a check said member, then gives a new key: the key is kept and reviews stop at once, across a restart too", async () => {
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time);
  const dir = home();
  const github = await onOrganisationApp(host, dir);
  const gh = personsGh();
  const { service, logged } = await start({ home: dir, host, time, gh, github, engines: claude(time) });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).connection).toMatchObject(CONNECTED);

  gh.leave("acme", OWNER);
  const { id, key } = host.credentials();
  expect((await post(service, cookie, { type: "connection.useApp", appId: id, key })).status).toBe(200);
  expect((await snapshot(service, cookie)).connection).toMatchObject(DISCONNECTED);
  expect(logged).toContain(
    "sasensi is no longer a member of acme: reviews stop until an admin adds them back",
  );
  host.open(opened(3));
  await time.advance(5 * MIN);
  expect((await snapshot(service, cookie)).connection).toMatchObject(DISCONNECTED);
  expect(host.posts).toEqual([]);
  await service.stop();

  gh.fail("offline");
  const { room } = await onAcme(gh, { dir, time, host, github, idsFrom: 100 });
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
});

test("live.json's organisation App GitHub described only after start: the person no longer a member, nothing is read for them", async () => {
  const time = new DemoClock({ at: T0 });
  const host = organisationHost(time);
  const { connect } = onFakeGitHub(host);
  // GitHub refuses to describe the App at start, then answers: Reconnect describes it.
  let refusing = true;
  const github: GitHubSide = {
    installations: {
      convertManifest: (code) => host.convertManifest(code),
      app: (credentials) =>
        refusing ? Promise.reject(new HostError("unavailable", "GitHub is down")) : host.app(credentials),
      installation: (credentials) => host.installation(credentials),
      repositories: (credentials, id) => host.repositories(credentials, id),
    },
    connect,
    given: host.credentials(),
    person: async () => OWNER,
  };
  const gh = personsGh(null);
  const { room, logged } = await startRoom({ home: home(), host, time, gh, github, engines: claude(time) });
  const started = runs(room);
  host.open(opened(3));
  refusing = false;

  await room.reconnect().catch(() => {});
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
  expect(room.snapshot().repos).toEqual([]);
  expect(logged).toContain(
    "sasensi is no longer a member of acme: reviews stop until an admin adds them back",
  );
  await time.advance(5 * MIN);
  expect(started).toEqual([]);
  expect(room.snapshot().connection).toMatchObject(DISCONNECTED);
});

test("a personal App never asks gh for a membership: not at start, not every hour, not on Check again", async () => {
  const time = new DemoClock({ at: T0 });
  const gh = counting(memoryGh({ as: OWNER }));
  const { room } = await startRoom({ time, gh, repo: SANDBOX });
  await time.advance(3 * HOUR);
  await room.github.checkMembership();
  expect(gh.asked).toEqual([]);
  expect(room.snapshot().connection).toMatchObject({ ...CONNECTED, bot: BOT.login });
});
