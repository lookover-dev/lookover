// App sign-in (ADR 0006, ADR 0039): a JWT signed with the private key buys an installation token for the
// repository's installation; the token is kept, per repository and scope, and renewed before it expires. A
// token GitHub no longer accepts (401: revoked, say, or its installation gone) is bought again once and the call made
// again, so the purchase's refusal says why; a permission refusal (403) is `unauthorized` too, the installation's
// (`uninstalled`, `suspended`), and drops the token as well, on purpose: the next call signs in again, which costs
// two requests and nothing else. Who posts is the App's bot (the `Session` it is, `session.ts`), its numeric user
// id looked up once, from the App's slug. An installation id whose token GitHub refuses as not found (the App
// uninstalled, then perhaps installed again under a new id) is forgotten, so the next call looks it up again (ADR
// 0053).
import type { Clock, RepositoryRef } from "@lookover/contracts";
import { HostError } from "@lookover/contracts";
import { type GitHubApi, GitHubRefusal } from "./api.ts";
import type { AppCredentials } from "./github.ts";
import { appCause, appJwt, jwtCause, tokenCause } from "./jwt.ts";
import { accessToken, app, botUser, installation, parse } from "./schemas.ts";
import type { Poster, Session, TokenScope } from "./session.ts";

/** A token is renewed this long before GitHub would expire it. */
const RENEW_MARGIN_MS = 5 * 60_000;

interface Token {
  value: string;
  expiresAt: number;
}

const keyOf = (repo: RepositoryRef) => `${repo.owner}/${repo.name}`;
const tokenKey = (repo: RepositoryRef, scope: TokenScope) => `${keyOf(repo)}:${scope}`;

/**
 * A token's refusal as the connection shows it: an act refused (a 403, GraphQL's `FORBIDDEN`) with no cause of its
 * own is the installation's grant refusing it, which its settings page fixes (`tokenCause`); never the key.
 */
function grantRefused(error: HostError): HostError {
  if (error.connectionCause !== undefined) return error;
  if (error instanceof GitHubRefusal && error.status === 401) return error;
  return new HostError(error.failure, error.message, {
    ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    connectionCause: { kind: "uninstalled", suspended: true },
  });
}

const PERMISSIONS: Record<TokenScope, Record<string, string> | undefined> = {
  ports: undefined,
  fetch: { contents: "read", metadata: "read" },
};

export class AppSession implements Session {
  private readonly api: GitHubApi;
  private readonly app: AppCredentials;
  private readonly clock: Clock;
  /** Installation ids and tokens, keyed by `owner/name` (and the token's scope). */
  private readonly installations = new Map<string, number>();
  private readonly tokens = new Map<string, Token>();
  private bot: { id: number; login: string } | undefined;
  /** Told each secret the session holds: the key now, each JWT and token as it comes. */
  private readonly secret: (value: string) => void;

  constructor(api: GitHubApi, app: AppCredentials, clock: Clock, secret: (value: string) => void) {
    this.api = api;
    this.app = app;
    this.clock = clock;
    this.secret = secret;
    secret(app.privateKey);
  }

  /**
   * Runs `call` with a token for the repository; a token GitHub rejects is forgotten. One it no longer takes (401) is
   * bought again once and the call made again, so a purchase's refusal says why (the App uninstalled); an act it
   * refuses (403) is the installation's grant, never the key.
   */
  async withToken<T>(repo: RepositoryRef, call: (token: string) => Promise<T>, scope: TokenScope = "ports") {
    const first = await this.attempt(repo, call, scope);
    if (first.done) return first.value;
    if (!(first.error instanceof GitHubRefusal) || first.error.status !== 401)
      throw grantRefused(first.error);
    const again = await this.attempt(repo, call, scope);
    if (again.done) return again.value;
    throw grantRefused(again.error);
  }

  /** `call` with a token, its refusal of the token given back, the token forgotten; anything else thrown. */
  private async attempt<T>(
    repo: RepositoryRef,
    call: (token: string) => Promise<T>,
    scope: TokenScope,
  ): Promise<{ done: true; value: T } | { done: false; error: HostError }> {
    const token = await this.token(repo, scope);
    try {
      return { done: true, value: await call(token) };
    } catch (error) {
      if (!(error instanceof HostError) || error.failure !== "unauthorized") throw error;
      this.tokens.delete(tokenKey(repo, scope));
      return { done: false, error };
    }
  }

  /** The App's id: what tells its check runs from another App's. */
  get appId(): number {
    return this.app.id;
  }

  /** Who posts: the App's bot, told by its numeric user id (ADR 0006). */
  async poster(repo: RepositoryRef): Promise<Poster> {
    return { ...(await this.botUser(repo)), bot: true };
  }

  /** The bot user, looked up once from the App's slug: `<slug>[bot]`. */
  async botUser(repo: RepositoryRef): Promise<{ id: number; login: string }> {
    if (this.bot !== undefined) return this.bot;
    const me = parse(
      app,
      (await this.api.request({ path: "/app", bearer: this.jwt(), cause: appCause })).body,
      "GET /app",
    );
    const path = `/users/${encodeURIComponent(`${me.slug}[bot]`)}`;
    const user = await this.withToken(repo, async (token) =>
      parse(botUser, (await this.api.request({ path, bearer: token })).body, `GET ${path}`),
    );
    this.bot = { id: user.id, login: user.login };
    return this.bot;
  }

  private async token(repo: RepositoryRef, scope: TokenScope): Promise<string> {
    const held = this.tokens.get(tokenKey(repo, scope));
    if (held && held.expiresAt - RENEW_MARGIN_MS > this.clock.now()) return held.value;
    const id = await this.installation(repo);
    const path = `/app/installations/${id}/access_tokens`;
    const permissions = PERMISSIONS[scope];
    const answer = await this.api
      .request({
        method: "POST",
        path,
        bearer: this.jwt(),
        body: { repositories: [repo.name], ...(permissions ? { permissions } : {}) },
        cause: tokenCause,
      })
      .catch((error: unknown) => {
        // The installation is gone: a reinstall gives it a new id, which the next call looks up.
        if (error instanceof HostError && error.failure === "not_found")
          this.installations.delete(keyOf(repo));
        throw error;
      });
    const bought = parse(accessToken, answer.body, `POST ${path}`);
    this.secret(bought.token);
    this.tokens.set(tokenKey(repo, scope), { value: bought.token, expiresAt: Date.parse(bought.expires_at) });
    return bought.token;
  }

  private async installation(repo: RepositoryRef): Promise<number> {
    const known = this.installations.get(keyOf(repo));
    if (known !== undefined) return known;
    const path = `/repos/${repo.owner}/${repo.name}/installation`;
    const answer = await this.api
      .request({ path, bearer: this.jwt(), cause: jwtCause })
      .catch((error: unknown) => {
        // GitHub has no installation of the App on a repository it was not added to: say what to do about it. No
        // connection cause: the repository may only have left the installation, which the installation's listing says.
        if (!(error instanceof HostError) || error.failure !== "not_found") throw error;
        throw new HostError(
          "not_found",
          `The GitHub App is not installed on ${keyOf(repo)}: add the repository to the App's installation on GitHub, then try again.`,
        );
      });
    const id = parse(installation, answer.body, `GET ${path}`).id;
    this.installations.set(keyOf(repo), id);
    return id;
  }

  /** A fresh JWT for the App, signed RS256 with its private key. */
  private jwt(): string {
    const jwt = appJwt({ id: this.app.id, key: this.app.privateKey }, this.clock);
    this.secret(jwt);
    return jwt;
  }
}
