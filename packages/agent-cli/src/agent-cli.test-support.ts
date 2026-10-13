// What `lookover`'s tests share: one pull request on a `FakeGitHost`, the agent's side of it, a local checkout
// whose head the test sets, a clock that `sleep` moves, and the App's moves scheduled at a time (`at`), played
// when the clock passes it. Nothing waits on the wall clock.
import {
  type ChangeRef,
  type CheckConclusion,
  type CommitSha,
  commitSha,
  FINDING_MARKER,
  HostError,
  type OpenCheckStatus,
  REPLY_MARKER,
  RESULT_MARKER,
  REVIEW_MARKER,
  REVIEW_RESULT_SCHEMA,
  type RepositoryRef,
  type ReviewResult,
  type ReviewResultFinding,
} from "@lookover/contracts";
import { type FakeChange, FakeGitHost } from "@lookover/testkit";
import { run, type World } from "./index.ts";

const repo: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
export const ref: ChangeRef = { repo, number: 7 };
export const sha = commitSha("5d9114c0a1b2c3d4e5f60718293a4b5c6d7e8f9a");
export const earlier = commitSha("4c8003b0a1b2c3d4e5f60718293a4b5c6d7e8f9a");
export const newer = commitSha("6eaa25d0a1b2c3d4e5f60718293a4b5c6d7e8f9a");
export const owner = { id: 1234567, login: "sasensi" };
const bot = { id: 338297044, login: "lookover-spike-sasensi[bot]" };
/** The App's slug, as `--app` or `LOOKOVER_APP` name it. */
export const APP = "lookover-spike-sasensi";
export const BRANCH = "feature/unpaid";
const START = Date.parse("2026-10-07T12:00:00Z");
/** `ms` past the start, as the result block writes a time. */
export const iso = (ms: number) => new Date(START + ms).toISOString();

const change: FakeChange = {
  number: 7,
  title: "Add unpaid filter",
  url: "https://github.com/sasensi/lookover-sandbox/pull/7",
  author: owner,
  draft: false,
  head: { ref: BRANCH, sha },
  base: { ref: "main", sha: commitSha("0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3") },
  diff: [{ path: "src/invoice.ts", side: "head", from: 2, to: 21 }],
};

const WAITING = { title: "Waiting for its turn", summary: "Queued.", text: "The result comes at the end." };

/** A finding of the result, needing the agent unless told otherwise. */
export function finding(id: string, overrides: Partial<ReviewResultFinding> = {}): ReviewResultFinding {
  return {
    id,
    fingerprints: { location: `loc-${id}`, meaning: `meaning-${id}` },
    status: "open",
    posted: true,
    placement: "inline",
    needs_action_by: "agent",
    severity: "blocking",
    category: "correctness",
    title: `Finding ${id}`,
    body: `What ${id} is about.`,
    location: { path: "src/invoice.ts", start_line: 12, end_line: 12, side: "head", sha },
    raised: { round: 1, sha },
    confirmation: { verdict: "confirmed", by: "codex", reason: `${id} holds.`, evidence: [] },
    ...overrides,
  };
}

/** A result block for the commit: a done round that tells the agent to stop, unless told otherwise. */
export function result(overrides: {
  run?: Partial<ReviewResult["run"]>;
  verdict?: ReviewResult["verdict"];
  loop?: Partial<ReviewResult["loop"]>;
  findings?: ReviewResultFinding[];
}): ReviewResult {
  return {
    schema: REVIEW_RESULT_SCHEMA,
    change: { host: "github", repository: "sasensi/lookover-sandbox", number: 7, head_sha: sha },
    run: { id: "r1", state: "done", trigger: "comment", ruled_out: 0, ...overrides.run },
    verdict: overrides.verdict ?? { value: "clean", conclusion: "success" },
    loop: { state: "settled", round: 1, next_action: "stop", ...overrides.loop },
    counts: {
      open: { blocking: 0, should_fix: 0, consider: 0 },
      escalated: 0,
      verified_fixed: 0,
      withdrawn: 0,
      acknowledged: 0,
      dismissed: 0,
      obsolete: 0,
      kept_in_app: 0,
    },
    findings: overrides.findings ?? [],
    truncated: false,
  };
}

/** A completed check's text: a line for people, then the result block. */
const textOf = (r: ReviewResult) => `Round 1.\n\n${RESULT_MARKER}${JSON.stringify(r)} -->`;

/**
 * The command's world on a fake host holding change #7; `fork`: #7 comes from a fork; `mayResolve: false`: the
 * agent's token may not resolve a thread; `refuse`: GitHub refuses to read the threads, or to resolve one, in
 * these words.
 */
export function world(
  options: {
    env?: Record<string, string | undefined>;
    fork?: boolean;
    mayResolve?: boolean;
    refuse?: { threads?: string; resolve?: string };
  } = {},
) {
  let now = START;
  const clock = { now: () => now };
  const fake = new FakeGitHost({ repo, bot, changes: [{ ...change, fork: options.fork ?? false }], clock });
  const local: { head: CommitSha; branch: string | null } = { head: sha, branch: BRANCH };
  const due: { at: number; act: () => Promise<unknown> | unknown }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  /** The App's checks the test made, by name. */
  const made = new Map<string, string>();

  const w: World = {
    host: () => {
      const agent = fake.asAgent(owner, { mayResolve: options.mayResolve ?? true });
      const { threads, resolve } = options.refuse ?? {};
      return Promise.resolve({
        ...agent,
        ...(threads === undefined
          ? {}
          : { threads: () => Promise.reject(new HostError("invalid", threads)) }),
        ...(resolve === undefined
          ? {}
          : { resolve: () => Promise.reject(new HostError("invalid", resolve)) }),
      });
    },
    git: {
      head: () => Promise.resolve(local.head),
      branch: () => Promise.resolve(local.branch),
      origin: () => Promise.resolve(repo),
    },
    env: options.env ?? { LOOKOVER_APP: APP },
    clock,
    sleep: async (ms) => {
      const until = now + ms;
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        const next = due[0];
        if (!next || next.at > until) break;
        due.shift();
        now = Math.max(now, next.at);
        await next.act();
      }
      now = until;
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };

  return {
    fake,
    local,
    out,
    err,
    /** Runs `lookover` with these arguments; its exit code. */
    lookover: (...argv: string[]) => run(argv, w),
    /** Plays `act` once the clock is `ms` past the start. */
    at(ms: number, act: () => Promise<unknown> | unknown): void {
      due.push({ at: START + ms, act });
    },
    /** How long since the start, in ms. */
    elapsed: () => now - START,
    /** The App creates its check on `on` (the commit by default), as `name`. */
    async check(name: string, status: OpenCheckStatus, on: CommitSha = sha): Promise<void> {
      made.set(name, await fake.createCheck(repo, on, status, WAITING, "job-1"));
    },
    /** The App completes its check `name` with the result block. */
    async complete(name: string, conclusion: CheckConclusion, r: ReviewResult): Promise<void> {
      const id = made.get(name);
      if (id === undefined) throw new Error(`No check ${name} made by this test`);
      await fake.completeCheck(repo, id, conclusion, { title: "Done", summary: "Round 1.", text: textOf(r) });
    },
    /**
     * The App's review on the commit, one inline comment per finding on `src/invoice.ts` from line 12 down, each
     * holding its finding marker. Returns the root comments' ids, in the findings' order.
     */
    async review(...findings: string[]): Promise<number[]> {
      await fake.publishReview(ref, {
        sha,
        body: `Round 1.\n${REVIEW_MARKER}r1 -->`,
        comments: findings.map((id, i) => ({
          path: "src/invoice.ts",
          side: "head" as const,
          line: 12 + i,
          endLine: null,
          body: `${id} is wrong.\n${FINDING_MARKER}${JSON.stringify({ id })} -->`,
        })),
      });
      const roots = (await fake.asAgent(owner).threads(ref, APP)).map((t) => t.commentId);
      return roots.slice(-findings.length);
    },
    /** The agent's reply on the thread of `root`, now by the host's clock. Returns its id. */
    agentReply: (root: number, body: string) => fake.seedReply(ref, root, { author: owner, body }),
    /** Lookover's reply on the thread of `root`, with its marker, now by the host's clock. */
    appReply: (root: number, body: string) =>
      fake.seedReply(ref, root, {
        author: bot,
        body: `${body}\n${REPLY_MARKER}{"v":1} -->`,
      }),
    /** Lookover's threads as the agent reads them now. */
    threads: () => fake.asAgent(owner).threads(ref, APP),
    /** The comments on the pull request now. */
    comments: () => fake.view(ref).comments,
    /** What `--json` printed, parsed. */
    json: (): unknown => JSON.parse(out.join("\n")),
  };
}
