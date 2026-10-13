// The reply marker each of Lookover's replies on its threads ends with (ADR 0052), written and read back.
import { describe, expect, test } from "bun:test";
import { findingId, REPLY_MARKER, readReplyMarker, replyMarker, runId } from "./index.ts";

describe("the reply marker", () => {
  test("a round's names its run, the finding and the claim it answers", () => {
    expect(replyMarker({ run: runId("run-2"), finding: findingId("F1"), claim: 100002 })).toBe(
      `${REPLY_MARKER}{"v":1,"run":"run-2","finding":"F1","claim":100002} -->`,
    );
    expect(replyMarker({ run: runId("run-2"), finding: findingId("F1") })).toBe(
      `${REPLY_MARKER}{"v":1,"run":"run-2","finding":"F1"} -->`,
    );
  });

  test("the owner's dismissal's names the dismissal and the finding", () => {
    expect(replyMarker({ dismissal: "d-7", finding: findingId("F3") })).toBe(
      `${REPLY_MARKER}{"v":1,"dismissal":"d-7","finding":"F3"} -->`,
    );
  });

  test("read back: the claim it answers, and what the reply says without it", () => {
    const marker = replyMarker({ run: runId("run-2"), finding: findingId("F1"), claim: 100002 });
    expect(readReplyMarker(`Kept.\n\nStill loops.\n\n${marker}`)).toEqual({
      claim: 100002,
      text: "Kept.\n\nStill loops.",
    });
  });

  test("a marker naming no claim, or one Lookover doesn't write, answers none; a body without one is no reply's", () => {
    const dismissed = replyMarker({ dismissal: "d-7", finding: findingId("F3") });
    expect(readReplyMarker(`Dismissed by the owner.\n\n${dismissed}`)).toEqual({
      claim: null,
      text: "Dismissed by the owner.",
    });
    expect(readReplyMarker(`Kept.\n${REPLY_MARKER}not json -->`)).toEqual({ claim: null, text: "Kept." });
    expect(readReplyMarker(`Kept.\n${REPLY_MARKER}{"v":1,"claim":"7"} -->`)).toEqual({
      claim: null,
      text: "Kept.",
    });
    expect(readReplyMarker(`Kept.\n${REPLY_MARKER}{"v":1,"claim":7}`)).toEqual({
      claim: null,
      text: "Kept.",
    });
    expect(readReplyMarker("Won't fix: the caller checks it.")).toBeNull();
  });
});
