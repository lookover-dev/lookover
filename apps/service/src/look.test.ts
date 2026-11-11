// The install look (ADR 0088), through the service's door on the held demo clock and the fake GitHub, counting each
// listing of the person's installations: `connection.look` lists them at once and every 4 s until an account or a
// repository not listed when it began arrives, or 3 minutes pass with nothing new, then discovery goes on at its own
// pace (2 minutes); a second command while it runs lists at once and moves its end, one timer still; a refused listing
// keeps it going, the connection showing the cause, while a rate limit stops it until GitHub's reset (nothing listed
// or polled before it, not even by a listing asked while the one GitHub refused was under way, a wait never ended by
// an answer that was under way when it began); the setup's install wait keeps its pace beside it; a new sign-in drops
// it; "Ask to install" starts it; a restart has none; nobody signed in, it is refused.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type HostAccount,
  type HostChange,
  HostError,
  type InstallLook,
  type Listing,
  type RepositoryRef,
  type Setup,
  type State,
} from "@lookover/contracts";
import { DemoClock, FakeGitHost, type FakeGitHostOptions, memoryGh } from "@lookover/testkit";
import type { RunningService } from "./index.ts";
import {
  eventually,
  home,
  OWNER,
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
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const SEC = 1_000;
const MIN = 60_000;
/** An organisation of the person's where the shared App isn't installed yet, with two repositories. */
const LEDGER: HostAccount = { id: 9101, login: "ledger-labs", type: "Organization" };
const LEDGER_API: RepositoryRef = { owner: LEDGER.login, name: "ledger-api" };
const LEDGER_WEB: RepositoryRef = { owner: LEDGER.login, name: "ledger-web" };
/** Another repository of the person's own, added to their installation later. */
const NOTES: RepositoryRef = { owner: SANDBOX.owner, name: "notes" };

/**
 * A fake GitHub that counts how often the person's installations are listed, and the repositories' polls (asked, and
 * answered). `accountsLimitedUntil`: only the installations' listing refused as rate limited, until then;
 * `holdPolls`: the repositories' polls answer once released.
 */
class Counting extends FakeGitHost {
  reads = 0;
  polls = 0;
  pollsAnswered = 0;
  accountsLimitedUntil: number | null = null;
  private pollsHeld: Promise<void> | null = null;
  /** Only the installations' listing refused as GitHub unreachable (5xx). */
  accountsUnavailable = false;
  override accounts(...args: Parameters<FakeGitHost["accounts"]>) {
    this.reads++;
    if (this.accountsUnavailable) return Promise.reject(new HostError("unavailable", "GitHub answered 502"));
    const retryAt = this.accountsLimitedUntil;
    if (retryAt !== null)
      return Promise.reject(new HostError("rate_limited", "The host asked to wait (429)", { retryAt }));
    return super.accounts(...args);
  }
  /** Only the polls of this owner's repositories refused as rate limited, until then. */
  pollsLimited: { owner: string; until: number } | null = null;
  override async listOpenChanges(repo: RepositoryRef): Promise<Listing<HostChange>> {
    this.polls++;
    if (this.pollsHeld !== null) await this.pollsHeld;
    const limit = this.pollsLimited;
    if (limit !== null && repo.owner === limit.owner)
      throw new HostError("rate_limited", "The host asked to wait (429)", { retryAt: limit.until });
    const listing = await super.listOpenChanges(repo);
    this.pollsAnswered++;
    return listing;
  }
  holdPolls(): () => void {
    let release = () => {};
    this.pollsHeld = new Promise((resolve) => {
      release = resolve;
    });
    return () => {
      this.pollsHeld = null;
      release();
    };
  }
}

/** The owner on the GitHub step, signed in, the shared App's install waited for. */
const WAITING: Setup = {
  done: false,
  step: "github",
  reached: "github",
  github: "waiting-for-install",
  firstReviewChange: null,
};

/**
 * The owner signed in, set up, the shared App on their own account; ledger-labs theirs without it. `refusedAtStart`:
 * GitHub refuses from the start, until the test says otherwise; `accountsLimitedUntil`: only the installations'
 * listing refused as rate limited from the start, until then; `listedBefore`: an earlier start listed them, so the
 * room watches what they granted then; `installedOn`, an account of the person's the shared App is installed on from
 * the first.
 */
async function running(
  o: Partial<FakeGitHostOptions> & {
    setup?: Setup;
    refusedAtStart?: Parameters<FakeGitHost["refuse"]>[0];
    accountsLimitedUntil?: number;
    listedBefore?: boolean;
    installedOn?: string;
  } = {},
) {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const { setup, refusedAtStart, accountsLimitedUntil, listedBefore, installedOn, ...options } = o;
  const host = new Counting({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    unreached: [{ account: LEDGER, repositories: [LEDGER_API, LEDGER_WEB] }],
    ...options,
  });
  if (installedOn !== undefined) host.installOn(installedOn);
  const gh = memoryGh({ as: OWNER });
  gh.join(LEDGER, OWNER, { state: "active", admin: false });
  const github = await signedInOn(host, dir);
  let restart = {};
  if (listedBefore === true) {
    // An earlier start listed the installations: the room watches what they granted then.
    const before = await startRoom({
      home: dir,
      host,
      time,
      gh,
      github,
      ...(setup === undefined ? {} : { setup }),
    });
    await before.room.stop();
    restart = { github: await signedInOn(host, dir), idsFrom: 100 };
  }
  if (refusedAtStart !== undefined) host.refuse(refusedAtStart);
  if (accountsLimitedUntil !== undefined) host.accountsLimitedUntil = accountsLimitedUntil;
  const { service } = await start({
    home: dir,
    host,
    time,
    gh,
    github,
    ...restart,
    ...(setup === undefined ? {} : { setup }),
  });
  const cookie = await openApp(service);
  return { dir, host, time, service, cookie };
}

const look = (service: RunningService, cookie: string) => post(service, cookie, { type: "connection.look" });

/**
 * `connection.look` answered, then its at-once listing answered too (the command doesn't wait for it): the look's
 * `lookedAt` at the clock's time. The state then.
 */
async function looked(service: RunningService, cookie: string, time: DemoClock): Promise<State> {
  expect((await look(service, cookie)).status).toBe(200);
  return eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.lookedAt === time.now(),
  );
}

/** The connection's look, as the app's snapshot shows it now. */
const lookOf = async (service: RunningService, cookie: string): Promise<InstallLook | null> =>
  (await snapshot(service, cookie)).connection.look;

test("a look lists the installations at once and every 4 s for 3 minutes, then none but discovery's", async () => {
  const { host, time, service, cookie } = await running();
  expect(await lookOf(service, cookie)).toBeNull();
  const before = host.reads;

  expect((await looked(service, cookie, time)).connection.look).toEqual({
    since: T0,
    until: T0 + 3 * MIN,
    lookedAt: T0,
    ended: null,
    arrived: null,
    stopped: null,
  });
  expect(host.reads).toBe(before + 1);

  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 2);
  expect((await lookOf(service, cookie))?.lookedAt).toBe(T0 + 4 * SEC);

  // 176 s in: the 45th listing, the last.
  await time.advance(172 * SEC);
  expect(host.reads).toBe(before + 45);
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 45);
  expect(await lookOf(service, cookie)).toEqual({
    since: T0,
    until: T0 + 3 * MIN,
    lookedAt: T0 + 176 * SEC,
    ended: T0 + 3 * MIN,
    arrived: null,
    stopped: null,
  });

  // Then discovery's pace again, from the look's end.
  await time.advance(2 * MIN - SEC);
  expect(host.reads).toBe(before + 45);
  await time.advance(SEC);
  expect(host.reads).toBe(before + 46);
});

test("a second command while a look runs lists at once and moves its end on; one timer still", async () => {
  const { host, time, service, cookie } = await running();
  const before = host.reads;
  await looked(service, cookie, time);
  await time.advance(2 * SEC);
  const again = await looked(service, cookie, time);
  expect(host.reads).toBe(before + 2);
  expect(again.connection.look).toMatchObject({
    since: T0,
    until: T0 + 2 * SEC + 3 * MIN,
    lookedAt: T0 + 2 * SEC,
    ended: null,
  });

  // The first command's next listing no longer comes: the pace is the second's.
  await time.advance(2 * SEC);
  expect(host.reads).toBe(before + 2);
  await time.advance(2 * SEC);
  expect(host.reads).toBe(before + 3);

  // From 2 s to 178 s, every 4 s: 45 listings after the first command's.
  await time.advance(172 * SEC);
  expect(host.reads).toBe(before + 46);
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 46);
  expect(await lookOf(service, cookie)).toMatchObject({ ended: T0 + 2 * SEC + 3 * MIN, arrived: null });
});

/** `connection.returned`, as a return to the tab sends it (ADR 0091): never the person asking. */
const returned = (service: RunningService, cookie: string) =>
  post(service, cookie, { type: "connection.returned" });

test("a return after a look ended lists nothing and starts none, answered as done", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  await time.advance(3 * MIN);
  const ended = await lookOf(service, cookie);
  expect(ended?.ended).toBe(T0 + 3 * MIN);
  const before = host.reads;

  expect((await returned(service, cookie)).status).toBe(200);
  expect(await lookOf(service, cookie)).toEqual(ended);
  // A look asked next lists once: the return queued no listing before it.
  await looked(service, cookie, time);
  expect(host.reads).toBe(before + 1);
});

test("a return during a look lists at once, its end unmoved", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  await time.advance(2 * SEC);
  const before = host.reads;

  expect((await returned(service, cookie)).status).toBe(200);
  const back = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.lookedAt === T0 + 2 * SEC,
  );
  expect(host.reads).toBe(before + 1);
  expect(back.connection.look).toMatchObject({ since: T0, until: T0 + 3 * MIN, ended: null });

  // The look still ends where the command put it.
  await time.advance(3 * MIN - 2 * SEC);
  expect(await lookOf(service, cookie)).toMatchObject({ ended: T0 + 3 * MIN, arrived: null });
});

test("a return during a look beside the setup's install wait lists once, by the wait's check, its end unmoved", async () => {
  const { host, time, service, cookie } = await running({ installed: false, setup: WAITING });
  await time.advance(2 * SEC);
  await looked(service, cookie, time);
  await time.advance(SEC);
  const before = host.reads;

  expect((await returned(service, cookie)).status).toBe(200);
  const back = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.lookedAt === T0 + 3 * SEC,
  );
  expect(host.reads).toBe(before + 1);
  expect(back.connection.look).toMatchObject({
    since: T0 + 2 * SEC,
    until: T0 + 2 * SEC + 3 * MIN,
    ended: null,
  });
});

test("a return during a look while GitHub asks to wait lists nothing and leaves the look as it was", async () => {
  const { host, time, service, cookie } = await running();
  // The look lists at 2 s and every 4 s on (58 s, 62 s); the repositories' poll comes at a minute.
  await time.advance(2 * SEC);
  await looked(service, cookie, time);
  await time.advance(56 * SEC);
  const before = host.reads;

  // The poll meets a 20-second wait, the look's next listing not come yet: the look still runs.
  const resetAt = T0 + MIN + 20 * SEC;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(2 * SEC);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt,
  );
  host.refuse(null);
  const runningLook = await lookOf(service, cookie);
  expect(runningLook).toMatchObject({ ended: null, stopped: null });

  expect((await returned(service, cookie)).status).toBe(200);
  expect(await lookOf(service, cookie)).toEqual(runningLook);
  // Nothing listed before GitHub's reset, the return's listing neither: one at it.
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(before);
  await time.advance(SEC);
  expect(host.reads).toBe(before + 1);
});

test("an account installed during a look ends it with what arrived, its repositories listed", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  await time.advance(8 * SEC);

  // An owner installs the shared App on ledger-labs: the next listing finds it and its two repositories.
  host.installOn(LEDGER.login);
  await time.advance(4 * SEC);
  const s: State = await snapshot(service, cookie);
  expect(s.connection.look).toEqual({
    since: T0,
    until: T0 + 3 * MIN,
    lookedAt: T0 + 12 * SEC,
    ended: T0 + 12 * SEC,
    arrived: { accounts: ["ledger-labs"], back: [], repositories: 2 },
    stopped: null,
  });
  expect(s.connection.accounts.map((a) => a.account.login)).toEqual(["sasensi", "ledger-labs"]);
  expect(s.repos.map((r) => r.id)).toEqual(
    expect.arrayContaining(["ledger-labs/ledger-api", "ledger-labs/ledger-web"]),
  );

  // Ended: no listing 4 s on.
  const reads = host.reads;
  await time.advance(4 * SEC);
  expect(host.reads).toBe(reads);
});

test("an account installed during a look whose first poll meets GitHub's wait still arrives; nothing read before the reset", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  await time.advance(8 * SEC);

  // ledger-labs installed: the listing finds it, and its repositories' first poll meets a 10-minute wait.
  const resetAt = T0 + 10 * MIN;
  host.pollsLimited = { owner: LEDGER.login, until: resetAt };
  host.installOn(LEDGER.login);
  await time.advance(4 * SEC);
  const s = await eventually(
    () => snapshot(service, cookie),
    (state) => state.connection.limitUntil === resetAt,
  );
  expect(s.connection.look).toMatchObject({
    ended: T0 + 12 * SEC,
    arrived: { accounts: ["ledger-labs"], back: [], repositories: 2 },
  });

  // The wait holds every read back.
  const reads = host.reads;
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(reads);
});

test("an account the install wait's check finds whose first poll meets GitHub's wait still arrives; nothing read before the reset", async () => {
  const { host, time, service, cookie } = await running({ installed: false, setup: WAITING });
  await time.advance(2 * SEC);
  await looked(service, cookie, time);

  const resetAt = T0 + 10 * MIN;
  host.pollsLimited = { owner: LEDGER.login, until: resetAt };
  host.installOn(LEDGER.login);
  await time.advance(4 * SEC);
  const s = await eventually(
    () => snapshot(service, cookie),
    (state) => state.connection.limitUntil === resetAt,
  );
  expect(s.connection.look).toMatchObject({
    ended: T0 + 6 * SEC,
    arrived: { accounts: ["ledger-labs"], back: [], repositories: 2 },
  });

  // The next check is held back: the look keeps what arrived, and nothing is read before the reset.
  const reads = host.reads;
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(reads);
  expect(await lookOf(service, cookie)).toMatchObject({ arrived: { accounts: ["ledger-labs"] } });
});

test("a repository added to an installation during a look ends it, no account arriving", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  host.addRepository(NOTES);
  await time.advance(4 * SEC);
  expect(await lookOf(service, cookie)).toMatchObject({
    ended: T0 + 4 * SEC,
    arrived: { accounts: [], back: [], repositories: 1 },
  });
});

test("an account suspended as the look began and unsuspended during it ends it, back with its repositories", async () => {
  const { host, time, service, cookie } = await running();
  // The owner suspends the person's own installation; the next discovery sees it.
  host.suspend();
  await time.advance(2 * MIN);
  expect((await snapshot(service, cookie)).connection.accounts[0]?.cause).toMatchObject({ suspended: true });

  await looked(service, cookie, time);
  host.unsuspend();
  await time.advance(4 * SEC);
  expect(await lookOf(service, cookie)).toMatchObject({
    ended: T0 + 2 * MIN + 4 * SEC,
    arrived: { accounts: [], back: ["sasensi"], repositories: 1 },
    stopped: null,
  });
});

test("an account uninstalled during a look and installed again ends it, back with its repositories", async () => {
  const { host, time, service, cookie } = await running();
  host.installOn(LEDGER.login);
  await time.advance(2 * MIN);
  await looked(service, cookie, time);

  // Uninstalled: the next listing no longer reaches it, nothing new; then installed again.
  host.uninstall(LEDGER.login);
  await time.advance(4 * SEC);
  expect(await lookOf(service, cookie)).toMatchObject({ ended: null, arrived: null });
  host.installOn(LEDGER.login);
  await time.advance(4 * SEC);
  expect(await lookOf(service, cookie)).toMatchObject({
    ended: T0 + 2 * MIN + 8 * SEC,
    arrived: { accounts: [], back: ["ledger-labs"], repositories: 2 },
  });
});

test("a look ended with nothing new takes what discovery finds later as what arrived, once, ended when it was", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  await time.advance(3 * MIN);
  expect(await lookOf(service, cookie)).toMatchObject({ ended: T0 + 3 * MIN, arrived: null });

  // An owner approves later: the next discovery, 2 minutes on, finds ledger-labs, and the line can say so.
  host.installOn(LEDGER.login);
  await time.advance(2 * MIN);
  const arrived = {
    since: T0,
    until: T0 + 3 * MIN,
    lookedAt: T0 + 176 * SEC,
    ended: T0 + 3 * MIN,
    arrived: { accounts: ["ledger-labs"], back: [], repositories: 2 },
    stopped: null,
  };
  expect(await lookOf(service, cookie)).toEqual(arrived);

  // What arrived is said once: a later repository changes nothing of it.
  host.addRepository(NOTES);
  await time.advance(2 * MIN);
  expect(await lookOf(service, cookie)).toEqual(arrived);
});

test("a find more than 15 minutes after a look ended with nothing new, nobody asked, is not said as arrived", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  await time.advance(3 * MIN);
  expect(await lookOf(service, cookie)).toMatchObject({ ended: T0 + 3 * MIN, arrived: null });

  // Discovery lists every 2 minutes, finding nothing; well past 15 minutes, a repository of the person's own arrives.
  await time.advance(16 * MIN);
  host.addRepository(NOTES);
  await time.advance(2 * MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.repos.some((r) => r.id === "sasensi/notes"),
  );
  expect(await lookOf(service, cookie)).toMatchObject({ ended: T0 + 3 * MIN, arrived: null });
});

test("an organisation asked to install, approved an hour after its look ended, is said as arrived", async () => {
  const { host, time, service, cookie } = await running();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.unreached.some((u) => u.account.login === LEDGER.login),
  );
  expect(
    (await post(service, cookie, { type: "connection.askToInstall", account: LEDGER.login })).status,
  ).toBe(200);
  await time.advance(3 * MIN);
  expect(await lookOf(service, cookie)).toMatchObject({ since: T0, ended: T0 + 3 * MIN, arrived: null });

  // The owner approves an hour later: the next discovery finds ledger-labs, the one the person asked.
  await time.advance(60 * MIN);
  host.installOn(LEDGER.login);
  await time.advance(2 * MIN);
  expect(await lookOf(service, cookie)).toMatchObject({
    ended: T0 + 3 * MIN,
    arrived: { accounts: ["ledger-labs"], back: [], repositories: 2 },
  });
});

test("a find dropped as too late is not counted again when an organisation asked is approved later", async () => {
  const { host, time, service, cookie } = await running();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.unreached.some((u) => u.account.login === LEDGER.login),
  );
  expect(
    (await post(service, cookie, { type: "connection.askToInstall", account: LEDGER.login })).status,
  ).toBe(200);
  await time.advance(3 * MIN);
  expect(await lookOf(service, cookie)).toMatchObject({ ended: T0 + 3 * MIN, arrived: null });

  // 20 minutes on, a repository of the person's own arrives: too late to be the look's news, dropped.
  await time.advance(20 * MIN);
  host.addRepository(NOTES);
  await time.advance(2 * MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.repos.some((r) => r.id === "sasensi/notes"),
  );
  expect(await lookOf(service, cookie)).toMatchObject({ arrived: null });

  // The owner approves ledger-labs an hour on: its two repositories arrive, not the one dropped.
  await time.advance(60 * MIN);
  host.installOn(LEDGER.login);
  await time.advance(2 * MIN);
  expect(await lookOf(service, cookie)).toMatchObject({
    ended: T0 + 3 * MIN,
    arrived: { accounts: ["ledger-labs"], back: [], repositories: 2 },
  });
});

test("a look stopped by GitHub's wait keeps its stop: what discovery finds after it is not said as arrived", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  host.refuse("rate_limited", { retryAt: T0 + MIN });
  await time.advance(4 * SEC);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.stopped === "rate-limited",
  );
  host.refuse(null);
  host.installOn(LEDGER.login);
  await time.advance(4 * MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.accounts.some((a) => a.account.login === "ledger-labs"),
  );
  expect(await lookOf(service, cookie)).toMatchObject({ stopped: "rate-limited", arrived: null });
});

test("a listing refused during a look keeps it going, the connection showing the cause", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  const before = host.reads;

  // GitHub unreachable for a minute: the look lists every 4 s all the same, and the connection says it as the
  // repositories' polls meet it (ADR 0070).
  host.refuse("unavailable");
  await time.advance(MIN);
  expect(host.reads).toBe(before + 15);
  const refused = await snapshot(service, cookie);
  expect(refused.connection).toMatchObject({ state: "disconnected", cause: { kind: "unreachable" } });
  expect(refused.connection.look).toMatchObject({ lookedAt: T0, ended: null });

  // GitHub answers again: the look goes on, and says when it looked.
  host.refuse(null);
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 16);
  expect(await lookOf(service, cookie)).toMatchObject({ lookedAt: T0 + 64 * SEC, ended: null });
});

test("a listing refused for a cause the connection shows at once keeps the look going", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  const before = host.reads;

  host.refuse("unauthorized");
  await time.advance(4 * SEC);
  const refused = await snapshot(service, cookie);
  expect(refused.connection).toMatchObject({ state: "disconnected", cause: { kind: "signed-out" } });
  expect(refused.connection.look).toMatchObject({ lookedAt: T0, ended: null });
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 2);
});

test("a listing rate limited during a look ends it, stopped; nothing listed before GitHub's reset, one after", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  const before = host.reads;

  // GitHub asks to wait 10 minutes: the look's next listing meets it.
  const resetAt = T0 + 10 * MIN;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 1);
  const limited = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.ended != null,
  );
  expect(limited.connection).toMatchObject({ state: "connected", limitUntil: resetAt });
  expect(limited.connection.look).toEqual({
    since: T0,
    until: T0 + 3 * MIN,
    lookedAt: T0,
    ended: T0 + 4 * SEC,
    arrived: null,
    stopped: "rate-limited",
  });

  // GitHub would answer, but asked to wait: nothing is listed before its reset, by discovery or a look, and no
  // repository is polled.
  const polls = host.polls;
  host.refuse(null);
  await time.advance(3 * MIN);
  const asked = await look(service, cookie);
  expect(asked.status).toBe(200);
  expect(await lookOf(service, cookie)).toMatchObject({
    since: T0 + 4 * SEC + 3 * MIN,
    ended: T0 + 4 * SEC + 3 * MIN,
    stopped: "rate-limited",
  });
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(before + 1);
  expect(host.polls).toBe(polls);

  // At the reset, one listing and one poll, then discovery's pace.
  await time.advance(SEC);
  expect(host.reads).toBe(before + 2);
  await waitFor(() => host.polls === polls + 1);
  const wait = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === null,
  );
  expect(wait.connection.limitUntil).toBeNull();
  await time.advance(2 * MIN - SEC);
  expect(host.reads).toBe(before + 2);
  await time.advance(SEC);
  expect(host.reads).toBe(before + 3);
});

test("a short wait: the next listing at its end, not a minute on, and a Reconnect meanwhile doesn't push it later", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  const before = host.reads;
  const resetAt = T0 + 34 * SEC;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 1);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.stopped === "rate-limited",
  );
  host.refuse(null);

  // "Reconnect" during the wait lists nothing, and keeps the listing at the wait's end.
  await time.advance(10 * SEC);
  await post(service, cookie, { type: "connection.reconnect" });
  expect(host.reads).toBe(before + 1);
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(before + 1);
  await time.advance(SEC);
  expect(host.reads).toBe(before + 2);
});

test("Reconnect during a listing's 10-minute wait polls no repository before the reset, and polls at it", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  const resetAt = T0 + 10 * MIN;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(4 * SEC);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt,
  );
  host.refuse(null);
  const polls = host.polls;

  // "Reconnect" during the wait answers, and asks GitHub for no repository's changes.
  await time.advance(10 * SEC);
  expect((await post(service, cookie, { type: "connection.reconnect" })).status).toBe(200);
  await time.advance(0);
  expect(host.polls).toBe(polls);
  await time.advance(resetAt - time.now() - SEC);
  expect(host.polls).toBe(polls);

  // At the reset, the repository is polled.
  await time.advance(SEC);
  await waitFor(() => host.polls === polls + 1);
});

test("Reconnect during a poll's 10-minute wait polls no repository before the reset, and polls at it", async () => {
  const { host, time, service, cookie } = await running();

  // The repositories' next poll, a minute on, meets a 10-minute wait.
  const resetAt = T0 + 11 * MIN;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt,
  );
  host.refuse(null);
  const polls = host.polls;
  const reads = host.reads;

  // "Reconnect" during the wait answers, and asks GitHub nothing.
  await time.advance(10 * SEC);
  expect((await post(service, cookie, { type: "connection.reconnect" })).status).toBe(200);
  await time.advance(0);
  expect(host.polls).toBe(polls);
  await time.advance(resetAt - time.now() - SEC);
  expect(host.polls).toBe(polls);
  expect(host.reads).toBe(reads);

  // At the reset, the repository is polled.
  await time.advance(SEC);
  await waitFor(() => host.polls === polls + 1);
});

test("Check again while a repository's poll keeps GitHub's wait: stopped, the next listing right at the reset", async () => {
  const { host, time, service, cookie } = await running();
  const before = host.reads;

  // The repositories' next poll, a minute on, meets a 20-second wait; discovery is armed for 2 minutes in.
  const resetAt = T0 + MIN + 20 * SEC;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt,
  );
  host.refuse(null);

  // Check again during the wait: the look stops at once, nothing listed before the reset, one listing at it.
  await time.advance(10 * SEC);
  expect((await look(service, cookie)).status).toBe(200);
  expect(await lookOf(service, cookie)).toMatchObject({ ended: time.now(), stopped: "rate-limited" });
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(before);
  await time.advance(SEC);
  expect(host.reads).toBe(before + 1);

  // Then discovery's pace from there, not the timer armed before the wait.
  await time.advance(2 * MIN - SEC);
  expect(host.reads).toBe(before + 1);
  await time.advance(SEC);
  expect(host.reads).toBe(before + 2);
});

test("Check again during a look's wait, the poll's: the look's own timer doesn't push the listing past the reset", async () => {
  const { host, time, service, cookie } = await running();
  // The look lists at 2 s and every 4 s on (58 s, 62 s); the repositories' poll comes at a minute.
  await time.advance(2 * SEC);
  await looked(service, cookie, time);
  await time.advance(56 * SEC);
  const before = host.reads;

  // The poll meets a 20-second wait; Check again a second on, before the look's next listing, stops the look.
  const resetAt = T0 + MIN + 20 * SEC;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(2 * SEC);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt,
  );
  host.refuse(null);
  await time.advance(SEC);
  expect((await look(service, cookie)).status).toBe(200);
  expect(await lookOf(service, cookie)).toMatchObject({ ended: time.now(), stopped: "rate-limited" });

  // The look's timer, due a second on, lists nothing and moves nothing past the reset: one listing at it.
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(before);
  await time.advance(SEC);
  expect(host.reads).toBe(before + 1);
});

test("the install wait's check rate limited: the look stopped, the next check at GitHub's reset, 4 s at the least", async () => {
  const { host, time, service, cookie } = await running({ installed: false, setup: WAITING });
  await time.advance(2 * SEC);
  await looked(service, cookie, time);
  const before = host.reads;

  // The wait's next check meets GitHub's wait, 30 s.
  const resetAt = T0 + 36 * SEC;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 1);
  const limited = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.ended != null,
  );
  expect(limited.connection.limitUntil).toBe(resetAt);
  expect(limited.connection.look).toMatchObject({ ended: T0 + 6 * SEC, stopped: "rate-limited" });
  expect(limited.setup.github).toBe("waiting-for-install");

  // Held back to the reset, then checked again.
  host.refuse(null);
  await time.advance(30 * SEC - SEC);
  expect(host.reads).toBe(before + 1);
  await time.advance(SEC);
  expect(host.reads).toBe(before + 2);

  // A wait of a second: the next check 4 s on all the same.
  host.refuse("rate_limited", { retryAt: time.now() + 5 * SEC });
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 3);
  host.refuse(null);
  await time.advance(3 * SEC);
  expect(host.reads).toBe(before + 3);
  await time.advance(SEC);
  expect(host.reads).toBe(before + 4);
});

test("a listing under way when a repository's poll meets GitHub's wait answers after it: the wait holds", async () => {
  const { host, time, service, cookie } = await running();
  const release = host.holdAccounts();
  expect((await look(service, cookie)).status).toBe(200);

  // The repositories' next poll, a minute on, meets a 10-minute wait.
  const resetAt = T0 + 11 * MIN;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt,
  );

  host.refuse(null);
  release();
  const answered = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.lookedAt != null,
  );
  expect(answered.connection.limitUntil).toBe(resetAt);
});

test("a repository's poll under way when a listing meets GitHub's wait answers after it: the wait holds", async () => {
  const { host, time, service, cookie } = await running();
  const release = host.holdPolls();
  const polls = host.polls;
  await time.advance(MIN);
  await waitFor(() => host.polls > polls);

  const resetAt = T0 + 11 * MIN;
  host.refuse("rate_limited", { retryAt: resetAt });
  expect((await look(service, cookie)).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.stopped === "rate-limited",
  );

  host.refuse(null);
  const answered = host.pollsAnswered;
  release();
  await waitFor(() => host.pollsAnswered > answered);
  expect((await snapshot(service, cookie)).connection.limitUntil).toBe(resetAt);
});

test("a poll under way when a listing meets a 10-minute wait, refused itself for a minute: the 10 minutes hold", async () => {
  const { host, time, service, cookie } = await running();
  const release = host.holdPolls();
  const polls = host.polls;
  await time.advance(MIN);
  await waitFor(() => host.polls > polls);

  const resetAt = time.now() + 10 * MIN;
  host.accountsLimitedUntil = resetAt;
  expect((await look(service, cookie)).status).toBe(200);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt && s.connection.look?.stopped === "rate-limited",
  );

  // The held poll answers: GitHub asks it to wait a minute only.
  host.refuse("rate_limited", { retryAt: time.now() + MIN });
  release();
  await time.advance(0);
  expect((await snapshot(service, cookie)).connection.limitUntil).toBe(resetAt);

  host.refuse(null);
  host.accountsLimitedUntil = null;
  const asked = { polls: host.polls, reads: host.reads };
  await time.advance(resetAt - time.now() - SEC);
  expect({ polls: host.polls, reads: host.reads }).toEqual(asked);
  await time.advance(SEC);
  await waitFor(() => host.polls > asked.polls);
});

test("a listing under way when a poll meets a 10-minute wait, refused itself for a minute: the 10 minutes hold", async () => {
  const { host, time, service, cookie } = await running();
  const before = host.reads;
  const release = host.holdAccounts();
  expect((await look(service, cookie)).status).toBe(200);
  await waitFor(() => host.reads > before);

  const resetAt = time.now() + MIN + 10 * MIN;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt,
  );

  // The held listing answers: GitHub asks it to wait a minute only.
  host.refuse(null);
  host.accountsLimitedUntil = time.now() + MIN;
  release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.stopped === "rate-limited",
  );
  await time.advance(0);
  expect((await snapshot(service, cookie)).connection.limitUntil).toBe(resetAt);

  host.accountsLimitedUntil = null;
  const asked = { polls: host.polls, reads: host.reads };
  await time.advance(resetAt - time.now() - SEC);
  expect({ polls: host.polls, reads: host.reads }).toEqual(asked);
  await time.advance(SEC);
  await waitFor(() => host.polls > asked.polls);
});

test("the start's listing rate limited: the connection says until when, nothing listed before the reset, one after", async () => {
  const resetAt = T0 + 10 * MIN;
  const { host, time, service, cookie } = await running({ accountsLimitedUntil: resetAt });
  expect((await snapshot(service, cookie)).connection.limitUntil).toBe(resetAt);
  const reads = host.reads;
  host.accountsLimitedUntil = null;
  await time.advance(resetAt - T0 - SEC);
  expect(host.reads).toBe(reads);
  await time.advance(SEC);
  expect(host.reads).toBe(reads + 1);
});

/**
 * The start's listing rate limited with no repository watched, its retry at the reset refused again (`again`): how
 * many timers the room armed from a second before the reset to 30 s past it (the poll's 10 s wake, the next
 * listing's), and the reads then and a minute after the reset.
 */
async function retriedPastTheReset(again: (host: Counting) => void) {
  const resetAt = T0 + 10 * MIN;
  const { host, time, service, cookie } = await running({ accountsLimitedUntil: resetAt });
  expect((await snapshot(service, cookie)).repos).toEqual([]);
  const reads = host.reads;
  again(host);
  await time.advance(resetAt - T0 - SEC);
  let wakes = 0;
  const after = time.after;
  time.after = (ms, fire) => {
    wakes++;
    return after(ms, fire);
  };
  await time.advance(31 * SEC);
  expect(time.now()).toBe(resetAt + 30 * SEC);
  expect(wakes).toBeLessThanOrEqual(6);
  expect(host.reads).toBe(reads + 1);
  await time.advance(30 * SEC);
  expect(host.reads).toBe(reads + 2);
}

test("the start's listing rate limited, nothing watched, its retry refused with a reset already past: no busy wake", async () => {
  await retriedPastTheReset(() => {});
});

test("the start's listing rate limited, nothing watched, its retry refused as unreachable: no busy wake", async () => {
  await retriedPastTheReset((host) => {
    host.accountsUnavailable = true;
  });
});

/**
 * Two more looks asked while the first one's listing is under way (GitHub slow to list), that listing then refused
 * as rate limited until `resetAt`: how many times the installations were read once the queue has drained.
 */
async function queuedBehindALimit(o: Parameters<typeof running>[0] = {}) {
  const { host, time, service, cookie } = await running(o);
  if (o.setup !== undefined) await time.advance(2 * SEC);
  const before = host.reads;
  const release = host.holdAccounts();
  expect((await look(service, cookie)).status).toBe(200);
  await waitFor(() => host.reads > before);
  expect((await look(service, cookie)).status).toBe(200);
  expect((await look(service, cookie)).status).toBe(200);

  // The held listing answers: GitHub asks to wait 10 minutes (its read counted again as it answers).
  const resetAt = time.now() + 10 * MIN;
  host.accountsLimitedUntil = resetAt;
  const read = host.reads + 1;
  release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt && s.connection.look?.stopped === "rate-limited",
  );
  // The two queued listings have their turn: the clock settles the work under way and fires nothing not due.
  await time.advance(0);
  expect(host.reads).toBe(read);
  host.accountsLimitedUntil = null;
  return { host, time, resetAt, read };
}

test("two looks queued behind a listing GitHub then rate limits read nothing more before the reset", async () => {
  const { host, time, resetAt, read } = await queuedBehindALimit();
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(read);
  await time.advance(SEC);
  expect(host.reads).toBe(read + 1);
});

test("the install wait's checks queued behind one GitHub then rate limits read nothing more before the reset", async () => {
  const { host, time, resetAt, read } = await queuedBehindALimit({ installed: false, setup: WAITING });
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(read);
  await time.advance(SEC);
  expect(host.reads).toBe(read + 1);
});

test("the setup's install wait keeps its 4 s pace with a look beside it, past the look's end; discovery after both", async () => {
  const { host, time, service, cookie } = await running({ installed: false, setup: WAITING });
  await time.advance(2 * SEC);
  const before = host.reads;
  expect((await looked(service, cookie, time)).connection.look).toMatchObject({
    since: T0 + 2 * SEC,
    lookedAt: T0 + 2 * SEC,
  });
  expect(host.reads).toBe(before + 1);

  // Every 4 s from then on, the wait's checks the look's listings too.
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 2);
  expect((await lookOf(service, cookie))?.lookedAt).toBe(T0 + 6 * SEC);

  // Past the look's end, nothing installed: the look ended with nothing new, the wait still reads every 4 s.
  await time.advance(3 * MIN);
  expect(host.reads).toBe(before + 47);
  expect(await lookOf(service, cookie)).toMatchObject({ ended: T0 + 182 * SEC, arrived: null });
  await time.advance(4 * SEC);
  expect(host.reads).toBe(before + 48);

  // Installed with a repository: the wait ends, and the installations are next listed by discovery.
  host.install();
  await time.advance(4 * SEC);
  expect((await snapshot(service, cookie)).setup.github).toBe("done");
  const reads = host.reads;
  await time.advance(2 * MIN - SEC);
  expect(host.reads).toBe(reads);
  await time.advance(SEC);
  expect(host.reads).toBe(reads + 1);
});

test("a new sign-in drops the look, and its listings stop", async () => {
  const { host, time, service, cookie } = await running();
  await looked(service, cookie, time);
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  const shown = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn !== null,
  );
  host.enterCode(shown.connection.signIn?.userCode ?? "");
  await time.advance(5 * SEC);
  const signedIn = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null && s.connection.listed,
  );
  expect(signedIn.connection.look).toBeNull();

  const reads = host.reads;
  await time.advance(MIN);
  expect(host.reads).toBe(reads);
});

test("the same person signing in again during GitHub's wait keeps it: nothing listed or polled before the reset", async () => {
  const { host, time, service, cookie } = await running();
  const resetAt = T0 + 31 * MIN;
  host.refuse("rate_limited", { retryAt: resetAt });
  await time.advance(MIN);
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.limitUntil === resetAt,
  );
  host.refuse(null);
  const { reads, polls } = host;

  // The owner signs in again: the wait is their sign-in's still.
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  const shown = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn !== null,
  );
  host.enterCode(shown.connection.signIn?.userCode ?? "");
  await time.advance(5 * SEC);
  const again = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );
  expect(again.connection.limitUntil).toBe(resetAt);
  await time.advance(resetAt - time.now() - SEC);
  expect(host.reads).toBe(reads);
  expect(host.polls).toBe(polls);

  // At the reset, listed and polled again.
  await time.advance(SEC);
  expect(host.reads).toBe(reads + 1);
  await waitFor(() => host.polls === polls + 1);
});

test("asking an owner to install starts a look", async () => {
  const { host, service, cookie } = await running();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.unreached.some((u) => u.account.login === LEDGER.login),
  );
  const before = host.reads;
  const asked = await post(service, cookie, { type: "connection.askToInstall", account: LEDGER.login });
  expect(asked.status).toBe(200);
  const lookedNow = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.lookedAt === T0,
  );
  expect(lookedNow.connection.look).toMatchObject({ since: T0, ended: null });
  expect(host.reads).toBe(before + 1);
});

test("a look doesn't outlive the service: restarted while one runs, there is none", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const dir = home();
  const first = await startRoom({ home: dir, host, time, github: await signedInOn(host, dir) });
  expect(await first.room.github.look()).toBe("ok");
  expect(first.room.snapshot().connection.look).toMatchObject({ since: T0, ended: null });
  await first.room.stop();

  const { room } = await startRoom({
    home: dir,
    host,
    time,
    idsFrom: 100,
    github: await signedInOn(host, dir),
  });
  expect(room.snapshot().connection.look).toBeNull();
  const reads = host.reads;
  await time.advance(MIN);
  expect(host.reads).toBe(reads);
});

test("with nobody signed in, a look is refused as an ask is", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const dir = home();
  const { service } = await start({ home: dir, host, time, github: signedOutOn(host, dir) });
  const cookie = await openApp(service);
  const res = await look(service, cookie);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ look: "signed-out" });
  expect(host.reads).toBe(0);
  expect(await lookOf(service, cookie)).toBeNull();
});

test("with nobody signed in, a return is answered as done, nothing listed", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const dir = home();
  const { service } = await start({ home: dir, host, time, github: signedOutOn(host, dir) });
  const cookie = await openApp(service);
  expect((await returned(service, cookie)).status).toBe(200);
  expect(host.reads).toBe(0);
  expect(await lookOf(service, cookie)).toBeNull();
});

test("nothing listed yet under the sign-in: the look measures from its first answered listing", async () => {
  // GitHub refused the start's listing: nothing is listed under this sign-in yet.
  const { host, time, service, cookie } = await running({ refusedAtStart: "unavailable" });
  expect((await snapshot(service, cookie)).connection.listed).toBe(false);
  const before = host.reads;
  await look(service, cookie);
  // Its at-once listing refused too, before GitHub answers again.
  await waitFor(() => host.reads > before);

  // GitHub answers with the accounts the person already had: nothing arrived, the look goes on.
  host.refuse(null);
  await time.advance(4 * SEC);
  const answered = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.lookedAt === T0 + 4 * SEC,
  );
  expect(answered.connection.listed).toBe(true);
  expect(answered.connection.look).toMatchObject({ ended: null, arrived: null });

  // Then an owner installs on ledger-labs: only that arrived.
  host.installOn(LEDGER.login);
  await time.advance(4 * SEC);
  expect(
    await eventually(
      () => snapshot(service, cookie),
      (s) => s.connection.look?.ended != null,
    ),
  ).toMatchObject({
    connection: {
      look: { ended: T0 + 8 * SEC, arrived: { accounts: ["ledger-labs"], back: [], repositories: 2 } },
    },
  });
});

test("nothing listed yet under the sign-in: an install before the first answered listing still arrives", async () => {
  // An earlier start watched the sandbox; this one's listing refused.
  const { host, time, service, cookie } = await running({
    listedBefore: true,
    refusedAtStart: "unavailable",
  });
  const before = host.reads;
  await look(service, cookie);
  await waitFor(() => host.reads > before);

  // An owner installs on ledger-labs while GitHub still refuses; then GitHub answers.
  host.installOn(LEDGER.login);
  host.refuse(null);
  await time.advance(4 * SEC);
  expect(
    await eventually(
      () => snapshot(service, cookie),
      (s) => s.connection.look?.ended != null,
    ),
  ).toMatchObject({
    connection: {
      look: { ended: T0 + 4 * SEC, arrived: { accounts: ["ledger-labs"], back: [], repositories: 2 } },
    },
  });
});

test("nothing listed yet under the sign-in: an account with no repository watched or granted is not said as arrived", async () => {
  // ledger-labs had the shared App with no repository chosen when an earlier start listed it; this one's refused.
  const { host, time, service, cookie } = await running({
    listedBefore: true,
    refusedAtStart: "unavailable",
    unreached: [{ account: LEDGER, repositories: [] }],
    installedOn: LEDGER.login,
  });
  const before = host.reads;
  await look(service, cookie);
  await waitFor(() => host.reads > before);

  // GitHub answers: Lookover can't tell an install of a moment ago from an old one with nothing granted.
  host.refuse(null);
  await time.advance(4 * SEC);
  const answered = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.lookedAt === T0 + 4 * SEC,
  );
  expect(answered.connection.accounts.map((a) => a.account.login)).toEqual(["sasensi", "ledger-labs"]);
  expect(answered.connection.look).toMatchObject({ ended: null, arrived: null });
});

test("a look answers while GitHub is slow to list, the listing read all the same", async () => {
  const { host, service, cookie } = await running();
  const before = host.reads;
  const release = host.holdAccounts();
  expect((await look(service, cookie)).status).toBe(200);
  expect(await lookOf(service, cookie)).toMatchObject({ since: T0, lookedAt: null, ended: null });
  await waitFor(() => host.reads > before);

  release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.lookedAt === T0,
  );
});

test("an ask kept answers while GitHub is slow to list, its look's listing read all the same", async () => {
  const { host, service, cookie } = await running();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.unreached.some((u) => u.account.login === LEDGER.login),
  );
  const before = host.reads;
  const release = host.holdAccounts();
  const asked = await post(service, cookie, { type: "connection.askToInstall", account: LEDGER.login });
  expect(asked.status).toBe(200);
  await waitFor(() => host.reads > before);

  release();
  await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.look?.lookedAt === T0,
  );
});

test("a look says nothing more once the service stops", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new Counting({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time });
  const dir = home();
  const { room, logged } = await startRoom({ home: dir, host, time, github: await signedInOn(host, dir) });
  const release = host.holdAccounts();
  void room.github.look();
  // Past the look's end while its listing waits on GitHub; then the service stops, and GitHub answers.
  await time.advance(4 * MIN);
  const shown = room.snapshot().connection.look;
  expect(shown).toMatchObject({ since: T0, ended: null });
  await room.stop();
  const said = logged.length;
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Nothing sent into the closed store, nothing to log.
  expect(logged.slice(said)).toEqual([]);
  expect(room.snapshot().connection.look).toEqual(shown);
});

/** Waits, in real time and a few seconds at most, until `holds` does. */
async function waitFor(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !holds(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(holds()).toBe(true);
}
