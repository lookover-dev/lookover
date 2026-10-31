// What the person signed in to the shared App reaches (ADR 0066): who they are, every installation of the shared App on
// every account, and each one's repositories. Each answer is in GitHub's shape, from GitHub's docs ("List app
// installations accessible to the user access token", "List repositories accessible to the user access token": an
// object holding `installations` or `repositories`, paged by the `Link` header; a resource an organisation protects
// with SAML SSO refused 403 with `X-GitHub-SSO: required; url=…`, "Authenticating to the REST API"). None of them was
// spiked: spike 20 read `GET /user` and `GET /user/installations` only.
import { describe, expect, test } from "bun:test";
import {
  connectionCauseOf,
  HostError,
  type RepositoryRef,
  SHARED_APP,
  type SignIn,
  type SignInKeeper,
} from "@lookover/contracts";
import { AT, type Call, type Route, stubGitHub } from "./github.test-support.ts";
import { createHostAccounts } from "./index.ts";

const API = "https://api.github.com";
const PERSON = { id: 11247504, login: "sasensi" };
const ORG = { id: 338456971, login: "lookover-dev", type: "Organization" } as const;
const ACME = { id: 5100, login: "acme", type: "Organization" } as const;
const MINE = { id: PERSON.id, login: PERSON.login, type: "User" } as const;
const KEPT: SignIn = {
  token: "ghu_first",
  expiresAt: AT + 8 * 3_600_000,
  refreshToken: "ghr_first",
  refreshExpiresAt: AT + 4000 * 3_600_000,
  person: PERSON,
};
const SAML_REFUSAL =
  "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.";

const keeper = (kept: SignIn | null): SignInKeeper => ({
  read: () => Promise.resolve(kept),
  write: () => Promise.resolve(true),
});

/** An installation as `GET /user/installations` lists it (GitHub's docs): of the shared App unless said. */
const installed = (id: number, account: object, more: Record<string, unknown> = {}) => ({
  id,
  app_id: SHARED_APP.id,
  app_slug: SHARED_APP.slug,
  account,
  suspended_at: null,
  ...more,
});

/** A repository as an installation's listing gives it (GitHub's docs). */
const repoOf = (owner: string, name: string, archived = false) => ({
  id: name.length,
  name,
  full_name: `${owner}/${name}`,
  owner: { login: owner, id: 1, type: "User" },
  archived,
});

const authorised = (call: Call) => call.authorization === `Bearer ${KEPT.token}`;

/** `GET <path>` answered with `pages` in order, each linking to the next by `?page=<n>`. */
const paged =
  (path: string, key: string, pages: unknown[][]): Route =>
  (call) => {
    const [where, query] = call.path.split("?");
    if (where !== path || !authorised(call)) return undefined;
    const n = Number(/(?:^|&)page=(\d+)/.exec(query ?? "")?.[1] ?? 1);
    const next = n < pages.length ? { link: `<${API}${path}?per_page=100&page=${n + 1}>; rel="next"` } : {};
    return {
      status: 200,
      body: { total_count: pages.flat().length, [key]: pages[n - 1] ?? [] },
      headers: next,
    };
  };

const userRoute: Route = (call) =>
  call.path === "/user" && authorised(call) ? { status: 200, body: { ...PERSON, type: "User" } } : undefined;

const reposOf = (id: number, ...pages: unknown[][]) =>
  paged(`/user/installations/${id}/repositories`, "repositories", pages);

function accountsOver(options: { repositories?: RepositoryRef[]; kept?: SignIn | null }, ...routes: Route[]) {
  const api = stubGitHub(...routes);
  const accounts = createHostAccounts({
    keeper: keeper(options.kept === undefined ? KEPT : options.kept),
    fetch: api.fetch,
    clock: { now: () => AT },
    ...(options.repositories === undefined ? {} : { repositories: options.repositories }),
  });
  return { accounts, calls: api.calls };
}

async function refusal(call: Promise<unknown>): Promise<HostError> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof HostError)) throw new Error(`Expected a HostError, got ${String(error)}`);
  return error;
}

describe("what the person reaches", () => {
  test("the person is GET /user, with their own token", async () => {
    const { accounts } = accountsOver({}, userRoute);
    expect(await accounts.person()).toEqual(PERSON);
  });

  test("every installation, every page, each with every page of its repositories, archived ones left out", async () => {
    const { accounts } = accountsOver(
      {},
      paged("/user/installations", "installations", [[installed(1, MINE)], [installed(2, ORG)]]),
      reposOf(1, [repoOf("sasensi", "lookover-sandbox")], [repoOf("sasensi", "old", true)]),
      reposOf(2, [repoOf("lookover-dev", "lookover-sandbox")], [repoOf("lookover-dev", "lookover-private")]),
    );
    expect(await accounts.accounts()).toEqual([
      {
        installation: { id: 1, account: MINE, suspended: false },
        repositories: [{ owner: "sasensi", name: "lookover-sandbox" }],
        cause: null,
      },
      {
        installation: { id: 2, account: ORG, suspended: false },
        repositories: [
          { owner: "lookover-dev", name: "lookover-sandbox" },
          { owner: "lookover-dev", name: "lookover-private" },
        ],
        cause: null,
      },
    ]);
  });

  test("the list cuts what is listed, and the names are GitHub's own whatever the list's case", async () => {
    const { accounts } = accountsOver(
      { repositories: [{ owner: "LOOKOVER-DEV", name: "Lookover-Sandbox" }] },
      paged("/user/installations", "installations", [[installed(2, ORG)]]),
      reposOf(2, [repoOf("lookover-dev", "lookover-sandbox"), repoOf("lookover-dev", "lookover-private")]),
    );
    const [org] = await accounts.accounts();
    expect(org?.repositories).toEqual([{ owner: "lookover-dev", name: "lookover-sandbox" }]);
  });

  test("another App's installation, never listed to the shared App's token, is left out all the same", async () => {
    const { accounts, calls } = accountsOver(
      {},
      paged("/user/installations", "installations", [
        [installed(3, ACME, { app_id: 99 }), installed(2, ORG)],
      ]),
      reposOf(2, [repoOf("lookover-dev", "lookover-sandbox")]),
    );
    expect((await accounts.accounts()).map((a) => a.installation.id)).toEqual([2]);
    expect(calls.some((c) => c.path.startsWith("/user/installations/3"))).toBe(false);
  });

  test("a suspended installation is its account's cause, naming who suspended it, its repositories not asked for", async () => {
    const by = { login: "rhea-k", id: 990001, type: "User", site_admin: false };
    const { accounts, calls } = accountsOver(
      {},
      paged("/user/installations", "installations", [
        [installed(1, MINE), installed(3, ACME, { suspended_at: "2026-10-29T08:00:00Z", suspended_by: by })],
      ]),
      reposOf(1, [repoOf("sasensi", "lookover-sandbox")]),
    );
    const [mine, acme] = await accounts.accounts();
    expect(acme).toEqual({
      installation: { id: 3, account: ACME, suspended: true },
      repositories: [],
      cause: { kind: "uninstalled", suspended: true, suspendedBy: "rhea-k" },
    });
    expect(mine?.cause).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/user/installations/3"))).toBe(false);
  });

  test("a suspension GitHub names nobody for is still the account's cause, naming nobody", async () => {
    const { accounts } = accountsOver(
      {},
      paged("/user/installations", "installations", [
        [installed(3, ACME, { suspended_at: "2026-10-29T08:00:00Z", suspended_by: null })],
      ]),
    );
    expect((await accounts.accounts())[0]?.cause).toEqual({ kind: "uninstalled", suspended: true });
  });

  test("an organisation asking for SAML SSO is that account's sso, with GitHub's page; the others are listed", async () => {
    const url = "https://github.com/orgs/acme/sso?authorization_request=A1B2C3";
    const { accounts } = accountsOver(
      {},
      paged("/user/installations", "installations", [[installed(3, ACME), installed(2, ORG)]]),
      (call) =>
        call.path.startsWith("/user/installations/3/repositories")
          ? {
              status: 403,
              body: { message: SAML_REFUSAL },
              headers: { "x-github-sso": `required; url=${url}` },
            }
          : undefined,
      reposOf(2, [repoOf("lookover-dev", "lookover-sandbox")]),
    );
    expect(await accounts.accounts()).toEqual([
      {
        installation: { id: 3, account: ACME, suspended: false },
        repositories: [],
        cause: { kind: "sso", organisation: "acme", url },
      },
      {
        installation: { id: 2, account: ORG, suspended: false },
        repositories: [{ owner: "lookover-dev", name: "lookover-sandbox" }],
        cause: null,
      },
    ]);
  });

  test("an installation gone between the two reads is left out", async () => {
    const { accounts } = accountsOver(
      {},
      paged("/user/installations", "installations", [[installed(3, ACME), installed(2, ORG)]]),
      reposOf(2, [repoOf("lookover-dev", "lookover-sandbox")]),
    );
    expect((await accounts.accounts()).map((a) => a.installation.id)).toEqual([2]);
  });

  test("any other refusal of an installation's repositories is the call's, as GitHub gave it", async () => {
    const { accounts } = accountsOver(
      {},
      paged("/user/installations", "installations", [[installed(2, ORG)]]),
      (call) => (call.path.startsWith("/user/installations/2") ? { status: 502 } : undefined),
    );
    expect(connectionCauseOf(await refusal(accounts.accounts()))).toEqual({ kind: "unreachable" });
  });

  test("nobody signed in is the connection's signed-out, before any request", async () => {
    const { accounts, calls } = accountsOver({ kept: null }, userRoute);
    expect(connectionCauseOf(await refusal(accounts.person()))).toEqual({ kind: "signed-out" });
    expect(connectionCauseOf(await refusal(accounts.accounts()))).toEqual({ kind: "signed-out" });
    expect(calls).toEqual([]);
  });

  test("GitHub out of reach is unreachable", async () => {
    const { accounts } = accountsOver({}, () => ({ status: 503 }));
    expect(connectionCauseOf(await refusal(accounts.person()))).toEqual({ kind: "unreachable" });
    expect(connectionCauseOf(await refusal(accounts.accounts()))).toEqual({ kind: "unreachable" });
  });
});
