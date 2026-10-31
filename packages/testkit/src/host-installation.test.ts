import { describe, expect, test } from "bun:test";
import {
  APP_PERMISSIONS,
  type ConnectionCause,
  commitSha,
  connectionCauseOf,
  HostError,
  type HostFailure,
  type HostInstallation,
  type RepositoryRef,
  SUMMARY_MARKER,
} from "@lookover/contracts";
import { describeHostInstallation, FakeGitHost } from "./index.ts";

const sandbox: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
const ledger: RepositoryRef = { owner: "sasensi", name: "ledger-api" };
const notes: RepositoryRef = { owner: "sasensi", name: "notes" };
const bot = { id: 338297044, login: "lookover-spike-sasensi[bot]" };
const owner = { id: 1234567, login: "sasensi", type: "User" as const };
const APP_ID = 2_041_517;

/** 2026-10-10 09:00:00 UTC, when the host starts. */
const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);

const heldClock = () => {
  let now = T0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

/** The owner's three repositories, the App installed on all of them unless told otherwise. */
const host = (options: { installed?: boolean; clock?: ReturnType<typeof heldClock> } = {}) =>
  new FakeGitHost({
    repo: sandbox,
    repositories: [ledger, notes],
    bot,
    changes: [],
    app: { id: APP_ID, owner },
    clock: options.clock ?? heldClock(),
    ...(options.installed === undefined ? {} : { installed: options.installed }),
  });

const theApp = { id: APP_ID, slug: "lookover-spike-sasensi", owner, permissions: APP_PERMISSIONS };

/** The fake's installation now, read through the port with the App's own key. */
const installationOf = async (fake: FakeGitHost): Promise<HostInstallation> => {
  const installation = await fake.installation(fake.credentials());
  if (installation === null) throw new Error("not installed");
  return installation;
};

describeHostInstallation("FakeGitHost", {
  way: "own",
  installed: () => {
    const fake = host();
    // Ledger's archived and notes left out of the installation: neither is listed.
    fake.archive(ledger);
    fake.removeRepository(notes);
    return Promise.resolve({
      installations: fake,
      credentials: fake.credentials(),
      app: theApp,
      granted: [sandbox],
      left: [ledger, notes],
    });
  },
  uninstalled: async () => {
    const fake = host();
    const formerInstallation = (await installationOf(fake)).id;
    fake.uninstall();
    return { installations: fake, credentials: fake.credentials(), formerInstallation };
  },
  suspended: async () => {
    const fake = host();
    fake.suspend();
    return {
      installations: fake,
      credentials: fake.credentials(),
      installation: (await installationOf(fake)).id,
    };
  },
  keyRefused: async () => {
    const fake = host();
    const credentials = fake.credentials();
    const installation = (await installationOf(fake)).id;
    fake.revokeKey();
    return { installations: fake, credentials, installation };
  },
  appGone: async () => {
    const fake = host();
    const installation = (await installationOf(fake)).id;
    return { installations: fake, credentials: { ...fake.credentials(), id: APP_ID + 7 }, installation };
  },
  unreachable: async () => {
    const fake = host();
    const installation = (await installationOf(fake)).id;
    fake.refuse("unavailable");
    return { installations: fake, credentials: fake.credentials(), installation };
  },
  manifest: () => {
    const fake = host({ installed: false });
    const code = fake.createApp({ name: "lookover-k3x9qa", permissions: APP_PERMISSIONS });
    return Promise.resolve({
      installations: fake,
      code,
      app: { id: APP_ID + 1, slug: "lookover-k3x9qa", owner, permissions: APP_PERMISSIONS },
    });
  },
});

/** An organisation's App (ADR 0059): on the organisation, made from a manifest there too. */
const organisation = { id: 338456971, login: "lookover-dev", type: "Organization" as const };
const orgSandbox: RepositoryRef = { owner: "lookover-dev", name: "lookover-sandbox" };
const orgLookover: RepositoryRef = { owner: "lookover-dev", name: "lookover" };
const orgHost = (installed = true) =>
  new FakeGitHost({
    repo: orgSandbox,
    repositories: [orgLookover],
    bot,
    changes: [],
    app: { id: APP_ID, owner: organisation },
    installed,
  });

describeHostInstallation("FakeGitHost, an organisation's App", {
  way: "own",
  installed: () => {
    const fake = orgHost();
    fake.removeRepository(orgLookover);
    return Promise.resolve({
      installations: fake,
      credentials: fake.credentials(),
      app: { ...theApp, owner: organisation },
      granted: [orgSandbox],
      left: [orgLookover],
    });
  },
  suspended: async () => {
    const fake = orgHost();
    fake.suspend();
    return {
      installations: fake,
      credentials: fake.credentials(),
      installation: (await installationOf(fake)).id,
    };
  },
  manifest: () => {
    const fake = orgHost(false);
    const code = fake.createApp({ name: "lookover-k3x9qa", permissions: APP_PERMISSIONS });
    return Promise.resolve({
      installations: fake,
      code,
      app: { id: APP_ID + 1, slug: "lookover-k3x9qa", owner: organisation, permissions: APP_PERMISSIONS },
    });
  },
});

/**
 * The person signed in to the shared App (ADR 0066), reaching three accounts: their own, where the App's installation
 * is, `lookover-dev` and `acme`.
 */
const person = { id: owner.id, login: owner.login };
const acme = { id: 5100, login: "acme", type: "Organization" as const };
const acmeApi: RepositoryRef = { owner: "acme", name: "api" };
const signedInHost = () =>
  new FakeGitHost({
    repo: sandbox,
    bot,
    person,
    changes: [],
    app: { id: APP_ID, owner },
    reaches: [
      { account: organisation, repositories: [orgSandbox, orgLookover] },
      { account: acme, repositories: [acmeApi] },
    ],
  });

describeHostInstallation("FakeGitHost, the person signed in on three accounts", {
  way: "shared",
  signedIn: () => {
    const fake = signedInHost();
    fake.archive(orgLookover);
    return Promise.resolve({
      accounts: fake,
      person,
      reached: [
        { account: owner, granted: [sandbox] },
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
  unreachable: () => {
    const fake = signedInHost();
    fake.refuse("unavailable");
    return Promise.resolve({ accounts: fake });
  },
});

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
  const why = async (call: Promise<unknown>) => {
    const error = await call.catch((e: unknown) => e);
    if (!(error instanceof HostError)) throw new Error("not refused");
    return [error.failure, connectionCauseOf(error)];
  };

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

  test("the person's own account, the App's made without an owner, is theirs by id as on GitHub", async () => {
    const own = { id: 1234, login: sandbox.owner };
    const fake = new FakeGitHost({ repo: sandbox, bot, person: own, changes: [] });
    expect((await fake.accounts())[0]?.installation.account).toEqual({ ...own, type: "User" });
  });

  test("the App's own installation gone, the others are still reached", async () => {
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
      app: { id: APP_ID, owner },
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

  test("signed out on GitHub, every repository and the accounts refuse as signed out, as the adapter does once its renewal is refused; a new sign-in answers again", async () => {
    const fake = signedInHost();
    fake.open(change(acmeApi));
    fake.signOut();
    const signedOut: [HostFailure, ConnectionCause] = ["unauthorized", { kind: "signed-out" }];
    expect(await why(fake.getChange(acmeApi, 1))).toEqual(signedOut);
    expect(await why(fake.listOpenChanges(sandbox))).toEqual(signedOut);
    expect(await why(fake.accounts())).toEqual(signedOut);
    // The refresh tokens given so far are refused too.
    const grant = await fake.startSignIn();
    fake.enterCode(grant.userCode);
    // Entered, but not signed in until the code is polled.
    expect(await why(fake.accounts())).toEqual(signedOut);
    expect((await fake.pollSignIn(grant)).kind).toBe("issued");
    expect((await fake.getChange(acmeApi, 1)).number).toBe(1);
    expect((await fake.accounts()).length).toBe(3);
  });

  test("nobody signed in, the person is signed out, as the adapter says it", async () => {
    const fake = new FakeGitHost({ repo: sandbox, bot, changes: [] });
    expect(await why(fake.person())).toEqual(["unauthorized", { kind: "signed-out" }]);
  });

  test("other accounts need a person signed in", () => {
    const nobody = () =>
      new FakeGitHost({ repo: sandbox, bot, changes: [], reaches: [{ account: acme, repositories: [] }] });
    expect(nobody).toThrow("person");
  });
});

describe("FakeGitHost's App and installation on their own", () => {
  test("installed by default on every repository of the owner's, in their order", async () => {
    const fake = host();
    const installation = await installationOf(fake);
    expect(installation).toEqual({ id: expect.any(Number), account: owner, suspended: false });
    expect(await fake.repositories(fake.credentials(), installation.id)).toEqual([sandbox, ledger, notes]);
  });

  test("its key is a private key's text, and the bot is the App's: its slug with `[bot]`", () => {
    const fake = host();
    expect(fake.credentials()).toEqual({ id: APP_ID, key: expect.stringContaining("PRIVATE KEY") });
  });

  test("installed on some repositories only, it lists those; a repository added or removed on GitHub follows", async () => {
    const fake = host({ installed: false });
    const id = fake.install([ledger]);
    const creds = fake.credentials();
    expect(await fake.repositories(creds, id)).toEqual([ledger]);
    fake.addRepository(notes);
    fake.removeRepository(ledger);
    expect(await fake.repositories(creds, id)).toEqual([notes]);
    // A repository new to the owner's account, granted to the installation at once.
    const fresh = { owner: "sasensi", name: "fresh" };
    fake.addRepository(fresh);
    expect(await fake.repositories(creds, id)).toEqual([notes, fresh]);
  });

  test("installed on all, a repository new to the account is listed; one removed turns it to the others", async () => {
    const fake = host();
    const { id } = await installationOf(fake);
    const fresh = { owner: "sasensi", name: "fresh" };
    fake.addRepository(fresh);
    fake.removeRepository(sandbox);
    expect(await fake.repositories(fake.credentials(), id)).toEqual([ledger, notes, fresh]);
  });

  test("granted nothing, the installation is there and lists no repository", async () => {
    const fake = host({ installed: false });
    const id = fake.install([]);
    expect(await fake.repositories(fake.credentials(), id)).toEqual([]);
  });

  test("an archived repository is left out of the listing", async () => {
    const fake = host();
    fake.archive(notes);
    expect(await fake.repositories(fake.credentials(), (await installationOf(fake)).id)).toEqual([
      sandbox,
      ledger,
    ]);
  });

  test("reinstalled, the installation has a new id and the old one is not found", async () => {
    const fake = host();
    const before = (await installationOf(fake)).id;
    fake.uninstall();
    const after = fake.install();
    expect(after).not.toBe(before);
    expect((await installationOf(fake)).id).toBe(after);
    await expect(fake.repositories(fake.credentials(), before)).rejects.toMatchObject({
      failure: "not_found",
    });
  });

  test("a refused key says why as GitHub's words do: revoked, the App deleted, or not a key at all", async () => {
    const fake = host();
    const old = fake.credentials();
    fake.revokeKey();
    const why = async (call: Promise<unknown>) => {
      const error = await call.catch((e: unknown) => e);
      if (!(error instanceof HostError)) throw new Error("not refused");
      return [error.failure, connectionCauseOf(error), error.message];
    };
    const revoked = [
      "unauthorized",
      { kind: "key-refused", why: "revoked" },
      expect.stringContaining("could not be decoded"),
    ];
    expect(await why(fake.app(old))).toEqual(revoked);
    // A key-shaped text that was never the App's: GitHub can't decode the token either.
    expect(await why(fake.app({ id: APP_ID, key: old.key.replace("fake-key", "other-key") }))).toEqual(
      revoked,
    );
    // Not a key: it can't sign, nothing leaves.
    expect(await why(fake.app({ id: APP_ID, key: "not the key" }))).toEqual([
      "unauthorized",
      { kind: "key-refused", why: null },
      expect.stringContaining("can't sign"),
    ]);
    const fresh = fake.generateKey();
    const deleted = [
      "unauthorized",
      { kind: "key-refused", why: "app-deleted" },
      expect.stringContaining("Integration not found"),
    ];
    expect(await why(fake.app({ id: APP_ID + 7, key: fresh }))).toEqual(deleted);
    // A key generated on the App's page opens it.
    expect((await fake.app({ id: APP_ID, key: fresh })).id).toBe(APP_ID);
    // A new App made from a manifest: the old one is deleted.
    fake.createApp({ name: "lookover-k3x9qa" });
    expect(await why(fake.app({ id: APP_ID, key: fresh }))).toEqual(deleted);
  });

  test("an App owned by an organisation is installed on the organisation, its repositories the organisation's", async () => {
    const fake = new FakeGitHost({
      repo: orgSandbox,
      repositories: [orgLookover],
      bot,
      changes: [],
      app: { id: APP_ID, owner: organisation },
    });
    expect(await installationOf(fake)).toEqual({
      id: expect.any(Number),
      account: organisation,
      suspended: false,
    });
    expect(await fake.repositories(fake.credentials(), (await installationOf(fake)).id)).toEqual([
      orgSandbox,
      orgLookover,
    ]);
  });

  test("an organisation's App on a repository outside the organisation is a shape GitHub never gives: refused", () => {
    const outside = () =>
      new FakeGitHost({
        repo: orgSandbox,
        repositories: [sandbox],
        bot,
        changes: [],
        app: { id: APP_ID, owner: organisation },
      });
    expect(outside).toThrow("sasensi/lookover-sandbox is not lookover-dev's");
  });

  test("an App holding fewer permissions says so", async () => {
    const fake = new FakeGitHost({
      repo: sandbox,
      bot,
      changes: [],
      app: { id: APP_ID, owner, permissions: { metadata: "read", pull_requests: "write" } },
    });
    expect((await fake.app(fake.credentials())).permissions).toEqual({
      metadata: "read",
      pull_requests: "write",
    });
  });

  test("a manifest's code expires after an hour on the host's clock", async () => {
    const clock = heldClock();
    const fake = host({ clock, installed: false });
    const code = fake.createApp({ name: "lookover-k3x9qa", permissions: APP_PERMISSIONS });
    clock.advance(60 * 60 * 1000 + 1);
    await expect(fake.convertManifest(code)).rejects.toMatchObject({ failure: "not_found" });
  });

  test("an App made from a manifest is a new App, not installed, its bot named after its slug", async () => {
    const fake = host();
    const code = fake.createApp({ name: "Lookover K3X9QA", permissions: APP_PERMISSIONS });
    const { app, key } = await fake.convertManifest(code);
    expect(app.slug).toBe("lookover-k3x9qa");
    expect(fake.credentials()).toEqual({ id: app.id, key });
    expect(await fake.installation({ id: app.id, key })).toBeNull();
    // The old App is gone with its key.
    await expect(fake.app({ id: APP_ID, key: "anything" })).rejects.toMatchObject({
      failure: "unauthorized",
    });
    fake.install();
    fake.open({
      number: 7,
      title: "Seven",
      url: "https://github.com/sasensi/lookover-sandbox/pull/7",
      author: { login: "sasensi", id: owner.id },
      draft: false,
      head: { ref: "seven", sha: commitSha("7".repeat(40)) },
      base: { ref: "main", sha: commitSha("0".repeat(40)) },
      diff: [],
    });
    await fake.upsertSummary({ repo: sandbox, number: 7 }, `${SUMMARY_MARKER}\nRound 1.`);
    expect((await fake.listComments(sandbox, 0)).items[0]?.author.login).toBe("lookover-k3x9qa[bot]");
  });

  test("with no App made yet, there are no credentials until a manifest makes one", () => {
    const fake = new FakeGitHost({ repo: sandbox, bot, changes: [], app: { made: false }, installed: false });
    expect(() => fake.credentials()).toThrow("no App");
    fake.createApp({ name: "lookover-k3x9qa" });
    expect(fake.credentials().key).toContain("PRIVATE KEY");
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
    await expect(fake.upsertSummary(ref, SUMMARY_MARKER)).rejects.toMatchObject({ failure });
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

  test("its key revoked, every call is unauthorized, the key revoked; signing with a new key, it answers", async () => {
    const fake = opened();
    fake.revokeKey();
    await failsWith(fake, "unauthorized", { kind: "key-refused", why: "revoked" });
    fake.useKey(fake.generateKey());
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

describe("an organisation's App an admin handed to the owner (ADR 0059)", () => {
  const ledgerCo = { id: 4242, login: "ledger-co", type: "Organization" as const };
  const handed = { id: 7, slug: "lookover-ledger-co", owner: ledgerCo };
  const key = "-----BEGIN RSA PRIVATE KEY-----\nledger-co's key\n-----END RSA PRIVATE KEY-----\n";
  const fake = () =>
    new FakeGitHost({
      repo: sandbox,
      bot,
      changes: [],
      app: { id: APP_ID, owner },
      clock: heldClock(),
      handed: [{ ...handed, key }],
    });

  test("GitHub describes it to its own key, with Lookover's permissions, installed nowhere; the owner's App unchanged", async () => {
    const host = fake();
    expect(await host.app({ id: 7, key })).toEqual({ ...handed, permissions: APP_PERMISSIONS });
    expect(await host.installation({ id: 7, key })).toBeNull();
    expect(await host.app(host.credentials())).toEqual(theApp);
  });

  test("another key, the owner's App's say, is refused for it", async () => {
    const host = fake();
    await expect(host.app({ id: 7, key: host.credentials().key })).rejects.toMatchObject({
      failure: "unauthorized",
    });
  });
});
