// `lookover settle` (ADR 0101) through the package's entry, on a `FakeGitHost`: the refusals of a wrong call (2), the
// refusals before posting (1, nothing posted), then the settle comment and Lookover's answer on it, 🚀 (0) or 😕 (1),
// or none in time (1). Lookover's reactions are scheduled on the clock the command's own sleeps move.
import { describe, expect, test } from "bun:test";
import { findingId, REASON_MAX, settleComment } from "@lookover/contracts";
import { colleague, finding, newer, ref, result, world } from "./agent-cli.test-support.ts";
import { SKILL_TEMPLATE } from "./index.ts";

const REASON = "The deploy window covers the last invoice.";

/** A round asking for the owner: F1 escalated, F2 in the status block only and open, F3 kept off the pull request. */
const escalated = () =>
  result({
    verdict: { value: "blocking", conclusion: "neutral" },
    loop: { state: "open", next_action: "ask_human" },
    findings: [
      finding("F1", { status: "escalated", needs_action_by: "human" }),
      finding("F2", { placement: "status", location: null }),
      finding("F3", { posted: false, placement: "check_only" }),
      finding("F4", { status: "accepted", needs_action_by: "none" }),
    ],
  });

/** A world whose head has a completed round, `escalated()` unless given another. */
async function rounded(r = escalated()) {
  const w = world();
  await w.check("round", "in_progress");
  await w.complete("round", "neutral", r);
  return w;
}

/**
 * A world whose head holds a round left running (a sign-in change cancelled it without telling GitHub), then a newer
 * round completed on the same head, `escalated()` unless given another.
 */
async function abandoned(r = escalated()) {
  const w = world();
  await w.check("cancelled", "in_progress");
  await w.check("round", "in_progress");
  await w.complete("round", "neutral", r);
  return w;
}

/**
 * A world whose head holds a completed round, then a round running, then a follow-up queued behind it (another review
 * asked for during the running one).
 */
async function followed() {
  const w = await rounded();
  await w.check("running", "in_progress");
  await w.check("follow-up", "queued");
  return w;
}

/** The settle comments the agent posted. */
const settles = (w: ReturnType<typeof world>) =>
  w.comments().filter((c) => c.body.startsWith("/lookover settle"));

/**
 * Lookover reacts `reaction` on the settle comment `ms` past the start; given `by`, a teammate of that id reacts
 * instead.
 */
function answer(w: ReturnType<typeof world>, ms: number, reaction: "rocket" | "confused", by?: number) {
  w.at(ms, async () => {
    const [comment] = settles(w);
    if (!comment) return;
    if (by === undefined) await w.fake.react(ref.repo, comment.id, reaction);
    else w.fake.reactAs(by, comment.id, reaction);
  });
}

const settle = (w: ReturnType<typeof world>, ...more: string[]) =>
  w.lookover("settle", ...more.slice(0, 2), "--confirmed-by-owner", ...more.slice(2));

describe("lookover settle: a wrong call is 2, and posts nothing", () => {
  test.each([
    [
      ["settle", "F1", "accepted"],
      "lookover settle needs --confirmed-by-owner and the person's reason: settle only what the person told you to settle, in their words.",
    ],
    [["settle", "F1", "accepted", "--confirmed-by-owner"], "--confirmed-by-owner needs a value."],
    [
      ["settle", "F1", "accepted", "--confirmed-by-owner", "   "],
      "--confirmed-by-owner needs the person's reason, in their words.",
    ],
    [
      ["settle", "F1", "accepted", "--confirmed-by-owner", `${"word ".repeat(40)}x`],
      "The reason is 201 characters: say it in 200 or fewer.",
    ],
    [["settle", "1", "accepted", "--confirmed-by-owner", REASON], '"1" is no finding: name one as F3.'],
    [
      ["settle", "F1", "dismissed", "--confirmed-by-owner", REASON],
      '"dismissed" is no decision: say accepted or wrong.',
    ],
    [
      ["settle", "F1", "--confirmed-by-owner", REASON],
      'lookover settle takes the finding and the decision: lookover settle F3 accepted --confirmed-by-owner "…".',
    ],
    [
      ["settle", "F1", "accepted", "now", "--confirmed-by-owner", REASON],
      'lookover settle takes the finding and the decision: lookover settle F3 accepted --confirmed-by-owner "…".',
    ],
    [
      ["settle", "F1", "accepted", "--confirmed-by-owner", REASON, "--appear-timeout", "1m"],
      'lookover settle has no option "--appear-timeout".',
    ],
  ])("%j", async (argv, said) => {
    const w = await rounded();
    expect(await w.lookover(...argv)).toBe(2);
    expect(w.err[0]).toBe(said);
    expect(w.err[1]).toStartWith("Usage:");
    expect(settles(w)).toEqual([]);
  });

  test("a reason of 200 characters once its white space is collapsed is taken", async () => {
    const w = await rounded();
    answer(w, 10_000, "rocket");
    expect(await settle(w, "F1", "accepted", `  ${"word \n ".repeat(39)}fives `)).toBe(0);
    expect(settles(w).map((c) => c.body)).toEqual([
      settleComment({ finding: findingId("F1"), decision: "accepted", reason: `${"word ".repeat(39)}fives` }),
    ]);
  });
  test("the skill gives the reason's limit as the service keeps it", () => {
    expect(SKILL_TEMPLATE.replace(/\s+/g, " ")).toContain(`on one line of at most ${REASON_MAX} characters`);
  });
});

describe("lookover settle: refused before posting, on what the newest round says", () => {
  test.each([
    [
      "F9",
      "Lookover's newest round on 5d9114c (pull request #7) has no F9: run lookover feedback to see its findings.",
    ],
    [
      "F3",
      "F3 isn't on the pull request: Lookover kept it off, so there is nothing to settle, and it doesn't hold the review open.",
    ],
    ["F4", "F4 is settled already: accepted as is. Run lookover wait."],
  ])("%s", async (id, said) => {
    const w = await rounded();
    expect(await settle(w, id, "wrong", REASON)).toBe(1);
    expect(w.err).toEqual([said]);
    expect(settles(w)).toEqual([]);
  });

  test("a result cut to fit GitHub's limit, without the finding: no definite answer, it posts", async () => {
    const w = await rounded({ ...escalated(), truncated: true });
    answer(w, 10_000, "rocket");
    expect(await settle(w, "F9", "accepted", REASON)).toBe(0);
    expect(settles(w)).toHaveLength(1);
  });

  test("a round running on the head: refused, run wait and settle again", async () => {
    const w = await rounded();
    await w.check("again", "in_progress");
    expect(await settle(w, "F1", "accepted", REASON)).toBe(1);
    expect(w.err).toEqual([
      "Lookover is reviewing 5d9114c (pull request #7): run lookover wait, then settle F1 again on the same answer.",
    ]);
    expect(settles(w)).toEqual([]);
  });

  test("a round left running under a newer completed one is no round running: the newer one is read", async () => {
    const posts = await abandoned();
    answer(posts, 10_000, "rocket");
    expect(await settle(posts, "F1", "accepted", REASON)).toBe(0);
    expect(settles(posts)).toHaveLength(1);
    const refused = await abandoned();
    expect(await settle(refused, "F4", "accepted", REASON)).toBe(1);
    expect(refused.err).toEqual(["F4 is settled already: accepted as is. Run lookover wait."]);
  });

  test("a follow-up queued behind a running round hides nothing: refused, run wait and settle again", async () => {
    const w = await followed();
    expect(await settle(w, "F1", "accepted", REASON)).toBe(1);
    expect(w.err).toEqual([
      "Lookover is reviewing 5d9114c (pull request #7): run lookover wait, then settle F1 again on the same answer.",
    ]);
    expect(settles(w)).toEqual([]);
  });

  test("a round only queued on the head refuses nothing: the newest completed round is read", async () => {
    const w = await rounded();
    await w.check("again", "queued");
    answer(w, 10_000, "rocket");
    expect(await settle(w, "F1", "accepted", REASON)).toBe(0);
  });

  test("a lone queued check on the head says nothing for sure: it posts", async () => {
    const w = world();
    await w.check("again", "queued");
    answer(w, 10_000, "rocket");
    expect(await settle(w, "F1", "accepted", REASON)).toBe(0);
    expect(settles(w)).toHaveLength(1);
  });

  test("no check on the head: it posts, and Lookover's answer says the rest", async () => {
    const w = world();
    await w.check("round", "in_progress", { on: newer });
    answer(w, 10_000, "rocket");
    expect(await settle(w, "F7", "wrong", REASON)).toBe(0);
    expect(settles(w)).toHaveLength(1);
  });

  test("another person's round on the head is none of the agent's: it posts", async () => {
    const w = world();
    await w.check("theirs", "in_progress", { by: 7654321 });
    answer(w, 10_000, "rocket");
    expect(await settle(w, "F1", "accepted", REASON)).toBe(0);
  });
});

describe("lookover settle: the comment and Lookover's answer", () => {
  test("accepted: the comment asks, 🚀 settles, 0", async () => {
    const w = await rounded();
    answer(w, 20_000, "rocket");
    expect(await settle(w, "F1", "accepted", REASON)).toBe(0);
    expect(settles(w).map((c) => c.body)).toEqual([
      settleComment({ finding: findingId("F1"), decision: "accepted", reason: REASON }),
    ]);
    expect(w.err).toEqual([
      "Asked Lookover to accept F1 as is, on the owner's word (pull request #7).",
      "F1 accepted as is on the owner's word. Run lookover wait.",
    ]);
    expect(w.elapsed()).toBe(20_000);
  });

  test("wrong, on a finding in the status block only, with --pr: 🚀, 0", async () => {
    const w = await rounded();
    answer(w, 10_000, "rocket");
    expect(await settle(w, "f2", "wrong", REASON, "--pr", "7")).toBe(0);
    expect(settles(w).map((c) => c.body)).toEqual([
      settleComment({ finding: findingId("F2"), decision: "wrong", reason: REASON }),
    ]);
    expect(w.err.at(-1)).toBe("F2 marked wrong on the owner's word. Run lookover wait.");
  });

  test("😕 for a round that started meanwhile: 1, saying so from the newest result", async () => {
    const w = await rounded();
    w.at(5_000, () => w.check("again", "in_progress"));
    answer(w, 10_000, "confused");
    expect(await settle(w, "F1", "accepted", REASON)).toBe(1);
    expect(w.err.at(-1)).toBe(
      "Lookover refused to settle F1. Lookover is reviewing 5d9114c (pull request #7): run lookover wait, then settle F1 again on the same answer.",
    );
  });

  test("😕 for a finding settled meanwhile: 1, saying how", async () => {
    const w = await rounded();
    w.at(5_000, async () => {
      await w.check("again", "in_progress");
      await w.complete(
        "again",
        "success",
        result({ findings: [finding("F1", { status: "dismissed", needs_action_by: "none" })] }),
      );
    });
    answer(w, 10_000, "confused");
    expect(await settle(w, "F1", "accepted", REASON)).toBe(1);
    expect(w.err.at(-1)).toBe(
      "Lookover refused to settle F1. F1 is settled already: marked wrong. Run lookover wait.",
    );
  });

  test("a teammate's 🚀 or 😕 is none of Lookover's: the wait goes on to Lookover's own 🚀", async () => {
    const w = await rounded();
    answer(w, 5_000, "rocket", colleague.id);
    answer(w, 5_000, "confused", colleague.id);
    answer(w, 30_000, "rocket");
    expect(await settle(w, "F1", "accepted", REASON)).toBe(0);
    expect(w.elapsed()).toBe(30_000);
    expect(w.err.at(-1)).toBe("F1 accepted as is on the owner's word. Run lookover wait.");
  });

  test("a teammate's 🚀 alone: no answer in time, 1", async () => {
    const w = await rounded();
    answer(w, 5_000, "rocket", colleague.id);
    expect(await settle(w, "F1", "accepted", REASON, "--timeout", "1m")).toBe(1);
    expect(w.elapsed()).toBe(60_000);
  });

  test("😕 with nothing the newest result explains: 1, pointing at feedback", async () => {
    const w = await rounded();
    answer(w, 10_000, "confused");
    expect(await settle(w, "F1", "accepted", REASON)).toBe(1);
    expect(w.err.at(-1)).toBe(
      "Lookover refused to settle F1. Run lookover feedback to see where it stands, and ask the person again if it still needs them.",
    );
  });

  test("😕 or no answer, on a cut result without the finding: never claimed missing", async () => {
    const cut = { ...escalated(), truncated: true };
    const refused = await rounded(cut);
    answer(refused, 10_000, "confused");
    expect(await settle(refused, "F9", "accepted", REASON)).toBe(1);
    expect(refused.err.at(-1)).toBe(
      "Lookover refused to settle F9. Run lookover feedback to see where it stands, and ask the person again if it still needs them.",
    );
    const silent = await rounded(cut);
    expect(await settle(silent, "F9", "accepted", REASON, "--timeout", "1m")).toBe(1);
    expect(silent.err.at(-1)).toBe(
      "Lookover didn't answer the settle of F9 in 1m: it may not be running (run lookover status). The owner can settle it in Lookover's app too (run lookover open).",
    );
  });

  test("😕 or no answer, a round left running under a newer completed one: never named running", async () => {
    const refused = await abandoned();
    answer(refused, 10_000, "confused");
    expect(await settle(refused, "F1", "accepted", REASON)).toBe(1);
    expect(refused.err.at(-1)).toBe(
      "Lookover refused to settle F1. Run lookover feedback to see where it stands, and ask the person again if it still needs them.",
    );
    const silent = await abandoned();
    expect(await settle(silent, "F1", "accepted", REASON, "--timeout", "1m")).toBe(1);
    expect(silent.err.at(-1)).toBe(
      "Lookover didn't answer the settle of F1 in 1m: it may not be running (run lookover status). The owner can settle it in Lookover's app too (run lookover open).",
    );
  });

  test("😕 or no answer, a follow-up queued behind a round started meanwhile: the round is named", async () => {
    const refused = await rounded();
    refused.at(5_000, async () => {
      await refused.check("running", "in_progress");
      await refused.check("follow-up", "queued");
    });
    answer(refused, 10_000, "confused");
    expect(await settle(refused, "F1", "accepted", REASON)).toBe(1);
    expect(refused.err.at(-1)).toBe(
      "Lookover refused to settle F1. Lookover is reviewing 5d9114c (pull request #7): run lookover wait, then settle F1 again on the same answer.",
    );
    const silent = await rounded();
    silent.at(5_000, async () => {
      await silent.check("running", "in_progress");
      await silent.check("follow-up", "queued");
    });
    expect(await settle(silent, "F1", "accepted", REASON, "--timeout", "1m")).toBe(1);
    expect(silent.err.at(-1)).toBe(
      "Lookover didn't answer the settle of F1 in 1m. Lookover is reviewing 5d9114c (pull request #7): run lookover wait, then settle F1 again on the same answer.",
    );
  });

  test("no answer within --timeout: 1, naming status and open", async () => {
    const w = await rounded();
    expect(await settle(w, "F1", "accepted", REASON, "--timeout", "1m")).toBe(1);
    expect(w.elapsed()).toBe(60_000);
    expect(w.err.at(-1)).toBe(
      "Lookover didn't answer the settle of F1 in 1m: it may not be running (run lookover status). The owner can settle it in Lookover's app too (run lookover open).",
    );
  });

  test("no answer in time while a round runs on the head: 1, naming the round", async () => {
    const w = await rounded();
    w.at(5_000, () => w.check("again", "in_progress"));
    expect(await settle(w, "F1", "accepted", REASON, "--timeout", "1m")).toBe(1);
    expect(w.err.at(-1)).toBe(
      "Lookover didn't answer the settle of F1 in 1m. Lookover is reviewing 5d9114c (pull request #7): run lookover wait, then settle F1 again on the same answer.",
    );
  });

  test("3 minutes by default", async () => {
    const w = await rounded();
    expect(await settle(w, "F1", "accepted", REASON)).toBe(1);
    expect(w.elapsed()).toBe(180_000);
  });

  test("a pull request that isn't one: 1, nothing posted", async () => {
    const w = await rounded();
    expect(await settle(w, "F1", "accepted", REASON, "--pr", "99")).toBe(1);
    expect(settles(w)).toEqual([]);
  });
});
