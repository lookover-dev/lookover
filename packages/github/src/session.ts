// A session (ADR 0066, ADR 0073): what intake, the writer and the view see of how the adapter is signed in. A token
// for a repository, who posts, and the App whose checks are Lookover's. The person's session (`user-session.ts`) posts
// as the signed-in person, with one token for every repository (a user token can't be narrowed: a fetch's is the
// ports' one), under the shared App.
import type { RepositoryRef } from "@lookover/contracts";

/** Who Lookover's posts are by: the signed-in person, told by their numeric id, never their login. */
export interface Poster {
  id: number;
  login: string;
}

export interface Session {
  /** GitHub's id of the App: what tells its check runs from another App's. */
  readonly appId: number;
  /**
   * Runs `call` with a token for the repository. A token GitHub no longer takes is the session's to renew; what it
   * can't, it throws as a `HostError`.
   */
  withToken<T>(repo: RepositoryRef, call: (token: string) => Promise<T>): Promise<T>;
  /** Who posts on the repository: the identity of Lookover's posts there. */
  poster(repo: RepositoryRef): Promise<Poster>;
}
