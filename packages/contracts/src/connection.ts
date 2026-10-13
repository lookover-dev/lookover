// The connection to the Git host: GitHub in v1, through the owner's own App and its bot (ADR 0008, ADR 0030,
// ADR 0053): the App, its installation on the App's account (the owner's own, or an organisation's, ADR 0059), and
// why GitHub can't be used when it can't.
import type { GhChoices } from "./gh.ts";
import type { HostAccount, HostLogin } from "./github-app.ts";
import type { ConnectionId } from "./ids.ts";

/**
 * Why the connection can't be used (ADR 0053), each with one fix the app offers. `unreachable`: GitHub could not be
 * reached or answered with an error of its own ("Reconnect GitHub"). `uninstalled`: the App is no longer installed on
 * its account, or its installation is `suspended` ("Install it on GitHub", a link to the install page, or to
 * the installation's settings when suspended). `key-refused`: GitHub refused the App's key; `why` is what GitHub
 * named, when it did: a key revoked on GitHub, the App deleted, or the computer's clock too far off ("Add a new
 * key"). `key-lost`: the key Lookover kept no longer opens, its keychain entry gone ("Add a new key" too).
 * `not-a-member`: the person's own `gh` says they are no longer an active member of `organisation` (its login), the
 * organisation whose App it is (ADR 0059): the App still works, but Lookover runs for that person, so reviews stop
 * until an admin adds them back ("Check again", `gh.check`) or another App is set up.
 */
export type ConnectionCause =
  | { kind: "unreachable" }
  | { kind: "uninstalled"; suspended: boolean }
  | { kind: "key-refused"; why: KeyRefusal | null }
  | { kind: "key-lost" }
  | { kind: "not-a-member"; organisation: string };

/** What GitHub said of a key it refused, when it said. */
export type KeyRefusal = "revoked" | "app-deleted" | "clock";

/** The owner's App, as the app shows and links to it: never its key. */
export interface ConnectionApp {
  /** GitHub's id of the App, the one "Use an existing App" asks for. */
  id: number;
  /** Its slug: the bot is `<slug>[bot]`, and `lookover wait` takes it as `LOOKOVER_APP`. */
  slug: string;
  /**
   * The account the App belongs to (ADR 0059): the owner's own, or an organisation's. Its settings pages, and its
   * installation's, are on it (`githubLinks`).
   */
  account: HostAccount;
  /**
   * The owner: the person Lookover works for, whose changes, requests and replies are theirs (ADR 0059). On a
   * personal account, the account itself.
   */
  person: HostLogin;
}

export interface Connection {
  /** Null until the bot is installed. */
  id: ConnectionId | null;
  state: "not-connected" | "connected" | "disconnected";
  /** Why it is `disconnected`; null in every other state. */
  cause: ConnectionCause | null;
  bot: string | null;
  /** The App once one is created or given; null before. */
  app: ConnectionApp | null;
  /** The App's installation on its account, once installed: what its settings link names. */
  installationId: number | null;
  /**
   * GitHub's web address, every link to GitHub is built from (`githubLinks`): `GITHUB_WEB` in live mode; in demo mode
   * the service's own fake of it (`DEMO_API.github`), so nothing the demo shows opens github.com.
   */
  web: string;
  since: number;
  /**
   * Until when the host asked Lookover to wait (its rate limit, ADR 0043): nothing is read from it before then.
   * Null when it asks nothing.
   */
  limitUntil: number | null;
  /**
   * The person's own `gh` as last read (ADR 0059): who it is signed in as and the organisations where they are an
   * admin, the places "Create your App" offers beside your own account. Null until read: the setup's GitHub step
   * asks for it (`gh.check`, its Check again), and "Create it on GitHub" on an organisation reads it again.
   */
  gh: GhChoices | null;
}
