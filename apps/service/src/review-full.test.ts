// Asking again (ADR 0052, ADR 0043), through the service's entry, on fakes only: a request on a commit already
// reviewed makes a new round (the agent asks again after replying on a thread, naming its reply), and the owner's
// `/lookover review full` makes a round that posts as a first round would, new `consider` findings included. Only the
// owner's request counts, full or not.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readResult, reviewRequest, type Severity } from "@lookover/contracts";
import { ScriptedRetrieval, type ScriptedRun } from "@lookover/testkit";
import {
  fakeEngines,
  OWNER,
  pr1,
  SANDBOX,
  SHA1,
  start,
  stopAll,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const PR1 = { repo: SANDBOX, number: 1 };
const OCTOCAT = { id: 583231, login: "octocat" };

/** A find pass that reports one finding of `severity` on `line`, titled `title`, and nothing of the earlier ones. */
const found = (line: number, severity: Severity, title: string): ScriptedRun => ({
  outcome: "ok",
  text: [
    "```json",
    JSON.stringify({
      findings: [
        {
          path: "src/total.ts",
          line,
          severity,
          category: "maintainability",
          title,
          body: `${title}.`,
          defect_key: title.toLowerCase().replaceAll(" ", "-"),
        },
      ],
    }),
    "```",
  ].join("\n"),
});

const NOTHING: ScriptedRun = { outcome: "ok", text: '```json\n{"findings": []}\n```' };

/** `src/total.ts`, its 40 lines added: every line takes a comment. */
const TOTAL_ADDED = [
  "diff --git a/src/total.ts b/src/total.ts",
  "--- /dev/null",
  "+++ b/src/total.ts",
  "@@ -0,0 +1,40 @@",
  ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
  "",
].join("\n");

/** The service on a fake GitHub, every finding posted (strictness `everything`), one pass per round (Quick). */
async function world() {
  const engines = fakeEngines();
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = TOTAL_ADDED;
  const { host, time } = await start({
    changes: [],
    engines,
    retrieval,
    repositorySettings: { strictness: "everything", depth: "quick" },
  });
  host.open(pr1);
  await time.advance(5_000);
  /** A comment `body` by `author` (the owner unless said), picked up by the poll; a round runs on `runs`. */
  const ask = async (body: string, runs: ScriptedRun[], author = OWNER): Promise<void> => {
    engines.answer(...runs);
    host.seedComment(PR1, { author, body });
    await time.advance(MIN);
    await time.advance(0);
  };
  return {
    host,
    engines,
    ask,
    /** The rounds posted: one review each. */
    reviews: () => host.posts.filter((p) => p.kind === "review").length,
    /** The round the last check completed says it was. */
    round: () => {
      const post = host.posts.findLast((p) => p.kind === "check.completed");
      return post?.kind === "check.completed" ? readResult(post.output.text)?.loop.round : undefined;
    },
    /** The titles of the findings posted on lines, oldest first. */
    posted: async () => {
      const ids = (await host.threads(PR1)).map((t) => t.findingId);
      const post = host.posts.findLast((p) => p.kind === "check.completed");
      const result = post?.kind === "check.completed" ? readResult(post.output.text) : null;
      return ids.map((id) => result?.findings.find((f) => f.id === id)?.title);
    },
  };
}

test("a request on a commit already reviewed makes a new round, the agent's naming its reply as the owner's plain one", async () => {
  const w = await world();
  await w.ask("/lookover review", [found(12, "blocking", "The total skips the last invoice")]);
  expect(w.reviews()).toBe(1);
  expect(w.round()).toBe(1);

  // No push: the same commit, asked again by the agent after its reply on the thread.
  const [thread] = await w.host.threads(PR1);
  if (!thread) throw new Error("round 1 posted no thread");
  const reply = w.host.seedReply(PR1, thread.commentId, { author: OWNER, body: "Won't fix: a sentinel." });
  await w.ask(reviewRequest(SHA1, { reply }), [NOTHING]);
  expect(w.reviews()).toBe(2);
  expect(w.round()).toBe(2);

  // And once more by the owner, by hand.
  await w.ask("/lookover review", [NOTHING]);
  expect(w.reviews()).toBe(3);
  expect(w.round()).toBe(3);
  expect(w.engines.queued).toBe(0);
});

test("from round 2 a new `consider` finding is posted only when the owner asks `/lookover review full`", async () => {
  const w = await world();
  await w.ask("/lookover review", [NOTHING]);
  expect(w.round()).toBe(1);

  // A plain request: round 2 keeps its new consider finding off the pull request.
  await w.ask("/lookover review", [found(20, "consider", "The loop could be a reduce")]);
  expect(w.round()).toBe(2);
  expect(await w.posted()).toEqual([]);

  // Someone else's full request is no request.
  await w.ask("/lookover review full", [], OCTOCAT);
  expect(w.round()).toBe(2);

  // The owner's full request: round 3 posts as a first round would.
  await w.ask("/Lookover Review FULL", [found(30, "consider", "The name hides the unit")]);
  expect(w.round()).toBe(3);
  expect(await w.posted()).toContain("The name hides the unit");
  expect(w.engines.queued).toBe(0);
});
