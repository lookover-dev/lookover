// The adapter's composition: one session (the person's, or one given), one API client, the ports over them.
import {
  type ChangeRef,
  type Clock,
  type CommitSha,
  GITHUB_WEB,
  type HostAccounts,
  type HostIntake,
  type HostSignIn,
  type HostView,
  type HostWriter,
  type RepositoryRef,
  type SignInKeeper,
} from "@lookover/contracts";
import { createAccounts } from "./accounts.ts";
import { allowedOnly } from "./allowed.ts";
import { type Deadline, type Fetch, GitHubApi, type RateLimit, realWaits, type Waits } from "./api.ts";
import { createIntake } from "./intake.ts";
import { parse, repository } from "./schemas.ts";
import type { Session } from "./session.ts";
import { createSignIn } from "./sign-in.ts";
import { UserSession } from "./user-session.ts";
import { createView } from "./view.ts";
import { createWriter } from "./writer.ts";

/** An account on the host, by the id that tells it apart and the login people read. */
export interface Account {
  id: number;
  login: string;
}

/**
 * Who the snapshot shows: the repository's owner (their changes are "you") and who posts, the session's poster: the
 * person signed in to the shared App (ADR 0066).
 */
export interface Identity {
  owner: Account;
  poster: Account;
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
  /** GitHub's web address, where the sign-in's OAuth endpoints are: `GITHUB_WEB` when not given. */
  web?: string;
  /** The time, for token renewal and for when GitHub said to retry. The real clock when not given. */
  clock?: Clock;
  /** The HTTP client, for tests. `globalThis.fetch` when not given. */
  fetch?: Fetch;
  /**
   * A pause of `ms`, for tests: between two tries of a request that failed on the way (1 s, then 3 s, ADR 0080), and
   * the status block's write's second between two reads while GitHub's read lags (ADR 0069), measured on `clock`. A
   * real timer when not given.
   */
  sleep?(ms: number): Promise<void>;
  /**
   * A try's time limit of `ms`, for tests: a signal that aborts when it runs out, and how to clear it once the try is
   * over (ADR 0080). A real timer, cleared at the try's end, when not given.
   */
  deadline?(ms: number): Deadline;
  /**
   * Given each secret the adapter holds, as it comes to hold it and before any request carries it: a device code, each
   * token and refresh token of the person's. The service's log removes them (ADR 0054). Nobody is told when not given.
   */
  secret?(value: string): void;
}

/**
 * How the adapter is signed in (ADR 0066, ADR 0073): as the person signed in to the shared App (`keeper`: where their
 * sign-in is kept, read and renewed there; one token for every repository, posting as them), or on a session made
 * elsewhere (`session`).
 */
export type GitHubOptions = HostOptions & ({ keeper: SignInKeeper } | { session: Session });

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
  /** The repository's owner and who posts, as the live snapshot shows them. */
  identity(repo: RepositoryRef): Promise<Identity>;
}

function apiOf(options: HostOptions): { api: GitHubApi; clock: Clock; waits: Waits } {
  const clock = options.clock ?? { now: () => Date.now() };
  const waits = { sleep: options.sleep ?? realWaits.sleep, deadline: options.deadline ?? realWaits.deadline };
  const api = new GitHubApi(
    options.fetch ?? ((input, init) => fetch(input, init)),
    clock,
    options.api,
    waits,
  );
  return { api, clock, waits };
}

/** Signing a person in to the shared App (contracts' `HostSignIn`): the device flow and the refresh. */
export function createHostSignIn(options: HostOptions): HostSignIn {
  const { api, clock, waits } = apiOf(options);
  return signInOf(options, api, clock, waits);
}

function signInOf(options: HostOptions, api: GitHubApi, clock: Clock, waits: Waits): HostSignIn {
  return createSignIn({
    api,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    web: options.web ?? GITHUB_WEB,
    clock,
    waits,
    secret: options.secret ?? (() => {}),
  });
}

/**
 * What the person whose sign-in `keeper` keeps reaches through the shared App (contracts' `HostAccounts`, ADR 0066):
 * their sign-in read and renewed as the person's session does it.
 */
export function createHostAccounts(options: HostOptions & { keeper: SignInKeeper }): HostAccounts {
  const { api, clock, waits } = apiOf(options);
  const secret = options.secret ?? (() => {});
  const session = new UserSession(signInOf(options, api, clock, waits), options.keeper, clock, secret);
  return createAccounts(api, session, options.repositories);
}

export function createGitHub(options: GitHubOptions): GitHub {
  const { api, clock, waits } = apiOf(options);
  const secret = options.secret ?? (() => {});
  const session =
    "keeper" in options
      ? new UserSession(signInOf(options, api, clock, waits), options.keeper, clock, secret)
      : options.session;
  const allowed = allowedOnly(options.repositories);
  return {
    intake: createIntake(api, session, allowed),
    writer: createWriter(api, session, allowed, { clock, sleep: waits.sleep }),
    rateLimit: () => api.rateLimit(),
    view: createView(api, session, allowed),
    async identity(repo) {
      allowed(repo);
      const path = `/repos/${repo.owner}/${repo.name}`;
      const owner = await session.withToken(repo, async (token) =>
        parse(repository, (await api.request({ path, bearer: token })).body, `GET ${path}`),
      );
      const { id, login } = await session.poster(repo);
      return { owner: { id: owner.owner.id, login: owner.owner.login }, poster: { id, login } };
    },
  };
}
