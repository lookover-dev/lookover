// The check following its job, through the entry (ADR 0043), against `FakeGitHost`: what the host received and
// what it shows. The expected texts and results are written by hand from the ticket's sentences.
import { expect, test } from "bun:test";
import { commitSha, HostError, jobId, type RepositoryRef, readResult, runId } from "@lookover/contracts";
import { FakeGitHost, type FakeGitHostOptions } from "@lookover/testkit";
import { createPublisher, type JobCheck } from "./index.ts";

const repo: RepositoryRef = { owner: "sasensi", name: "demo-app" };
const change = { repo, number: 42 };
const BASE = commitSha("0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3");
const HEAD = commitSha("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
const AT = Date.UTC(2026, 9, 7, 12, 0, 0);

const OPTIONS: FakeGitHostOptions = {
  repo,
  bot: { id: 9001, login: "lookover-demo[bot]" },
  changes: [
    {
      number: 42,
      title: "Retry sends through fetch",
      url: "https://github.com/sasensi/demo-app/pull/42",
      author: { login: "sasensi", id: 1 },
      draft: false,
      head: { ref: "retry-fetch", sha: HEAD },
      base: { ref: "main", sha: BASE },
      diff: [],
    },
  ],
};

const host = () => new FakeGitHost(OPTIONS);
/** The person Lookover posts for: their id is in each check's external id (ADR 0066). */
const PERSON = 1;
const person = () => PERSON;

/** The job asked by "Review now" on the head commit, waiting its turn, with no check yet. */
const waiting: JobCheck = {
  change: { ...change, host: "github" },
  sha: HEAD,
  job: { id: jobId("job-1"), trigger: "manual" },
  run: null,
  rounds: 0,
  loop: "open",
  standing: { kind: "waiting", deferral: null, until: null },
  onlyCodex: false,
  at: AT,
  checkId: null,
};

const RUN = { id: runId("run-1"), engine: "claude" as const, startedAt: AT - 60_000 };

/** The host, refusing the first completion of a check, as GitHub does on a bad moment. */
class RefusedCompletion extends FakeGitHost {
  private refused = false;
  constructor() {
    super(OPTIONS);
  }
  override completeCheck(...args: Parameters<FakeGitHost["completeCheck"]>): Promise<void> {
    if (this.refused) return super.completeCheck(...args);
    this.refused = true;
    return Promise.reject(new HostError("unavailable", "GitHub did not answer"));
  }
}

test("a job's check carries the job's id and the person's, read at each post (ADR 0066)", async () => {
  const github = host();
  let who = PERSON;
  const id = await createPublisher({ writer: github, person: () => who }).check(waiting);
  expect(await github.findCheck(repo, HEAD, `job-1@${PERSON}`)).toBe(id);
  who = 7;
  const next = await createPublisher({ writer: github, person: () => who }).check({
    ...waiting,
    job: { id: jobId("job-2"), trigger: "manual" },
  });
  expect(await github.findCheck(repo, HEAD, "job-2@7")).toBe(next);
});

test("a job recorded creates its check queued on its commit, saying it waits for its turn", async () => {
  const github = host();
  const id = await createPublisher({ writer: github, person }).check(waiting);
  expect(github.view(change).checks).toEqual([
    {
      id,
      name: "Lookover",
      sha: HEAD,
      status: "queued",
      conclusion: null,
      output: {
        title: "Waiting for its turn",
        summary: "Lookover looks over a1b2c3d once the reviews before it are done.",
        text: "This check is completed when the review ends. The last line of its text is then the `lookover.review-result/v1` result, for coding agents.",
      },
    },
  ]);
});

test("a deferred job's check says why it waits, and changes when the reason changes", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  const id = await publisher.check(waiting);
  const signedOut = { reason: "engine-signed-out", engine: "claude" } as const;
  expect(
    await publisher.check({
      ...waiting,
      checkId: id,
      standing: { kind: "waiting", deferral: signedOut, until: null },
    }),
  ).toBe(id);
  expect(github.view(change).checks[0]).toMatchObject({
    status: "queued",
    output: {
      title: "Waiting: Claude is signed out",
      summary: "Lookover looks over a1b2c3d by itself once the owner signs Claude in.",
    },
  });
  await publisher.check({
    ...waiting,
    checkId: id,
    standing: { kind: "waiting", deferral: { reason: "paused" }, until: null },
  });
  expect(github.view(change).checks[0]).toMatchObject({
    status: "queued",
    output: {
      title: "Waiting: reviews are paused",
      summary: "Lookover looks over a1b2c3d once the owner resumes reviews.",
    },
  });
  expect(github.posts.map((p) => p.kind)).toEqual(["check.created", "check.updated", "check.updated"]);
});

test("a job waiting on an engine that failed its self-test says so on its check (ADR 0044)", async () => {
  const github = host();
  const failed = { reason: "engine-failed-self-test", engine: "codex" } as const;
  await createPublisher({ writer: github, person }).check({
    ...waiting,
    standing: { kind: "waiting", deferral: failed, until: null },
  });
  expect(github.view(change).checks[0]?.output).toMatchObject({
    title: "Waiting: Codex didn't pass Lookover's safety check",
    summary: "Lookover looks over a1b2c3d by itself once a version of Codex passes it.",
  });
});

test("a job waiting on an engine found but not usable says why on its check, and what starts it", async () => {
  const tooOld = { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  const cases = [
    [tooOld, "Codex 0.161.0 is too old for gpt-6.1-sol", "once Codex is updated"],
    [
      { kind: "signed-in-otherwise", how: "an API key" },
      "Codex is signed in with an API key, not ChatGPT",
      "once the owner signs Codex in with ChatGPT",
    ],
    [
      { kind: "npm-launcher" },
      "only npm's codex launcher was found",
      "once the native codex program is installed",
    ],
  ] as const;
  for (const [unusable, why, when] of cases) {
    const github = host();
    const held = { reason: "engine-missing", engine: "codex", unusable } as const;
    await createPublisher({ writer: github, person }).check({
      ...waiting,
      standing: { kind: "waiting", deferral: held, until: null },
    });
    expect(github.view(change).checks[0]?.output).toMatchObject({
      title: `Waiting: ${why}`,
      summary: `Lookover looks over a1b2c3d by itself ${when}.`,
    });
  }
});

test("a job waiting on an engine's limit gives the reset on its check, with its offset (ADR 0055)", async () => {
  const github = host();
  const limit = { reason: "engine-limit", engine: "codex" } as const;
  const publisher = createPublisher({ writer: github, person });
  const id = await publisher.check({
    ...waiting,
    standing: { kind: "waiting", deferral: limit, until: Date.parse("2026-10-14T10:11:00Z") },
  });
  // bun test runs in UTC: the service's offset is none.
  expect(github.view(change).checks[0]?.output).toMatchInlineSnapshot(`
    {
      "summary": "Lookover looks over a1b2c3d once the limit resets, on Wed 14 Oct 2026 at 10:11 (UTC).",
      "text": "This check is completed when the review ends. The last line of its text is then the \`lookover.review-result/v1\` result, for coding agents.",
      "title": "Waiting: Codex reached its limit",
    }
  `);
  // No reset read: no time is given.
  await publisher.check({
    ...waiting,
    checkId: id,
    standing: { kind: "waiting", deferral: limit, until: null },
  });
  expect(github.view(change).checks[0]?.output.summary).toBe(
    "Lookover looks over a1b2c3d once the limit resets.",
  );
});

test("the reset is the service's wall-clock time and its offset from UTC, read elsewhere (ADR 0055)", async () => {
  const limit = { reason: "engine-limit", engine: "codex" } as const;
  /** The check's summary for a reset at `at`, written by a service `minutes` east of UTC. */
  const summary = async (minutes: number, at: string) => {
    const github = host();
    await createPublisher({ writer: github, person, offset: () => minutes }).check({
      ...waiting,
      standing: { kind: "waiting", deferral: limit, until: Date.parse(at) },
    });
    return github
      .view(change)
      .checks[0]?.output.summary.replace("Lookover looks over a1b2c3d once the limit resets, on ", "");
  };
  expect([
    await summary(120, "2026-10-14T08:11:00Z"),
    await summary(-150, "2026-10-14T08:11:00Z"),
    await summary(120, "2026-10-14T23:30:00Z"),
  ]).toEqual([
    "Wed 14 Oct 2026 at 10:11 (UTC+02:00).",
    "Wed 14 Oct 2026 at 05:41 (UTC-02:30).",
    "Thu 15 Oct 2026 at 01:30 (UTC+02:00).",
  ]);
});

test("the run's start moves the check in progress", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  const id = await publisher.check(waiting);
  await publisher.check({
    ...waiting,
    checkId: id,
    run: RUN,
    rounds: 1,
    standing: { kind: "running", round: 2 },
  });
  expect(github.view(change).checks[0]).toMatchObject({
    status: "in_progress",
    conclusion: null,
    output: { title: "Looking over a1b2c3d", summary: "Round 2 is running." },
  });
});

test("a job moved to a newer commit completes its old check skipped, with the result block and no findings", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  const id = await publisher.check(waiting);
  await publisher.check({
    ...waiting,
    checkId: id,
    standing: { kind: "ended", ended: { kind: "skipped", why: "newer-commit" } },
  });
  const [check] = github.view(change).checks;
  expect(check).toMatchObject({
    status: "completed",
    conclusion: "skipped",
    output: {
      title: "A newer commit was pushed",
      summary: "Lookover did not look over a1b2c3d: it looks over the newer commit instead.",
    },
  });
  const text = check?.output.text ?? "";
  expect(text.split("\n")[0]).toBe(
    "Lookover posted no review of this commit. The last line of this text is the `lookover.review-result/v1` result, for coding agents.",
  );
  expect(readResult(text)).toEqual({
    schema: "lookover.review-result/v1",
    change: {
      host: "github",
      repository: "sasensi/demo-app",
      number: 42,
      head_sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    },
    run: {
      id: "job-1",
      state: "skipped",
      state_reason: "newer_commit",
      trigger: "manual",
      ruled_out: 0,
      completed_at: "2026-10-07T12:00:00.000Z",
    },
    verdict: { value: "none", conclusion: "skipped", headline: "A newer commit was pushed." },
    loop: { state: "open", round: 0, next_action: "wait" },
    counts: {
      open: { blocking: 0, should_fix: 0, consider: 0 },
      escalated: 0,
      verified_fixed: 0,
      withdrawn: 0,
      acknowledged: 0,
      dismissed: 0,
      obsolete: 0,
      kept_in_app: 0,
    },
    findings: [],
    truncated: false,
  });
});

test("a closed pull request's or another author's job is skipped with its reason", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  const closed = await publisher.check({
    ...waiting,
    standing: { kind: "ended", ended: { kind: "skipped", why: "closed" } },
  });
  const notYours = await publisher.check({
    ...waiting,
    job: { id: jobId("job-2"), trigger: "opened" },
    standing: { kind: "ended", ended: { kind: "skipped", why: "not-yours" } },
  });
  const checks = github.view(change).checks;
  const of = (id: string) => checks.find((c) => c.id === id);
  expect(of(closed)).toMatchObject({
    conclusion: "skipped",
    output: { title: "The pull request was closed", summary: "Lookover did not look over a1b2c3d." },
  });
  expect(readResult(of(closed)?.output.text ?? "")?.run).toMatchObject({
    state: "skipped",
    state_reason: "closed",
  });
  expect(readResult(of(closed)?.output.text ?? "")?.loop.next_action).toBe("stop");
  expect(of(notYours)).toMatchObject({ conclusion: "skipped", output: { title: "Not your pull request" } });
  expect(readResult(of(notYours)?.output.text ?? "")?.run).toMatchObject({
    state: "skipped",
    state_reason: "not_yours",
    trigger: "opened",
  });
  // A check that was never created is created, then completed at once: the commit is never left without one.
  expect(github.posts.map((p) => p.kind)).toEqual([
    "check.created",
    "check.completed",
    "check.created",
    "check.completed",
  ]);
});

test("another author's job skipped because only Codex may review says why, and stops the agent (ADR 0044)", async () => {
  const github = host();
  const id = await createPublisher({ writer: github, person }).check({
    ...waiting,
    standing: { kind: "ended", ended: { kind: "skipped", why: "codex-not-yours" } },
  });
  const check = github.view(change).checks.find((c) => c.id === id);
  expect(check).toMatchObject({
    conclusion: "skipped",
    output: {
      title: "Codex reviews only the owner's pull requests from this repository",
      summary:
        "Lookover did not look over a1b2c3d: only Codex may review here, and it reviews only the owner's pull requests from this repository.",
    },
  });
  const result = readResult(check?.output.text ?? "");
  expect(result?.run).toMatchObject({ state: "skipped", state_reason: "codex_not_yours" });
  expect(result?.loop.next_action).toBe("stop");
});

test("a fork's job skipped says why and how the owner asks, and stops the agent (ADR 0048)", async () => {
  const github = host();
  const id = await createPublisher({ writer: github, person }).check({
    ...waiting,
    standing: { kind: "ended", ended: { kind: "skipped", why: "fork" } },
  });
  const check = github.view(change).checks.find((c) => c.id === id);
  expect(check).toMatchObject({
    conclusion: "skipped",
    output: {
      title: "Not reviewed: it comes from a fork",
      summary:
        "Lookover did not look over a1b2c3d: it reviews a pull request from a fork only when the owner asks, and with Claude only. To ask, comment `/lookover review` on it, or use “Review again” in Lookover.",
    },
  });
  const result = readResult(check?.output.text ?? "");
  expect(result?.run).toMatchObject({ state: "skipped", state_reason: "fork" });
  expect(result?.loop.next_action).toBe("stop");
});

test("a fork's job skipped where only Codex may review points to Settings, not to a request (ADR 0048)", async () => {
  const github = host();
  const id = await createPublisher({ writer: github, person }).check({
    ...waiting,
    onlyCodex: true,
    standing: { kind: "ended", ended: { kind: "skipped", why: "fork" } },
  });
  expect(github.view(change).checks.find((c) => c.id === id)?.output).toMatchObject({
    title: "Not reviewed: it comes from a fork",
    summary:
      "Lookover did not look over a1b2c3d: it reviews a pull request from a fork only when the owner asks, and with Claude only, and only Codex may review here. To have it reviewed, the owner lets Claude review too, in Lookover's Settings.",
  });
});

test("a fork's request ended by a push says a newer commit came after it, and to ask again (ADR 0048)", async () => {
  const github = host();
  const id = await createPublisher({ writer: github, person }).check({
    ...waiting,
    job: { id: jobId("job-1"), trigger: "comment" },
    standing: { kind: "ended", ended: { kind: "skipped", why: "pushed" } },
  });
  const check = github.view(change).checks.find((c) => c.id === id);
  expect(check).toMatchObject({
    conclusion: "skipped",
    output: {
      title: "A newer commit was pushed after the request",
      summary:
        "Lookover did not look over a1b2c3d: the owner asked for this commit, and a newer one was pushed before its review began. Ask again to review the newer commit.",
    },
  });
  const result = readResult(check?.output.text ?? "");
  expect(result?.run).toMatchObject({ state: "skipped", state_reason: "pushed" });
  expect(result?.loop.next_action).toBe("stop");
});

test("an ended job's check never created is created, and its id given before it is completed: a refused completion completes that one next time", async () => {
  const github = new RefusedCompletion();
  const publisher = createPublisher({ writer: github, person });
  const ended: JobCheck = {
    ...waiting,
    standing: { kind: "ended", ended: { kind: "skipped", why: "closed" } },
  };
  const created: string[] = [];
  await expect(publisher.check(ended, (id) => created.push(id))).rejects.toMatchObject({
    failure: "unavailable",
  });
  const [id = "no check"] = created;
  expect(github.view(change).checks.map((c) => [c.id, c.status])).toEqual([[id, "queued"]]);
  // Sent again with that check: completed, and none created.
  expect(await publisher.check({ ...ended, checkId: id }, (again) => created.push(again))).toBe(id);
  expect(created).toEqual([id]);
  expect(github.view(change).checks.map((c) => [c.id, c.status, c.conclusion])).toEqual([
    [id, "completed", "skipped"],
  ]);
});

test("a review the engine gave none of names the engine; a draft says when it is reviewed", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  const failed = await publisher.check({
    ...waiting,
    run: RUN,
    standing: { kind: "ended", ended: { kind: "failed", failure: "review_failed" } },
  });
  const draft = await publisher.check({
    ...waiting,
    job: { id: jobId("job-2"), trigger: "opened" },
    standing: { kind: "ended", ended: { kind: "skipped", why: "draft" } },
  });
  const titles = new Map(github.view(change).checks.map((c) => [c.id, c.output.title]));
  expect(titles.get(failed)).toBe("The review failed: Claude gave no review");
  expect(titles.get(draft)).toBe("A draft: reviewed when the owner asks");
});

test("a failed review completes its check neutral with the failure, never failure", async () => {
  const github = host();
  const publisher = createPublisher({ writer: github, person });
  const id = await publisher.check({ ...waiting, run: RUN, standing: { kind: "running", round: 1 } });
  await publisher.check({
    ...waiting,
    checkId: id,
    run: RUN,
    standing: { kind: "ended", ended: { kind: "failed", failure: "prepare_failed" } },
  });
  const [check] = github.view(change).checks;
  expect(check).toMatchObject({
    status: "completed",
    conclusion: "neutral",
    output: {
      title: "The review failed: the code could not be fetched",
      summary: "Lookover did not look over a1b2c3d. The owner sees why in Lookover.",
    },
  });
  expect(readResult(check?.output.text ?? "")).toMatchObject({
    run: {
      id: "run-1",
      state: "failed",
      state_reason: "prepare_failed",
      trigger: "manual",
      engine: { finder: "claude", confirmer: null },
      ruled_out: 0,
      started_at: "2026-10-07T11:59:00.000Z",
      completed_at: "2026-10-07T12:00:00.000Z",
    },
    verdict: { value: "none", conclusion: "neutral" },
    loop: { next_action: "ask_human" },
    findings: [],
  });
});
