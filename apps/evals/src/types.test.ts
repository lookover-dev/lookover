import { describe, expect, test } from "bun:test";
import { DAY, isRead, isSessionName, isUsable, SESSIONS, SETUPS, type SessionRecord } from "./index.ts";

const RAN = {
  session: "claude-find",
  text: "",
  json: null,
  usage: null,
  wallMs: 1000,
  cli: { name: "claude", version: "2.1.0", model: "opus" },
} as const;

describe("sessions and setups", () => {
  test("a stored session is usable when it was read, or when a confirm had nothing to judge", () => {
    const read: SessionRecord = { ...RAN, outcome: "ok", failure: null };
    const unreadable: SessionRecord = { ...RAN, outcome: "ok", failure: "missing_block" };
    const timedOut: SessionRecord = { ...RAN, outcome: "timeout", failure: "timeout" };
    expect(isUsable(read)).toBe(true);
    expect(isUsable({ session: "codex-confirms-both", outcome: "no_candidates" })).toBe(true);
    expect(isUsable(unreadable)).toBe(false);
    expect(isUsable(timedOut)).toBe(false);
  });

  test("a stored session is read only when its answer came back and was read: not when it had nothing to judge", () => {
    const read: SessionRecord = { ...RAN, outcome: "ok", failure: null };
    expect(isRead(read)).toBe(true);
    expect(isRead({ session: "codex-confirms-both", outcome: "no_candidates" })).toBe(false);
    expect(isRead({ ...RAN, outcome: "ok", failure: "missing_block" })).toBe(false);
    expect(isRead({ ...RAN, outcome: "timeout", failure: "timeout" })).toBe(false);
  });

  test("a session's name is one of the five; a day is YYYY-MM-DD", () => {
    expect(isSessionName("codex-confirms-both")).toBe(true);
    expect(isSessionName("codex-confirms-codex")).toBe(false);
    expect(isSessionName("toString")).toBe(false);
    expect(DAY.test("2026-10-10")).toBe(true);
    expect(DAY.test("2026-10-1")).toBe(false);
    expect(DAY.test("10/10/2026")).toBe(false);
  });

  test("a run that didn't answer ok can't be stored as read", () => {
    // @ts-expect-error: a session whose engine run wasn't `ok` always names its failure, so it is never usable.
    const fooled: SessionRecord = { ...RAN, outcome: "timeout", failure: null };
    expect(fooled.outcome).toBe("timeout");
  });

  test("the five sessions and the five setups, as ADR 0050 names them", () => {
    expect(Object.keys(SESSIONS)).toEqual([
      "claude-find",
      "codex-find",
      "claude-confirms-claude",
      "codex-confirms-claude",
      "codex-confirms-both",
    ]);
    expect(SETUPS).toEqual({
      quick: { finds: ["claude-find"], confirm: null },
      "quick-codex": { finds: ["codex-find"], confirm: null },
      "standard-one": { finds: ["claude-find"], confirm: "claude-confirms-claude" },
      "standard-cross": { finds: ["claude-find"], confirm: "codex-confirms-claude" },
      deep: { finds: ["claude-find", "codex-find"], confirm: "codex-confirms-both" },
    });
  });

  test("a setup's confirm judges the candidates of the very finds the setup takes", () => {
    for (const setup of Object.values(SETUPS)) {
      if (setup.confirm !== null) expect(SESSIONS[setup.confirm].of).toEqual(setup.finds);
    }
  });
});
