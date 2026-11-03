// `FakeGitHost` lagging as GitHub does after a write (ADR 0069), for the HostWriter and HostIntake suites' runs in
// `bun run check`: the App's reads made before a write answer stale for a few reads after it. With the patience every
// port suite's fake runs take, the AgentHost suite's too: at once, or waiting out the lag.
import type { HostIntake, HostWriter } from "@lookover/contracts";
import { FakeGitHost, type Lagging, lagging, type Patience } from "./index.ts";

/** The fakes' patience: they show a write on the next read, so one read, no pause. */
export const AT_ONCE: Readonly<Patience> = { boundMs: 0, pauseMs: 0 };
/** The lagging host's lag, and the patience that waits it out: a few ms, so `bun run check` stays fast. */
export const LAG = 2;
export const LAGGING_PATIENCE: Readonly<Patience> = { boundMs: 500, pauseMs: 1 };

/** Each of the writer's calls, read or write: a call the port gains must be sorted here, or this fails to compile. */
const WRITER_CALLS = {
  createCheck: "write",
  findCheck: "read",
  updateCheck: "write",
  completeCheck: "write",
  publishReview: "write",
  findReview: "read",
  upsertStatus: "write",
  react: "write",
  reply: "write",
  minimize: "write",
} as const satisfies Record<keyof HostWriter, "read" | "write">;

/**
 * Each of the intake's calls, read or write. `fetchSpec` reads, but its answer holds a function (`credentials`), which
 * can't be remembered to be answered again: nothing the suites write changes it, so it is never lagged.
 */
const INTAKE_CALLS = {
  listOpenChanges: "read",
  listComments: "read",
  getChange: "read",
  threads: "read",
  poster: "read",
  countCommits: "read",
  fetchSpec: "unlagged",
} as const satisfies Record<keyof HostIntake, "read" | "unlagged">;

const isFakeCall = (call: string): call is keyof FakeGitHost => call in FakeGitHost.prototype;
/** A read the fake doesn't have would never be lagged: it throws, so the runs can't pass without it. */
const fakeCall = (call: string): keyof FakeGitHost => {
  if (!isFakeCall(call)) throw new Error(`FakeGitHost has no ${call} to lag`);
  return call;
};
const readsOf = (calls: Record<string, string>): (keyof FakeGitHost)[] =>
  Object.entries(calls)
    .filter(([, kind]) => kind === "read")
    .map(([call]) => fakeCall(call));

/**
 * The App's reads a lagging host answers stale after a write: the writer's, the intake's, the fake's `view`, and the
 * description `upsertStatus` reads before it writes.
 */
const LAGGED: readonly (keyof FakeGitHost)[] = [
  ...readsOf(WRITER_CALLS),
  ...readsOf(INTAKE_CALLS),
  "view",
  "description",
];

/**
 * `fake` lagging: after any write through the returned port (the writer's posts, the fixture's seeding, a push), each
 * of the App's reads made before it answers as it last did for its next `lag` reads, the description `upsertStatus`
 * reads included, as GitHub's does. `fetchSpec` passes through.
 */
export const laggingGitHost = (fake: FakeGitHost, lag: number): Lagging<FakeGitHost> => {
  const lagged = lagging(fake, LAGGED, lag);
  const upsertStatus: FakeGitHost["upsertStatus"] = (change, render) =>
    fake
      .upsertStatusReading(change, render, () => lagged.port.description(change))
      .then(() => lagged.wrote());
  return {
    ...lagged,
    port: new Proxy(lagged.port, {
      get(target, name, receiver) {
        // `fetchSpec` reads and holds a function: past the proxy, so it is neither remembered nor counted as a write.
        if (name === "fetchSpec") return fake.fetchSpec.bind(fake);
        if (name === "upsertStatus") return upsertStatus;
        return Reflect.get(target, name, receiver);
      },
    }),
  };
};
