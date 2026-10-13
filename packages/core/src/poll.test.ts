// How often the service polls a repository (ADR 0043): about every 10 s while one of its changes is in a review
// loop, every minute otherwise.
import { expect, test } from "bun:test";
import { pollEvery } from "./index.ts";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const MIN = 60_000;

test("a quiet repository is polled every minute", () => {
  expect(pollEvery({ asked: false, lastPostedAt: null, now: NOW })).toBe(60_000);
});

test("a review asked, waiting or running makes it every 10 s", () => {
  expect(pollEvery({ asked: true, lastPostedAt: null, now: NOW })).toBe(10_000);
});

test("for 30 minutes after a round is posted, every 10 s: the agent is likely to push and ask again", () => {
  expect(pollEvery({ asked: false, lastPostedAt: NOW - 29 * MIN, now: NOW })).toBe(10_000);
  expect(pollEvery({ asked: false, lastPostedAt: NOW - 30 * MIN, now: NOW })).toBe(60_000);
});
