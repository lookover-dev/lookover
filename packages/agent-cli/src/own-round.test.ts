// A check names its pull request (ADR 0077): two pull requests on one head, #7 and #8, and the agent's verbs on #8
// read only the checks naming its person and #8, never #7's round, nor one naming no pull request.
import { describe, expect, test } from "bun:test";
import { reviewRequest } from "@lookover/contracts";
import { finding, iso, other, ref, result, sha, world } from "./agent-cli.test-support.ts";

/** #7's round: F1 verified fixed, nothing left to do. */
const fixedOnSeven = () =>
  result({
    run: { started_at: iso(-60_000), completed_at: iso(-30_000) },
    findings: [finding("F1", { status: "verified_fixed", needs_action_by: "none" })],
  });

/** A round with F1 to fix. */
const fix = () =>
  result({
    run: { started_at: iso(10_000), completed_at: iso(30_000) },
    loop: { next_action: "fix" },
    verdict: { value: "blocking", conclusion: "neutral" },
    findings: [finding("F1")],
  });

describe("wait on the second pull request of a head", () => {
  test("another pull request's completed check: it asks, resolves no thread, and ends on its own check", async () => {
    const w = world({ second: true });
    const [root = 0] = await w.reviewOn(other, "F1");
    await w.check("seven", "in_progress");
    await w.complete("seven", "success", fixedOnSeven());
    w.at(20_000, () => w.check("eight", "queued", { pr: other.number }));
    w.at(40_000, () => w.complete("eight", "neutral", fix()));
    expect(await w.lookover("wait", "--pr", "8")).toBe(3);
    expect(w.elapsed()).toBe(40_000);
    expect(w.comments(other).map((c) => c.body)).toEqual([reviewRequest(sha)]);
    expect(w.comments(ref)).toEqual([]);
    expect((await w.threads(other)).map((t) => [t.commentId, t.resolved])).toEqual([[root, false]]);
    expect(w.err[0]).toBe("Asked Lookover to review 5d9114c (pull request #8).");
  });

  test("another pull request's running check doesn't hold it: it asks, and ends on its own", async () => {
    const w = world({ second: true });
    await w.check("seven", "in_progress");
    w.at(20_000, () => w.check("eight", "queued", { pr: other.number }));
    w.at(40_000, () => w.complete("eight", "success", result({})));
    expect(await w.lookover("wait", "--pr", "8")).toBe(0);
    expect(w.elapsed()).toBe(40_000);
    expect(w.comments(other).map((c) => c.body)).toEqual([reviewRequest(sha)]);
  });

  test("another pull request's running check is no sign Lookover is at work on this one: no review appears", async () => {
    const w = world({ second: true });
    await w.check("seven", "in_progress");
    expect(await w.lookover("wait", "--pr", "8", "--appear-timeout", "1m")).toBe(9);
    expect(w.comments(other).map((c) => c.body)).toEqual([reviewRequest(sha)]);
  });

  test("a check naming no pull request, as before ADR 0077, is no one's: it asks, and no review appears", async () => {
    const w = world();
    await w.check("old", "in_progress", { pr: null });
    await w.complete("old", "success", result({}));
    expect(await w.lookover("wait", "--appear-timeout", "1m")).toBe(9);
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha)]);
  });

  for (const [said, round, exit] of [
    ["nothing to fix", () => result({ run: { started_at: iso(10_000), completed_at: iso(30_000) } }), 0],
    ["something to fix", fix, 3],
  ] as const)
    test(`a check naming no pull request, then the asked one, ${said}: it ends on the asked one (${exit})`, async () => {
      const w = world();
      await w.check("old", "in_progress", { pr: null });
      await w.complete("old", "neutral", fix());
      w.at(20_000, () => w.check("asked", "queued"));
      w.at(40_000, () => w.complete("asked", exit === 0 ? "success" : "neutral", round()));
      expect(await w.lookover("wait")).toBe(exit);
      expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha)]);
    });

  test("another job's check for the same person and pull request counts: it asks nothing and reads it", async () => {
    const w = world();
    await w.check("first", "in_progress");
    await w.complete("first", "neutral", fix());
    await w.check("second", "in_progress");
    await w.complete("second", "success", result({}));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.comments()).toEqual([]);
  });
});

describe("feedback and reply on the second pull request of a head", () => {
  for (const done of [false, true])
    test(`feedback with only the other pull request's check, ${done ? "done" : "running"}: no review yet`, async () => {
      const w = world({ second: true });
      await w.check("seven", "in_progress");
      if (done) await w.complete("seven", "neutral", fix());
      expect(await w.lookover("feedback", "--pr", "8")).toBe(9);
      expect(w.err.at(-1)).toBe("No review of 5d9114c (pull request #8) yet: run lookover wait.");
    });

  test("reply: the status block only is said from its own pull request's result, never the other's", async () => {
    const w = world({ second: true });
    const inBlock = result({ findings: [finding("F1", { placement: "status", location: null })] });
    await w.check("seven", "in_progress");
    await w.complete("seven", "neutral", inBlock);
    expect(await w.lookover("reply", "F1", "wont-fix", "Not here.", "--pr", "8")).toBe(1);
    expect(w.err).toEqual(["Lookover has no thread for F1 on pull request #8."]);
    w.err.length = 0;
    await w.check("eight", "in_progress", { pr: other.number });
    await w.complete("eight", "neutral", inBlock);
    expect(await w.lookover("reply", "F1", "wont-fix", "Not here.", "--pr", "8")).toBe(1);
    expect(w.err[0]).toStartWith("F1 is in the status block only");
  });
});
