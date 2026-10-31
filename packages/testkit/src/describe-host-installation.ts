// The contract of the `HostInstallations` port (ADR 0053), written once: what the App level of a Git host must
// answer and how it refuses, run against `FakeGitHost` in every check and against the real adapter in
// `bun run live` with the spike App (#192). Each case asks `setup` for a fresh adapter in the state it needs: the
// App installed (always), then, each optional, the App with no installation, the installation suspended, a key the
// host refuses, an App id it has not, the host out of reach, and a manifest code the host has not converted yet. A
// state the real host can't be brought to on demand is left out of its setup and that case is skipped: live, the
// spike App stays installed and unsuspended, and the loop never creates an App, so a manifest is converted on the
// fake only. The refusals are read as the service reads them, through `connectionCauseOf`: an adapter must say an
// uninstalled or suspended App, or a refused key and why, in the `HostError`'s `connectionCause`, not leave it to be
// guessed. GitHub's own words were checked live (#192): another key "could not be decoded" (401), an App id it has
// not "Integration not found" (a 404 on every JWT request, never an uninstall).
// It takes either way in (ADR 0066): `own`, the App's credentials with each call, as above; or `shared`, the person
// signed in to the shared App (`HostAccounts`), reaching several accounts at once. What both must say (each
// installation on its account, listing what it grants and nothing else) is asked of both; the shared way adds who
// signed in, a suspended installation or an organisation asking for SAML SSO kept as that account's cause while the
// others are listed, and the connection's causes (signed out, unreachable) on every call.
import { describe, expect, test } from "bun:test";
import {
  type AppCredentials,
  type ConnectionCause,
  connectionCauseOf,
  type HostAccount,
  type HostAccounts,
  type HostApp,
  HostError,
  type HostFailure,
  type HostInstallations,
  type HostLogin,
  type ReachedAccount,
  type RepositoryRef,
} from "@lookover/contracts";

/** An adapter and the credentials to ask it with: the App's id and a key, the App's own or one refused. */
export interface HostInstallationAdapter {
  installations: HostInstallations;
  credentials: AppCredentials;
}

export interface HostInstallationFixture extends HostInstallationAdapter {
  /**
   * The App as the host must describe it: its id, slug and owner exactly, and at least the permissions given (the
   * host may say more).
   */
  app: HostApp;
  /** Repositories the installation grants: each must be listed (live, the host may list more). */
  granted: RepositoryRef[];
  /** Repositories of the owner's the installation must not list: not granted, or archived. None: not checked. */
  left?: RepositoryRef[];
}

/** A manifest code the host has not converted yet, and the App its conversion must give. */
export interface ManifestFixture {
  installations: HostInstallations;
  code: string;
  /** The App GitHub made from the manifest: id, slug and owner exactly, at least these permissions. */
  app: HostApp;
}

/** The own way: the App's id and key given with each call (`HostInstallations`). */
export interface HostInstallationSetup {
  way: "own";
  /** The App, installed on its owner's account with `granted`. */
  installed(): Promise<HostInstallationFixture>;
  /** The App with no installation (uninstalled after it was installed): none, and the case is skipped. */
  uninstalled?: () => Promise<HostInstallationAdapter & { formerInstallation: number }>;
  /** The App's installation suspended by its owner: none, and the case is skipped. */
  suspended?: () => Promise<HostInstallationAdapter & { installation: number }>;
  /** Credentials the host refuses: a key that isn't the App's (revoked, or never its). None: skipped. */
  keyRefused?: () => Promise<HostInstallationAdapter & { installation: number }>;
  /** Credentials naming an App the host has not (deleted, or never made), with a key it would sign. None: skipped. */
  appGone?: () => Promise<HostInstallationAdapter & { installation: number }>;
  /** The host out of reach. None: skipped. */
  unreachable?: () => Promise<HostInstallationAdapter & { installation: number }>;
  /** A manifest's code, not converted yet. None: skipped (live never converts one, ADR 0045). */
  manifest?: () => Promise<ManifestFixture>;
}

/** No installation of any App: GitHub's installation ids start at 1, and the spike App's is far past it. */
const NO_INSTALLATION = 1;

/** What a refused call must have thrown: a `HostError` failing as `failure`, its cause as the connection shows it. */
async function refused(call: Promise<unknown>, failure: HostFailure, cause: Partial<ConnectionCause> | null) {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HostError);
  if (!(error instanceof HostError)) return;
  expect(error.failure).toBe(failure);
  if (cause === null) expect(connectionCauseOf(error)).toBeNull();
  else expect(connectionCauseOf(error)).toMatchObject(cause);
}

/** An account an installation must be on, the repositories it must list there, and those it must not. */
export interface ReachFixture {
  account: HostAccount;
  /** Each must be listed (live, the host may list more). */
  granted: RepositoryRef[];
  /** Repositories of the account's the installation must not list: not granted, or archived. None: not checked. */
  left?: RepositoryRef[];
}

/** The person signed in to the shared App, and what they must reach. */
export interface HostAccountsFixture {
  accounts: HostAccounts;
  /** Who signed in: `person` must name them. */
  person: HostLogin;
  /** The accounts the person must reach, each installed and usable (live, the host may list more). */
  reached: ReachFixture[];
}

/** The shared way (ADR 0066): the person signed in, their token from their sign-in, never given with a call. */
export interface HostAccountsSetup {
  way: "shared";
  /** Signed in, reaching each of `reached`. */
  signedIn(): Promise<HostAccountsFixture>;
  /**
   * One installation the person reaches suspended, by `by` (the login GitHub names in `suspended_by`) when the setup
   * knows who; without it, any login is taken. None: skipped.
   */
  suspended?: () => Promise<{ accounts: HostAccounts; account: HostAccount; by?: string }>;
  /** One organisation asking for SAML SSO the sign-in hasn't; `others` still reached. None: skipped. */
  sso?: () => Promise<{ accounts: HostAccounts; organisation: HostAccount; others: HostAccount[] }>;
  /** Nobody signed in, or a sign-in GitHub refuses. None: skipped. */
  signedOut?: () => Promise<{ accounts: HostAccounts }>;
  /** The host out of reach. None: skipped. */
  unreachable?: () => Promise<{ accounts: HostAccounts }>;
}

/** What one way reaches, read through its port, and what it must reach. */
async function reachedOf(
  setup: HostInstallationSetup | HostAccountsSetup,
): Promise<{ reached: ReachedAccount[]; expected: ReachFixture[] }> {
  if (setup.way === "shared") {
    const f = await setup.signedIn();
    return { reached: await f.accounts.accounts(), expected: f.reached };
  }
  const f = await setup.installed();
  const installation = await f.installations.installation(f.credentials);
  if (installation === null) throw new Error("The fixture's App is not installed");
  const repositories = await f.installations.repositories(f.credentials, installation.id);
  return {
    reached: [{ installation, repositories, cause: null }],
    expected: [{ account: f.app.owner, granted: f.granted, ...(f.left ? { left: f.left } : {}) }],
  };
}

/**
 * The App level's contract on either way (ADR 0066): `own`, the App's credentials with each call
 * (`HostInstallations`); `shared`, the person signed in to the shared App (`HostAccounts`). What both must say is
 * asked of both; the rest of each way's.
 */
export function describeHostInstallation(
  name: string,
  setup: HostInstallationSetup | HostAccountsSetup,
): void {
  describe(`${setup.way === "own" ? "HostInstallations" : "HostAccounts"} port: ${name}`, () => {
    test("each installation is on its account, not suspended, listing what it grants as owner and name, and none it doesn't", async () => {
      const { reached, expected } = await reachedOf(setup);
      for (const want of expected) {
        const found = reached.find((r) => r.installation.account.id === want.account.id);
        expect(found?.installation).toEqual({
          id: expect.any(Number),
          account: want.account,
          suspended: false,
        });
        expect(found?.cause).toBeNull();
        const listed = found?.repositories ?? [];
        expect(listed).toEqual(expect.arrayContaining(want.granted));
        for (const repo of listed) expect(Object.keys(repo).sort()).toEqual(["name", "owner"]);
        const lower = listed.map((r) => `${r.owner}/${r.name}`.toLowerCase());
        for (const left of want.left ?? [])
          expect(lower).not.toContain(`${left.owner}/${left.name}`.toLowerCase());
      }
    });

    if (setup.way === "own") describeOwn(setup);
    else describeShared(setup);
  });
}

/** The shared way's own cases: who signed in, an account's causes kept on it, and the connection's. */
function describeShared(setup: HostAccountsSetup): void {
  test("the person is who signed in", async () => {
    const f = await setup.signedIn();
    expect(await f.accounts.person()).toEqual(f.person);
  });

  const { suspended, sso, signedOut, unreachable } = setup;

  (suspended ? test : test.skip)(
    "a suspended installation is its account's cause, naming who suspended it, with no repositories; the call stands",
    async () => {
      if (!suspended) return;
      const f = await suspended();
      const found = (await f.accounts.accounts()).find((r) => r.installation.account.id === f.account.id);
      expect(found).toEqual({
        installation: { id: expect.any(Number), account: f.account, suspended: true },
        repositories: [],
        cause: { kind: "uninstalled", suspended: true, suspendedBy: f.by ?? expect.any(String) },
      });
    },
  );

  (sso ? test : test.skip)(
    "an organisation asking for SAML SSO is that account's sso, never the call's: the others are listed",
    async () => {
      if (!sso) return;
      const f = await sso();
      const reached = await f.accounts.accounts();
      const found = reached.find((r) => r.installation.account.id === f.organisation.id);
      // GitHub's page to sign in there, when it gave one.
      const url = found?.cause?.kind === "sso" ? found.cause.url : null;
      expect(found).toEqual({
        installation: { id: expect.any(Number), account: f.organisation, suspended: false },
        repositories: [],
        cause: { kind: "sso", organisation: f.organisation.login, url },
      });
      if (url !== null) expect(url).toStartWith("https://");
      for (const other of f.others)
        expect(reached.find((r) => r.installation.account.id === other.id)?.cause).toBeNull();
    },
  );

  (signedOut ? test : test.skip)(
    "signed out, every call is unauthorized, the person signed out",
    async () => {
      if (!signedOut) return;
      const f = await signedOut();
      await refused(f.accounts.person(), "unauthorized", { kind: "signed-out" });
      await refused(f.accounts.accounts(), "unauthorized", { kind: "signed-out" });
    },
  );

  (unreachable ? test : test.skip)(
    "out of reach, every call is unavailable, the host unreachable",
    async () => {
      if (!unreachable) return;
      const f = await unreachable();
      await refused(f.accounts.person(), "unavailable", { kind: "unreachable" });
      await refused(f.accounts.accounts(), "unavailable", { kind: "unreachable" });
    },
  );
}

/** The own way's own cases: the App, its installation's refusals, its key's, a manifest's code. */
function describeOwn(setup: HostInstallationSetup): void {
  test("the App is described by its id, its slug, its owner and the permissions it holds", async () => {
    const f = await setup.installed();
    const app = await f.installations.app(f.credentials);
    expect({ id: app.id, slug: app.slug, owner: app.owner }).toEqual({
      id: f.app.id,
      slug: f.app.slug,
      owner: f.app.owner,
    });
    expect(app.permissions).toMatchObject(f.app.permissions);
  });

  test("an installation the App doesn't have is not found, and says the App isn't installed", async () => {
    const f = await setup.installed();
    await refused(f.installations.repositories(f.credentials, NO_INSTALLATION), "not_found", {
      kind: "uninstalled",
      suspended: false,
    });
  });

  test("a manifest code the host never gave is not found, and creates nothing", async () => {
    const f = await setup.installed();
    await refused(f.installations.convertManifest("no-such-manifest-code"), "not_found", null);
  });

  const { uninstalled, suspended, keyRefused, appGone, unreachable, manifest } = setup;

  (uninstalled ? test : test.skip)(
    "uninstalled, the App has no installation, and its former one is not found as uninstalled",
    async () => {
      if (!uninstalled) return;
      const f = await uninstalled();
      expect(await f.installations.installation(f.credentials)).toBeNull();
      await refused(f.installations.repositories(f.credentials, f.formerInstallation), "not_found", {
        kind: "uninstalled",
        suspended: false,
      });
      // The App itself is still there: its key still opens it.
      expect((await f.installations.app(f.credentials)).id).toBe(f.credentials.id);
    },
  );

  (suspended ? test : test.skip)(
    "suspended, the installation says so, and its repositories are refused as a suspended installation",
    async () => {
      if (!suspended) return;
      const f = await suspended();
      expect(await f.installations.installation(f.credentials)).toMatchObject({
        id: f.installation,
        suspended: true,
      });
      await refused(f.installations.repositories(f.credentials, f.installation), "unauthorized", {
        kind: "uninstalled",
        suspended: true,
      });
    },
  );

  (keyRefused ? test : test.skip)(
    "with a key the host refuses, every call with it is unauthorized, the key refused",
    async () => {
      if (!keyRefused) return;
      const f = await keyRefused();
      // GitHub can't decode a token signed with a key it doesn't hold: the key revoked, or never the App's.
      const cause = { kind: "key-refused", why: "revoked" } as const;
      await refused(f.installations.app(f.credentials), "unauthorized", cause);
      await refused(f.installations.installation(f.credentials), "unauthorized", cause);
      await refused(f.installations.repositories(f.credentials, f.installation), "unauthorized", cause);
    },
  );

  (appGone ? test : test.skip)(
    "for an App the host has not, every call is unauthorized, the App deleted, never an uninstall",
    async () => {
      if (!appGone) return;
      const f = await appGone();
      const cause = { kind: "key-refused", why: "app-deleted" } as const;
      await refused(f.installations.app(f.credentials), "unauthorized", cause);
      await refused(f.installations.installation(f.credentials), "unauthorized", cause);
      await refused(f.installations.repositories(f.credentials, f.installation), "unauthorized", cause);
    },
  );

  (unreachable ? test : test.skip)(
    "out of reach, every call is unavailable, the host unreachable",
    async () => {
      if (!unreachable) return;
      const f = await unreachable();
      const cause = { kind: "unreachable" } as const;
      await refused(f.installations.app(f.credentials), "unavailable", cause);
      await refused(f.installations.installation(f.credentials), "unavailable", cause);
      await refused(f.installations.repositories(f.credentials, f.installation), "unavailable", cause);
      await refused(f.installations.convertManifest("any-code"), "unavailable", cause);
    },
  );

  (manifest ? test : test.skip)(
    "a manifest's code converts once into the App and its key, which opens the App; used again, it is not found",
    async () => {
      if (!manifest) return;
      const f = await manifest();
      const { app, key } = await f.installations.convertManifest(f.code);
      expect({ id: app.id, slug: app.slug, owner: app.owner }).toEqual({
        id: f.app.id,
        slug: f.app.slug,
        owner: f.app.owner,
      });
      expect(app.permissions).toMatchObject(f.app.permissions);
      expect(key).not.toBe("");
      expect((await f.installations.app({ id: app.id, key })).slug).toBe(f.app.slug);
      await refused(f.installations.convertManifest(f.code), "not_found", null);
    },
  );
}
