// A finding's thread among a change's (ADR 0052): the newest whose marker names it.
import { expect, test } from "bun:test";
import { findingId, type HostThread, newestThread } from "./index.ts";

const thread = (finding: string, commentId: number): HostThread => ({
  commentId,
  url: `https://github.com/o/r/pull/1#discussion_r${commentId}`,
  nodeId: `PRRC_${commentId}`,
  findingId: findingId(finding),
  outdated: false,
  replies: [],
});

test("a finding posted again after a review that never landed has two threads: the newest is its", () => {
  const threads = [thread("F1", 100003), thread("F2", 100002), thread("F1", 100001)];
  expect(newestThread(threads, "F1")).toBe(threads[0]);
  expect(newestThread(threads, "F2")).toBe(threads[1]);
});

test("a finding with no thread has none", () => {
  expect(newestThread([thread("F1", 100001)], "F9")).toBeUndefined();
});
