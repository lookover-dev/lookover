// A review's steps advance by their marks (ADR 0087, design-system.md "Motion"), in a real DOM: a step's new mark
// (the reading eyes, the check) and the verdict replacing the Running card are marked `data-arrived`, which their CSS
// entry is keyed on, only when they came after the first commit. A page opening on a running or finished review
// marks nothing, so nothing moves.
//
// The DOM is `withDom`'s, this file's only; the screens are imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import { changeId, emptyReview, type Review, type Run, runId, type State } from "@lookover/contracts";
import { withDom } from "../ui/dom.test-support.tsx";

type Support = typeof import("./review.test-support.tsx");
type World = typeof import("./repositories.test-support.tsx");
type Setup = typeof import("./setup.tsx");

const dom = withDom();
const { render, unmount } = dom;
let support: Support;
let world: World;
let setup: Setup;

beforeAll(async () => {
  support = await import("./review.test-support.tsx");
  world = await import("./repositories.test-support.tsx");
  setup = await import("./setup.tsx");
});

/** The round running at `step`, the steps before it done. */
function running(step: Run["step"], done: Run["step"][]): Partial<Review> {
  const at = Date.UTC(2026, 10, 7, 9, 58, 0);
  return {
    job: support.job("running"),
    loop: null,
    rounds: [],
    run: {
      id: runId("run-1"),
      reviewer: "claude",
      secondFinder: null,
      confirmer: null,
      confirmFallback: null,
      sha: support.SHA,
      preview: false,
      startedAt: at,
      step,
      stepAt: at,
      steps: done.map((s) => ({ step: s, ms: 10_000 })),
      activities: [],
      posting: null,
    },
  };
}

/** The round done, nothing found. */
const finished = (): Partial<Review> => ({
  job: support.job("done"),
  loop: "settled",
  findings: [],
  run: null,
});

/** Each step's row: its mark's kind, and whether the mark came in after the first commit. */
function marks(): string[] {
  return [...dom.host().querySelectorAll(".steplist li")].map((li) => {
    const mark = li.querySelector(":scope > .step-mark");
    if (!mark) return "dot";
    const kind = mark.querySelector(".eyes") ? "eyes" : "check";
    return mark.hasAttribute("data-arrived") ? `${kind} arrived` : kind;
  });
}

const verdict = () => dom.host().querySelector(".card.verdict");

test("a page opening on a running review marks nothing; a step advancing marks its two new marks only", async () => {
  await render(support.pageOf(running("finding", ["preparing"])));
  expect(marks()).toEqual(["check", "eyes", "dot", "dot"]);

  await render(support.pageOf(running("confirming", ["preparing", "finding"])));
  // The check that replaced the eyes and the eyes that replaced the dot came in; the first check stays as it was.
  expect(marks()).toEqual(["check", "check arrived", "eyes arrived", "dot"]);
  await unmount();
});

test("the verdict replacing the Running card comes in; a page opening on a finished review has it still", async () => {
  await render(support.pageOf(finished()));
  expect(verdict()?.hasAttribute("data-arrived")).toBe(false);
  await unmount();

  await render(support.pageOf(running("publishing", ["preparing", "finding", "confirming"])));
  expect(verdict()).toBeNull();
  await render(support.pageOf(finished()));
  expect(verdict()?.hasAttribute("data-arrived")).toBe(true);
  await unmount();
});

test("an outcome changing in place doesn't come in: the needs-you notice settling into the verdict, no round between", async () => {
  const needsYou: Partial<Review> = {
    job: support.job("done"),
    loop: "needs_owner",
    findings: [support.finding("f1", "escalated")],
    run: null,
  };
  await render(support.pageOf(needsYou));
  expect(dom.host().textContent).toContain("Only you can settle it");
  expect(verdict()).toBeNull();
  await render(support.pageOf(finished()));
  expect(verdict()?.hasAttribute("data-arrived")).toBe(false);
  await unmount();
});

test("the verdict's gate starts over on another pull request: one opened finished after a running one is still", async () => {
  await render(support.pageOf(running("publishing", ["preparing", "finding", "confirming"])));
  expect(verdict()).toBeNull();
  await render(support.pageOf(finished(), changeId("sasensi/ledger-api#7-again")));
  expect(verdict()?.hasAttribute("data-arrived")).toBe(false);
  await unmount();
});

test("setup's First review: the marks it opened with are still, the ones a step takes later come in", async () => {
  const pr = world.change("sasensi/ledger-api", 148);
  const at = (step: Run["step"], done: Run["step"][]): State => {
    const base = world.world();
    return {
      ...base,
      setup: { ...base.setup, done: false, step: "first-review", firstReviewChange: pr.id },
      changes: { [pr.id]: pr },
      reviews: { [pr.id]: { ...emptyReview(pr.id, pr.openedAt), ...running(step, done) } },
    };
  };
  const store = world.app();
  await render(world.screenOf(store, at("finding", ["preparing"]), setup.StepFirstReview));
  expect(marks()).toEqual(["check", "eyes", "dot", "dot"]);
  await render(world.screenOf(store, at("confirming", ["preparing", "finding"]), setup.StepFirstReview));
  expect(marks()).toEqual(["check", "check arrived", "eyes arrived", "dot"]);
  await unmount();
});
