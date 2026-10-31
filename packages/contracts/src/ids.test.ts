// Branded IDs: two kinds of ID never mix, and a value that can't be an ID is refused where it enters.
import { expect, test } from "bun:test";
import {
  type ChangeId,
  type CommitSha,
  type ConnectionId,
  changeId,
  changeIdOf,
  changeName,
  changeNameParts,
  changePrefixOf,
  commitSha,
  connectionId,
  type FindingId,
  findingId,
  type JobId,
  jobId,
  type RepositoryId,
  type RunId,
  repositoryId,
  repositoryRefOf,
  runId,
} from "./index.ts";

test("mixing two kinds of ID is a type error", () => {
  const change = changeId("ledger-api#148");
  const repository = repositoryId("sam/ledger-api");
  // Each line below must fail to compile; `tsc` reports an unused expectation if one ever compiles.
  // @ts-expect-error: a change ID is not a repository ID
  const asRepository: RepositoryId = change;
  // @ts-expect-error: a repository ID is not a change ID
  const asChange: ChangeId = repository;
  // @ts-expect-error: a plain string is not an ID until its constructor says so
  const fromString: FindingId = "148-key-in-log";
  // @ts-expect-error: a job is not a run
  const asRun: RunId = jobId("job-1");
  // @ts-expect-error: a run is not a job
  const asJob: JobId = runId("run-1");
  // @ts-expect-error: a connection ID is not a commit
  const asSha: CommitSha = connectionId("github:sam");
  // @ts-expect-error: a commit is not a connection
  const asConnection: ConnectionId = commitSha("a1f9c2e");
  // An ID is still a string wherever a string is read.
  const text: string = change;
  expect([asRepository, asChange, fromString, asRun, asJob, asSha, asConnection, text]).toHaveLength(8);
});

test("an ID keeps its value", () => {
  expect(String(changeId("ledger-api#148"))).toBe("ledger-api#148");
  expect(String(findingId("148-key-in-log"))).toBe("148-key-in-log");
  expect(String(commitSha("a1f9c2e"))).toBe("a1f9c2e");
});

test("an empty ID is refused", () => {
  expect(() => changeId("")).toThrow('"" is not a change ID');
  expect(() => repositoryId("  ")).toThrow("is not a repository ID");
});

test("a commit SHA is 7 to 40 lowercase hex digits", () => {
  expect(commitSha("9f8e7d6a1b2c3d4e5f60718293a4b5c6d7e8f901")).toHaveLength(40);
  for (const bad of ["a1f9c2", "A1F9C2E", "main", "a1f9c2g"]) {
    expect(() => commitSha(bad)).toThrow("is not a commit SHA");
  }
});

test("a change is named by its repository's owner and name and its number, and read back", () => {
  const change = { repo: { owner: "lookover-dev", name: "ledger-api" }, number: 148 };
  expect(changeName(change)).toBe("lookover-dev/ledger-api#148");
  expect(changePrefixOf(change.repo)).toBe("lookover-dev/ledger-api#");
  expect(String(changeIdOf(change.repo, 148))).toBe("lookover-dev/ledger-api#148");
  expect(changeNameParts("lookover-dev/ledger-api#148")).toEqual({
    repository: "lookover-dev/ledger-api",
    number: 148,
  });
  // Before ADR 0066 a change was named by its repository's name alone: read as written.
  expect(changeNameParts("ledger-api#148")).toEqual({ repository: "ledger-api", number: 148 });
  for (const bad of ["ledger-api", "ledger-api#", "ledger-api#0", "ledger-api#1.5", "#3"])
    expect(changeNameParts(bad)).toBeNull();
});

test("a repository is read from its owner and name", () => {
  expect(repositoryRefOf("lookover-dev/ledger-api")).toEqual({ owner: "lookover-dev", name: "ledger-api" });
  for (const bad of ["ledger-api", "/ledger-api", "lookover-dev/", "a/b/c"])
    expect(repositoryRefOf(bad)).toBeNull();
});
