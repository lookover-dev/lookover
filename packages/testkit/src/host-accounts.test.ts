import { describe, expect, test } from "bun:test";
import {
  type ConnectionCause,
  commitSha,
  connectionCauseOf,
  HostError,
  type HostFailure,
  type RepositoryRef,
} from "@lookover/contracts";
import { describeHostAccounts, FakeGitHost } from "./index.ts";

const sandbox: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
const ledger: RepositoryRef = { owner: "sasensi", name: "ledger-api" };
const notes: RepositoryRef = { owner: "sasensi", name: "notes" };
const bot = { id: 338297045, login: "lookover-dev[bot]" };
const owner = { id: 1234567, login: "sasensi", type: "User" as const };
const person = { id: owner.id, login: owner.login };

/** The person's three repositories, the shared App installed on all of them unless told otherwise. */
const host = (options: { installed?: boolean } = {}) =>
  new FakeGitHost({
    repo: sandbox,
    repositories: [ledger, notes],
    bot,
    person,
    changes: [],
    ...(options.installed === undefined ? {} : { installed: options.installed }),
  });

/**
 * The person signed in to the shared App (ADR 0066), reaching three accounts: their own, `lookover-dev` and `acme`.
 */
const organisation = { id: 338456971, login: "lookover-dev", type: "Organization" as const };
const orgSandbox: RepositoryRef = { owner: "lookover-dev", name: "lookover-sandbox" };
const orgLookover: RepositoryRef = { owner: "lookover-dev", name: "lookover" };
const acme = { id: 5100, login: "acme", type: "Organization" as const };
const acmeApi: RepositoryRef = { owner: "acme", name: "api" };
const signedInHost = () =>
  new FakeGitHost({
    repo: sandbox,
    repositories: [ledger, notes],
    bot,
    person,
    changes: [],
    reaches: [
      { account: organisation, repositories: [orgSandbox, orgLookover] },
      { account: acme, repositories: [acmeApi] },
    ],
  });

describeHostAccounts("FakeGitHost, the person signed in on three accounts", {
  signedIn: () => {
    const fake = signedInHost();
    // Ledger's archived and notes left out of the installation on their own account: neither is listed.
    fake.archive(ledger);
    fake.removeRepository(notes);
    fake.archive(orgLookover);
    return Promise.resolve({
      accounts: fake,
      person,
      reached: [
        { account: owner, granted: [sandbox], left: [ledger, notes] },
        { account: organisation, granted: [orgSandbox], left: [orgLookover] },
        { account: acme, granted: [acmeApi] },
      ],
    });
  },
  suspended: () => {
    const fake = signedInHost();
    fake.suspend("acme", "rhea-k");
    return Promise.resolve({ accounts: fake, account: acme, by: "rhea-k" });
  },
  sso: () => {
    const fake = signedInHost();
    fake.askSso("acme");
    return Promise.resolve({ accounts: fake, organisation: acme, others: [owner, organisation] });
  },
  signedOut: () => {
    const fake = signedInHost();
    fake.signOut();
    return Promise.resolve({ accounts: fake });
  },
  unreachable: () => {
    const fake = signedInHost();
    fake.refuse("unavailable");
    return Promise.resolve({ accounts: fake });
  },
});

test("accounts held: the listing answers only once released, then as before; who is signed in still answers", async () => {
  const fake = signedInHost();
  const release = fake.holdAccounts();
  let answered = false;
  const listing = fake.accounts().then((accounts) => {
    answered = true;
    return accounts;
  });
  expect(await fake.person()).toEqual(person);
  await Promise.resolve();
  expect(answered).toBe(false);
  release();
  expect((await listing).map((a) => a.installation.account.login)).toEqual([
    "sasensi",
    "lookover-dev",
    "acme",
  ]);
  // Released, the next listing answers at once.
  expect(await fake.accounts()).toHaveLength(3);
});

const why = async (call: Promise<unknown>) => {
  const error = await call.catch((e: unknown) => e);
  if (!(error instanceof HostError)) throw new Error("not refused");
  return [error.failure, connectionCauseOf(error)];
};

/** The installation on the person's own account, as `accounts` gives it. */
const ownOf = async (fake: FakeGitHost) => {
  const own = (await fake.accounts()).find((a) => a.installation.account.id === owner.id);
  if (own === undefined) throw new Error("not installed on the person's own account");
  return own;
};

describe("FakeGitHost's other accounts, as the person signed in reaches them", () => {
  const change = (repo: RepositoryRef) => ({
    repo,
    number: 1,
    title: "One",
    url: `https://github.com/${repo.owner}/${repo.name}/pull/1`,
    author: { login: "sasensi", id: owner.id },
    draft: false,
    head: { ref: "one", sha: commitSha("1".repeat(40)) },
    base: { ref: "main", sha: commitSha("0".repeat(40)) },
    diff: [],
  });

  test("an organisation's repositories answer through its own installation, its pull requests theirs", async () => {
    const fake = signedInHost();
    fake.open(change(acmeApi));
    expect((await fake.getChange(acmeApi, 1)).number).toBe(1);
    expect((await fake.listOpenChanges(orgSandbox)).items).toEqual([]);
  });

  test("an organisation asking for SSO refuses its repositories with its sso; the others answer; signed in there, it answers", async () => {
    const fake = signedInHost();
    fake.open(change(acmeApi));
    const url = "https://github.com/orgs/acme/sso?authorization_request=FAKE";
    fake.askSso("acme", url);
    expect(await why(fake.getChange(acmeApi, 1))).toEqual([
      "unauthorized",
      { kind: "sso", organisation: "acme", url },
    ]);
    expect((await fake.listOpenChanges(sandbox)).items).toEqual([]);
    fake.signInSso("acme");
    expect((await fake.getChange(acmeApi, 1)).number).toBe(1);
  });

  test("an organisation's installation suspended refuses only its repositories, causeless as to a person's token; lifted, they answer", async () => {
    const fake = signedInHost();
    fake.suspend("acme");
    expect(await why(fake.listOpenChanges(acmeApi))).toEqual(["invalid", null]);
    expect((await fake.listOpenChanges(orgSandbox)).items).toEqual([]);
    fake.unsuspend("acme");
    expect((await fake.listOpenChanges(acmeApi)).items).toEqual([]);
  });

  test("the person's own account is theirs by id, as on GitHub", async () => {
    const own = { id: 1234, login: sandbox.owner };
    const fake = new FakeGitHost({ repo: sandbox, bot, person: own, changes: [] });
    expect((await fake.accounts())[0]?.installation.account).toEqual({ ...own, type: "User" });
  });

  test("the installation on their own account gone, the others are still reached", async () => {
    const fake = signedInHost();
    fake.uninstall();
    expect((await fake.accounts()).map((a) => a.installation.account.login)).toEqual([
      "lookover-dev",
      "acme",
    ]);
  });

  test("an organisation of the person's without the App isn't reached, its repositories refused; installed there, it is, after the others", async () => {
    const ledgerDev = { id: 338, login: "ledger-dev", type: "Organization" as const };
    const ledgerWeb: RepositoryRef = { owner: "ledger-dev", name: "ledger-web" };
    const fake = new FakeGitHost({
      repo: sandbox,
      bot,
      person,
      changes: [],
      reaches: [{ account: acme, repositories: [acmeApi] }],
      unreached: [{ account: ledgerDev, repositories: [ledgerWeb] }],
    });
    expect((await fake.accounts()).map((a) => a.installation.account.login)).toEqual(["sasensi", "acme"]);
    expect((await why(fake.listOpenChanges(ledgerWeb)))[0]).toBe("not_found");

    const id = fake.installOn("LEDGER-DEV");
    const reached = await fake.accounts();
    expect(reached.map((a) => a.installation.account.login)).toEqual(["sasensi", "acme", "ledger-dev"]);
    expect(reached[2]).toEqual({
      installation: { id, account: ledgerDev, suspended: false },
      repositories: [ledgerWeb],
      cause: null,
    });
    expect((await fake.listOpenChanges(ledgerWeb)).items).toEqual([]);
    expect(() => fake.installOn("ledger-dev")).toThrow("ledger-dev");

    // Uninstalled there, it is the person's again without the App, and can be installed again, with a new id.
    fake.uninstall("ledger-dev");
    expect((await fake.accounts()).length).toBe(2);
    expect(fake.installOn("ledger-dev")).not.toBe(id);
  });

  test("a repository removed from an organisation's installation leaves its listing and is not found; its others and the person's own stay", async () => {
    const fake = signedInHost();
    fake.open(change(orgSandbox));
    fake.removeRepository({ owner: "LOOKOVER-DEV", name: "lookover-sandbox" });
    const reached = await fake.accounts();
    expect(reached.map((a) => [a.installation.account.login, a.repositories])).toEqual([
      ["sasensi", [sandbox, ledger, notes]],
      ["lookover-dev", [orgLookover]],
      ["acme", [acmeApi]],
    ]);
    expect(await why(fake.getChange(orgSandbox, 1))).toEqual(["not_found", null]);
    expect((await fake.listOpenChanges(orgLookover)).items).toEqual([]);
    // Removed again, or never there, it is a test's mistake.
    expect(() => fake.removeRepository(orgSandbox)).toThrow("lookover-dev/lookover-sandbox");
  });

  test("a repository added back to an organisation's installation is listed there again, never on the person's own", async () => {
    const fake = signedInHost();
    fake.install([sandbox]);
    fake.removeRepository(orgSandbox);
    fake.addRepository({ owner: "LOOKOVER-DEV", name: "lookover-sandbox" });
    fake.addRepository(orgLookover);
    const reached = await fake.accounts();
    expect(reached.map((a) => [a.installation.account.login, a.repositories])).toEqual([
      ["sasensi", [sandbox]],
      ["lookover-dev", [orgLookover, orgSandbox]],
      ["acme", [acmeApi]],
    ]);
  });

  test("a repository added on an organisation the shared App left installs it there again, on that repository alone, with a new id", async () => {
    const fake = signedInHost();
    const [, before] = await fake.accounts();
    fake.uninstall("lookover-dev");
    fake.addRepository(orgSandbox);
    const reached = await fake.accounts();
    expect(reached.map((a) => [a.installation.account.login, a.repositories])).toEqual([
      ["sasensi", [sandbox, ledger, notes]],
      ["acme", [acmeApi]],
      ["lookover-dev", [orgSandbox]],
    ]);
    expect(reached[2]?.installation.id).not.toBe(before?.installation.id);
    expect(fake.onGitHub().unreached).toEqual([]);
  });

  test("another account's repositories are only that account's: one named for another is refused", () => {
    const outside = () =>
      new FakeGitHost({
        repo: sandbox,
        bot,
        person,
        changes: [],
        reaches: [{ account: acme, repositories: [orgSandbox] }],
      });
    expect(outside).toThrow("lookover-dev/lookover-sandbox is not acme's");
  });

  test("the person's own installation holds only their repositories, or those of an organisation they reach", () => {
    const elsewhere = { owner: "someone-else", name: "api" };
    const others = () => new FakeGitHost({ repo: elsewhere, bot, person, changes: [] });
    expect(others).toThrow("someone-else/api is not sasensi's");
    const added = () => host().addRepository(elsewhere);
    expect(added).toThrow("someone-else/api is not sasensi's");
    // A repository of an organisation the person reaches is held there, through its own installation.
    const reached = new FakeGitHost({
      repo: orgSandbox,
      bot,
      person,
      changes: [],
      reaches: [{ account: organisation, repositories: [orgSandbox] }],
    });
    expect(reached.onGitHub().account).toEqual(owner);
  });

  test("signed out on GitHub, every repository and the accounts refuse as signed out, as the adapter does once its renewal is refused; a new sign-in answers again", async () => {
    const fake = signedInHost();
    fake.open(change(acmeApi));
    fake.signOut();
    const signedOut: [HostFailure, ConnectionCause] = ["unauthorized", { kind: "signed-out" }];
    expect(await why(fake.getChange(acmeApi, 1))).toEqual(signedOut);
    expect(await why(fake.listOpenChanges(sandbox))).toEqual(signedOut);
    expect(await why(fake.accounts())).toEqual(signedOut);
    expect(await why(fake.person())).toEqual(signedOut);
    // The refresh tokens given so far are refused too.
    const grant = await fake.startSignIn();
    fake.enterCode(grant.userCode);
    // Entered, but not signed in until the code is polled.
    expect(await why(fake.accounts())).toEqual(signedOut);
    expect((await fake.pollSignIn(grant)).kind).toBe("issued");
    expect((await fake.getChange(acmeApi, 1)).number).toBe(1);
    expect((await fake.accounts()).length).toBe(3);
  });
});

describe("FakeGitHost's installation on the person's own account", () => {
  test("installed by default on every repository of theirs, in their order", async () => {
    const own = await ownOf(host());
    expect(own.installation).toEqual({ id: expect.any(Number), account: owner, suspended: false });
    expect(own.repositories).toEqual([sandbox, ledger, notes]);
  });

  test("installed on some repositories only, it lists those; a repository added or removed on GitHub follows", async () => {
    const fake = host({ installed: false });
    fake.install([ledger]);
    expect((await ownOf(fake)).repositories).toEqual([ledger]);
    fake.addRepository(notes);
    fake.removeRepository(ledger);
    expect((await ownOf(fake)).repositories).toEqual([notes]);
    // A repository new to the person's account, granted to the installation at once.
    const fresh = { owner: "sasensi", name: "fresh" };
    fake.addRepository(fresh);
    expect((await ownOf(fake)).repositories).toEqual([notes, fresh]);
  });

  test("installed on all, a repository new to the account is listed; one removed turns it to the others", async () => {
    const fake = host();
    const fresh = { owner: "sasensi", name: "fresh" };
    fake.addRepository(fresh);
    fake.removeRepository(sandbox);
    expect((await ownOf(fake)).repositories).toEqual([ledger, notes, fresh]);
  });

  test("granted nothing, the installation is there and lists no repository", async () => {
    const fake = host({ installed: false });
    fake.install([]);
    expect((await ownOf(fake)).repositories).toEqual([]);
  });

  test("an archived repository is left out of the listing", async () => {
    const fake = host();
    fake.archive(notes);
    expect((await ownOf(fake)).repositories).toEqual([sandbox, ledger]);
  });

  test("reinstalled, the installation has a new id", async () => {
    const fake = host();
    const before = (await ownOf(fake)).installation.id;
    fake.uninstall();
    expect((await fake.accounts()).length).toBe(0);
    const after = fake.install();
    expect(after).not.toBe(before);
    expect((await ownOf(fake)).installation.id).toBe(after);
  });
});

describe("FakeGitHost's repository ports as the installation stands", () => {
  const ref = { repo: sandbox, number: 1 };
  const opened = () => {
    const fake = host();
    fake.open({
      number: 1,
      title: "One",
      url: "https://github.com/sasensi/lookover-sandbox/pull/1",
      author: { login: "sasensi", id: owner.id },
      draft: false,
      head: { ref: "one", sha: commitSha("1".repeat(40)) },
      base: { ref: "main", sha: commitSha("0".repeat(40)) },
      diff: [],
    });
    return fake;
  };
  const failsWith = async (fake: FakeGitHost, failure: HostFailure, cause: ConnectionCause | null) => {
    const error = await fake.listOpenChanges(sandbox).catch((e: unknown) => e);
    if (!(error instanceof HostError)) throw new Error("not refused");
    expect([error.failure, connectionCauseOf(error)]).toEqual([failure, cause]);
    await expect(fake.getChange(sandbox, 1)).rejects.toMatchObject({ failure });
    await expect(fake.upsertStatus(ref, () => "Round 1")).rejects.toMatchObject({ failure });
    expect(fake.posts).toEqual([]);
  };

  test("uninstalled, every call is not found, the App uninstalled", async () => {
    const fake = opened();
    fake.uninstall();
    await failsWith(fake, "not_found", { kind: "uninstalled", suspended: false });
  });

  test("suspended, every call is unauthorized, the installation suspended; lifted, it answers", async () => {
    const fake = opened();
    fake.suspend();
    await failsWith(fake, "unauthorized", { kind: "uninstalled", suspended: true });
    fake.unsuspend();
    expect((await fake.getChange(sandbox, 1)).number).toBe(1);
  });

  test("a repository removed from the installation is not found, with no cause: the others answer", async () => {
    const fake = opened();
    fake.removeRepository(sandbox);
    await failsWith(fake, "not_found", null);
    expect((await fake.listOpenChanges(ledger)).items).toEqual([]);
  });

  test("GitHub down comes first, whatever the installation", async () => {
    const fake = opened();
    fake.uninstall();
    fake.refuse("unavailable");
    await failsWith(fake, "unavailable", { kind: "unreachable" });
  });
});
