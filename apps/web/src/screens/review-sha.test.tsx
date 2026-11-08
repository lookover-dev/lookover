// The review page draws every commit one way (design-system.md "Inline code", `Sha`): the settled verdict, the open
// one and the failed notice each name theirs as a commit, never as plain text in a sentence; after a round, Details'
// Posted, its Rounds summary and the rounds' table name it too, four in all.
import { expect, test } from "bun:test";
import type { Finding, ReviewJob } from "@lookover/contracts";
import { SEPARATOR } from "../view-model/format.ts";
import { world } from "./repositories.test-support.tsx";
import { finding, job, page, SHA } from "./review.test-support.tsx";

// A commit followed by punctuation is drawn tight (design-system.md "Inline code"): still the one chip.
const SHAS = /<code class="sha(?: tight)?">a1f9c2e<\/code>/g;
const verdict = (html: string) => html.match(/<div class="[^"]*verdict[^"]*">.*?<\/div>/)?.[0] ?? "";

test("settled: the verdict names its commit as a commit", () => {
  const html = page({ job: job("done"), loop: "settled", findings: [finding("a", "verified_fixed")] });
  expect(verdict(html)).toContain('Looked over <code class="sha tight">a1f9c2e</code>.');
  expect(html.match(SHAS)?.length).toBe(4);
});

test("findings open: the verdict names its commit as a commit, never as plain text", () => {
  const html = page({ job: job("done"), loop: "open", findings: [finding("a", "open")] });
  expect(verdict(html)).toContain('Looked over <code class="sha tight">a1f9c2e</code>. One thing to fix');
  expect(html).not.toContain("Looked over a1f9c2e");
  expect(html.match(SHAS)?.length).toBe(4);
});

test("failed before any round: the notice names its commit as a commit", () => {
  const failure: ReviewJob["failure"] = {
    kind: "prepare_failed",
    detail: "fetch_failed",
    engine: "claude",
    cause: "git_time_limit",
    limitMs: 600_000,
  };
  const html = page({ job: job("failed", { failure }), loop: null, rounds: [] });
  expect(html).toContain('Couldn&#x27;t look over <code class="sha tight">a1f9c2e</code>.');
  expect(html.match(SHAS)?.length).toBe(1);
});

test("Checked by says its citation in its sentence, before the reason, tight against the full stop after it", () => {
  const checked: Finding = {
    ...finding("a", "open"),
    confirmation: {
      verdict: "confirmed",
      by: "codex",
      reason: "Nothing reads the signature header.",
      evidence: ["src/webhooks/payments.ts:12"],
    },
  };
  const html = page({ job: job("done"), loop: "open", findings: [checked] });
  expect(html).toContain(
    '<b>Checked by:</b> Codex, confirmed at <code class="path tight"><span class="piece">src/webhooks/payments.ts:12</span></code>. Nothing reads the signature header.</span>',
  );
});

test("settled, or the agent working on its findings: Review again is a secondary, the page has no filled primary", () => {
  for (const review of [
    { job: job("done"), loop: "settled" as const, findings: [finding("a", "verified_fixed")] },
    { job: job("done"), loop: "open" as const, findings: [finding("a", "open")] },
  ]) {
    const html = page(review);
    const seen = html.match(/<span class="same-width-slot">(<button[^>]*>)(.*?)<\/button>/);
    expect(seen?.[1]).toContain("btn-secondary");
    expect(seen?.[2]).toContain("Review again");
    expect(html).not.toContain("btn-primary");
  }
});

test("the line under the title: one separator between who opened, wrote and reviewed it", () => {
  const html = page({ job: job("done"), loop: "settled", findings: [] });
  const meta = ["by sasensi", "written by Claude", "reviewed by Claude"].join(SEPARATOR);
  expect(html).toContain(`<span>${meta}</span>`);
});

test("a finding's severity opens its title's line, open or done; a verified fix says its round after a comma", () => {
  const fixed: Finding = { ...finding("a", "verified_fixed"), verifiedSha: SHA };
  const done = page({ job: job("done"), loop: "settled", findings: [fixed] });
  expect(done).toMatch(/<div class="ti"><span class="sev-label fix">Should fix <\/span>/);
  expect(done).toContain('verified fixed in <code class="sha tight">a1f9c2e</code>, round 1');
  const open = page({ job: job("done"), loop: "open", findings: [finding("b", "open")] });
  expect(open).toMatch(/<h5><span class="sev fix">Should fix <\/span>/);
});

test("failed where another try can help: Try again is the one primary, the notice says the cause and no more", () => {
  const failure: ReviewJob["failure"] = {
    kind: "review_failed",
    detail: "no_review",
    engine: "codex",
    cause: "engine_answer",
    limitMs: null,
  };
  const timeline = [{ at: world().now - 4 * 60_000, sha: SHA, kind: "failed" as const, failure }];
  const html = page({ job: job("failed", { failure }), loop: null, rounds: [], timeline });
  // The seen slot of the review button's place is the primary "Try again"; the others are hidden.
  const seen = html.match(/<span class="same-width-slot">(<button[^>]*>)(.*?)<\/button>/);
  expect(seen?.[1]).toContain("btn-primary");
  expect(seen?.[2]).toContain("Try again");
  // Every other primary on the page is a hidden label of that place.
  const primaries = html.match(/class="btn btn-primary/g)?.length ?? 0;
  const hidden = html.match(/aria-hidden="true"><button type="button" class="btn btn-primary/g)?.length ?? 0;
  expect(primaries - hidden).toBe(1);
  const banner = html.match(/<div class="banner">.*?<\/div>/)?.[0] ?? "";
  expect(banner).toContain("Codex gave no usable review.");
  expect(banner).not.toContain("try once more");
  // Details › Log, below it, is the way to the log: the notice has no action of its own.
  expect(banner).not.toContain("<button");
});

// A finding's severity opens its title's line: a heading and a closed row read "Should fix Title", a space between
// them, never "Should fixTitle" (the severity's margin is drawn, never read).
const text = (html: string) => html.replace(/<[^>]+>/g, "");

test("a finding card's heading reads its severity, a space, then its title", () => {
  const html = page({ job: job("done"), loop: "open", findings: [finding("SQL injection", "open")] });
  const heading = html.match(/<h5>.*?<\/h5>/)?.[0] ?? "";
  expect(text(heading)).toBe("Should fix SQL injection");
});

test("a closed finding's row reads its severity, a space, then its title", () => {
  const html = page({
    job: job("done"),
    loop: "settled",
    findings: [finding("SQL injection", "verified_fixed")],
  });
  const title = html.match(/<div class="ti">.*?<\/div>/)?.[0] ?? "";
  expect(text(title)).toBe("Should fix SQL injection");
});
