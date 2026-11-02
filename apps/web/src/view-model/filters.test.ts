// All reviews' outcome filters (#270, ADR 0070): which reviews each filter holds, which filters hold nothing and are
// dimmed, and the search box, which narrows the rows but never what can be picked. Reviews are built by hand.
import { expect, test } from "bun:test";
import {
  type Change,
  changeId,
  commitSha,
  emptyReview,
  type JobState,
  jobId,
  type LoopState,
  type Repository,
  type ResolvedSettings,
  type Review,
  type ReviewJob,
  repositoryId,
} from "@lookover/contracts";
import { allReviews } from "./filters.ts";
import type { ChangeReview } from "./select.ts";
import type { Filter } from "./status.ts";

const NOW = Date.UTC(2026, 10, 1, 9, 0, 0);
const HEAD = commitSha("a1f9c2e");

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

const REPO: Repository = {
  id: repositoryId("sasensi/ledger-api"),
  owner: "sasensi",
  name: "ledger-api",
  enabled: true,
  settings: DEFAULTS,
};

const job = (state: JobState): ReviewJob => ({
  id: jobId(`job-${state}`),
  sha: HEAD,
  trigger: "opened",
  state,
  deferral: null,
  stepIn: null,
  skip: state === "skipped" ? "on-open-off" : null,
  cancel: state === "cancelled" ? "closed" : null,
  failure: state === "failed" ? { kind: "review_failed", engine: "claude", detail: "it stopped" } : null,
  turn: null,
});

const done = (loop: LoopState): Partial<Review> => ({ job: job("done"), loop });

/** Each status a row can show, as its review makes it. */
const HOW = {
  "needs-you": done("needs_owner"),
  failed: { job: job("failed") },
  "to-fix": done("open"),
  preview: { ...done("open"), preview: true },
  settled: done("settled"),
  skipped: { job: job("skipped") },
  "not-asked": {},
  cancelled: { job: job("cancelled") },
  waiting: { job: job("queued") },
  running: { job: job("running") },
} satisfies Record<string, Partial<Review>>;
type How = keyof typeof HOW;

function item(n: number, how: How, title = `Change ${n}`): ChangeReview {
  const id = changeId(`sasensi/ledger-api#${n}`);
  const change: Change = {
    id,
    repoId: REPO.id,
    number: n,
    title,
    openedBy: "sasensi",
    author: "you",
    writtenBy: "claude",
    headSha: HEAD,
    openedAt: NOW,
    draft: false,
    fork: false,
    newCommits: 0,
  };
  return { change, review: { ...emptyReview(id, NOW), ...HOW[how] }, repo: REPO };
}

const line = () => "";
const numbers = (items: ChangeReview[], filter: Filter, query = "") =>
  allReviews(items, filter, query, line).rows.map((i) => i.change.number);
const dimmed = (items: ChangeReview[], filter: Filter, query = "") =>
  allReviews(items, filter, query, line)
    .options.filter((o) => o.disabled)
    .map((o) => o.value);

const EVERY_HOW: How[] = [
  "needs-you",
  "failed",
  "to-fix",
  "settled",
  "skipped",
  "not-asked",
  "cancelled",
  "waiting",
  "running",
];
const EVERY = EVERY_HOW.map((how, n) => item(n + 1, how));

test("each filter holds its statuses; waiting and running are only in All", () => {
  expect(numbers(EVERY, "all")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(numbers(EVERY, "needs")).toEqual([1, 2]);
  expect(numbers(EVERY, "open")).toEqual([3]);
  expect(numbers(EVERY, "done")).toEqual([4]);
  expect(numbers(EVERY, "skipped")).toEqual([5, 6, 7]);
});

test("a preview is the owner's to read: in Needs you, not Findings open (ADR 0072)", () => {
  const items = [item(1, "preview"), item(2, "to-fix")];
  expect(numbers(items, "needs")).toEqual([1]);
  expect(numbers(items, "open")).toEqual([2]);
  expect(dimmed([item(1, "preview")], "all")).toEqual(["open", "done", "skipped"]);
});

test("the options keep their order and words whatever they hold", () => {
  expect(allReviews([], "all", "", line).options.map((o) => o.label)).toEqual([
    "All",
    "Needs you",
    "Findings open",
    "Clean or settled",
    "Skipped",
  ]);
});

test("a filter that holds nothing is dimmed; one that holds something is not", () => {
  expect(dimmed(EVERY, "all")).toEqual([]);
  expect(dimmed([item(1, "to-fix"), item(2, "cancelled")], "all")).toEqual(["needs", "done"]);
});

test("a review waiting or running alone leaves every filter but All dimmed", () => {
  expect(dimmed([item(1, "waiting"), item(2, "running")], "all")).toEqual([
    "needs",
    "open",
    "done",
    "skipped",
  ]);
});

test("All is never dimmed, even with no review at all", () => {
  expect(dimmed([], "all")).toEqual(["needs", "open", "done", "skipped"]);
});

test("the selected filter is never dimmed, even once it holds nothing", () => {
  const left = [item(1, "settled")];
  expect(dimmed(left, "open")).toEqual(["needs", "skipped"]);
  expect(numbers(left, "open")).toEqual([]);
});

test("the search box narrows the rows but never what can be picked", () => {
  const items = [item(1, "to-fix", "Fix the rounding"), item(2, "skipped", "Bump the lockfile")];
  expect(numbers(items, "all", "rounding")).toEqual([1]);
  expect(dimmed(items, "all", "rounding")).toEqual(["needs", "done"]);
  expect(dimmed(items, "all", "nothing matches this")).toEqual(["needs", "done"]);
});

test("the search reads the title, the number, the author and the status line, in any case", () => {
  const items = [item(148, "to-fix", "Fix the Ledger")];
  expect(numbers(items, "all", "  LEDGER ")).toEqual([148]);
  expect(numbers(items, "all", "#148")).toEqual([148]);
  expect(allReviews(items, "all", "two findings", () => "Two findings open").rows).toHaveLength(1);
  expect(numbers(items, "all", "codex")).toEqual([]);
});
