// The settle comment (ADR 0101): what `lookover settle` posts to settle a finding on the owner's word, and what the
// service reads back from any comment.
import { describe, expect, test } from "bun:test";
import {
  commitSha,
  findingId,
  REPLY_MARKER,
  readRequest,
  readSettle,
  reviewRequest,
  SETTLE_MARKER,
  STATUS_MARKER,
  settleComment,
} from "./index.ts";

const F2 = findingId("F2");
/** The invisible break the sentence puts in (U+200B); the expected texts are written by hand. */
const Z = "\u{200B}";

describe("settle comments", () => {
  test("the comment is the command, a sentence that asks, then the marker naming the finding, decision, reason and the owner's word", () => {
    expect(settleComment({ finding: F2, decision: "accepted", reason: "We keep the retry on purpose" })).toBe(
      "/lookover settle F2 accepted\n" +
        "The coding agent asks Lookover, on the owner's word, to accept F2 as is: “We keep the retry on purpose”\n" +
        `${SETTLE_MARKER}{"v":1,"finding":"F2","decision":"accepted","reason":"We keep the retry on purpose","confirmed":"owner"} -->`,
    );
    expect(
      settleComment({ finding: F2, decision: "wrong", reason: "The lock is held there" }).split("\n")[1],
    ).toBe(
      "The coding agent asks Lookover, on the owner's word, to mark F2 as wrong: “The lock is held there”",
    );
  });

  test("the comment reads back as the settle it says", () => {
    for (const decision of ["accepted", "wrong"] as const) {
      const settle = { finding: findingId("F12"), decision, reason: "Out of scope for this pull request" };
      expect(readSettle(settleComment(settle))).toEqual(settle);
    }
  });

  test("the reason's mentions and markup are neutralised in the sentence, and kept whole in the marker", () => {
    const reason = "@octo said <b>no</b> ![x](y) &amp; ``` run";
    const body = settleComment({ finding: F2, decision: "wrong", reason });
    expect(body.split("\n")[1]).toBe(
      "The coding agent asks Lookover, on the owner's word, to mark F2 as wrong: " +
        `“@${Z}octo said <${Z}b>no<${Z}/b> !${Z}[x](y) &${Z}amp; ${Z}\`\`\` run”`,
    );
    expect(readSettle(body)?.reason).toBe(reason);
  });

  test("a reason holding a line or paragraph separator keeps the marker's JSON on its one line", () => {
    const reason = "first\u{2028}second\u{2029}third";
    const body = settleComment({ finding: F2, decision: "wrong", reason });
    expect(body.split("\n")[2]).toBe(
      `${SETTLE_MARKER}{"v":1,"finding":"F2","decision":"wrong","reason":"first\\u2028second\\u2029third","confirmed":"owner"} -->`,
    );
    expect(readSettle(body)?.reason).toBe(reason);
  });

  test("a reason holding `-->` or a Lookover marker neither ends the marker nor hides the settle", () => {
    const reason = `it --> ends ${STATUS_MARKER} here`;
    const body = settleComment({ finding: F2, decision: "accepted", reason });
    const marker = (body.split("\n")[2] ?? "").slice(SETTLE_MARKER.length);
    expect(marker.indexOf("-->")).toBe(marker.length - 3);
    expect(marker).not.toContain("<");
    expect(readSettle(body)).toEqual({ finding: F2, decision: "accepted", reason });
  });

  test("a reason on many lines is one line in the sentence", () => {
    const body = settleComment({ finding: F2, decision: "wrong", reason: "first\nsecond" });
    expect(body.split("\n")).toHaveLength(3);
    expect(readSettle(body)?.reason).toBe("first\nsecond");
  });

  test("a command written by hand settles nothing", () => {
    expect(readSettle("/lookover settle F2 accepted")).toBeNull();
    expect(readSettle("/lookover settle F2 wrong\nThe owner says so.")).toBeNull();
  });

  test("a malformed marker settles nothing", () => {
    const marker = (json: string) => `/lookover settle F2 accepted\nAsks.\n${SETTLE_MARKER}${json} -->`;
    const good = { v: 1, finding: "F2", decision: "accepted", reason: "fine", confirmed: "owner" };
    expect(readSettle(marker(JSON.stringify(good)))).toEqual({
      finding: F2,
      decision: "accepted",
      reason: "fine",
    });
    expect(readSettle(marker("{not json"))).toBeNull();
    expect(readSettle(marker(JSON.stringify({ ...good, v: 2 })))).toBeNull();
    expect(readSettle(marker(JSON.stringify({ ...good, confirmed: "agent" })))).toBeNull();
    expect(readSettle(marker(JSON.stringify({ ...good, decision: "fixed" })))).toBeNull();
    expect(readSettle(marker(JSON.stringify({ ...good, finding: "F0" })))).toBeNull();
    expect(readSettle(marker(JSON.stringify({ ...good, finding: "x" })))).toBeNull();
    expect(readSettle(marker(JSON.stringify({ ...good, reason: "  " })))).toBeNull();
    expect(readSettle(marker(JSON.stringify({ ...good, reason: 3 })))).toBeNull();
    expect(readSettle(marker(JSON.stringify({ ...good, finding: "F3" })))).toBeNull();
    expect(readSettle(marker(JSON.stringify({ ...good, decision: "wrong" })))).toBeNull();
    expect(readSettle(`/lookover settle F2 accepted\n${SETTLE_MARKER}${JSON.stringify(good)}`)).toBeNull();
  });

  test("a Lookover post quoting the comment settles nothing", () => {
    const body = settleComment({ finding: F2, decision: "accepted", reason: "fine" });
    expect(readSettle(`${body}\n${REPLY_MARKER}{"v":1} -->`)).toBeNull();
    expect(readSettle(`${body}\n${STATUS_MARKER}`)).toBeNull();
    expect(readSettle(`Lookover saw:\n${body}`)).toBeNull();
    expect(readSettle(`${body}\n${body.split("\n")[2]}`)).toBeNull();
  });

  test("a settle is never a review request, and a review request never a settle", () => {
    const sha = commitSha("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    expect(readRequest(settleComment({ finding: F2, decision: "accepted", reason: "fine" }))).toBeNull();
    expect(readSettle(reviewRequest(sha))).toBeNull();
    expect(readSettle("/lookover review")).toBeNull();
  });
});
