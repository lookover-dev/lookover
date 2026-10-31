// A session (ADR 0066): what intake, the writer and the view see of how the adapter is signed in. A token for a
// repository, who posts, and the App whose checks are Lookover's. The App's session (`auth.ts`) buys a token per
// repository and posts as the App's bot; a person's session posts as the signed-in person, with one token for every
// repository, under the shared App. A person's session ignores `scope`: a user token can't be narrowed, so a
// fetch's is the ports' one.
import type { RepositoryRef } from "@lookover/contracts";

/** What a token may do: the ports' own, or a fetch's (read the contents, nothing more). */
export type TokenScope = "ports" | "fetch";

/**
 * Who Lookover's posts are by: the App's bot (`bot`, its login `<slug>[bot]`), or the signed-in person, told by their
 * numeric id, never their login.
 */
export interface Poster {
  id: number;
  login: string;
  bot: boolean;
}

export interface Session {
  /** GitHub's id of the App: what tells its check runs from another App's. */
  readonly appId: number;
  /**
   * Runs `call` with a token for the repository, of that scope (`ports` when not given; a person's session has one
   * token, whatever the scope). A token GitHub no longer takes is the session's to renew; what it can't, it throws
   * as a `HostError`.
   */
  withToken<T>(repo: RepositoryRef, call: (token: string) => Promise<T>, scope?: TokenScope): Promise<T>;
  /** Who posts on the repository: the identity of Lookover's posts there. */
  poster(repo: RepositoryRef): Promise<Poster>;
}
