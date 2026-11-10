// Whether the person's installations have been listed under the current sign-in (`Connection.listed`, ADR 0086):
// false from the moment a sign-in is kept until a listing under it answers, and no account said to be not reached
// meanwhile; true once any listing answers (the setup's install check, a Reconnect, discovery, the start's), even one
// that finds nothing new; a refused listing shows the connection's cause rather than looking on. The service runs in
// this process on the fake host, its listing of the accounts held where the test says.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type Event,
  type HostAccount,
  type HostAccounts,
  HostError,
  type SignIn,
  type State,
} from "@lookover/contracts";
import { DemoClock, FakeGitHost, type MemoryGh, memoryGh } from "@lookover/testkit";
import { type GitHubSide, type Keychain, memoryKeychain, type RunningService, signInStore } from "./index.ts";
import {
  api,
  eventually,
  home,
  messages,
  OWNER,
  openApp,
  post,
  pr1,
  SANDBOX,
  SHARED_BOT,
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
const userOnly = async () => {};
/** An organisation the person is a member of, where the shared App isn't installed. */
const LEDGER: HostAccount = { id: 9101, login: "ledger-dev", type: "Organization" };
/** A setup at its GitHub step, nothing asked of GitHub yet: what a fresh data folder shows there. */
const AT_GITHUB = {
  done: false,
  step: "github",
  reached: "github",
  github: "start",
  firstReviewChange: null,
} as const;

/** The person's sign-in, as GitHub gives it: a token for 8 hours. */
const SIGN_IN: SignIn = {
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: T0 + 8 * 3_600_000,
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: T0 + 180 * 86_400_000,
  person: { ...OWNER },
};

/** The owner's `gh`: a member of ledger-dev, which the App doesn't reach. */
function ownersGh(): MemoryGh {
  const gh = memoryGh({ as: OWNER });
  gh.join(LEDGER, OWNER, { state: "active", admin: false });
  return gh;
}

/** The fake's listing of the accounts, held while the test says: each listing asked meanwhile answers on `release`. */
function held(host: FakeGitHost) {
  let holding = false;
  let refusing = false;
  const waiting: (() => void)[] = [];
  const accounts: HostAccounts = {
    person: () => host.person(),
    accounts: async () => {
      if (holding) await new Promise<void>((resolve) => waiting.push(resolve));
      if (refusing) throw new HostError("unavailable", "GitHub didn't answer the accounts' listing");
      return host.accounts();
    },
  };
  return {
    accounts,
    /** The listing of the accounts alone refused as GitHub not answering, every other call answered; or no longer. */
    refuse: (refuse: boolean) => {
      refusing = refuse;
    },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const answer of waiting.splice(0)) answer();
    },
    /** How many listings wait. */
    waiting: () => waiting.length,
  };
}

type Held = ReturnType<typeof held>;

/** GitHub as the fake plays it, the accounts listed through `gate`, the sign-in kept in `dir` on `keychain`. */
function sideOf(host: FakeGitHost, dir: string, keychain: Keychain, gate: Held): GitHubSide {
  return {
    shared: {
      signIn: host,
      signIns: signInStore({ home: dir, keychain, userOnly }),
      accounts: () => gate.accounts,
      connect: () => ({ intake: host, writer: host }),
    },
  };
}

const hostOf = (time: DemoClock, o: { installed?: boolean } = {}) =>
  new FakeGitHost({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1], clock: time, ...o });

/** A sign-in from the app: the code asked, entered on GitHub, and the poll answered. */
async function signIn(service: RunningService, cookie: string, host: FakeGitHost, time: DemoClock) {
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  const shown = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn !== null,
  );
  host.enterCode(shown.connection.signIn?.userCode ?? "");
  await time.advance(5_000);
}

/** The state once `holds`. */
const once = (service: RunningService, cookie: string, holds: (s: State) => boolean) =>
  eventually(() => snapshot(service, cookie), holds);

test("signed in from the setup, nothing is said not reached until the installations are listed; then the person's own first", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const host = hostOf(time, { installed: false });
  const gate = held(host);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: sideOf(host, dir, keychain, gate),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  expect((await snapshot(service, cookie)).connection).toMatchObject({ listed: false, unreached: [] });

  gate.hold();
  await signIn(service, cookie, host, time);
  const looking = await once(service, cookie, (s) => s.connection.person !== null && gate.waiting() > 0);
  expect(looking.connection).toMatchObject({ person: OWNER, listed: false, accounts: [], unreached: [] });

  gate.release();
  const listed = await once(service, cookie, (s) => s.connection.listed);
  // Installed nowhere: the person's own account is the one to install on.
  expect(listed.connection.accounts).toEqual([]);
  expect(listed.connection.unreached).toEqual([{ account: OWNER, kind: "user", owner: true, askedAt: null }]);
});

test("signed in again from Settings with the App installed, listed again even with nothing new; until then nothing is said not reached", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(SIGN_IN);
  const host = hostOf(time);
  const gate = held(host);
  const { service } = await start({
    home: dir,
    host,
    time,
    gh: ownersGh(),
    github: sideOf(host, dir, keychain, gate),
  });
  const cookie = await openApp(service);
  const before = await once(service, cookie, (s) => s.connection.unreached.length === 1);
  expect(before.connection).toMatchObject({ listed: true, state: "connected" });
  expect(before.connection.unreached.map((u) => u.account.login)).toEqual([LEDGER.login]);

  gate.hold();
  await signIn(service, cookie, host, time);
  const looking = await once(service, cookie, (s) => s.connection.signIn === null && gate.waiting() > 0);
  expect(looking.connection).toMatchObject({ listed: false, unreached: [] });

  gate.release();
  const listed = await once(
    service,
    cookie,
    (s) => s.connection.listed && s.connection.unreached.length === 1,
  );
  expect(listed.connection.accounts).toEqual(before.connection.accounts);
  expect(listed.connection.unreached).toEqual(before.connection.unreached);
});

test("a listing refused under a new sign-in shows the connection's cause; the next discovery, finding nothing new, lists them", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(SIGN_IN);
  const host = hostOf(time);
  const gate = held(host);
  const { service } = await start({
    home: dir,
    host,
    time,
    gh: ownersGh(),
    github: sideOf(host, dir, keychain, gate),
  });
  const cookie = await openApp(service);
  const before = await once(service, cookie, (s) => s.connection.unreached.length === 1);

  gate.hold();
  await signIn(service, cookie, host, time);
  await once(service, cookie, (s) => s.connection.signIn === null && gate.waiting() > 0);
  host.refuse("unavailable");
  gate.release();
  const refused = await once(
    service,
    cookie,
    (s) => s.connection.cause !== null && s.connection.listingCause !== null,
  );
  // The listing's own cause: the one the accounts list says while not listed (ADR 0086).
  expect(refused.connection).toMatchObject({
    listed: false,
    unreached: [],
    state: "disconnected",
    listingCause: { kind: "unreachable" },
  });

  host.refuse(null);
  await time.advance(5 * MIN);
  const listed = await once(service, cookie, (s) => s.connection.listed);
  expect(listed.connection).toMatchObject({ state: "connected", cause: null });
  expect(listed.connection.unreached).toEqual(before.connection.unreached);
  expect(listed.repos.map((r) => r.id)).toEqual(before.repos.map((r) => r.id));
});

test("the accounts' listing alone refused under a new sign-in, the repositories still polled: its cause is said, not looking on", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(SIGN_IN);
  const host = hostOf(time);
  const gate = held(host);
  const { service } = await start({
    home: dir,
    host,
    time,
    gh: ownersGh(),
    github: sideOf(host, dir, keychain, gate),
  });
  const cookie = await openApp(service);
  const before = await once(service, cookie, (s) => s.connection.unreached.length === 1);

  gate.refuse(true);
  await signIn(service, cookie, host, time);
  const refused = await once(service, cookie, (s) => s.connection.listingCause !== null);
  expect(refused.connection).toMatchObject({
    listed: false,
    listingCause: { kind: "unreachable" },
    unreached: [],
  });
  // The repositories answer their polls meanwhile: the connection stays connected, the listing's cause kept.
  await time.advance(MIN);
  const polled = await snapshot(service, cookie);
  expect(polled.connection).toMatchObject({
    state: "connected",
    cause: null,
    listed: false,
    listingCause: { kind: "unreachable" },
  });

  // The listing is tried again a minute on, as the refusal says: it answers, listed, its cause gone.
  gate.refuse(false);
  await time.advance(MIN);
  const listed = await once(service, cookie, (s) => s.connection.listed);
  expect(listed.connection).toMatchObject({ listingCause: null, state: "connected" });
  expect(listed.connection.unreached).toEqual(before.connection.unreached);
});

test("the setup's install check refused while it waits shows the connection's cause, not looking on", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const host = hostOf(time, { installed: false });
  const gate = held(host);
  const { service } = await start({
    home: dir,
    host,
    time,
    github: sideOf(host, dir, keychain, gate),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);
  gate.hold();
  await signIn(service, cookie, host, time);
  await once(service, cookie, (s) => s.connection.person !== null && gate.waiting() > 0);
  host.refuse("unavailable");
  gate.release();
  const refused = await once(
    service,
    cookie,
    (s) => s.connection.cause !== null && s.connection.listingCause !== null,
  );
  // The listing's own cause too: the one the accounts list says while not listed (ADR 0086).
  expect(refused.connection).toMatchObject({
    listed: false,
    unreached: [],
    cause: { kind: "unreachable" },
    listingCause: { kind: "unreachable" },
  });

  // GitHub answers again: the cause cleared, the installations listed.
  host.refuse(null);
  await time.advance(4_000);
  const listed = await once(service, cookie, (s) => s.connection.listed);
  expect(listed.connection).toMatchObject({ cause: null, listingCause: null });
  expect(listed.connection.unreached).toEqual([{ account: OWNER, kind: "user", owner: true, askedAt: null }]);
});

/**
 * What refuses an organisation's repository on its first poll, asked once its repositories are listed, and what its
 * account then says: SSO asked is that account's cause; GitHub not answering that poll alone is nobody's.
 */
const FIRST_POLL_REFUSED: {
  refusal: string;
  refuse: (host: FakeGitHost, org: string) => void;
  accountCause: "sso" | null;
}[] = [
  {
    refusal: "SSO asked by the organisation",
    refuse: (host, org) => host.askSso(org, "https://github.com/orgs/lookover-dev/sso"),
    accountCause: "sso",
  },
  {
    refusal: "GitHub not answering that poll",
    refuse: (host) => host.refuse("unavailable"),
    accountCause: null,
  },
];

test.each(FIRST_POLL_REFUSED)(
  "the setup's install check: an organisation's repository refused on its first poll ($refusal) never shows as the connection's cause",
  async ({ refuse, accountCause }) => {
    const dir = home();
    const keychain = memoryKeychain();
    const time = new DemoClock({ at: T0 });
    const org: HostAccount = { id: 9001, login: "lookover-dev", type: "Organization" };
    const orgSandbox = { owner: org.login, name: SANDBOX.name };
    const host = new FakeGitHost({
      repo: SANDBOX,
      bot: SHARED_BOT,
      person: OWNER,
      changes: [pr1],
      clock: time,
      installed: false,
      reaches: [{ account: org, repositories: [orgSandbox] }],
    });
    // Refused once the first listing has read the repositories, before their first poll; the next listing answers.
    const gate = held(host);
    let listings = 0;
    const listing: HostAccounts = {
      person: () => host.person(),
      accounts: async () => {
        host.refuse(null);
        const reached = await gate.accounts.accounts();
        listings += 1;
        if (listings === 1) refuse(host, org.login);
        return reached;
      },
    };
    const { service } = await start({
      home: dir,
      host,
      time,
      github: sideOf(host, dir, keychain, { ...gate, accounts: listing }),
      setup: AT_GITHUB,
    });
    const cookie = await openApp(service);
    const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

    await signIn(service, cookie, host, time);
    // A check refused on the first poll leaves the setup waiting: a next one, 4 s on, finds the repository watched.
    for (let i = 0; i < 20 && (await snapshot(service, cookie)).setup.github !== "done"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await time.advance(4_000);
    }
    const seen: Event[] = [];
    while (!seen.some((e) => e.type === "setup.changed" && e.setup.github === "done"))
      seen.push(...(await until(stream, "setup.changed")));

    const causes = seen.flatMap((e) =>
      e.type === "connection.changed" && "cause" in e.patch ? [e.patch.cause] : [],
    );
    expect(causes.filter((c) => c !== null)).toEqual([]);
    const done = await once(
      service,
      cookie,
      (s) => (s.connection.accounts[0]?.cause?.kind ?? null) === accountCause,
    );
    expect(done.connection).toMatchObject({ listed: true, cause: null });
  },
);

test("the setup's install check: accounts listed, their first poll refused, then the App uninstalled; the next listing, empty, clears them", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  const org: HostAccount = { id: 9001, login: "lookover-dev", type: "Organization" };
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    installed: false,
    reaches: [{ account: org, repositories: [{ owner: org.login, name: SANDBOX.name }] }],
  });
  // The first listing answers, then GitHub refuses the repository's first poll; the App is uninstalled before the next.
  const gate = held(host);
  let listings = 0;
  const listing: HostAccounts = {
    person: () => host.person(),
    accounts: async () => {
      host.refuse(null);
      if (listings === 1) host.uninstall(org.login);
      const reached = await gate.accounts.accounts();
      listings += 1;
      if (listings === 1) host.refuse("unavailable");
      return reached;
    },
  };
  const { service } = await start({
    home: dir,
    host,
    time,
    github: sideOf(host, dir, keychain, { ...gate, accounts: listing }),
    setup: AT_GITHUB,
  });
  const cookie = await openApp(service);

  await signIn(service, cookie, host, time);
  const reached = await once(service, cookie, (s) => s.connection.accounts.length === 1);
  expect(reached.connection.accounts[0]?.account.login).toBe(org.login);
  for (let i = 0; i < 20 && listings < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await time.advance(4_000);
  }
  expect(listings).toBeGreaterThanOrEqual(2);
  const cleared = await once(service, cookie, (s) => s.connection.accounts.length === 0);
  expect(cleared.setup.github).toBe("waiting-for-install");
  expect(cleared.connection).toMatchObject({ listed: true, accounts: [] });
  // Installed nowhere: the person's own account is the one to install on.
  expect(cleared.connection.unreached).toContainEqual({
    account: OWNER,
    kind: "user",
    owner: true,
    askedAt: null,
  });
});

test("at start, listed once the start's listing answers; a start whose listing is refused says not listed, whatever the log said", async () => {
  const dir = home();
  const keychain = memoryKeychain();
  const time = new DemoClock({ at: T0 });
  await signInStore({ home: dir, keychain, userOnly }).write(SIGN_IN);
  const host = hostOf(time);
  const first = await startRoom({ home: dir, host, time, github: sideOf(host, dir, keychain, held(host)) });
  expect(first.room.snapshot().connection).toMatchObject({ listed: true, state: "connected" });
  await first.room.stop();

  host.refuse("unavailable");
  const { room } = await startRoom({
    home: dir,
    host,
    time,
    idsFrom: 100,
    github: sideOf(host, dir, keychain, held(host)),
    log: () => {},
  });
  expect(room.snapshot().connection).toMatchObject({ listed: false, state: "disconnected" });
  expect(room.snapshot().connection.cause).not.toBeNull();
  // The listing's own cause, the one the accounts list says while not listed (ADR 0086).
  expect(room.snapshot().connection.listingCause).toEqual(room.snapshot().connection.cause);
});
