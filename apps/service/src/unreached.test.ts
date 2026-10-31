// The person's accounts the shared App doesn't reach (ADR 0067): their own account while it isn't installed there,
// and the organisations their own `gh` names when it is signed in as them (by id), each with whether they own it;
// "Ask to install on <org>" kept as Lookover's own memory until the organisation is reached or another person signs
// in. The service runs in this process on the fake host and the fake `gh`; the UI's copy follows the events with
// `apply`, as the web's does.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  apply,
  type Event,
  type Gh,
  type HostAccount,
  type HostLogin,
  type SignIn,
  type State,
} from "@lookover/contracts";
import type { Store } from "@lookover/store";
import { DemoClock, FakeGitHost, type MemoryGh, memoryGh } from "@lookover/testkit";
import { type GitHubSide, memoryKeychain, type RunningService, signInStore } from "./index.ts";
import {
  api,
  eventually,
  home,
  messages,
  next,
  OWNER,
  openApp,
  post,
  pr1,
  recordedStore,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const SHARED_BOT = { id: 2020, login: "lookover-dev[bot]" };
/** The person's own account as the fake names it. */
const SASENSI: HostAccount = { ...OWNER, type: "User" };
/** An organisation the person is a member of, where the shared App isn't installed yet. */
const LEDGER: HostAccount = { id: 9101, login: "ledger-dev", type: "Organization" };
const LEDGER_API = { owner: LEDGER.login, name: "ledger-api" };
/** An organisation the person owns, without the App. */
const ACME: HostAccount = { id: 9102, login: "acme", type: "Organization" };
/** An organisation the App reaches, which the person owns. */
const LABS: HostAccount = { id: 9103, login: "owner-labs", type: "Organization" };
const LABS_TOOLS = { owner: LABS.login, name: "tools" };
const userOnly = async () => {};

const login = ({ id, login }: HostAccount): HostLogin => ({ id, login });

/** The person's sign-in, as GitHub gives it: a token for 8 hours. */
const signInOf = (person: HostLogin): SignIn => ({
  token: "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
  expiresAt: T0 + 8 * 3_600_000,
  refreshToken: "ghr_1B4a2e77838347a7E420ce178F2E7c6912E1",
  refreshExpiresAt: T0 + 180 * 86_400_000,
  person: { ...person },
});

/**
 * A data folder signed in to the shared App as the owner, on the fake; the device flow's next sign-in names whoever
 * `next.person` holds then.
 */
async function signedIn(
  host: FakeGitHost,
  dir: string,
  nextPerson: { person: HostLogin },
  as: HostLogin = OWNER,
): Promise<GitHubSide> {
  const signIns = signInStore({ home: dir, keychain: memoryKeychain(), userOnly });
  await signIns.write(signInOf(as));
  return {
    installations: host,
    connect: () => ({ intake: host, writer: host }),
    shared: {
      signIn: {
        startSignIn: () => host.startSignIn(),
        pollSignIn: (grant) => host.pollSignIn(grant),
        person: async (token) => {
          await host.person(token);
          return { ...nextPerson.person };
        },
        refreshSignIn: (s) => host.refreshSignIn(s),
      },
      signIns,
      accounts: () => host,
      connect: () => ({ intake: host, writer: host }),
    },
  };
}

/** The owner's `gh`: a member of ledger-dev, an owner of acme and owner-labs. */
function ownersGh(): MemoryGh {
  const gh = memoryGh({ as: OWNER });
  gh.join(LEDGER, OWNER, { state: "active", admin: false });
  gh.join(ACME, OWNER, { state: "active", admin: true });
  gh.join(LABS, OWNER, { state: "active", admin: true });
  return gh;
}

/** The service signed in as the owner, the App on their account and owner-labs, not on ledger-dev. */
async function onShared(
  o: { gh?: Gh; installed?: boolean; as?: HostLogin; dir?: string; store?: Store } = {},
) {
  const dir = o.dir ?? home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: SHARED_BOT,
    person: OWNER,
    changes: [pr1],
    clock: time,
    reaches: [{ account: LABS, repositories: [LABS_TOOLS] }],
    unreached: [{ account: LEDGER, repositories: [LEDGER_API] }],
  });
  if (o.installed === false) host.uninstall();
  const nextPerson = { person: OWNER };
  const gh = o.gh ?? ownersGh();
  const { service } = await start({
    home: dir,
    host,
    time,
    gh,
    github: await signedIn(host, dir, nextPerson, o.as),
    ...(o.store === undefined ? {} : { store: o.store }),
  });
  const cookie = await openApp(service);
  return { dir, service, cookie, host, time, gh, nextPerson };
}
const ask = (service: RunningService, cookie: string, account: string) =>
  post(service, cookie, { type: "connection.askToInstall", account });

/** The UI's copy from `before`, the events of `stream` applied with `apply` until it is as new as `after`. */
async function followed(
  service: RunningService,
  cookie: string,
  before: State,
  after: State,
): Promise<State> {
  const headers = { cookie, "last-event-id": String(before.seq) };
  const stream = messages(await fetch(api(service, "/events"), { headers }));
  let state = before;
  while (state.seq < after.seq) {
    const message = await next(stream);
    if (message.event !== "event") continue;
    const event: Event = JSON.parse(message.data);
    state = apply(state, event);
  }
  await stream.return(undefined);
  return state;
}

/** The connection as it settles: the `gh` read at start answered. */
const settled = (service: RunningService, cookie: string, holds: (s: State) => boolean) =>
  eventually(() => snapshot(service, cookie), holds);

test("ask to install on an organisation: waiting, then an owner installs it and it is reached, the ask forgotten", async () => {
  const { service, cookie, host, time } = await onShared();
  const before = await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  // Reached accounts first, the person's own owned; then what `gh` names without the App, in its order.
  expect(before.connection.accounts.map((a) => [a.account.login, a.owner])).toEqual([
    [SASENSI.login, true],
    [LABS.login, true],
  ]);
  expect(before.connection.unreached).toEqual([
    { account: login(LEDGER), kind: "organisation", owner: false, askedAt: null },
    { account: login(ACME), kind: "organisation", owner: true, askedAt: null },
  ]);

  // An owner installs, a member asks: the ask on ledger-dev is kept, with when.
  await time.advance(MIN);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  const waiting = await settled(service, cookie, (s) => s.connection.unreached[0]?.askedAt != null);
  expect(waiting.connection.unreached[0]).toEqual({
    account: login(LEDGER),
    kind: "organisation",
    owner: false,
    askedAt: T0 + MIN,
  });
  expect((await followed(service, cookie, before, waiting)).connection).toEqual(waiting.connection);

  // An owner of ledger-dev approves it on GitHub: the next listing reaches it, and the ask is forgotten.
  host.installOn(LEDGER.login);
  await time.advance(5 * MIN);
  const reached = await settled(service, cookie, (s) => s.connection.accounts.length === 3);
  expect(reached.connection.accounts.map((a) => [a.account.login, a.owner])).toEqual([
    [SASENSI.login, true],
    [LABS.login, true],
    [LEDGER.login, false],
  ]);
  expect(reached.connection.unreached).toEqual([
    { account: login(ACME), kind: "organisation", owner: true, askedAt: null },
  ]);
  expect((await followed(service, cookie, waiting, reached)).connection).toEqual(reached.connection);

  // Uninstalled there again later: named again, never asked.
  host.uninstall(LEDGER.login);
  await time.advance(5 * MIN);
  const again = await settled(service, cookie, (s) => s.connection.accounts.length === 2);
  expect(again.connection.unreached).toEqual([
    { account: login(LEDGER), kind: "organisation", owner: false, askedAt: null },
    { account: login(ACME), kind: "organisation", owner: true, askedAt: null },
  ]);
});

test("an ask is refused off the accounts not reached, and for an organisation the person owns", async () => {
  const { service, cookie } = await onShared();
  await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  const refused = async (account: string) => {
    const res = await ask(service, cookie, account);
    expect(res.status).toBe(409);
    const body: { askToInstall: string } = await res.json();
    return body.askToInstall;
  };
  expect(await refused(ACME.login)).toBe("owner");
  expect(await refused(LABS.login)).toBe("not-named");
  expect(await refused("nobody-here")).toBe("not-named");
  const state: State = await snapshot(service, cookie);
  expect(state.connection.unreached.map((u) => u.askedAt)).toEqual([null, null]);
});

test("the person's own account not reached comes first, theirs, and no ask is taken for it", async () => {
  const { service, cookie } = await onShared({ installed: false });
  const state = await settled(service, cookie, (s) => s.connection.unreached.length === 3);
  expect(state.connection.accounts.map((a) => a.account.login)).toEqual([LABS.login]);
  expect(state.connection.unreached).toEqual([
    { account: OWNER, kind: "user", owner: true, askedAt: null },
    { account: login(LEDGER), kind: "organisation", owner: false, askedAt: null },
    { account: login(ACME), kind: "organisation", owner: true, askedAt: null },
  ]);
  const res = await ask(service, cookie, OWNER.login);
  expect(res.status).toBe(409);
});

test("`gh` signed in as another account of the same login names no organisation, and no owner but the person's own", async () => {
  const gh = memoryGh({ as: { id: 777, login: OWNER.login } });
  gh.join(LEDGER, { id: 777, login: OWNER.login }, { state: "active", admin: true });
  gh.join(LABS, { id: 777, login: OWNER.login }, { state: "active", admin: true });
  const { service, cookie } = await onShared({ gh });
  // Read, and unknown: the person's own account owned, the organisation's owner nobody's to say.
  const state = await settled(service, cookie, (s) => s.connection.accounts[0]?.owner === true);
  expect(state.connection.accounts.map((a) => [a.account.login, a.owner])).toEqual([
    [SASENSI.login, true],
    [LABS.login, null],
  ]);
  expect(state.connection.unreached).toEqual([]);
});

test("`gh` unable to answer names no organisation, and discovery goes on without it", async () => {
  const gh = ownersGh();
  gh.fail("offline");
  const { service, cookie, host, time } = await onShared({ gh });
  const state = await settled(service, cookie, (s) => s.connection.accounts[0]?.owner === true);
  expect(state.connection.unreached).toEqual([]);
  expect(state.connection.accounts.map((a) => a.owner)).toEqual([true, null]);
  // An owner installs it on ledger-dev: discovery finds it all the same.
  host.installOn(LEDGER.login);
  await time.advance(5 * MIN);
  const reached = await settled(service, cookie, (s) => s.connection.accounts.length === 3);
  expect(reached.connection.accounts.map((a) => [a.account.login, a.owner])).toEqual([
    [SASENSI.login, true],
    [LABS.login, null],
    [LEDGER.login, null],
  ]);
  expect(reached.repos.map((r) => String(r.id))).toContain("ledger-dev/ledger-api");
});

test("`gh` that never answers delays nothing: the start lists the accounts and their repositories", async () => {
  const gh: Gh = { ...ownersGh(), memberships: () => new Promise(() => {}) };
  const { service, cookie } = await onShared({ gh });
  const state: State = await snapshot(service, cookie);
  expect(state.repos.map((r) => String(r.id))).toEqual(["sasensi/lookover-sandbox", "owner-labs/tools"]);
  expect(state.connection.accounts.map((a) => a.owner)).toEqual([true, null]);
  expect(state.connection.unreached).toEqual([]);
});

test("`gh` is read at start, after each ask and each sign-in, never by discovery", async () => {
  const owners = ownersGh();
  let reads = 0;
  const gh: Gh = {
    ...owners,
    memberships: () => {
      reads += 1;
      return owners.memberships();
    },
  };
  const { service, cookie, host, time } = await onShared({ gh });
  await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  expect(reads).toBe(1);
  await time.advance(10 * MIN);
  expect(reads).toBe(1);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  await until(() => reads === 2);
  await signInAgain(service, cookie, host, time);
  await until(() => reads === 3);
});

/** Sign in again from the app: a code asked, entered, and the poll answered by whoever the device flow names. */
async function signInAgain(service: RunningService, cookie: string, host: FakeGitHost, time: DemoClock) {
  const code = await codeShown(service, cookie);
  host.enterCode(code);
  await time.advance(5_000);
  return eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn === null,
  );
}

/** Sign in again asked: the code shown, the sign-in held working meanwhile. */
async function codeShown(service: RunningService, cookie: string): Promise<string> {
  expect((await post(service, cookie, { type: "connection.signIn" })).status).toBe(200);
  const shown = await eventually(
    () => snapshot(service, cookie),
    (s) => s.connection.signIn !== null,
  );
  return shown.connection.signIn?.userCode ?? "";
}

/** Waits for `holds` to hold, polled every 10 ms for 3 s. */
async function until(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !holds(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(holds()).toBe(true);
}

test("Sign in again while connected: the sign-in keeps working until the code is entered, and Cancel keeps it", async () => {
  const { service, cookie, time } = await onShared();
  await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  const before = await settled(service, cookie, (s) => s.connection.unreached[0]?.askedAt != null);

  await codeShown(service, cookie);
  await time.advance(10_000);
  const waiting: State = await snapshot(service, cookie);
  expect(waiting.connection).toMatchObject({ state: "connected", person: OWNER, id: "github:sasensi" });
  expect(waiting.connection.accounts).toEqual(before.connection.accounts);
  expect(waiting.connection.unreached).toEqual(before.connection.unreached);
  expect(waiting.repos).toEqual(before.repos);

  expect((await post(service, cookie, { type: "connection.cancelSignIn" })).status).toBe(200);
  const cancelled: State = await snapshot(service, cookie);
  expect(cancelled.connection).toMatchObject({ signIn: null, state: "connected", person: OWNER });
  expect(cancelled.connection.accounts).toEqual(before.connection.accounts);
  expect(cancelled.connection.unreached).toEqual(before.connection.unreached);
});

test("Sign in again as the same person keeps their accounts and their asks", async () => {
  const { service, cookie, host, time } = await onShared();
  await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  const before = await settled(service, cookie, (s) => s.connection.unreached[0]?.askedAt != null);

  const after = await signInAgain(service, cookie, host, time);
  expect(after.connection).toMatchObject({ state: "connected", person: OWNER, id: "github:sasensi" });
  expect(after.connection.accounts).toEqual(before.connection.accounts);
  expect(after.connection.unreached).toEqual(before.connection.unreached);
});

test("the person's own account is theirs by its id, whatever login their sign-in kept", async () => {
  // Renamed on GitHub since they signed in: the sign-in kept their old login, GitHub lists the account by its new one.
  const { service, cookie } = await onShared({ as: { id: OWNER.id, login: "sasensi-was" } });
  const state = await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  expect(state.connection.accounts.map((a) => [a.account.login, a.owner])).toEqual([
    [SASENSI.login, true],
    [LABS.login, true],
  ]);
  expect(state.connection.unreached.map((u) => u.kind)).toEqual(["organisation", "organisation"]);
});

test("`gh` unable to answer later keeps the organisations it named last: only a listing replaces them", async () => {
  const gh = ownersGh();
  let reads = 0;
  const counted: Gh = {
    ...gh,
    memberships: () => {
      reads += 1;
      return gh.memberships();
    },
  };
  const { service, cookie, host, time } = await onShared({ gh: counted });
  const before = await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  gh.fail("offline");
  // Read again after a sign-in as the same person, and after an ask (5 s on): neither answers, nothing shifts but
  // the ask.
  await signInAgain(service, cookie, host, time);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  await until(() => reads === 3);
  await time.advance(MIN);
  const after: State = await snapshot(service, cookie);
  expect(after.connection.accounts).toEqual(before.connection.accounts);
  expect(after.connection.unreached).toEqual([
    { account: login(LEDGER), kind: "organisation", owner: false, askedAt: T0 + 5_000 },
    { account: login(ACME), kind: "organisation", owner: true, askedAt: null },
  ]);

  // A listing again replaces them: acme left, it is gone.
  gh.fail(null);
  gh.leave(ACME.login, OWNER);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  const listed = await settled(service, cookie, (s) => s.connection.unreached.length === 1);
  expect(listed.connection.unreached).toEqual([
    { account: login(LEDGER), kind: "organisation", owner: false, askedAt: T0 + 5_000 + MIN },
  ]);
});

test("an ask shows until its organisation is reached, whatever `gh` names", async () => {
  const gh = ownersGh();
  const { service, cookie } = await onShared({ gh });
  await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  // The person leaves ledger-dev, then asks: `gh` no longer names it, the ask still waits for an owner.
  gh.leave(LEDGER.login, OWNER);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  const state = await settled(
    service,
    cookie,
    (s) => s.connection.unreached.length === 2 && s.connection.unreached[1]?.askedAt != null,
  );
  expect(state.connection.unreached).toEqual([
    { account: login(ACME), kind: "organisation", owner: true, askedAt: null },
    { account: login(LEDGER), kind: "organisation", owner: false, askedAt: T0 },
  ]);
});

test("an organisation renamed between the ask and its install is reached under its new login, the ask forgotten by its id", async () => {
  const { service, cookie, host, time } = await onShared();
  await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  const waiting = await settled(service, cookie, (s) => s.connection.unreached[0]?.askedAt != null);
  // ledger-dev becomes ledger-co on GitHub, then an owner installs the App there; the person's `gh` still names the
  // old login (read before the rename).
  host.rename(LEDGER.login, "ledger-co");
  host.installOn("ledger-co");
  await time.advance(5 * MIN);
  const reached = await settled(service, cookie, (s) => s.connection.accounts.length === 3);
  expect(reached.connection.accounts.map((a) => [a.account.id, a.account.login, a.owner])).toEqual([
    [SASENSI.id, SASENSI.login, true],
    [LABS.id, LABS.login, true],
    [LEDGER.id, "ledger-co", false],
  ]);
  // No row waits under the old login.
  expect(reached.connection.unreached).toEqual([
    { account: login(ACME), kind: "organisation", owner: true, askedAt: null },
  ]);
  expect((await followed(service, cookie, waiting, reached)).connection).toEqual(reached.connection);

  // Uninstalled again: named, never asked: the ask was forgotten.
  host.uninstall("ledger-co");
  await time.advance(5 * MIN);
  const again = await settled(service, cookie, (s) => s.connection.accounts.length === 2);
  expect(again.connection.unreached.map((u) => [u.account.id, u.askedAt])).toEqual([
    [LEDGER.id, null],
    [ACME.id, null],
  ]);
});

test("`gh` naming an asked organisation under a new login shows it once, under that login, still asked", async () => {
  const gh = ownersGh();
  const { service, cookie } = await onShared({ gh });
  await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  // ledger-dev is renamed ledger-co: the same id. The ask reads `gh` again, which names the new login.
  gh.leave(LEDGER.login, OWNER);
  gh.join({ id: LEDGER.id, login: "ledger-co" }, OWNER, { state: "active", admin: false });
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  const state = await settled(service, cookie, (s) =>
    s.connection.unreached.some((u) => u.account.login === "ledger-co" && u.askedAt !== null),
  );
  expect(state.connection.unreached).toEqual([
    { account: login(ACME), kind: "organisation", owner: true, askedAt: null },
    { account: { id: LEDGER.id, login: "ledger-co" }, kind: "organisation", owner: false, askedAt: T0 },
  ]);
});

test("a restart on the same data folder with a `gh` that never answers shows the asks and the organisations as before", async () => {
  const { dir, service, cookie, host, time, nextPerson } = await onShared();
  await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  await time.advance(MIN);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  const before = await settled(service, cookie, (s) => s.connection.unreached[0]?.askedAt != null);
  await service.stop();

  const gh: Gh = { ...ownersGh(), memberships: () => new Promise(() => {}) };
  const again = await start({ home: dir, host, time, gh, github: await signedIn(host, dir, nextPerson) });
  const after: State = await snapshot(again.service, await openApp(again.service));
  expect(after.connection.unreached).toEqual(before.connection.unreached);
  expect(after.connection.unreached[0]?.askedAt).toBe(T0 + MIN);
  expect(after.connection.accounts).toEqual(before.connection.accounts);
});

test("`gh` answering once the service stopped touches nothing: no store read, no rejection", async () => {
  const owners = ownersGh();
  const answers: (() => void)[] = [];
  const gh: Gh = {
    ...owners,
    memberships: () => new Promise((resolve) => answers.push(() => void owners.memberships().then(resolve))),
  };
  const dir = home();
  const { store, calls } = recordedStore(dir, 0);
  const rejected: unknown[] = [];
  const onRejection = (reason: unknown) => rejected.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const { service } = await onShared({ gh, dir, store });
    await until(() => answers.length === 1);
    await service.stop();
    const before = calls.length;
    for (const answer of answers) answer();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.slice(before)).toEqual([]);
    expect(rejected).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("a store that fails as `gh` answers is logged, never left an unhandled rejection", async () => {
  const owners = ownersGh();
  const answers: (() => void)[] = [];
  const gh: Gh = {
    ...owners,
    memberships: () => new Promise((resolve) => answers.push(() => void owners.memberships().then(resolve))),
  };
  const dir = home();
  const { store } = recordedStore(dir, 0);
  let failing = false;
  const asks = store.installAsks;
  const failingStore: Store = {
    ...store,
    installAsks: {
      ...asks,
      of: (person) => {
        if (failing) throw new Error("disk I/O error");
        return asks.of(person);
      },
    },
  };
  const rejected: unknown[] = [];
  const onRejection = (reason: unknown) => rejected.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const logged: string[] = [];
    const time = new DemoClock({ at: T0 });
    const host = new FakeGitHost({
      repo: SANDBOX,
      bot: SHARED_BOT,
      person: OWNER,
      changes: [pr1],
      clock: time,
      reaches: [{ account: LABS, repositories: [LABS_TOOLS] }],
    });
    await start({
      home: dir,
      host,
      time,
      gh,
      store: failingStore,
      log: (line) => logged.push(line),
      github: await signedIn(host, dir, { person: OWNER }),
    });
    await until(() => answers.length === 1);
    failing = true;
    for (const answer of answers) answer();
    await until(() => logged.some((l) => l.includes("disk I/O error")));
    expect(logged).toContain("your organisations could not be shown again: disk I/O error");
    expect(rejected).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("Sign in again as another person replaces the accounts and forgets the asks", async () => {
  const { service, cookie, host, time, nextPerson } = await onShared();
  await settled(service, cookie, (s) => s.connection.unreached.length === 2);
  expect((await ask(service, cookie, LEDGER.login)).status).toBe(200);
  await settled(service, cookie, (s) => s.connection.unreached[0]?.askedAt != null);

  // Bob signs in; GitHub lists him the App on owner-labs alone, and his `gh` is the owner's, so it names nothing.
  const BOB: HostLogin = { id: 5678, login: "bob" };
  nextPerson.person = BOB;
  host.uninstall();
  await signInAgain(service, cookie, host, time);
  const asBob = await settled(
    service,
    cookie,
    (s) => s.connection.person?.id === BOB.id && s.connection.accounts.length === 1,
  );
  expect(asBob.connection.accounts.map((a) => [a.account.login, a.owner])).toEqual([[LABS.login, null]]);
  expect(asBob.connection.unreached).toEqual([{ account: BOB, kind: "user", owner: true, askedAt: null }]);

  // The owner signs in again: their ask on ledger-dev went when Bob signed in.
  nextPerson.person = OWNER;
  host.install();
  await signInAgain(service, cookie, host, time);
  const back = await settled(
    service,
    cookie,
    (s) => s.connection.person?.id === OWNER.id && s.connection.unreached.length === 2,
  );
  expect(back.connection.unreached).toEqual([
    { account: login(LEDGER), kind: "organisation", owner: false, askedAt: null },
    { account: login(ACME), kind: "organisation", owner: true, askedAt: null },
  ]);
});
