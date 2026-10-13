// Branded IDs: the identifiers that cross modules, each its own type, so one can't be passed for another.
// A plain string becomes an ID only through its constructor, where it enters: from the Git host, the store,
// a fixture. The constructor checks the little it can and throws on a value that can't be that ID.
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
