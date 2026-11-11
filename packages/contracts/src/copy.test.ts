// The shared phrases, through the entry: written by hand from the copy the app and the check say.
import { expect, test } from "bun:test";
import {
  asSentence,
  cancelPhrase,
  cancelText,
  confirmFailureText,
  deferralText,
  ENDED_LINE,
  type EngineId,
  endedHead,
  engineDeferral,
  engineDetailText,
  engineHealthText,
  engineName,
  escalationText,
  type FailureCause,
  failedHead,
  failedLine,
  failedTitle,
  failureWords,
  findersText,
  foundAndCheckedText,
  type JobFailureKind,
  keptText,
  lookingOverHead,
  NEEDS_YOUR_LOOK,
  NOTHING_NEW_TO_CHECK,
  notInDiffText,
  postWaitText,
  pushedText,
  replyKind,
  roundCountsText,
  roundLine,
  shortSha,
  skipText,
  startsOnceText,
  TRY_AGAIN,
  twoDigits,
  UNFINISHED_SAFETY_CHECK,
  unusableFixedText,
  unusableStateText,
  upperFirst,
  waitingHead,
  waitingText,
} from "./index.ts";

test("an engine is named after its program", () => {
  expect([engineName("claude"), engineName("codex")]).toEqual(["Claude", "Codex"]);
});

test("why a review waits names the engine it waits for", () => {
  expect(deferralText({ reason: "paused" })).toBe("reviews are paused");
  expect(deferralText({ reason: "connection" })).toBe("GitHub is disconnected");
  expect(deferralText({ reason: "engine-signed-out", engine: "claude" })).toBe("Claude is signed out");
  expect(deferralText({ reason: "engine-missing", engine: "codex", unusable: null })).toBe(
    "Codex is not installed",
  );
  const tooOld = { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  expect(deferralText({ reason: "engine-missing", engine: "codex", unusable: tooOld })).toBe(
    "Codex 0.161.0 is too old for gpt-6.1-sol",
  );
  const apiKey = { kind: "signed-in-otherwise", how: "an API key" } as const;
  expect(deferralText({ reason: "engine-missing", engine: "codex", unusable: apiKey })).toBe(
    "Codex is signed in with an API key, not ChatGPT",
  );
  expect(
    deferralText({ reason: "engine-missing", engine: "claude", unusable: { kind: "npm-launcher" } }),
  ).toBe("only npm's claude launcher was found");
  expect(deferralText({ reason: "engine-limit", engine: "codex" })).toBe("Codex reached its limit");
  expect(deferralText({ reason: "engine-failed-self-test", engine: "codex" })).toBe(
    "Codex didn't pass Lookover's safety check",
  );
  expect(deferralText({ reason: "engine-self-test-unfinished", engine: "codex" })).toBe(
    "Codex couldn't finish Lookover's safety check",
  );
});

test("a self-test that couldn't finish (ADR 0075): its state's words, and when the review it holds starts", () => {
  expect(UNFINISHED_SAFETY_CHECK).toBe("couldn't finish Lookover's safety check");
  const unfinished = { reason: "engine-self-test-unfinished", engine: "codex" } as const;
  expect(startsOnceText(unfinished)).toBe("by itself once Codex passes it");
  expect(waitingText(unfinished, null)).toBe(
    "Codex couldn't finish Lookover's safety check. The review starts by itself once Codex passes it.",
  );
  expect(engineDeferral("claude", "self-test-unfinished")).toEqual({
    reason: "engine-self-test-unfinished",
    engine: "claude",
  });
});

test("what makes a program found but unusable usable: the app says it to you of the engine it just named", () => {
  const tooOld = { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  const apiKey = { kind: "signed-in-otherwise", how: "an API key" } as const;
  const npm = { kind: "npm-launcher" } as const;
  expect([tooOld, apiKey, npm].map((why) => unusableFixedText(why, "codex", "you"))).toEqual([
    "it is updated",
    "you sign in with ChatGPT",
    "the native program is installed",
  ]);
  expect([tooOld, apiKey, npm].map((why) => unusableFixedText(why, "codex", "the owner"))).toEqual([
    "Codex is updated",
    "the owner signs Codex in with ChatGPT",
    "the native codex program is installed",
  ]);
  expect([tooOld, apiKey, npm, null].map(unusableStateText)).toEqual(["too old", null, null, null]);
});

test("an AI not installed gives this machine's command to install it: Claude's own installer, npm for Codex", () => {
  const missing = { installed: false } as const;
  expect(engineDetailText("claude", missing, "win32")).toBe(
    "The claude program was not found on this computer. Install it in PowerShell, then check again: irm https://claude.ai/install.ps1 | iex",
  );
  for (const platform of ["darwin", "linux"]) {
    expect(engineDetailText("claude", missing, platform)).toBe(
      "The claude program was not found on this computer. Install it, then check again: curl -fsSL https://claude.ai/install.sh | bash",
    );
  }
  for (const platform of ["win32", "darwin", "linux"]) {
    expect(engineDetailText("codex", missing, platform)).toBe(
      "The codex program was not found on this computer. Install it, then check again: npm install -g @openai/codex",
    );
  }
});

test("npm's launcher alone gives the native program's command; Windows' in the status menu, where it is looked for", () => {
  const npm = { installed: false, why: { kind: "npm-launcher" } } as const;
  const windows =
    "Only npm's claude launcher was found, and it runs Claude through Node. Install the native claude program in PowerShell, then check again: irm https://claude.ai/install.ps1 | iex";
  expect(engineDetailText("claude", npm, "win32")).toBe(windows);
  expect(engineDetailText("claude", npm, "linux")).toBe(
    "Only npm's claude launcher was found, and it runs Claude through Node. Install the native claude program, then check again: curl -fsSL https://claude.ai/install.sh | bash",
  );
  expect(engineHealthText({ kind: "npm-launcher" }, "claude")).toBe(windows);
});

test("an AI found and usable has no detail; one found but unusable says why, whatever the machine", () => {
  expect(engineDetailText("claude", { installed: true }, "win32")).toBe("");
  const tooOld = { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  expect(engineDetailText("codex", { installed: false, why: tooOld }, "linux")).toBe(
    "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.161.0. Update it, then check again: npm install -g @openai/codex@latest",
  );
});

test("why a review did not run, with no cause, names the engine that gave no review, or says the reviewer", () => {
  const failureText = (failure: { kind: JobFailureKind; engine: EngineId | null } | null) =>
    failureWords(failure === null ? null : { ...failure, cause: null, limitMs: null }).phrase;
  expect(failureText({ kind: "review_failed", engine: "codex" })).toBe("Codex gave no review");
  expect(failureText({ kind: "review_failed", engine: null })).toBe("the reviewer gave no review");
  expect(failureText({ kind: "service_stopped", engine: "claude" })).toBe(
    "the service stopped before the review finished",
  );
  expect(failureText({ kind: "prepare_failed", engine: "claude" })).toBe("the code could not be fetched");
  expect(failureText({ kind: "publish_failed", engine: "claude" })).toBe("GitHub refused a post");
  expect(failureText({ kind: "host_failed", engine: null })).toBe("GitHub didn't answer");
  expect(failureText({ kind: "unexpected", engine: null })).toBe("the review could not run");
  // A job that failed before anyone said why.
  expect(failureText(null)).toBe("the review could not run");
});

test("why a confirm pass gave no answer names its engine", () => {
  expect(confirmFailureText("auth_required", "claude")).toBe("Claude is signed out");
  expect(confirmFailureText("quota_exhausted", "codex")).toBe("Codex reached its limit");
  expect(confirmFailureText("timeout", "claude")).toBe("Claude ran out of time");
  expect(confirmFailureText("crashed", "codex")).toBe("Codex stopped before it answered");
  expect(confirmFailureText("cancelled", "claude")).toBe("Claude was stopped before it answered");
  expect(confirmFailureText("invalid_output", "claude")).toBe("Claude's answer could not be read");
  expect(confirmFailureText("unreadable", "codex")).toBe("Codex's answer could not be read");
});

test("why a waiting review was cancelled, as a title and as a phrase", () => {
  expect(cancelText("closed")).toBe("The pull request was closed");
  expect(cancelText("replaced")).toBe("A newer review took its place");
  expect(cancelPhrase("pushed")).toBe("a newer commit was pushed after the request");
});

test("why a post waits says what GitHub did, and when it is tried again (ADR 0055)", () => {
  expect(postWaitText("unavailable", "at 00:01")).toBe("GitHub didn't answer, trying again at 00:01");
  expect(postWaitText("rate_limited", "at 14:05")).toBe("GitHub asked to wait, trying again at 14:05");
});

test("a phrase as a sentence of its own: upper case first, a full stop last", () => {
  expect(asSentence("reviews are paused")).toBe("Reviews are paused.");
  expect(upperFirst("at its limit until 10:11")).toBe("At its limit until 10:11");
});

test("a commit is named by its first seven characters, a clock's figure by two digits", () => {
  expect(shortSha("0123456789abcdef")).toBe("0123456");
  expect([twoDigits(5), twoDigits(12)]).toEqual(["05", "12"]);
});

test("a round's finders: one, both of Deep's, or one in two sessions", () => {
  expect(findersText("claude", null)).toBe("Claude");
  expect(findersText("claude", "codex")).toBe("Claude and Codex");
  expect(findersText("codex", "codex")).toBe("Codex in two sessions");
});

test("the findings kept in the app are counted in one sentence, and none says nothing", () => {
  expect(keptText(0)).toBeNull();
  expect(keptText(1)).toBe("One finding stays in Lookover, not on the pull request.");
  expect(keptText(3)).toBe("3 findings stay in Lookover, not on the pull request.");
});

test("who found a round and who double-checked it is said the same on the pull request and in the app (ADR 0055)", () => {
  const by = (round: Partial<Parameters<typeof foundAndCheckedText>[0]> = {}) =>
    foundAndCheckedText({
      reviewer: "codex",
      secondFind: null,
      confirmer: "claude",
      confirmFailure: null,
      raised: 1,
      ...round,
    });
  expect(by()).toBe("found by Codex, double-checked by Claude");
  expect(by({ confirmer: "codex" })).toBe("found by Codex, double-checked by Codex in a new session");
  expect(by({ confirmFailure: "quota_exhausted" })).toBe("found by Codex, not double-checked");
  expect(by({ confirmer: null, raised: 0 })).toBe(`found by Codex, ${NOTHING_NEW_TO_CHECK}`);
  expect(NOTHING_NEW_TO_CHECK).toBe("nothing new to double-check");
  expect(by({ confirmer: null })).toBe("found by Codex, not double-checked");
  expect(by({ secondFind: { engine: "claude", failure: null } })).toBe(
    "found by Codex and Claude, double-checked by Claude",
  );
  expect(by({ secondFind: { engine: "codex", failure: null }, confirmer: "codex" })).toBe(
    "found by Codex in two sessions, double-checked by Codex in a new session",
  );
  expect(by({ secondFind: { engine: "claude", failure: "timeout" } })).toBe(
    "found by Codex, double-checked by Claude",
  );
});

test("why a change wasn't reviewed", () => {
  expect(skipText("not-yours")).toBe("not opened by you or your agents");
  expect(skipText("draft")).toBe("still a draft");
  expect(skipText("repo-off")).toBe("this repository is off");
  expect(skipText("on-open-off")).toBe("reviews on open are off");
  expect(skipText("codex-not-yours")).toBe(
    "only Codex may review here, and it reviews only your own pull requests from this repository",
  );
  expect(skipText("fork")).toBe("it comes from a fork");
});

test("why the owner decides an escalated finding: a dispute whatever its keeps, else the claim kept twice", () => {
  expect(escalationText("disputed")).toBe(
    "Disputed, and the finder still calls it wrong: the owner decides on the thread.",
  );
  expect(escalationText("wont_fix")).toBe(
    "Said won't fix twice, kept twice: the owner decides on the thread.",
  );
  expect(escalationText("claimed_fixed")).toBe(
    "Said fixed twice, kept twice: the owner decides on the thread.",
  );
  expect(escalationText("deferred")).toBe(
    "Said deferred twice, kept twice: the owner decides on the thread.",
  );
  expect(escalationText("question")).toBe("Asked twice, kept twice: the owner decides on the thread.");
  expect(escalationText(null)).toBe("Kept twice: the owner decides on the thread.");
});

test("a reply's kind by what the round decided: kept once warns, kept on an escalated one hands over", () => {
  const open = { status: "open" as const, kept: 1, claim: null };
  const escalated = (kept: number, kind: "wont_fix" | "disputed") => ({
    status: "escalated" as const,
    kept,
    claim: { kind },
  });
  expect(replyKind("kept", open)).toEqual({
    kind: "Kept",
    why: null,
    last: "If it is kept again, the owner decides.",
  });
  expect(replyKind("kept", escalated(3, "wont_fix"))).toEqual({
    kind: "Kept. The owner decides",
    why: null,
    last: null,
  });
  expect(replyKind("escalated", escalated(2, "wont_fix"))).toEqual({
    kind: "The owner decides this one",
    why: 'Kept twice against "won\'t fix". Fix it, or resolve this thread to keep the code as it is.',
    last: null,
  });
  expect(replyKind("escalated", escalated(1, "wont_fix")).why).toBeNull();
  expect(replyKind("escalated", escalated(0, "disputed"))).toEqual({
    kind: "The owner decides this one",
    why: null,
    last: null,
  });
  expect(replyKind("withdrawn", open)).toEqual({ kind: "Withdrawn", why: null, last: null });
  expect(replyKind("answered", open)).toEqual({ kind: "Answer", why: null, last: null });
  expect(replyKind("still_present", open)).toEqual({ kind: "Still present", why: null, last: null });
  expect(replyKind("dismissed", undefined)).toEqual({
    kind: "Dismissed by the owner",
    why: null,
    last: "It won't be raised again on this pull request.",
  });
});

test("a round's line: its number, its commit, then what was fixed and withdrawn among the posted findings", () => {
  const f = (status: "verified_fixed" | "withdrawn" | "dismissed" | "open", posted = true) => ({
    status,
    posted,
  });
  expect(roundLine(3, "C", [f("verified_fixed"), f("withdrawn"), f("dismissed"), f("open")])).toEqual([
    "Round 3 · ",
    "C",
    " · 1 fixed, 2 withdrawn",
  ]);
  expect(roundLine(2, "C", [f("withdrawn"), f("verified_fixed", false)])).toEqual([
    "Round 2 · ",
    "C",
    " · 1 withdrawn",
  ]);
  expect(roundLine(1, "C", [f("open")])).toEqual(["Round 1 · ", "C"]);
  expect(roundCountsText([f("verified_fixed"), f("verified_fixed")])).toBe("2 fixed");
  expect(roundCountsText([f("open")])).toBe("");
});

test("the status block's headings and its note for a finding not in the diff", () => {
  expect(NEEDS_YOUR_LOOK).toBe("Needs your look");
  expect(lookingOverHead("C", false)).toEqual(["Looking over ", "C"]);
  expect(lookingOverHead("C", true)).toEqual(["Looking over ", "C", " again"]);
  expect(waitingHead("C")).toEqual(["Waiting to look over ", "C"]);
  expect(failedHead("C")).toEqual(["Couldn't look over ", "C"]);
  expect(endedHead("C")).toEqual(["Didn't look over ", "C"]);
  expect(ENDED_LINE).toBe(
    "A newer commit was pushed after the request. Comment `/lookover review` to look over the newest one.",
  );
  expect(notInDiffText("Reminders go out twice.")).toBe("Not in the diff: reminders go out twice.");
});

// Each list from a record over its union: a kind or a cause added fails to compile here until it is listed.
const EVERY_KIND = {
  service_stopped: true,
  prepare_failed: true,
  review_failed: true,
  publish_failed: true,
  host_failed: true,
  unexpected: true,
} satisfies Record<JobFailureKind, true>;
const KINDS = Object.keys(EVERY_KIND).filter((k): k is JobFailureKind => k in EVERY_KIND);
const EVERY_CAUSE = {
  git_silent: true,
  git_time_limit: true,
  engine_time_limit: true,
  base_not_found: true,
  path_too_long: true,
  git_missing: true,
  network: true,
  engine_answer: true,
} satisfies Record<FailureCause, true>;
const CAUSES = Object.keys(EVERY_CAUSE).filter((k): k is FailureCause => k in EVERY_CAUSE);

test("every failure, by its kind and its cause or none, has a phrase, a sentence and a next line", () => {
  for (const kind of KINDS)
    for (const cause of [...CAUSES, null])
      for (const engine of ["claude", "codex", null] as const) {
        const words = failureWords({ kind, cause, engine, limitMs: 120_000 });
        expect(words.phrase).not.toBe("");
        expect(words.phrase).not.toMatch(/[.!?]$/);
        expect(words.sentence).toMatch(/^[A-Z].*\.$/);
        expect(words.next).toMatch(/^[A-Z].*\.$/);
      }
});

test("new commits: the agent's when it signed every one, else no one named; not counted, just new commits", () => {
  expect(pushedText("agent", 1)).toBe("the agent pushed 1 commit");
  expect(pushedText("agent", 2)).toBe("the agent pushed 2 commits");
  expect(pushedText("agent", 0)).toBe("the agent pushed new commits");
  expect(pushedText(null, 1)).toBe("1 new commit");
  expect(pushedText(null, 3)).toBe("3 new commits");
  expect(pushedText(null, 0)).toBe("new commits");
});

test("a time limit is said in words from its milliseconds", () => {
  const job = { kind: "prepare_failed", engine: null } as const;
  expect(failureWords({ ...job, cause: "git_silent", limitMs: 120_000 })).toEqual({
    phrase: "git sent nothing for 2 minutes while Lookover got the code ready",
    sentence: "Git sent nothing for 2 minutes while Lookover got the code ready.",
    retry: true,
    next: TRY_AGAIN,
  });
  expect(failureWords({ ...job, cause: "git_silent", limitMs: 60_000 }).phrase).toBe(
    "git sent nothing for 1 minute while Lookover got the code ready",
  );
  expect(failureWords({ ...job, cause: "git_time_limit", limitMs: 600_000 })).toEqual({
    phrase: "getting the code ready ran past its 10-minute limit",
    sentence: "Getting the code ready ran past its 10-minute limit.",
    retry: false,
    next: "The repository or the change is too large to get ready in that time.",
  });
  expect(failureWords({ ...job, cause: "git_time_limit", limitMs: 90_000 }).phrase).toBe(
    "getting the code ready ran past its 90-second limit",
  );
  expect(failureWords({ ...job, cause: "git_time_limit", limitMs: 7_200_000 }).phrase).toBe(
    "getting the code ready ran past its 2-hour limit",
  );
  // A limit nobody recorded, or none above zero: not known.
  for (const limitMs of [null, 0, -1_000]) {
    expect(failureWords({ ...job, cause: "git_silent", limitMs }).phrase).toBe(
      "git sent nothing for too long while Lookover got the code ready",
    );
    expect(failureWords({ ...job, cause: "git_time_limit", limitMs }).phrase).toBe(
      "getting the code ready ran past its time limit",
    );
  }
});

test("an engine's cause names the engine that was reviewing", () => {
  const failed = { kind: "review_failed", limitMs: null } as const;
  expect(
    failureWords({ ...failed, engine: "claude", cause: "engine_time_limit", limitMs: 1_200_000 }),
  ).toEqual({
    phrase: "Claude ran past its 20-minute limit",
    sentence: "Claude ran past its 20-minute limit.",
    retry: false,
    next: "A smaller pull request fits in the time.",
  });
  expect(failureWords({ ...failed, engine: "codex", cause: "engine_answer" })).toEqual({
    phrase: "Codex gave no usable review",
    sentence: "Codex gave no usable review.",
    retry: true,
    next: TRY_AGAIN,
  });
  expect(failureWords({ ...failed, engine: null, cause: "engine_answer" }).sentence).toBe(
    "The reviewer gave no usable review.",
  );
});

test("a failed review's check title and status block line, from its words", () => {
  const late = {
    kind: "review_failed",
    engine: "codex",
    cause: "engine_time_limit",
    limitMs: 1_200_000,
  } as const;
  expect(failedTitle(late)).toBe("The review failed: Codex ran past its 20-minute limit");
  expect(failedLine(late)).toBe(
    "Codex ran past its 20-minute limit. A smaller pull request fits in the time.",
  );
  expect(failedLine({ ...late, cause: "network", kind: "host_failed" })).toBe(
    `GitHub didn't answer. ${TRY_AGAIN}`,
  );
});

test("a cause another try can't change says what would", () => {
  const job = { kind: "prepare_failed", engine: null, limitMs: null } as const;
  expect(failureWords({ ...job, cause: "base_not_found" })).toEqual({
    phrase: "where the commit branches off its base branch couldn't be found",
    sentence: "Lookover couldn't find where the commit branches off its base branch.",
    retry: false,
    next: "Rebase onto the base branch, then push.",
  });
  expect(failureWords({ ...job, cause: "path_too_long" })).toEqual({
    phrase: "a file path is too long for this machine",
    sentence: "A file path is too long for the machine Lookover runs on.",
    retry: false,
    next: "Turning on long paths in Windows, or shorter paths, would fix it.",
  });
  expect(failureWords({ ...job, cause: "git_missing" })).toEqual({
    phrase: "git isn't installed where Lookover runs",
    sentence: "Git isn't installed where Lookover runs.",
    retry: false,
    next: "Install git, then push again.",
  });
  expect(failureWords({ kind: "host_failed", engine: null, limitMs: null, cause: "network" })).toEqual({
    phrase: "GitHub didn't answer",
    sentence: "GitHub didn't answer.",
    retry: true,
    next: TRY_AGAIN,
  });
});

test("a failure with no cause says today's words for its kind", () => {
  expect(failureWords({ kind: "prepare_failed", engine: null, cause: null, limitMs: null })).toEqual({
    phrase: "the code could not be fetched",
    sentence: "Lookover couldn't get the code ready.",
    retry: true,
    next: TRY_AGAIN,
  });
  expect(failureWords({ kind: "review_failed", engine: "codex", cause: null, limitMs: null })).toEqual({
    phrase: "Codex gave no review",
    sentence: "Codex stopped before it finished.",
    retry: true,
    next: TRY_AGAIN,
  });
  expect(failureWords(null).phrase).toBe("the review could not run");
});
