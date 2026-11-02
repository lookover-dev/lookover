// Setup's First review list (#425, ADR 0070): which pull requests it offers, which of them Lookover already reviewed
// on their head, what is picked, and what the step says when nothing is left to pick. Snapshots are built by hand.
import { expect, test } from "bun:test";
import {
  apply,
  type Change,
  changeId,
  commitSha,
  type Engine,
  type EngineId,
  emptyReview,
  GITHUB_WEB,
  type JobState,
  jobId,
  type ResolvedSettings,
  type Review,
  type ReviewJob,
  type Round,
  repositoryId,
  type State,
} from "@lookover/contracts";
import {
  firstReviewCandidates,
  firstReviewPick,
  firstReviewPrimary,
  firstReviewRows,
  firstReviewSecondary,
  NONE_LEFT,
  noneLeft,
  REVIEWED_CHIPS,
  reviewedLine,
  reviewedLines,
} from "./first-review.ts";

const NOW = Date.UTC(2026, 9, 31, 21, 42, 0);
const MIN = 60_000;
const HEAD = commitSha("a1f9c2e");
const OLDER = commitSha("0b7d3e1");

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

function engine(id: EngineId, name: string): Engine {
  return {
    id,
    name,
    cli: id,
    version: "1.0.0",
    state: "ready",
    detail: "",
    unusable: null,
    since: NOW,
    limitUntil: null,
    signingIn: false,
  };
}

const job = (state: JobState, sha = HEAD): ReviewJob => ({
  id: jobId(`job-${state}`),
  sha,
  trigger: "opened",
  state,
  deferral: null,
  stepIn: null,
  skip: state === "skipped" ? "on-open-off" : null,
  cancel: state === "cancelled" ? "closed" : null,
  failure: state === "failed" ? { kind: "review_failed", engine: "claude", detail: "it stopped" } : null,
  turn: null,
});

const round = (sha = HEAD): Round => ({
  n: 1,
  sha,
  reviewer: "claude",
  secondFind: null,
  confirmer: null,
  confirmFallback: null,
  confirmFailure: null,
  ruledOut: [],
  startedAt: NOW - 3 * MIN,
  endedAt: NOW - MIN,
  raised: 0,
  verifiedFixed: 0,
  open: 0,
  steps: [],
  sessions: [],
});

/** How far each pull request's review went, as the snapshot shows it. */
const REVIEWS = {
  none: {},
  /** Reviewed by itself on its head: a round posted, its job done. */
  posted: { job: job("done"), loop: "settled", rounds: [round()] },
  /** The same, its findings left to fix. */
  postedToFix: { job: job("done"), loop: "open", rounds: [round()] },
  /** The same, a finding waiting on the person. */
  postedNeedsYou: { job: job("done"), loop: "needs_owner", rounds: [round()] },
  /** A round posted on an older commit, and a commit pushed since. */
  pushed: { job: job("done", OLDER), loop: "settled", rounds: [round(OLDER)] },
  /** The round on its head was a preview: nothing was posted. */
  preview: { job: job("done"), loop: "settled", rounds: [round()], preview: true },
  /** Its first round runs now. */
  running: { job: job("running") },
  failed: { job: job("failed") },
  skipped: { job: job("skipped") },
  cancelled: { job: job("cancelled") },
} satisfies Record<string, Partial<Review>>;
type Reviewed = keyof typeof REVIEWS;

const id = (n: number) => changeId(`sasensi/ledger-api#${n}`);

function change(n: number): Change {
  return {
    id: id(n),
    repoId: repositoryId("sasensi/ledger-api"),
    number: n,
    title: `Change ${n}`,
    openedBy: "sasensi",
    author: "you",
    writtenBy: "claude",
    headSha: HEAD,
    openedAt: NOW - 60 * MIN,
    draft: false,
    fork: false,
    newCommits: 0,
  };
}

/** Setup on First review, the owner's ledger-api on, its pull requests as given, the newest update first. */
function world(prs: [number, Reviewed][]): State {
  const changes: State["changes"] = {};
  const reviews: State["reviews"] = {};
  prs.forEach(([n, how], i) => {
    changes[id(n)] = change(n);
    reviews[id(n)] = { ...emptyReview(id(n), NOW - i * MIN), ...REVIEWS[how] };
  });
  return {
    seq: 0,
    now: NOW,
    setup: {
      done: false,
      step: "first-review",
      reached: "first-review",
      github: "done",
      githubRefused: null,
      firstReviewChange: null,
    },
    engines: { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") },
    connection: {
      id: null,
      state: "connected",
      cause: null,
      bot: "lookover-k3x9q2[bot]",
      app: null,
      accounts: [],
      unreached: [],
      way: "own",
      signIn: null,
      person: null,
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
      gh: null,
    },
    service: {
      state: "running",
      since: NOW,
      version: "0.1.0",
      command: "lookover",
      agent: { path: { reach: "no", folder: "C:\\bin" }, offer: "binary", skills: [] },
      startAtLogin: true,
      atLogin: "none",
      loginItem: "os",
      paused: null,
      remote: false,
      unlocked: false,
      checks: null,
    },
    settings: DEFAULTS,
    repos: [
      {
        id: repositoryId("sasensi/ledger-api"),
        owner: "sasensi",
        name: "ledger-api",
        enabled: true,
        settings: DEFAULTS,
      },
    ],
    departed: [],
    rules: [],
    changes,
    reviews,
  };
}

test("it offers the owner's pull requests of the repositories on, never a fork's nor another author's (ADR 0048)", () => {
  const state = world([
    [1, "none"],
    [2, "none"],
    [3, "none"],
  ]);
  const own = (n: number, more: Partial<Change>) => ({ ...change(n), ...more });
  const mixed = {
    ...state,
    changes: { ...state.changes, [id(2)]: own(2, { fork: true }), [id(3)]: own(3, { author: "other" }) },
  };
  expect(firstReviewCandidates(mixed).map((it) => it.change.number)).toEqual([1]);
  const off = { ...state, repos: state.repos.map((r) => ({ ...r, enabled: false })) };
  expect(firstReviewCandidates(off)).toEqual([]);
});

const rowsOf = (state: State) => firstReviewRows(state).map((r) => [r.change.number, r.reviewed]);

test("a pull request with a round posted on its head is listed as reviewed, with its state chip's words", () => {
  const state = world([[5053, "posted"]]);
  expect(rowsOf(state)).toEqual([[5053, true]]);
  expect(firstReviewRows(state)[0]?.chip).toEqual({ tone: "ok", label: "Clean" });
});

test("a review running, a preview, a round on an older commit, or a skipped, failed or cancelled job stays pickable", () => {
  const state = world([
    [1, "none"],
    [2, "running"],
    [3, "preview"],
    [4, "pushed"],
    [5, "failed"],
    [6, "skipped"],
    [7, "cancelled"],
  ]);
  expect(rowsOf(state)).toEqual([
    [1, false],
    [2, false],
    [3, false],
    [4, false],
    [5, false],
    [6, false],
    [7, false],
  ]);
});

test("the pick skips a reviewed row, and passes to the next pickable one when the picked one becomes reviewed", () => {
  // #5053 was reviewed by itself and updated last, so it heads the list; #148 is picked.
  let state = world([
    [5053, "posted"],
    [148, "none"],
    [131, "none"],
  ]);
  expect(rowsOf(state)).toEqual([
    [5053, true],
    [148, false],
    [131, false],
  ]);
  expect(firstReviewPick(firstReviewRows(state), null)).toBe(id(148));
  // The person's pick on a reviewed row isn't kept.
  expect(firstReviewPick(firstReviewRows(state), id(5053))).toBe(id(148));
  // The person picked #131, then its round, run by itself, is posted: its review is now the latest updated, which
  // would put it first on Home; here it stays where it was shown, and the pick passes to #148.
  const shown = [id(5053), id(148), id(131)];
  expect(firstReviewPick(firstReviewRows(state, shown), id(131))).toBe(id(131));
  state = world([
    [131, "posted"],
    [5053, "posted"],
    [148, "none"],
  ]);
  expect(firstReviewRows(state, shown).map((r) => [r.change.number, r.reviewed])).toEqual([
    [5053, true],
    [148, false],
    [131, true],
  ]);
  expect(firstReviewPick(firstReviewRows(state, shown), id(131))).toBe(id(148));
});

test("a pull request that appears is listed under the rows shown, whatever its update", () => {
  const state = world([
    [152, "none"],
    [148, "none"],
    [131, "none"],
  ]);
  const rows = firstReviewRows(state, [id(148), id(131)]).map((r) => r.change.number);
  expect(rows).toEqual([148, 131, 152]);
  // A row shown that closed since leaves no hole.
  expect(firstReviewRows(state, [id(148), id(99), id(131)]).map((r) => r.change.number)).toEqual([
    148, 131, 152,
  ]);
});

test("the pick follows the list as it is: the first that appears, the next when the picked one closes (ADR 0068)", () => {
  let state: State = { ...world([]) };
  expect(firstReviewPick(firstReviewRows(state), null)).toBeNull();
  state = apply(state, { seq: 1, type: "change.opened", at: NOW, change: change(1) });
  expect(firstReviewPick(firstReviewRows(state), null)).toBe(id(1));
  state = apply(state, { seq: 2, type: "change.opened", at: NOW, change: change(2) });
  expect(firstReviewPick(firstReviewRows(state), null)).toBe(id(1));
  expect(firstReviewPick(firstReviewRows(state), id(2))).toBe(id(2));
  state = apply(state, { seq: 3, type: "change.closed", at: NOW, changeId: id(2) });
  expect(firstReviewPick(firstReviewRows(state), id(2))).toBe(id(1));
  state = apply(state, { seq: 4, type: "change.closed", at: NOW, changeId: id(1) });
  expect(firstReviewPick(firstReviewRows(state), id(1))).toBeNull();
});

test("a reviewed row's chip is one of the chips held in its place, as Home words them", () => {
  const rows = firstReviewRows(
    world([
      [1, "posted"],
      [2, "postedToFix"],
      [3, "postedNeedsYou"],
    ]),
  );
  for (const row of rows) {
    expect(row.reviewed).toBe(true);
    expect(REVIEWED_CHIPS).toContainEqual(row.chip);
  }
  expect(rows.map((r) => r.chip.label)).toEqual(["Clean", "To fix", "Needs you"]);
  expect(REVIEWED_CHIPS.map((c) => c.label)).toEqual(["Clean", "Settled", "To fix", "Needs you"]);
});

test("the step says none is left only when rows are listed and every one is reviewed", () => {
  expect(noneLeft(firstReviewRows(world([])))).toBe(false);
  expect(noneLeft(firstReviewRows(world([[148, "none"]])))).toBe(false);
  expect(
    noneLeft(
      firstReviewRows(
        world([
          [5053, "posted"],
          [148, "none"],
        ]),
      ),
    ),
  ).toBe(false);
  expect(
    noneLeft(
      firstReviewRows(
        world([
          [5053, "posted"],
          [148, "posted"],
        ]),
      ),
    ),
  ).toBe(true);
});

test("when every pull request listed is reviewed, none is picked and the step says so", () => {
  const state = world([
    [5053, "posted"],
    [148, "posted"],
  ]);
  expect(firstReviewPick(firstReviewRows(state), id(148))).toBeNull();
  expect(noneLeft(firstReviewRows(state))).toBe(true);
  expect(NONE_LEFT).toBe(
    "Lookover already reviewed these by itself. Open one on GitHub to see its review, or go on.",
  );
});

test("a pull request reviewed by itself during setup makes Continue the primary, the old one still picked (#458)", () => {
  const state = world([
    [152, "posted"],
    [131, "none"],
  ]);
  state.changes[id(131)] = { ...change(131), openedAt: NOW - 19 * 24 * 60 * MIN };
  const rows = firstReviewRows(state);
  const picked = firstReviewPick(rows, null);
  expect(picked).toBe(id(131));
  expect(firstReviewPrimary(rows, picked)).toBe("go-on");
  expect(reviewedLine(rows)).toBe("Lookover already reviewed sasensi/ledger-api #152 by itself: Clean.");
});

test("several reviewed by itself and one left: Continue, and the line counts them", () => {
  const rows = firstReviewRows(
    world([
      [152, "posted"],
      [153, "postedToFix"],
      [131, "none"],
    ]),
  );
  const picked = firstReviewPick(rows, null);
  expect(picked).toBe(id(131));
  expect(firstReviewPrimary(rows, picked)).toBe("go-on");
  expect(reviewedLine(rows)).toBe("Lookover already reviewed 2 of your pull requests by itself.");
});

test("nothing reviewed by itself: Review this pull request is the primary, and no line", () => {
  for (const how of ["none", "running", "pushed", "failed"] as const) {
    const rows = firstReviewRows(
      world([
        [1, how],
        [2, "none"],
      ]),
    );
    expect(firstReviewPrimary(rows, firstReviewPick(rows, null))).toBe("review");
    expect(reviewedLine(rows)).toBe("");
  }
});

test("a preview never counts as reviewed: the primary stays Review this pull request, and no line", () => {
  const rows = firstReviewRows(
    world([
      [1, "preview"],
      [2, "none"],
    ]),
  );
  expect(firstReviewPrimary(rows, firstReviewPick(rows, null))).toBe("review");
  expect(reviewedLine(rows)).toBe("");
});

test("every row reviewed: Continue, and the line says none is left", () => {
  const rows = firstReviewRows(
    world([
      [152, "posted"],
      [148, "posted"],
    ]),
  );
  const picked = firstReviewPick(rows, null);
  expect(picked).toBeNull();
  expect(firstReviewPrimary(rows, picked)).toBe("go-on");
  expect(reviewedLine(rows)).toBe(NONE_LEFT);
});

test("nothing listed: Continue, and no line", () => {
  const rows = firstReviewRows(world([]));
  expect(firstReviewPrimary(rows, firstReviewPick(rows, null))).toBe("go-on");
  expect(reviewedLine(rows)).toBe("");
});

test("the line says a reviewed row's chip word: To fix, Needs you", () => {
  const toFix = firstReviewRows(
    world([
      [152, "postedToFix"],
      [131, "none"],
    ]),
  );
  expect(reviewedLine(toFix)).toBe("Lookover already reviewed sasensi/ledger-api #152 by itself: To fix.");
  const needsYou = firstReviewRows(
    world([
      [152, "postedNeedsYou"],
      [131, "none"],
    ]),
  );
  expect(reviewedLine(needsYou)).toBe(
    "Lookover already reviewed sasensi/ledger-api #152 by itself: Needs you.",
  );
});

test("the lines held are the one shown and every one the step could show, so a review landing grows nothing", () => {
  const held = [
    ...[152, 131].flatMap((n) =>
      REVIEWED_CHIPS.map((c) => `Lookover already reviewed sasensi/ledger-api #${n} by itself: ${c.label}.`),
    ),
    "Lookover already reviewed 2 of your pull requests by itself.",
    NONE_LEFT,
  ];
  const before = firstReviewRows(
    world([
      [152, "none"],
      [131, "none"],
    ]),
  );
  expect(reviewedLines(before)).toEqual(["", ...held]);
  for (const how of ["posted", "postedToFix", "postedNeedsYou"] as const) {
    const after = firstReviewRows(
      world([
        [152, how],
        [131, "none"],
      ]),
    );
    expect(reviewedLines(after)[0]).toBe(reviewedLine(after));
    for (const line of held) expect(reviewedLines(after)).toContain(line);
  }
});

test("the bar's middle place: the preview until a review was posted, then Review this pull request while one is left", () => {
  const fresh = firstReviewRows(
    world([
      [152, "none"],
      [131, "none"],
    ]),
  );
  expect(firstReviewSecondary(fresh, firstReviewPick(fresh, null))).toBe("preview");
  const one = firstReviewRows(
    world([
      [152, "posted"],
      [131, "none"],
    ]),
  );
  expect(firstReviewSecondary(one, firstReviewPick(one, null))).toBe("review");
  const all = firstReviewRows(
    world([
      [152, "posted"],
      [131, "posted"],
    ]),
  );
  expect(firstReviewSecondary(all, firstReviewPick(all, null))).toBe("preview");
  const none = firstReviewRows(world([]));
  expect(firstReviewSecondary(none, firstReviewPick(none, null))).toBe("preview");
});
