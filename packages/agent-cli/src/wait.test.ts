// `lookover wait` through the package's entry, on a `FakeGitHost`: the App's moves are scheduled on a clock the
// command's own sleeps move, so a 30-minute wait takes milliseconds. One test per exit code, then the rules.
import { describe, expect, test } from "bun:test";
import { REQUEST_MARKER, reviewRequest } from "@lookover/contracts";
import {
  APP,
  BRANCH,
  earlier,
  finding,
  newer,
  owner,
  ref,
  result,
  sha,
  world,
} from "./agent-cli.test-support.ts";

const someone = { id: 99, login: "someone" };
/** A fork's pull request skipped when it opened (ADR 0048). */
const forkSkip = result({
  run: { state: "skipped", state_reason: "fork", trigger: "opened" },
  verdict: { value: "none", conclusion: "skipped" },
});

describe("lookover wait: exit codes", () => {
  test("0: the round says stop", async () => {
    const w = world();
    w.at(20_000, () => w.check("round", "queued"));
    w.at(60_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait", "--json")).toBe(0);
    expect(w.json()).toEqual({
      commit: sha,
      change: 7,
      exit: 0,
      meaning: "nothing_to_fix",
      message: "Lookover: nothing to fix on 5d9114c.",
      verdict: "clean",
      next_action: "stop",
      state_reason: null,
      findings: [],
    });
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha)]);
  });

  test("1: the pull request doesn't show the commit within 15 s: push first", async () => {
    const w = world();
    w.local.head = newer;
    expect(await w.lookover("wait", "--json")).toBe(1);
    expect(w.json()).toMatchObject({
      commit: newer,
      change: 7,
      exit: 1,
      meaning: "error",
      message: "Pull request #7 is at 5d9114c, not at your 6eaa25d: push first.",
    });
    expect(w.elapsed()).toBe(15_000);
    expect(w.comments()).toEqual([]);
  });

  test("2: an unknown option or a bad value", async () => {
    const w = world();
    expect(await w.lookover("wait", "--follow")).toBe(2);
    expect(await w.lookover("wait", "--timeout", "soon")).toBe(2);
    expect(await w.lookover("wait", "--pr", "seven")).toBe(2);
    expect(await w.lookover("review")).toBe(2);
    expect(w.err.filter((l) => !l.startsWith("Usage:"))).toEqual([
      'lookover wait has no option "--follow".',
      '--timeout takes a duration such as 30m, 90s or 1h, not "soon".',
      '--pr takes a pull request\'s number, not "seven".',
      'lookover has no command "review".',
    ]);
  });

  test("3: something to fix: the findings that need the agent, blocking first", async () => {
    const w = world();
    const findings = [
      finding("F1", { severity: "should_fix", title: "Totals skip refunds" }),
      finding("F2", { needs_action_by: "human", status: "escalated" }),
      finding("F3", { severity: "blocking", title: "Unpaid filter drops drafts" }),
      finding("F4", { needs_action_by: "none", status: "verified_fixed" }),
    ];
    w.at(10_000, () => w.check("round", "in_progress"));
    w.at(90_000, () =>
      w.complete(
        "round",
        "neutral",
        result({
          verdict: { value: "blocking", conclusion: "neutral" },
          loop: { state: "open", next_action: "fix" },
          findings,
        }),
      ),
    );
    expect(await w.lookover("wait", "--json")).toBe(3);
    expect(w.json()).toMatchObject({
      exit: 3,
      meaning: "fix",
      message: "Lookover: 2 findings to fix on 5d9114c.",
      verdict: "blocking",
      next_action: "fix",
      findings: [findings[2], findings[0]],
    });
  });

  test("4: a person is needed", async () => {
    const w = world();
    w.at(10_000, () => w.check("round", "in_progress"));
    w.at(20_000, () =>
      w.complete("round", "neutral", result({ loop: { state: "needs_owner", next_action: "ask_human" } })),
    );
    expect(await w.lookover("wait")).toBe(4);
    expect(w.err.at(-1)).toBe("Lookover: a person is needed on 5d9114c.");
  });

  test("5: the check is still waiting at the timeout", async () => {
    const w = world();
    w.at(10_000, () => w.check("round", "queued"));
    expect(await w.lookover("wait", "--timeout", "2m")).toBe(5);
    expect(w.elapsed()).toBe(120_000);
    expect(w.err.at(-1)).toBe(
      "No result for 5d9114c (pull request #7) after 2m: run lookover wait again to keep waiting.",
    );
  });

  test("6: the review was skipped, whatever its reason", async () => {
    const w = world();
    w.at(10_000, () => w.check("job", "queued"));
    w.at(20_000, () =>
      w.complete(
        "job",
        "skipped",
        result({
          run: { state: "skipped", state_reason: "closed" },
          verdict: { value: "none", conclusion: "skipped" },
        }),
      ),
    );
    expect(await w.lookover("wait", "--json")).toBe(6);
    expect(w.json()).toMatchObject({ exit: 6, meaning: "skipped", state_reason: "closed", verdict: "none" });
  });

  test("7: the review failed", async () => {
    const w = world();
    w.at(10_000, () => w.check("job", "in_progress"));
    w.at(20_000, () =>
      w.complete(
        "job",
        "neutral",
        result({
          run: { state: "failed", state_reason: "review_failed" },
          verdict: { value: "none", conclusion: "neutral" },
          loop: { next_action: "ask_human" },
        }),
      ),
    );
    expect(await w.lookover("wait", "--json")).toBe(7);
    expect(w.json()).toMatchObject({ exit: 7, meaning: "failed", state_reason: "review_failed" });
  });

  test("9: neither a 👀 nor a check within the appear timeout: run lookover status to see whether it runs", async () => {
    const w = world();
    expect(await w.lookover("wait")).toBe(9);
    expect(w.elapsed()).toBe(180_000);
    expect(w.err.at(-1)).toBe(
      "No review appeared for 5d9114c (pull request #7) in 3m: is Lookover running? Run lookover status.",
    );
  });

  test("10: the pull request moved past the commit", async () => {
    const w = world();
    w.at(10_000, () => w.check("round", "queued"));
    w.at(40_000, () => w.fake.push(ref, newer, []));
    expect(await w.lookover("wait", "--json")).toBe(10);
    expect(w.json()).toMatchObject({
      commit: sha,
      exit: 10,
      meaning: "newer_commit",
      message: "Pull request #7 moved on to 6eaa25d: run lookover wait for it.",
    });
  });
});

describe("lookover wait: asking", () => {
  test("a request naming the commit is there already: none is posted", async () => {
    const w = world();
    w.fake.seedComment(ref, { author: owner, body: reviewRequest(sha) });
    w.at(10_000, () => w.check("round", "queued"));
    w.at(20_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha)]);
    expect(w.err[0]).toBe("Waiting for Lookover on 5d9114c (pull request #7).");
  });

  test("the App's check is on the commit already: no request is posted", async () => {
    const w = world();
    await w.check("round", "in_progress");
    w.at(10_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.comments()).toEqual([]);
  });

  test("requests naming another commit, or none, and others' comments don't count: one is posted", async () => {
    const w = world();
    w.fake.seedComment(ref, { author: owner, body: reviewRequest(earlier) });
    w.fake.seedComment(ref, { author: someone, body: "/lookover review" });
    w.fake.seedComment(ref, { author: someone, body: `Looks good.\n${REQUEST_MARKER}${sha} -->` });
    w.at(10_000, () => w.check("round", "queued"));
    w.at(20_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.comments().at(-1)?.body).toBe(reviewRequest(sha));
    expect(w.comments()).toHaveLength(4);
    expect(w.err[0]).toBe("Asked Lookover to review 5d9114c (pull request #7).");
  });

  test("another App's check named Lookover is never read: a request is posted, and its end ends nothing", async () => {
    const w = world();
    w.fake.foreignCheck(sha, "someone-elses-app");
    w.at(10_000, () => w.check("round", "queued"));
    w.at(50_000, () => w.complete("round", "neutral", result({ loop: { next_action: "fix" } })));
    expect(await w.lookover("wait")).toBe(3);
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha)]);
  });

  test("the App named by --app is the one read; LOOKOVER_APP's is not", async () => {
    const w = world({ env: { LOOKOVER_APP: "someone-elses-app" } });
    w.at(10_000, () => w.check("round", "queued"));
    w.at(20_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait", "--app", APP)).toBe(0);
  });

  test("a check of an earlier commit is not this one's", async () => {
    const w = world();
    w.fake.push(ref, earlier, []);
    await w.check("old", "in_progress", earlier);
    await w.complete("old", "success", result({}));
    w.fake.push(ref, sha, []);
    expect(await w.lookover("wait", "--appear-timeout", "30s")).toBe(9);
  });

  test("a 👀 on the request means Lookover has it: the wait goes on past the appear timeout", async () => {
    const w = world();
    w.at(20_000, async () => {
      const request = w.comments().find((c) => c.body === reviewRequest(sha));
      if (request) await w.fake.react(ref.repo, request.id, "eyes");
    });
    w.at(240_000, () => w.check("round", "queued"));
    w.at(260_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.elapsed()).toBe(260_000);
  });

  test("a newer review took this one's place: the wait goes on, then reads the newest check", async () => {
    const w = world();
    w.at(10_000, () => w.check("first", "queued"));
    w.at(20_000, () =>
      w.complete(
        "first",
        "skipped",
        result({ run: { state: "skipped", state_reason: "replaced" }, loop: { next_action: "wait" } }),
      ),
    );
    // Reads at 20 s and 30 s see the replaced check alone.
    w.at(35_000, () => w.check("second", "queued"));
    w.at(60_000, () => w.complete("second", "success", result({})));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.elapsed()).toBe(60_000);
  });

  test("a colleague's pull request skipped when it opened, nobody asking: the request is posted, and its round read", async () => {
    const w = world();
    // The automatic "Not your pull request": an opening asked, not a person (ADR 0043: wait asks anyway).
    const notYours = result({
      run: { state: "skipped", state_reason: "not_yours", trigger: "opened" },
      verdict: { value: "none", conclusion: "skipped" },
    });
    await w.check("opened", "queued");
    await w.complete("opened", "skipped", notYours);
    w.at(30_000, () => w.check("round", "queued"));
    w.at(60_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait", "--json")).toBe(0);
    expect(w.json()).toMatchObject({ exit: 0, meaning: "nothing_to_fix" });
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha)]);
    expect(w.err[0]).toBe("Asked Lookover to review 5d9114c (pull request #7).");
    expect(w.elapsed()).toBe(60_000);
  });

  test("a pull request from a fork skipped when it opened is never asked past: 6, the skip reported, no request posted (ADR 0048)", async () => {
    const w = world({ fork: true });
    await w.check("opened", "queued");
    await w.complete("opened", "skipped", forkSkip);
    expect(await w.lookover("wait", "--pr", "7", "--json")).toBe(6);
    // The check's own skip, not `wait`'s "comes from a fork": `fork` is no rule `wait` asks past.
    expect(w.json()).toMatchObject({
      exit: 6,
      meaning: "skipped",
      state_reason: "fork",
      message: expect.stringMatching(/^Lookover skipped 5d9114c\./),
    });
    expect(w.comments()).toEqual([]);
  });

  test("a fork's skip on a pull request read as the repository's own is still never asked past: 6, no request posted", async () => {
    const w = world();
    await w.check("opened", "queued");
    await w.complete("opened", "skipped", forkSkip);
    expect(await w.lookover("wait", "--json")).toBe(6);
    expect(w.json()).toMatchObject({
      exit: 6,
      meaning: "skipped",
      state_reason: "fork",
      message: expect.stringMatching(/^Lookover skipped 5d9114c\./),
    });
    expect(w.comments()).toEqual([]);
  });

  test("a pull request from a fork the owner asked for in the app is followed: its round's answer, nothing posted (ADR 0048)", async () => {
    const w = world({ fork: true });
    await w.check("round", "in_progress");
    w.at(40_000, () =>
      w.complete(
        "round",
        "neutral",
        result({
          verdict: { value: "blocking", conclusion: "neutral" },
          loop: { state: "open", next_action: "fix" },
          findings: [finding("F1", { severity: "blocking" })],
        }),
      ),
    );
    expect(await w.lookover("wait", "--pr", "7", "--json")).toBe(3);
    expect(w.json()).toMatchObject({ exit: 3, meaning: "fix", next_action: "fix" });
    expect(w.comments()).toEqual([]);
    expect(w.err[0]).toBe("Waiting for Lookover on 5d9114c (pull request #7).");
  });

  test("a pull request from a fork the owner asked for with a comment is followed until its check comes: 0, nothing posted (ADR 0048)", async () => {
    const w = world({ fork: true });
    // The opening's skip is on the commit already; the service hasn't read the owner's comment yet.
    await w.check("opened", "queued");
    await w.complete("opened", "skipped", forkSkip);
    w.fake.seedComment(ref, { author: owner, body: reviewRequest(sha) });
    w.at(20_000, () => w.check("round", "queued"));
    w.at(50_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait", "--pr", "7", "--json")).toBe(0);
    expect(w.json()).toMatchObject({ exit: 0, meaning: "nothing_to_fix" });
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha)]);
    expect(w.elapsed()).toBe(50_000);
  });

  test("a pull request from a fork, with no check yet, is never asked for: 6 at once, why reported, nothing posted (ADR 0048)", async () => {
    const w = world({ fork: true });
    // By number: a fork's head is no branch of the repository itself.
    expect(await w.lookover("wait", "--pr", "7", "--json")).toBe(6);
    expect(w.json()).toMatchObject({
      commit: sha,
      change: 7,
      exit: 6,
      meaning: "skipped",
      message:
        "Pull request #7 comes from a fork: Lookover reviews it only when the owner asks, so lookover wait asks nothing. Ask the owner.",
      state_reason: "fork",
    });
    expect(w.comments()).toEqual([]);
    expect(w.elapsed()).toBe(0);
  });

  test("an automatic skip is no sign of Lookover: with no 👀 and no newer check, 9", async () => {
    const w = world();
    await w.check("opened", "queued");
    await w.complete(
      "opened",
      "skipped",
      result({
        run: { state: "skipped", state_reason: "not_yours", trigger: "opened" },
        verdict: { value: "none", conclusion: "skipped" },
      }),
    );
    expect(await w.lookover("wait")).toBe(9);
    expect(w.elapsed()).toBe(180_000);
  });

  test("a request skipped is an answer: 6, and none is posted again", async () => {
    const w = world();
    w.fake.seedComment(ref, { author: owner, body: reviewRequest(sha) });
    await w.check("asked", "queued");
    await w.complete(
      "asked",
      "skipped",
      result({
        run: { state: "skipped", state_reason: "repo_off", trigger: "comment" },
        verdict: { value: "none", conclusion: "skipped" },
      }),
    );
    expect(await w.lookover("wait")).toBe(6);
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(sha)]);
  });

  test("the service saw the push first and skipped this commit's check: 10, not 6", async () => {
    const w = world();
    w.at(10_000, () => w.check("round", "queued"));
    w.at(40_000, async () => {
      w.fake.push(ref, newer, []);
      await w.complete(
        "round",
        "skipped",
        result({
          run: { state: "skipped", state_reason: "newer_commit" },
          verdict: { value: "none", conclusion: "skipped" },
          loop: { next_action: "wait" },
        }),
      );
    });
    expect(await w.lookover("wait", "--json")).toBe(10);
    expect(w.json()).toMatchObject({ exit: 10, meaning: "newer_commit" });
  });
});

describe("lookover wait: finding the pull request", () => {
  test("--pr names it, whatever the branch", async () => {
    const w = world();
    w.local.branch = null;
    w.at(10_000, () => w.check("round", "queued"));
    w.at(20_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait", "--pr=7")).toBe(0);
  });

  test("on a detached head without --pr: 1", async () => {
    const w = world();
    w.local.branch = null;
    expect(await w.lookover("wait")).toBe(1);
    expect(w.err.at(-1)).toBe("Not on a branch: give the pull request with --pr.");
  });

  test("a branch with no open pull request: 1", async () => {
    const w = world();
    w.local.branch = `${BRANCH}-2`;
    expect(await w.lookover("wait")).toBe(1);
    expect(w.err.at(-1)).toBe(
      "No open pull request for feature/unpaid-2: push the branch and open one, or give --pr.",
    );
  });

  test("a push GitHub shows a few seconds late is waited for", async () => {
    const w = world();
    w.local.head = newer;
    w.at(5_000, () => w.fake.push(ref, newer, []));
    w.at(20_000, () => w.check("round", "queued", newer));
    w.at(30_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.comments().map((c) => c.body)).toEqual([reviewRequest(newer)]);
  });
});

describe("lookover wait: what it says", () => {
  test("a heartbeat on stderr every 30 s while it waits", async () => {
    const w = world();
    w.at(10_000, () => w.check("round", "queued"));
    w.at(75_000, () => w.complete("round", "success", result({})));
    expect(await w.lookover("wait")).toBe(0);
    expect(w.err).toEqual([
      "Asked Lookover to review 5d9114c (pull request #7).",
      "Still waiting for Lookover on 5d9114c: Waiting for its turn (30s).",
      "Still waiting for Lookover on 5d9114c: Waiting for its turn (1m).",
      "Lookover: nothing to fix on 5d9114c.",
    ]);
  });

  test("without --json, the findings that need the agent go on stdout as text", async () => {
    const w = world();
    const f = finding("F1", {
      title: "Unpaid filter drops drafts",
      body: "Drafts have no due date.\nKeep them.",
      location: { path: "src/invoice.ts", start_line: 12, end_line: 14, side: "head", sha },
    });
    await w.check("round", "in_progress");
    await w.complete("round", "neutral", result({ loop: { next_action: "fix" }, findings: [f] }));
    expect(await w.lookover("wait")).toBe(3);
    expect(w.out).toEqual([
      "F1 blocking src/invoice.ts:12-14: Unpaid filter drops drafts",
      "  Drafts have no due date.",
      "  Keep them.",
      "",
    ]);
    expect(w.err.at(-1)).toBe("Lookover: 1 finding to fix on 5d9114c.");
  });

  test("a check that ended without a result it can read: 1", async () => {
    const w = world();
    const id = await w.fake.createCheck(
      ref.repo,
      sha,
      "queued",
      { title: "Waiting", summary: "", text: "" },
      "job-1",
    );
    await w.fake.completeCheck(ref.repo, id, "neutral", { title: "Done", summary: "", text: "No block." });
    expect(await w.lookover("wait")).toBe(1);
    expect(w.err.at(-1)).toBe("Lookover's check on 5d9114c ended without a result this lookover can read.");
  });

  test("GitHub refusing: 1, with its reason", async () => {
    const w = world();
    w.fake.refuse("unauthorized");
    expect(await w.lookover("wait", "--json")).toBe(1);
    expect(w.json()).toMatchObject({
      exit: 1,
      meaning: "error",
      message: "The host refused the credentials (401)",
    });
  });

  test("help: the usage on stdout", async () => {
    const w = world();
    expect(await w.lookover("--help")).toBe(0);
    expect(w.out[0]).toStartWith("Usage: lookover wait");
  });
});
