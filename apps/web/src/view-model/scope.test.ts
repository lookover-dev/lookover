// Mine and Everyone (ADR 0078): which pull requests are the person's, the tabs that split a list, and what holds the
// tabs while the page is open. Reviews are built by hand.
import { expect, test } from "bun:test";
import {
  type Change,
  changeId,
  commitSha,
  emptyReview,
  type JobState,
  jobId,
  type Repository,
  type ResolvedSettings,
  type Review,
  type ReviewJob,
  repositoryId,
  type SkipReason,
  type Trigger,
} from "@lookover/contracts";
import { inTab, isMine, ListScope, neverAsked, scopeTabs } from "./scope.ts";
import { type ChangeReview, reviewList } from "./select.ts";

const NOW = Date.UTC(2026, 10, 6, 9, 0, 0);
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

const job = (state: JobState, trigger: Trigger, skip: SkipReason | null = null): ReviewJob => ({
  id: jobId(`job-${state}`),
  sha: HEAD,
  trigger,
  state,
  deferral: null,
  stepIn: null,
  askedBy: null,
  skip,
  cancel: null,
  failure: null,
  turn: null,
});

const ROUND = {
  n: 1,
  sha: HEAD,
  base: null,
  reviewer: "claude" as const,
  secondFind: null,
  confirmer: null,
  confirmFallback: null,
  confirmFailure: null,
  ruledOut: [],
  startedAt: NOW,
  endedAt: NOW,
  raised: 0,
  verifiedFixed: 0,
  open: 0,
  steps: [],
  sessions: [],
};

function item(
  n: number,
  author: Change["author"],
  review: Partial<Review> = {},
  repo: Repository = REPO,
): ChangeReview {
  const id = changeId(`sasensi/ledger-api#${n}`);
  const change: Change = {
    id,
    repoId: REPO.id,
    number: n,
    title: `Change ${n}`,
    openedBy: author === "other" ? "ana" : "sasensi",
    author,
    writtenBy: null,
    headSha: HEAD,
    openedAt: NOW,
    draft: false,
    fork: false,
    newCommits: 0,
  };
  return { change, review: { ...emptyReview(id, NOW), ...review }, repo };
}

const numbers = (items: ChangeReview[]) => items.map((i) => i.change.number);

test("mine: the person's own and their agent's, and another's the person asked about; everyone: every open one", () => {
  const items = [
    item(1, "you"),
    item(2, "agent"),
    item(3, "other"),
    item(4, "other", { job: job("queued", "manual") }),
    item(5, "other", { job: job("done", "comment"), rounds: [ROUND], loop: "settled" }),
    item(6, "other", { job: job("skipped", "opened", "not-yours") }),
    item(7, "other", { job: job("skipped", "opened", "fork") }),
    item(8, "other", { job: job("skipped", "first-review", "not-yours") }),
    item(9, "other", { job: job("skipped", "comment", "codex-not-yours") }),
    item(10, "other", { job: job("cancelled", "push") }),
  ];
  expect(numbers(items.filter(isMine))).toEqual([1, 2, 4, 5, 9]);
  expect(numbers(inTab("mine", items))).toEqual([1, 2, 4, 5, 9]);
  expect(numbers(inTab("everyone", items))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("never asked: another's with no request and no round, an old skip of another's included; never the person's", () => {
  const items = [
    item(1, "you"),
    item(2, "agent", { job: job("skipped", "opened", "draft") }),
    item(3, "other"),
    item(4, "other", { job: job("skipped", "opened", "not-yours") }),
    item(5, "other", { job: job("queued", "manual") }),
    item(6, "other", { rounds: [ROUND], loop: "open" }),
  ];
  expect(numbers(items.filter(neverAsked))).toEqual([3, 4]);
});

test("the tabs: none while only the person's are listed, then Mine and Everyone with their counts", () => {
  const mine = [item(1, "you"), item(2, "agent")];
  expect(scopeTabs(mine, false)).toBeNull();
  const listed = [...mine, item(3, "other"), item(4, "other", { job: job("queued", "manual") })];
  expect(scopeTabs(listed, false)).toEqual([
    { value: "mine", label: "Mine", count: 3 },
    { value: "everyone", label: "Everyone", count: 4 },
  ]);
  // Once shown, they stay: the other's change closed, the counts are the same.
  expect(scopeTabs(mine, true)).toEqual([
    { value: "mine", label: "Mine", count: 2 },
    { value: "everyone", label: "Everyone", count: 2 },
  ]);
});

test("the list's choice is Mine by default, one for both screens, and its tabs are never taken away once shown", () => {
  const scope = new ListScope();
  let heard = 0;
  scope.subscribe(() => heard++);
  expect(scope.get()).toEqual({ scope: "mine", shown: false });
  scope.see([item(1, "you")]);
  expect(scope.get()).toEqual({ scope: "mine", shown: false });
  expect(heard).toBe(0);
  scope.see([item(1, "you"), item(2, "other")]);
  expect(scope.get()).toEqual({ scope: "mine", shown: true });
  scope.choose("everyone");
  expect(scope.get()).toEqual({ scope: "everyone", shown: true });
  // The other's pull request closed: the tabs stay, and so does the choice.
  scope.see([item(1, "you")]);
  scope.choose("mine");
  expect(scope.get()).toEqual({ scope: "mine", shown: true });
  expect(heard).toBe(3);
  // The same value is the same object, so a reader of it doesn't render again for nothing.
  const before = scope.get();
  scope.see([item(1, "you"), item(2, "other")]);
  scope.choose("mine");
  expect(scope.get()).toBe(before);
});

test("Review a pull request…: the person's first, then others', none that runs or waits", () => {
  const items = [
    item(1, "other"),
    item(2, "you"),
    item(3, "other", { job: job("running", "manual") }),
    item(4, "agent", { job: job("queued", "opened") }),
    item(5, "agent"),
    item(6, "other", { job: job("skipped", "opened", "not-yours") }),
  ];
  expect(numbers(reviewList(items))).toEqual([2, 5, 1, 6]);
});

test("Review a pull request…: not another's a request wouldn't review, as its row offers no Review now (ADR 0078)", () => {
  const off = { ...REPO, enabled: false };
  const codex = {
    ...REPO,
    settings: { ...DEFAULTS, reviewers: { ...DEFAULTS.reviewers, value: "codex" as const } },
  };
  const items = [
    item(1, "other", {}, off),
    item(2, "other", {}, codex),
    item(3, "other", { job: job("skipped", "opened", "not-yours") }, codex),
    item(4, "you", {}, off),
    item(5, "you", {}, codex),
    item(6, "other"),
  ];
  expect(numbers(reviewList(items))).toEqual([4, 5, 6]);
});
