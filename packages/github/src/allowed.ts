// The repositories the adapter may use, when it is built with a list (ADR 0041, ADR 0053: `live.json`'s list, the
// sandbox and Lookover's own). Every call checks its repository against the list before any request leaves, and
// refuses any other as not found, the way `FakeGitHost` refuses a repository it doesn't hold; what an installation
// lists is cut to it. Built with no list, nothing is refused: the product's service uses what the App is installed
// on. GitHub's names ignore case, and so does the list.
import { HostError, type RepositoryRef, repositoryName, sameRepository } from "@lookover/contracts";

/** The guard for a list: throws `HostError("not_found")` for any repository the list doesn't hold. */
export type Allowed = (repo: RepositoryRef) => void;

/** Whether the list, if any, holds the repository. */
export const allows = (repositories: readonly RepositoryRef[] | undefined, repo: RepositoryRef): boolean =>
  repositories === undefined || repositories.some((listed) => sameRepository(listed, repo));

export function allowedOnly(repositories: readonly RepositoryRef[] | undefined): Allowed {
  if (repositories === undefined) return () => {};
  const list = repositories.map(repositoryName).join(", ");
  return (repo) => {
    if (allows(repositories, repo)) return;
    throw new HostError(
      "not_found",
      `${repositoryName(repo)} is not on the list of repositories Lookover may use: ${list === "" ? "none" : list}`,
    );
  };
}
