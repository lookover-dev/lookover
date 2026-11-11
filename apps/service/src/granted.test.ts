// What each account the shared App reaches grants (ADR 0091), on the held demo clock and the fake GitHub: the
// repositories its listing grants, cut to the allow-list, sent with the accounts on every answered listing before
// those repositories' first `repo.added` (ADR 0086's order), so the app can tell an account being read from one
// granting nothing: "nothing granted" then granted, a look's arrival and discovery's find after the setup, a
// repository added to an account granting some, an account with a cause granting none, and the connection at start.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type ConnectionAccount,
  type Event,
  type HostAccount,
  type RepositoryRef,
  repositoryId,
  type Setup,
} from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import {
  home,
  OWNER,
  pr1,
  SANDBOX,
  SHARED_BOT,
  signedInOn,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
/** An organisation of the person's where the shared App isn't installed yet, with two repositories. */
const LEDGER: HostAccount = { id: 9101, login: "ledger-labs", type: "Organization" };
const LEDGER_API: RepositoryRef = { owner: LEDGER.login, name: "ledger-api" };
const LEDGER_WEB: RepositoryRef = { owner: LEDGER.login, name: "ledger-web" };
const SANDBOX_ID = repositoryId("sasensi/lookover-sandbox");
const LEDGER_API_ID = repositoryId("ledger-labs/ledger-api");
const LEDGER_WEB_ID = repositoryId("ledger-labs/ledger-web");

/** The owner on the GitHub step, signed in, the shared App's install waited for. */
const WAITING: Setup = {
  done: false,
  step: "github",
  reached: "github",
  github: "waiting-for-install",
  firstReviewChange: null,
};

/** A fake GitHub, the person signed in; ledger-labs theirs without the shared App. */
const hostOn = (time: DemoClock, installed = true) =>
  new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    installed,
    unreached: [{ account: LEDGER, repositories: [LEDGER_API, LEDGER_WEB] }],
  });

/** The events the room sends from now on. */
function heard(events: { subscribe(listener: (event: Event) => void): () => void }) {
  const sent: Event[] = [];
  const stop = events.subscribe((e) => {
    sent.push(e);
  });
  return { sent, stop };
}

/** The account `login` as the `connection.changed` event `e` sends it; undefined when it sends no such account. */
const sentAccount = (e: Event, login: string): ConnectionAccount | undefined =>
  e.type === "connection.changed" ? e.patch.accounts?.find((a) => a.account.login === login) : undefined;

/**
 * Where in `sent` the account `login` is first sent granting `granted`, and where the first of them is first added:
 * the first must come before the second (ADR 0086).
 */
function order(sent: readonly Event[], login: string, granted: readonly string[]) {
  const grantedAt = sent.findIndex((e) => {
    const account = sentAccount(e, login);
    return account !== undefined && account.granted.map(String).join() === granted.join();
  });
  const addedAt = sent.findIndex((e) => e.type === "repo.added" && e.repo.id === granted[0]);
  return { grantedAt, addedAt };
}

test("nothing granted, then a repository granted: the account says so with its accounts, before the repository's `repo.added`", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time, false);
  const { room } = await startRoom({ host, time, setup: WAITING });
  host.install([]);
  await time.advance(4_000);
  expect(room.snapshot().setup.github).toBe("nothing-granted");
  expect(room.snapshot().connection.accounts.map((a) => a.granted)).toEqual([[]]);

  const events = heard(room.events);
  host.addRepository(SANDBOX);
  await time.advance(4_000);
  events.stop();
  const { grantedAt, addedAt } = order(events.sent, OWNER.login, [SANDBOX_ID]);
  expect(grantedAt).toBeGreaterThanOrEqual(0);
  expect(addedAt).toBeGreaterThan(grantedAt);
  expect(room.snapshot().setup.github).toBe("done");
});

test("a look's arrival after the setup: the new account says what it grants, cut to the allow-list, before its first read", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  const { room } = await startRoom({ host, time, repos: [SANDBOX, LEDGER_API] });
  expect(await room.github.look()).toBe("ok");
  const events = heard(room.events);
  host.installOn(LEDGER.login);
  await time.advance(4_000);
  events.stop();

  // ledger-web is off the allow-list: never granted, as it is never watched.
  const { grantedAt, addedAt } = order(events.sent, LEDGER.login, [LEDGER_API_ID]);
  expect(grantedAt).toBeGreaterThanOrEqual(0);
  expect(addedAt).toBeGreaterThan(grantedAt);
  expect(room.snapshot().connection.look?.arrived).toMatchObject({ accounts: [LEDGER.login] });
  expect(room.snapshot().connection.accounts.map((a) => [a.account.login, a.granted])).toEqual([
    [OWNER.login, [SANDBOX_ID]],
    [LEDGER.login, [LEDGER_API_ID]],
  ]);
});

test("discovery's find after the setup (an owner's approval): the account says what it grants before its first read", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  const { room } = await startRoom({ host, time, repos: [SANDBOX, LEDGER_API, LEDGER_WEB] });
  const events = heard(room.events);
  host.installOn(LEDGER.login);
  await time.advance(2 * MIN);
  events.stop();

  const { grantedAt, addedAt } = order(events.sent, LEDGER.login, [LEDGER_API_ID, LEDGER_WEB_ID]);
  expect(grantedAt).toBeGreaterThanOrEqual(0);
  expect(addedAt).toBeGreaterThan(grantedAt);
  expect(
    room
      .snapshot()
      .repos.map((r) => String(r.id))
      .sort(),
  ).toEqual([LEDGER_API_ID, LEDGER_WEB_ID, SANDBOX_ID]);
});

test("a repository added to an account that grants some already: the account grants both before the new one's first read", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  // ledger-labs installed on ledger-api alone.
  host.addRepository(LEDGER_API);
  const { room } = await startRoom({ host, time, repos: [SANDBOX, LEDGER_API, LEDGER_WEB] });
  const grantedBy = (login: string) =>
    room.snapshot().connection.accounts.find((a) => a.account.login === login)?.granted;
  expect(grantedBy(LEDGER.login)).toEqual([LEDGER_API_ID]);

  const events = heard(room.events);
  host.addRepository(LEDGER_WEB);
  await time.advance(2 * MIN);
  events.stop();
  const grantedAt = events.sent.findIndex(
    (e) => sentAccount(e, LEDGER.login)?.granted.map(String).join() === [LEDGER_API_ID, LEDGER_WEB_ID].join(),
  );
  const addedAt = events.sent.findIndex((e) => e.type === "repo.added" && e.repo.id === LEDGER_WEB_ID);
  expect(grantedAt).toBeGreaterThanOrEqual(0);
  expect(addedAt).toBeGreaterThan(grantedAt);
  expect(grantedBy(LEDGER.login)).toEqual([LEDGER_API_ID, LEDGER_WEB_ID]);
});

test("an account listed with a cause grants none: its repositories can't be read", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  host.installOn(LEDGER.login);
  host.askSso(LEDGER.login);
  const { room } = await startRoom({ host, time, repos: [SANDBOX, LEDGER_API, LEDGER_WEB] });
  const ledger = room.snapshot().connection.accounts.find((a) => a.account.login === LEDGER.login);
  expect(ledger).toMatchObject({ cause: { kind: "sso" }, granted: [] });
});

test("the connection at start says what each account grants, as its listing then did; a restart GitHub refuses keeps the last", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  host.installOn(LEDGER.login);
  const dir = home();
  const first = await startRoom({ home: dir, host, time, repos: [SANDBOX, LEDGER_API] });
  const granted = [
    [OWNER.login, [SANDBOX_ID]],
    [LEDGER.login, [LEDGER_API_ID]],
  ];
  expect(first.room.snapshot().connection.accounts.map((a) => [a.account.login, a.granted])).toEqual(granted);
  await first.room.stop();

  const github = { ...(await signedInOn(host, dir)), allowed: [SANDBOX, LEDGER_API] };
  host.refuse("unavailable");
  const again = await startRoom({ home: dir, host, time, idsFrom: 100, github });
  expect(again.room.snapshot().connection.accounts.map((a) => [a.account.login, a.granted])).toEqual(granted);
});
