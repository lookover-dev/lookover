// Running times tick in the browser (ADR 0058): the service's `now`, plus what the browser counted since it arrived,
// at the pace the service's clock flows, never going back.
import { expect, test } from "bun:test";
import { changeId, commitSha, emptyReview, type Review, runId } from "@lookover/contracts";
import { follow, somethingRuns, tickingNow } from "./ticking.ts";

const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
/** The browser's own clock, apart from the service's. */
const B = 5_000_000;

test("ticks with the browser from the moment the service's now arrived", () => {
  const tick = follow(null, NOW, 1, B);
  expect(tickingNow(tick, B)).toBe(NOW);
  expect(tickingNow(tick, B + 1_000)).toBe(NOW + 1_000);
  expect(tickingNow(tick, B + 61_500)).toBe(NOW + 61_500);
});

test("the same now arriving again keeps counting from where it first came", () => {
  const first = follow(null, NOW, 1, B);
  const again = follow(first, NOW, 1, B + 10_000);
  expect(tickingNow(again, B + 12_000)).toBe(NOW + 12_000);
});

test("a later now takes over from where it arrived", () => {
  const first = follow(null, NOW, 1, B);
  const next = follow(first, NOW + 20_000, 1, B + 15_000);
  expect(tickingNow(next, B + 16_000)).toBe(NOW + 21_000);
});

test("never goes back when a new now arrives behind the time shown", () => {
  const first = follow(null, NOW, 1, B);
  // The browser counted 15 s, the service's keepalive says 14.6 s passed.
  const behind = follow(first, NOW + 14_600, 1, B + 15_000);
  expect(tickingNow(behind, B + 15_000)).toBe(NOW + 15_000);
  expect(tickingNow(behind, B + 15_200)).toBe(NOW + 15_000);
  expect(tickingNow(behind, B + 16_000)).toBe(NOW + 15_600);
});

test("a now behind the service's last one is another clock (a scenario loaded again): it is taken as it is", () => {
  const first = follow(null, NOW, 60, B);
  const reset = follow(first, NOW - 1_000, 60, B + 15_000);
  expect(tickingNow(reset, B + 15_000)).toBe(NOW - 1_000);
});

test("at demo mode's speed, a now a few seconds late is still the same clock", () => {
  const fast = follow(null, NOW, 60, B);
  // The browser counted 2 s (2 min at 60×); the event that comes says 1 min.
  const late = follow(fast, NOW + 60_000, 60, B + 2_000);
  expect(tickingNow(late, B + 2_000)).toBe(NOW + 120_000);
});

test("stands still with demo mode's clock, and moves when it is moved", () => {
  const still = follow(null, NOW, 0, B);
  expect(tickingNow(still, B + 30_000)).toBe(NOW);
  const moved = follow(still, NOW + 60_000, 0, B + 30_000);
  expect(tickingNow(moved, B + 90_000)).toBe(NOW + 60_000);
});

test("follows demo mode's clock at its speed, from the time shown when the speed changed", () => {
  const slow = follow(null, NOW, 1, B);
  const fast = follow(slow, NOW, 60, B + 2_000);
  expect(tickingNow(fast, B + 2_000)).toBe(NOW + 2_000);
  expect(tickingNow(fast, B + 3_000)).toBe(NOW + 62_000);
  const paused = follow(fast, NOW, 0, B + 4_000);
  expect(tickingNow(paused, B + 10_000)).toBe(NOW + 122_000);
});

test("a new now and a new pace read together: counts from the new now at the new pace", () => {
  const slow = follow(null, NOW, 1, B);
  // The clock was sped up and the service's now moved before the read.
  const fast = follow(slow, NOW + 10_000, 60, B + 2_000);
  expect(tickingNow(fast, B + 2_000)).toBe(NOW + 10_000);
  expect(tickingNow(fast, B + 3_000)).toBe(NOW + 70_000);
  // Then paused, its now moved on again: it stands on that now.
  const paused = follow(fast, NOW + 130_000, 0, B + 4_000);
  expect(tickingNow(paused, B + 4_000)).toBe(NOW + 130_000);
  expect(tickingNow(paused, B + 60_000)).toBe(NOW + 130_000);
  // Paused behind the time shown: it stays on the time shown, never back.
  const behind = follow(fast, NOW + 100_000, 0, B + 4_000);
  expect(tickingNow(behind, B + 60_000)).toBe(NOW + 130_000);
});

test("a browser clock that stands still (proof's) shows the service's now", () => {
  const tick = follow(null, NOW, 1, B);
  expect(tickingNow(follow(tick, NOW, 1, B), B)).toBe(NOW);
});

test("the time is redrawn only while a review runs", () => {
  const idle = emptyReview(changeId("app#1"), NOW);
  const busy: Review = {
    ...emptyReview(changeId("app#2"), NOW),
    run: {
      id: runId("run-1"),
      reviewer: "claude",
      secondFinder: null,
      confirmer: null,
      confirmFallback: null,
      sha: commitSha("a1f9c2e"),
      preview: false,
      startedAt: NOW,
      step: "finding",
      stepAt: NOW,
      steps: [],
      activities: [],
      posting: null,
    },
  };
  expect(somethingRuns({})).toBe(false);
  expect(somethingRuns({ [idle.changeId]: idle })).toBe(false);
  expect(somethingRuns({ [idle.changeId]: idle, [busy.changeId]: busy })).toBe(true);
});
