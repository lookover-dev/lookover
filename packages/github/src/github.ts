// The adapter's composition: one App session, one API client, the two ports over them.
import type {
  ChangeRef,
  Clock,
  CommitSha,
  HostInstallations,
  HostIntake,
  HostView,
  HostWriter,
  RepositoryRef,
} from "@lookover/contracts";
import { allowedOnly } from "./allowed.ts";
import { type Fetch, GitHubApi, type RateLimit } from "./api.ts";
import { AppSession } from "./auth.ts";
import { createInstallations } from "./installations.ts";
import { createIntake } from "./intake.ts";
import { parse, repository } from "./schemas.ts";
import { createView } from "./view.ts";
import { createWriter } from "./writer.ts";

/** An account on the host, by the id that tells it apart and the login people read. */
export interface Account {
  id: number;
  login: string;
}

/** Who the snapshot shows: the repository's owner (their changes are "you") and the App's bot (the reviewer). */
export interface Identity {
  owner: Account;
  bot: Account;
}

/** The App as the live config gives it: its id and the PEM text of its private key. */
export interface AppCredentials {
  id: number;
  /** The private key's PEM text. Read from the key file by config code; never logged. */
  privateKey: string;
}

/** How the adapter reaches GitHub, and what it may use there. */
export interface HostOptions {
  /**
   * The repositories the adapter may use (`live.json`'s list). Given, any other is refused, as not found, before a
   * request leaves, and an installation's listing is cut to it; not given, nothing is refused (ADR 0053).
   */
  repositories?: readonly RepositoryRef[];
  /** GitHub's API address, `https://api.github.com` when not given: a stub's in tests and demo mode. */
  api?: string;
  /** The time, for token renewal and for when GitHub said to retry. The real clock when not given. */
  clock?: Clock;
  /** The HTTP client, for tests. `globalThis.fetch` when not given. */
  fetch?: Fetch;
  /**
   * Given each secret the adapter holds, as it comes to hold it and before any request carries it: the App's key, each
   * JWT it signs, each installation token it buys, a manifest's code and the key it converts to. The service's log
   * removes them (ADR 0054). Nobody is told when not given.
   */
  secret?(value: string): void;
}

export interface GitHubOptions extends HostOptions {
  app: AppCredentials;
}

export interface GitHub {
  intake: HostIntake;
  writer: HostWriter;
  /** The rate-limit headers of the last answer read; `null` before the first. */
  rateLimit(): RateLimit | null;
  /**
   * What GitHub shows for the change now: the checks of `commit` (the head's when none is named), the reviews
   * with their comments, the conversation.
   */
  view(change: ChangeRef, commit?: CommitSha): Promise<HostView>;
  /** The repository's owner and the App's bot, as the live snapshot shows them. */
  identity(repo: RepositoryRef): Promise<Identity>;
}

function apiOf(options: HostOptions): { api: GitHubApi; clock: Clock } {
  const clock = options.clock ?? { now: () => Date.now() };
  const api = new GitHubApi(options.fetch ?? ((input, init) => fetch(input, init)), clock, options.api);
  return { api, clock };
}

/** The App level of GitHub (contracts' `HostInstallations`): the credentials come with each call. */
export function createHostInstallations(options: HostOptions): HostInstallations {
  const { api, clock } = apiOf(options);
  return createInstallations(api, clock, options.repositories, options.secret ?? (() => {}));
}

export function createGitHub(options: GitHubOptions): GitHub {
  const { api, clock } = apiOf(options);
  const session = new AppSession(api, options.app, clock, options.secret ?? (() => {}));
  const allowed = allowedOnly(options.repositories);
  return {
    intake: createIntake(api, session, allowed),
    writer: createWriter(api, session, allowed),
    rateLimit: () => api.rateLimit(),
    view: createView(api, session, allowed),
    async identity(repo) {
      allowed(repo);
      const path = `/repos/${repo.owner}/${repo.name}`;
      const owner = await session.withToken(repo, async (token) =>
        parse(repository, (await api.request({ path, bearer: token })).body, `GET ${path}`),
      );
      const bot = await session.botUser(repo);
      return { owner: { id: owner.owner.id, login: owner.owner.login }, bot };
    },
  };
}
