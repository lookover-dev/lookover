// How often the service polls a repository (ADR 0043, ADR 0068): about every 10 s while one of its changes is in a
// review loop or setup shows a list of them, every minute otherwise.
import { expect, test } from "bun:test";
import { pollEvery } from "./index.ts";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const MIN = 60_000;
const QUIET = { asked: false, lastPostedAt: null, setupShowsList: false, now: NOW };

test("a quiet repository is polled every minute", () => {
  expect(pollEvery(QUIET)).toBe(60_000);
});

test("a review asked, waiting or running makes it every 10 s", () => {
  expect(pollEvery({ ...QUIET, asked: true })).toBe(10_000);
});

test("for 30 minutes after a round is posted, every 10 s: the agent is likely to push and ask again", () => {
  expect(pollEvery({ ...QUIET, lastPostedAt: NOW - 29 * MIN })).toBe(10_000);
  expect(pollEvery({ ...QUIET, lastPostedAt: NOW - 30 * MIN })).toBe(60_000);
});

test("while setup shows Repositories or First review, every 10 s: a pull request just opened shows within seconds", () => {
  expect(pollEvery({ ...QUIET, setupShowsList: true })).toBe(10_000);
  expect(pollEvery({ ...QUIET, setupShowsList: true, lastPostedAt: NOW - 2 * 60 * MIN })).toBe(10_000);
});
