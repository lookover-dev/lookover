// Branded IDs: the identifiers that cross modules, each its own type, so one can't be passed for another.
// A plain string becomes an ID only through its constructor, where it enters: from the Git host, the store,
// a fixture. The constructor checks the little it can and throws on a value that can't be that ID. A change is
// named `<owner>/<name>#<n>` (ADR 0066) by `changeName`, and read back by `changeNameParts`, written once here.
import { type ChangeRef, type RepositoryRef, repositoryName } from "./host.ts";

declare const kind: unique symbol;

/** A string that is known to be an ID of this kind. */
type Id<K extends string> = string & { readonly [kind]: K };

export type ChangeId = Id<"change">;
export type RepositoryId = Id<"repository">;
export type ConnectionId = Id<"connection">;
export type FindingId = Id<"finding">;
export type JobId = Id<"job">;
export type RunId = Id<"run">;
export type CommitSha = Id<"commit">;

function brand<K extends string>(name: string, valid: (value: string) => boolean) {
  const is = (value: string): value is Id<K> => valid(value);
  return (value: string): Id<K> => {
    if (is(value)) return value;
    throw new Error(`"${value}" is not a ${name}`);
  };
}

const named = (value: string) => value.trim() !== "";
const SHA = /^[0-9a-f]{7,40}$/;

export const changeId = brand<"change">("change ID", named);
export const repositoryId = brand<"repository">("repository ID", named);
export const connectionId = brand<"connection">("connection ID", named);
export const findingId = brand<"finding">("finding ID", named);
export const jobId = brand<"job">("job ID", named);
export const runId = brand<"run">("run ID", named);
/** A commit SHA, full or abbreviated: 7 to 40 lowercase hex digits. */
export const commitSha = brand<"commit">("commit SHA", (value) => SHA.test(value));

/**
 * What every name of the repository's changes starts with: its owner and name as GitHub gives them (ADR 0066), so
 * two repositories of one name on two accounts never share one.
 */
export const changePrefixOf = (repo: RepositoryRef): string => `${repositoryName(repo)}#`;

/** A change as Lookover names it, in its ids, its logs and its keys: `<owner>/<name>#<n>`. */
export const changeName = ({ repo, number }: ChangeRef): string => `${changePrefixOf(repo)}${number}`;

/** The id the UI and the store know a change by: its name (`changeName`). */
export const changeIdOf = (repo: RepositoryRef, number: number): ChangeId =>
  changeId(changeName({ repo, number }));

/**
 * A change's name read back: what names its repository, before its last `#` (`<owner>/<name>`, or the name alone
 * that named it before ADR 0066), and its number; null when it ends in no number of a change.
 */
export function changeNameParts(name: string): { repository: string; number: number } | null {
  const at = name.lastIndexOf("#");
  const repository = name.slice(0, at);
  const number = Number(name.slice(at + 1));
  if (at < 1 || !/^\d+$/.test(name.slice(at + 1)) || number < 1) return null;
  return { repository, number };
}

/** The repository an `<owner>/<name>` names (a repository's id); null when it names none. */
export function repositoryRefOf(name: string): RepositoryRef | null {
  const [owner, repo, ...rest] = name.split("/");
  if (owner === undefined || repo === undefined || owner === "" || repo === "" || rest.length > 0)
    return null;
  return { owner, name: repo };
}
