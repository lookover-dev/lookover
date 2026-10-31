// What the person signed in to the shared App reaches (ADR 0066): who they are (`GET /user`), every installation of
// the shared App their token reaches, on every account (`GET /user/installations`, every page), and the repositories
// each grants them (`GET /user/installations/{id}/repositories`, every page), archived ones and any off the list left
// out. What is one account's stays on it: a suspended installation (its repositories not asked for), or an
// organisation asking for SAML SSO (GitHub's 403 with `X-GitHub-SSO`), is that account's cause; an installation gone
// between the two reads is left out. Anything else refuses the call, the connection's: signed out, unreachable.
import {
  type HostAccounts,
  HostError,
  type HostInstallation,
  type ReachedAccount,
  type RepositoryRef,
  SHARED_APP,
} from "@lookover/contracts";
import { allows } from "./allowed.ts";
import { type GitHubApi, ssoAsked } from "./api.ts";
import { accountOf, everyPage } from "./installations.ts";
import { installationRepositories, parse, person, userInstallations } from "./schemas.ts";
import type { UserSession } from "./user-session.ts";

export function createAccounts(
  api: GitHubApi,
  session: UserSession,
  repositories: readonly RepositoryRef[] | undefined,
): HostAccounts {
  /** The repositories an installation grants the person, as GitHub names them, cut to the list. */
  const granted = (id: number) =>
    session.asPerson(async (token) => {
      const listed = await everyPage(
        api,
        `/user/installations/${id}/repositories?per_page=100`,
        token,
        undefined,
        (body, what) => parse(installationRepositories, body, what).repositories,
      );
      return listed
        .filter((repo) => !repo.archived)
        .map((repo) => ({ owner: repo.owner.login, name: repo.name }))
        .filter((repo) => allows(repositories, repo));
    });

  return {
    person: () =>
      session.asPerson(async (token) => {
        const who = parse(person, (await api.request({ path: "/user", bearer: token })).body, "GET /user");
        return { id: who.id, login: who.login };
      }),

    async accounts() {
      const listed = await session.asPerson((token) =>
        everyPage(
          api,
          "/user/installations?per_page=100",
          token,
          undefined,
          (body, what) => parse(userInstallations, body, what).installations,
        ),
      );
      const reached: ReachedAccount[] = [];
      // A user token lists only its own App's installations; another App's is left out all the same.
      for (const one of listed.filter((i) => i.app_id === SHARED_APP.id)) {
        const account = await reach(
          { id: one.id, account: accountOf(one.account), suspended: one.suspended_at != null },
          one.suspended_by?.login ?? null,
          granted,
        );
        if (account !== null) reached.push(account);
      }
      return reached;
    },
  };
}

/**
 * One installation as the person reaches it: suspended (by `suspendedBy`, when GitHub named them), or its
 * organisation asking for SAML SSO, its account's cause; gone since it was listed (not found), null; any other
 * refusal thrown.
 */
async function reach(
  installation: HostInstallation,
  suspendedBy: string | null,
  granted: (id: number) => Promise<RepositoryRef[]>,
): Promise<ReachedAccount | null> {
  if (installation.suspended) {
    const by = suspendedBy === null ? {} : { suspendedBy };
    return { installation, repositories: [], cause: { kind: "uninstalled", suspended: true, ...by } };
  }
  try {
    return { installation, repositories: await granted(installation.id), cause: null };
  } catch (error) {
    const sso = ssoAsked(error);
    if (sso !== null) {
      const cause = { kind: "sso", organisation: installation.account.login, url: sso.url } as const;
      return { installation, repositories: [], cause };
    }
    if (error instanceof HostError && error.failure === "not_found") return null;
    throw error;
  }
}
