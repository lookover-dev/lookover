// A review request as a comment's text (ADR 0043): what `lookover wait` writes, and what the service and `wait`
// read back from any comment.
import { describe, expect, test } from "bun:test";
import {
  commitSha,
  FINDING_MARKER,
  isReviewRequest,
  REQUEST_MARKER,
  RESULT_MARKER,
  readRequest,
  requestedCommit,
  reviewRequest,
  SUMMARY_MARKER,
} from "./index.ts";

const sha = commitSha("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");

describe("review requests", () => {
  test("the request `lookover wait` posts is the command, then a hidden marker naming the commit", () => {
    expect(reviewRequest(sha)).toBe(`/lookover review\n${REQUEST_MARKER}{"v":1,"commit":"${sha}"} -->`);
  });

  test("the marker may name the reply the request asks to have answered", () => {
    expect(reviewRequest(sha, { reply: 4242 })).toBe(
      `/lookover review\n${REQUEST_MARKER}{"v":1,"commit":"${sha}","reply":4242} -->`,
    );
    expect(readRequest(reviewRequest(sha, { reply: 4242 }))).toEqual({
      full: false,
      commit: sha,
      reply: 4242,
    });
    expect(requestedCommit(reviewRequest(sha, { reply: 4242 }))).toBe(sha);
    expect(readRequest(reviewRequest(sha))).toEqual({ full: false, commit: sha, reply: null });
  });

  test("`/lookover review full` is a request for a full round, in any case; it names no commit", () => {
    expect(readRequest("/lookover review full")).toEqual({ full: true, commit: null, reply: null });
    expect(readRequest("  /Lookover Review FULL \nplease")).toEqual({
      full: true,
      commit: null,
      reply: null,
    });
    expect(isReviewRequest("/lookover review full")).toBe(true);
    expect(readRequest("/lookover review")).toEqual({ full: false, commit: null, reply: null });
    expect(readRequest("/lookover review fully")).toBeNull();
    expect(readRequest("/lookover review full now")).toBeNull();
    expect(readRequest("/lookover reviewfull")).toBeNull();
  });

  test("a marker that isn't the request's JSON names no commit and no reply", () => {
    expect(readRequest(`/lookover review\n${REQUEST_MARKER}${sha} -->`)).toEqual({
      full: false,
      commit: null,
      reply: null,
    });
    expect(
      readRequest(`/lookover review\n${REQUEST_MARKER}{"v":1,"commit":"${sha}","reply":"x"} -->`),
    ).toEqual({
      full: false,
      commit: sha,
      reply: null,
    });
    expect(readRequest(`/lookover review\n${REQUEST_MARKER}{"v":1,"reply":7} -->`)).toEqual({
      full: false,
      commit: null,
      reply: 7,
    });
  });

  test("a comment is a request when its first line, trimmed, is the command, in any case", () => {
    expect(isReviewRequest("/lookover review")).toBe(true);
    expect(isReviewRequest("  /Lookover Review  \nplease")).toBe(true);
    expect(isReviewRequest("/lookover review\r\nfrom Windows")).toBe(true);
    expect(isReviewRequest(reviewRequest(sha))).toBe(true);
  });

  test("the command anywhere but the first line, or with more on its line, is no request", () => {
    expect(isReviewRequest("Thanks!\n/lookover review")).toBe(false);
    expect(isReviewRequest("/lookover review now")).toBe(false);
    expect(isReviewRequest("/lookover reviews")).toBe(false);
    expect(isReviewRequest("")).toBe(false);
  });

  test("a comment holding any Lookover marker but the request's is no request, whatever its first line", () => {
    expect(isReviewRequest(`/lookover review\n${SUMMARY_MARKER}`)).toBe(false);
    expect(isReviewRequest(`/lookover review\n${FINDING_MARKER}{"v":1} -->`)).toBe(false);
    expect(isReviewRequest(`/lookover review\n${reviewRequest(sha)}\n${RESULT_MARKER}{} -->`)).toBe(false);
    expect(isReviewRequest(reviewRequest(sha, { reply: 1 }))).toBe(true);
  });

  test("the commit a request names is read from its marker; a plain request names none", () => {
    expect(requestedCommit(reviewRequest(sha))).toBe(sha);
    expect(requestedCommit("/lookover review")).toBeNull();
    expect(requestedCommit(`/lookover review\n${REQUEST_MARKER}{"v":1,"commit":"not-a-sha"} -->`)).toBeNull();
  });

  test("a marker in a comment that is no request names nothing", () => {
    expect(requestedCommit(`Not now.\n${reviewRequest(sha).split("\n")[1]}`)).toBeNull();
    expect(readRequest(`Not now.\n${reviewRequest(sha, { reply: 3 }).split("\n")[1]}`)).toBeNull();
  });
});
