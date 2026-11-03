// The contract of the `HostAccounts` port (ADR 0066, ADR 0073), written once: what the person signed in to the shared
// App reaches, and how it refuses, run against `FakeGitHost` in every check and against the real adapter in
// `bun run live` on the live sign-in. Each case asks `setup` for a fresh adapter in the state it needs: signed in
// (always), then, each optional, one installation suspended, an organisation asking for SAML SSO, signed out, the host
// out of reach. A state the real host can't be brought to on demand is left out of its setup and that case is
// skipped. Each installation is on its account, listing what it grants and nothing else; a suspended installation or
// an organisation asking for SAML SSO is kept as that account's cause while the others are listed; the connection's
// causes (signed out, unreachable) refuse every call, read as the service reads them, through `connectionCauseOf`.
import { describe, expect, test } from "bun:test";
import {
  type ConnectionCause,
  connectionCauseOf,
  type HostAccount,
  type HostAccounts,
  HostError,
  type HostFailure,
  type HostLogin,
  type RepositoryRef,
} from "@lookover/contracts";

/** What a refused call must have thrown: a `HostError` failing as `failure`, its cause as the connection shows it. */
async function refused(call: Promise<unknown>, failure: HostFailure, cause: Partial<ConnectionCause>) {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HostError);
  if (!(error instanceof HostError)) return;
  expect(error.failure).toBe(failure);
  expect(connectionCauseOf(error)).toMatchObject(cause);
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

/** The person signed in to the shared App (ADR 0066): their token from their sign-in, never given with a call. */
export interface HostAccountsSetup {
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

/** The `HostAccounts` contract: who signed in, each account they reach, an account's causes kept on it. */
export function describeHostAccounts(name: string, setup: HostAccountsSetup): void {
  describe(`HostAccounts port: ${name}`, () => {
    test("each installation is on its account, not suspended, listing what it grants as owner and name, and none it doesn't", async () => {
      const f = await setup.signedIn();
      const reached = await f.accounts.accounts();
      for (const want of f.reached) {
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
  });
}
