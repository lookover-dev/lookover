// The App level (ADR 0053): a manifest's code converted, the App read with its own JWT, its installation on its
// owner's account (a person's or an organisation's, ADR 0059), and the repositories that installation grants.
// Credentials come with each call, so the service can check an App before it keeps it.
import type {
  AppCredentials,
  Clock,
  HostAccount,
  HostApp,
  HostInstallation,
  HostInstallations,
  RepositoryRef,
} from "@lookover/contracts";
import { allows } from "./allowed.ts";
import type { CauseOf, GitHubApi } from "./api.ts";
import { appCause, appJwt, jwtCause, tokenCause } from "./jwt.ts";
import {
  accessToken,
  appInstallations,
  conversion,
  hostApp,
  installationRepositories,
  parse,
} from "./schemas.ts";

/** A listing's pages, each read whole as the `Link` header gives the next: a discovery read is not cached. */
export async function everyPage<T>(
  api: GitHubApi,
  first: string,
  bearer: string,
  cause: CauseOf | undefined,
  read: (body: unknown, what: string) => T[],
): Promise<T[]> {
  const items: T[] = [];
  for (let where: string | null = first; where !== null; ) {
    const page = await api.page(where, bearer, false, cause);
    items.push(...read(page.body, `GET ${where}`));
    where = page.next;
  }
  return items;
}

/** GitHub's account type as the contracts take it: anything but a person's account is an organisation's. */
export const accountOf = (account: { id: number; login: string; type: string }): HostAccount => ({
  id: account.id,
  login: account.login,
  type: account.type === "User" ? "User" : "Organization",
});

const appOf = (app: ReturnType<typeof hostApp.parse>): HostApp => ({
  id: app.id,
  slug: app.slug,
  owner: accountOf(app.owner),
  permissions: app.permissions,
});

export function createInstallations(
  api: GitHubApi,
  clock: Clock,
  repositories: readonly RepositoryRef[] | undefined,
  secret: (value: string) => void,
): HostInstallations {
  /** A fresh JWT for the App the credentials give; the key and the JWT given to `secret` first. */
  const signed = (credentials: AppCredentials): string => {
    secret(credentials.key);
    const jwt = appJwt(credentials, clock);
    secret(jwt);
    return jwt;
  };
  const app = async (credentials: AppCredentials): Promise<HostApp> => {
    const bearer = signed(credentials);
    const answer = await api.request({ path: "/app", bearer, cause: appCause });
    return appOf(parse(hostApp, answer.body, "GET /app"));
  };
  return {
    async convertManifest(code) {
      // The code is a credential for its hour: the request carries it, and no message names it.
      secret(code);
      const path = `/app-manifests/${encodeURIComponent(code)}/conversions`;
      const answer = await api.request({ method: "POST", path, bearer: null, secret: code });
      const converted = parse(conversion, answer.body, "POST /app-manifests/…/conversions");
      secret(converted.pem);
      return { app: appOf(converted), key: converted.pem };
    },
    app,
    async installation(credentials) {
      const owner = (await app(credentials)).owner;
      const bearer = signed(credentials);
      const listed = await everyPage(api, "/app/installations?per_page=100", bearer, jwtCause, (body, what) =>
        parse(appInstallations, body, what),
      );
      // The App's own account, a person's or an organisation's (ADR 0059): a private App is installed only there.
      const own = listed.find((one) => one.account.id === owner.id);
      if (own === undefined) return null;
      const installation: HostInstallation = {
        id: own.id,
        account: accountOf(own.account),
        suspended: own.suspended_at != null,
      };
      return installation;
    },
    async repositories(credentials, installationId) {
      // A token for the listing only: it reads the metadata, of every repository the installation grants.
      const path = `/app/installations/${installationId}/access_tokens`;
      const bought = await api.request({
        method: "POST",
        path,
        bearer: signed(credentials),
        body: { permissions: { metadata: "read" } },
        cause: tokenCause,
      });
      const token = parse(accessToken, bought.body, `POST ${path}`).token;
      secret(token);
      const granted = await everyPage(
        api,
        "/installation/repositories?per_page=100",
        token,
        tokenCause,
        (body, what) => parse(installationRepositories, body, what).repositories,
      );
      return granted
        .filter((repo) => !repo.archived)
        .map((repo) => ({ owner: repo.owner.login, name: repo.name }))
        .filter((repo) => allows(repositories, repo));
    },
  };
}
