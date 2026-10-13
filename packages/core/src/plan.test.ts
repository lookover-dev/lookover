// The round plan (ADR 0044): who finds a change and who confirms it. The finder is the engine the repository allows
// that didn't write it, Claude when nobody knows; Codex never reviews another author's change while its reads aren't
// confined, and a change only Codex may review is then skipped, with the reason. The confirmer is the other engine
// when it may review the change and is ready, else the finder in a new session, with why.
import { expect, test } from "bun:test";
import type { Change, ConfirmFallback, Depth, EngineId, EngineState, Reviewers } from "@lookover/contracts";
import { type ReviewPlan, type RoundPlan, roundPlan } from "./index.ts";

const STATES: EngineState[] = ["ready", "missing", "signed-out", "limit", "failed-self-test"];
const SKIPPED: RoundPlan = { kind: "skipped", reason: "codex-not-yours" };
const by = (
  finder: EngineId,
  confirmer: EngineId,
  confirmFallback: ConfirmFallback | null = null,
): RoundPlan => ({
  kind: "review",
  finder,
  secondFinder: null,
  confirmer,
  confirmFallback,
});
/** Found and confirmed by `engine`, since the other engine may not review the change: why. */
const alone = (engine: EngineId, reason: "settings" | "not-own"): RoundPlan =>
  by(engine, engine, { reason, engine: engine === "claude" ? "codex" : "claude" });

/**
 * Every mix of reviewers, author and writer, with what the plan must give with both engines ready, written by hand.
 * "agent" is the owner's coding agent, pushing as the owner (ADR 0016): the owner's change.
 */
const TABLE: [Reviewers, Change["author"], EngineId | null, RoundPlan][] = [
  // Both engines: the one that didn't write it finds, the other confirms; Claude finds when nobody knows.
  ["both", "you", null, by("claude", "codex")],
  ["both", "you", "claude", by("codex", "claude")],
  ["both", "you", "codex", by("claude", "codex")],
  ["both", "agent", null, by("claude", "codex")],
  ["both", "agent", "claude", by("codex", "claude")],
  ["both", "agent", "codex", by("claude", "codex")],
  // Another author's: never Codex, so Claude finds and confirms, even on Claude's own code.
  ["both", "other", null, alone("claude", "not-own")],
  ["both", "other", "claude", alone("claude", "not-own")],
  ["both", "other", "codex", alone("claude", "not-own")],
  // Only Claude: Claude, whoever wrote it.
  ["claude", "you", null, alone("claude", "settings")],
  ["claude", "you", "claude", alone("claude", "settings")],
  ["claude", "you", "codex", alone("claude", "settings")],
  ["claude", "agent", null, alone("claude", "settings")],
  ["claude", "agent", "claude", alone("claude", "settings")],
  ["claude", "agent", "codex", alone("claude", "settings")],
  ["claude", "other", null, alone("claude", "settings")],
  ["claude", "other", "claude", alone("claude", "settings")],
  ["claude", "other", "codex", alone("claude", "settings")],
  // Only Codex: Codex on the owner's changes, even its own code; another author's is skipped.
  ["codex", "you", null, alone("codex", "settings")],
  ["codex", "you", "claude", alone("codex", "settings")],
  ["codex", "you", "codex", alone("codex", "settings")],
  ["codex", "agent", null, alone("codex", "settings")],
  ["codex", "agent", "claude", alone("codex", "settings")],
  ["codex", "agent", "codex", alone("codex", "settings")],
  ["codex", "other", null, SKIPPED],
  ["codex", "other", "claude", SKIPPED],
  ["codex", "other", "codex", SKIPPED],
];

test("the finder and the confirmer for every mix of reviewers, author and writer, both engines ready", () => {
  // Every mix, once: 3 reviewers × 3 authors × 3 writers.
  expect(new Set(TABLE.map(([r, a, w]) => `${r} ${a} ${w}`)).size).toBe(27);
  for (const [reviewers, author, writtenBy, expected] of TABLE) {
    const plan = roundPlan({
      reviewers,
      change: { author, writtenBy, fork: false },
      depth: "standard",
      finder: null,
      engines: { claude: "ready", codex: "ready" },
    });
    expect([reviewers, author, writtenBy, plan]).toEqual([reviewers, author, writtenBy, expected]);
  }
});

/** What a plan says of who finds: the kind, and the finder or the skip's reason. */
const finding = (plan: RoundPlan) =>
  plan.kind === "review" ? { kind: plan.kind, finder: plan.finder } : plan;

test("the finder never depends on the engines' states: a finder that isn't ready defers, it never switches", () => {
  for (const [reviewers, author, writtenBy, expected] of TABLE)
    for (const claude of STATES)
      for (const codex of STATES) {
        const plan = roundPlan({
          reviewers,
          change: { author, writtenBy, fork: false },
          depth: "standard",
          finder: null,
          engines: { claude, codex },
        });
        expect([reviewers, author, writtenBy, claude, codex, finding(plan)]).toEqual([
          reviewers,
          author,
          writtenBy,
          claude,
          codex,
          finding(expected),
        ]);
      }
});

test("the other engine not ready: the finder confirms in a new session, with the other engine's state", () => {
  const plan = (writtenBy: EngineId | null, engines: Record<EngineId, EngineState>) =>
    roundPlan({
      reviewers: "both",
      change: { author: "you", writtenBy, fork: false },
      depth: "standard",
      engines,
      finder: null,
    });
  expect([
    plan(null, { claude: "ready", codex: "signed-out" }),
    plan(null, { claude: "ready", codex: "missing" }),
    plan(null, { claude: "ready", codex: "limit" }),
    plan(null, { claude: "ready", codex: "failed-self-test" }),
    plan("claude", { claude: "signed-out", codex: "ready" }),
    plan("claude", { claude: "limit", codex: "ready" }),
  ]).toEqual([
    by("claude", "claude", { reason: "not-ready", engine: "codex", state: "signed-out" }),
    by("claude", "claude", { reason: "not-ready", engine: "codex", state: "missing" }),
    by("claude", "claude", { reason: "not-ready", engine: "codex", state: "limit" }),
    by("claude", "claude", { reason: "not-ready", engine: "codex", state: "failed-self-test" }),
    by("codex", "codex", { reason: "not-ready", engine: "claude", state: "signed-out" }),
    by("codex", "codex", { reason: "not-ready", engine: "claude", state: "limit" }),
  ]);
});

test("the finder not ready changes no confirmer: the job defers on its finder", () => {
  expect(
    roundPlan({
      reviewers: "both",
      change: { author: "you", writtenBy: null, fork: false },
      depth: "standard",
      finder: null,
      engines: { claude: "signed-out", codex: "ready" },
    }),
  ).toEqual(by("claude", "codex"));
});

test("an engine barred from the change says so, whatever its state: the settings first, then the author", () => {
  expect([
    roundPlan({
      reviewers: "claude",
      change: { author: "you", writtenBy: null, fork: false },
      depth: "standard",
      finder: null,
      engines: { claude: "ready", codex: "signed-out" },
    }),
    roundPlan({
      reviewers: "both",
      change: { author: "other", writtenBy: null, fork: false },
      depth: "standard",
      finder: null,
      engines: { claude: "ready", codex: "missing" },
    }),
    roundPlan({
      reviewers: "claude",
      change: { author: "other", writtenBy: null, fork: false },
      depth: "standard",
      finder: null,
      engines: { claude: "ready", codex: "limit" },
    }),
  ]).toEqual([alone("claude", "settings"), alone("claude", "not-own"), alone("claude", "settings")]);
});

/** The plan for the owner's change at `depth`, with `reviewers` and the engines' states. */
const atDepth = (
  depth: Depth,
  engines: Record<EngineId, EngineState> = { claude: "ready", codex: "ready" },
  more: {
    reviewers?: Reviewers;
    author?: Change["author"];
    writtenBy?: EngineId | null;
    fork?: boolean;
  } = {},
) =>
  roundPlan({
    reviewers: more.reviewers ?? "both",
    change: { author: more.author ?? "you", writtenBy: more.writtenBy ?? null, fork: more.fork ?? false },
    depth,
    engines,
    finder: null,
  });

test("Quick: one find pass and no confirm, whatever the other engine can do", () => {
  const quick: ReviewPlan = {
    kind: "review",
    finder: "claude",
    secondFinder: null,
    confirmer: null,
    confirmFallback: null,
  };
  expect([
    atDepth("quick"),
    atDepth("quick", { claude: "ready", codex: "signed-out" }),
    atDepth("quick", undefined, { reviewers: "claude" }),
    atDepth("quick", undefined, { author: "other" }),
  ]).toEqual([quick, quick, quick, quick]);
  expect(atDepth("quick", undefined, { writtenBy: "claude" })).toEqual({ ...quick, finder: "codex" });
  expect(atDepth("quick", undefined, { reviewers: "codex", author: "other" })).toEqual(SKIPPED);
});

test("Deep: the second find pass on the other engine when it may review the change and is ready, else the finder again", () => {
  const deep = (
    finder: EngineId,
    other: EngineId,
    confirmFallback: ConfirmFallback | null = null,
  ): RoundPlan => ({
    kind: "review",
    finder,
    secondFinder: other,
    confirmer: other,
    confirmFallback,
  });
  expect([
    atDepth("deep"),
    atDepth("deep", undefined, { writtenBy: "claude" }),
    atDepth("deep", { claude: "ready", codex: "limit" }),
    atDepth("deep", undefined, { reviewers: "claude" }),
    // Codex never finds another author's change, the second pass included.
    atDepth("deep", undefined, { author: "other", writtenBy: "codex" }),
    atDepth("deep", undefined, { reviewers: "codex", author: "other" }),
  ]).toEqual([
    deep("claude", "codex"),
    deep("codex", "claude"),
    deep("claude", "claude", { reason: "not-ready", engine: "codex", state: "limit" }),
    deep("claude", "claude", { reason: "settings", engine: "codex" }),
    deep("claude", "claude", { reason: "not-own", engine: "codex" }),
    SKIPPED,
  ]);
});

/** The owner's change, sent to `finder` by `engine.reroute`, with `more` over both engines ready at Standard. */
const sentTo = (
  finder: EngineId,
  more: {
    change?: Pick<Change, "author" | "writtenBy" | "fork">;
    engines?: Record<EngineId, EngineState>;
    depth?: Depth;
    reviewers?: Reviewers;
  } = {},
) =>
  roundPlan({
    reviewers: more.reviewers ?? "both",
    change: more.change ?? { author: "you", writtenBy: null, fork: false },
    depth: more.depth ?? "standard",
    engines: more.engines ?? { claude: "ready", codex: "ready" },
    finder,
  });

test("the engine the owner sent the job to finds (engine.reroute, ADR 0047), whoever wrote the change; the confirmer falls back as usual", () => {
  expect([
    sentTo("codex"),
    sentTo("claude", { change: { author: "you", writtenBy: "claude", fork: false } }),
    // The finder still never depends on the engines' states: sent to Codex, it finds or the job waits for it.
    sentTo("codex", { engines: { claude: "ready", codex: "signed-out" } }),
    sentTo("codex", { engines: { claude: "signed-out", codex: "ready" } }),
    sentTo("codex", { depth: "quick" }),
    sentTo("codex", { depth: "deep" }),
  ]).toEqual([
    by("codex", "claude"),
    by("claude", "codex"),
    by("codex", "claude"),
    by("codex", "codex", { reason: "not-ready", engine: "claude", state: "signed-out" }),
    { kind: "review", finder: "codex", secondFinder: null, confirmer: null, confirmFallback: null },
    { kind: "review", finder: "codex", secondFinder: "claude", confirmer: "claude", confirmFallback: null },
  ]);
});

test("an engine the owner sent the job to that may not review the change is refused: the rule picks, as if nobody chose", () => {
  expect([
    // The settings changed since: the repository reviews with Claude alone.
    sentTo("codex", { reviewers: "claude" }),
    // Codex never reviews another author's change.
    sentTo("codex", { change: { author: "other", writtenBy: null, fork: false } }),
    // Only Codex may review here, and the change is another author's: skipped, as the rule says.
    sentTo("claude", { reviewers: "codex", change: { author: "other", writtenBy: null, fork: false } }),
  ]).toEqual([alone("claude", "settings"), alone("claude", "not-own"), SKIPPED]);
});

test("a fork change is Claude's alone, whoever wrote it, as another author's is (ADR 0048)", () => {
  const authors: Change["author"][] = ["you", "agent", "other"];
  for (const author of authors) {
    expect([
      author,
      atDepth("standard", undefined, { author, writtenBy: "claude", fork: true }),
      atDepth("deep", undefined, { author, fork: true }),
      atDepth("quick", undefined, { author, writtenBy: "claude", fork: true }),
      // Sent to Codex by hand: refused, the rule picks Claude.
      sentTo("codex", { change: { author, writtenBy: "claude", fork: true } }),
      // Only Codex may review here: skipped.
      atDepth("standard", undefined, { author, fork: true, reviewers: "codex" }),
    ]).toEqual([
      author,
      alone("claude", "not-own"),
      {
        kind: "review",
        finder: "claude",
        secondFinder: "claude",
        confirmer: "claude",
        confirmFallback: { reason: "not-own", engine: "codex" },
      },
      { kind: "review", finder: "claude", secondFinder: null, confirmer: null, confirmFallback: null },
      alone("claude", "not-own"),
      SKIPPED,
    ]);
  }
});
