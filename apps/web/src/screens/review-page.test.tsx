// The review page's outcome and its actions (design-system.md "Finding card", "Button"; ADR 0083): every outcome card
// opens with the eyes in its tone, a finding marked by its edge says "Needs you" to a screen reader too, and while a
// review runs its status stands just before Open on GitHub, in every round.
import { expect, test } from "bun:test";
import type { Review } from "@lookover/contracts";
import { finding, job, page } from "./review.test-support.tsx";

const HIDDEN_NEED = '<span class="visually-hidden">Needs you. </span>';
/** The one finding card's opening and heading. */
const card = (html: string) => html.match(/<div class="card finding[^"]*"><h5>.*?<\/h5>/)?.[0] ?? "";
const verdictClass = (html: string) => html.match(/<div class="card (verdict[^"]*)">/)?.[1];

test("a later round running, an escalated finding alone: its card's edge and its heading say it needs you", () => {
  const html = page({ job: job("running"), loop: "needs_owner", findings: [finding("a", "escalated")] });
  const a = card(html);
  expect(a).toContain('class="card finding need"');
  expect(a).toContain(HIDDEN_NEED);
});

test("under the banner, an escalated finding alone has no edge and no hidden words: the banner said it", () => {
  const html = page({ job: job("done"), loop: "needs_owner", findings: [finding("a", "escalated")] });
  expect(card(html)).toContain('class="card finding"');
  expect(html).not.toContain(HIDDEN_NEED);
});

test("every outcome's card opens with the still eyes, in its tone", () => {
  const cases: [Partial<Review>, string][] = [
    [{ job: job("done"), loop: "settled", findings: [] }, "verdict ok"],
    [{ job: job("done"), loop: "settled", findings: [finding("a", "verified_fixed")] }, "verdict ok"],
    [{ job: job("done"), loop: "open", findings: [finding("a", "open")] }, "verdict fix"],
    [{ job: job("cancelled", { cancel: "closed" }), loop: null, rounds: [] }, "verdict quiet"],
    [{ job: job("skipped", { skip: "not-yours" }), loop: null, rounds: [] }, "verdict quiet"],
  ];
  for (const [review, tone] of cases) {
    const html = page(review);
    expect(verdictClass(html)).toBe(tone);
    const verdict = html.slice(html.indexOf(`class="card ${tone}"`));
    expect(verdict.indexOf('class="eyes ')).toBeLessThan(verdict.indexOf("<b>"));
  }
});

test("while a later round runs, Reviewing… stands just before Open on GitHub, after Copy, as the button it keeps", () => {
  for (const shown of ["running", "done"] as const) {
    const html = page({ job: job(shown), loop: "open", findings: [finding("a", "open")] });
    const acts = html.match(/<div class="rv-acts">.*$/)?.[0] ?? "";
    const copy = acts.indexOf("Copy a fix prompt for my agent");
    const place = acts.indexOf('class="same-width"');
    const github = acts.indexOf("Open on GitHub");
    expect([shown, copy < place && place < github]).toEqual([shown, true]);
  }
});
