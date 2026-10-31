// The ports on a session that posts as a person (ADR 0066's `shared` way): intake and the writer ask the session who
// posts, never the bot, and `findCheck` filters by the session's App. The payloads are GitHub's as spike 20 recorded
// them (`spikes/20-shared-app/results.json`): a review, its line comments and replies posted with the person's
// token are the person's, with no `performed_via_github_app`; the summary, an issue comment, carries the App there.
import { expect, test } from "bun:test";
import {
  commitSha,
  FINDING_MARKER,
  findingId,
  REVIEW_MARKER,
  SHARED_APP,
  SUMMARY_MARKER,
} from "@lookover/contracts";
import { AT, type Call, type Route, stubGitHub, withToken } from "./github.test-support.ts";
import { createGitHub, type Session } from "./index.ts";

const REPO = { owner: "lookover-dev", name: "lookover-sandbox" };
const CHANGE = { repo: REPO, number: 2 };
const PULL = "/repos/lookover-dev/lookover-sandbox/pulls/2";
const ISSUE = "/repos/lookover-dev/lookover-sandbox/issues/2";
/** The signed-in person, as spike 20's `GET /user` gave them. */
const PERSON = { id: 11247504, login: "sasensi" };
/** A teammate on the same pull request. */
const TEAMMATE = { id: 5550001, login: "teammate" };
const TOKEN = "ghu_person";
/** `performed_via_github_app` as GitHub gives it on an issue comment the App's user token posted. */
const VIA_SHARED: Via = { id: SHARED_APP.id, slug: SHARED_APP.slug, name: "Lookover Dev" };
const VIA_OTHER: Via = { id: 4242, slug: "someone-elses-app", name: "Someone else's App" };

/** A session that posts as the person: one token for every repository, the shared App's id. */
const personSession: Session = {
  appId: SHARED_APP.id,
  withToken: (_repo, call) => call(TOKEN),
  poster: () => Promise.resolve({ ...PERSON, bot: false }),
};

function ports(...routes: Route[]) {
  const api = stubGitHub(...routes);
  const github = createGitHub({ session: personSession, fetch: api.fetch, clock: { now: () => AT } });
  return { calls: api.calls, writer: github.writer, intake: github.intake };
}

type Via = { id: number; slug: string; name: string };
type IssueComment = {
  id: number;
  user: { id: number; login: string };
  body: string;
  performed_via_github_app: Via | null;
};

/** The conversation, created and edited as GitHub does with the person's token: the App named on what it posts. */
function conversation(comments: IssueComment[]): Route {
  let next = 900;
  const text = (call: Call) =>
    typeof call.body === "object" &&
    call.body !== null &&
    "body" in call.body &&
    typeof call.body.body === "string"
      ? call.body.body
      : "";
  return withToken(TOKEN, (call) => {
    if (call.method === "GET" && call.path === `${ISSUE}/comments?per_page=100`)
      return { status: 200, body: comments };
    if (call.method === "POST" && call.path === `${ISSUE}/comments`) {
      const created = { id: next++, user: PERSON, body: text(call), performed_via_github_app: VIA_SHARED };
      comments.push(created);
      return { status: 201, body: created };
    }
    const edit = /\/issues\/comments\/(\d+)$/.exec(call.path);
    const edited = edit && comments.find((c) => c.id === Number(edit[1]));
    if (call.method === "PATCH" && edited) {
      edited.body = text(call);
      return { status: 200, body: edited };
    }
    return undefined;
  });
}

test("the summary on a person's session is theirs, holds the marker and names the App: one the person wrote by hand is not it", async () => {
  const comments: IssueComment[] = [
    // The person quoting the summary by hand: theirs, the marker in it, no App.
    { id: 1, user: PERSON, body: `${SUMMARY_MARKER}\nQuoted by hand.`, performed_via_github_app: null },
    // Through another App's token: theirs, the marker in it, another App.
    { id: 2, user: PERSON, body: `${SUMMARY_MARKER}\nAnother App.`, performed_via_github_app: VIA_OTHER },
    // A teammate's own Lookover summary: the shared App, the marker, someone else.
    { id: 3, user: TEAMMATE, body: `${SUMMARY_MARKER}\nTheirs.`, performed_via_github_app: VIA_SHARED },
  ];
  const { writer, calls } = ports(conversation(comments));
  const first = await writer.upsertSummary(CHANGE, `${SUMMARY_MARKER}\nRound 1: 1 open.`);
  expect(first).toBe("900");
  expect(await writer.upsertSummary(CHANGE, `${SUMMARY_MARKER}\nRound 2: 0 open.`)).toBe("900");
  expect(comments.map((c) => [c.id, c.body])).toEqual([
    [1, `${SUMMARY_MARKER}\nQuoted by hand.`],
    [2, `${SUMMARY_MARKER}\nAnother App.`],
    [3, `${SUMMARY_MARKER}\nTheirs.`],
    [900, `${SUMMARY_MARKER}\nRound 2: 0 open.`],
  ]);
  expect(calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path])).toEqual([
    ["POST", `${ISSUE}/comments`],
    ["PATCH", "/repos/lookover-dev/lookover-sandbox/issues/comments/900"],
  ]);
});

test("the review on a person's session is found as theirs, by its marker; a teammate's holding it is not", async () => {
  const marker = `${REVIEW_MARKER}round-1 -->`;
  // GitHub's review as spike 20 recorded it: the person's, no App named.
  const review = (id: number, user: { id: number; login: string }) => ({
    id,
    user,
    body: `Lookover found 1 thing.\n\n${marker}`,
    commit_id: "9f2237a1cbb9f9c3b9fe180042382e51dd92ae96",
  });
  const { writer } = ports(
    withToken(TOKEN, (call) =>
      call.path === `${PULL}/reviews?per_page=100`
        ? { status: 200, body: [review(1, TEAMMATE), review(2, PERSON)] }
        : undefined,
    ),
  );
  expect(await writer.findReview(CHANGE, marker)).toBe("2");
  expect(await writer.findReview(CHANGE, `${REVIEW_MARKER}round-2 -->`)).toBeNull();
});

test("the check on a person's session is looked for among the session's App's runs", async () => {
  const sha = "9f2237a1cbb9f9c3b9fe180042382e51dd92ae96";
  const runs = `/repos/lookover-dev/lookover-sandbox/commits/${sha}/check-runs?check_name=Lookover&filter=all&app_id=${SHARED_APP.id}&per_page=100`;
  const { writer } = ports(
    withToken(TOKEN, (call) =>
      call.path === runs
        ? {
            status: 200,
            body: {
              total_count: 2,
              check_runs: [
                { id: 1, external_id: `job-1@${TEAMMATE.id}` },
                { id: 2, external_id: `job-1@${PERSON.id}` },
              ],
            },
          }
        : undefined,
    ),
  );
  expect(await writer.findCheck(REPO, commitSha(sha), `job-1@${PERSON.id}`)).toBe("2");
});

test("Lookover's threads on a person's session are the person's roots holding a finding marker; a teammate's copy is none", async () => {
  const marker = (id: string) => `${FINDING_MARKER}{"v":1,"id":"${id}"} -->`;
  const inline = (id: number, user: { id: number; login: string }, body: string, inReplyTo?: number) => ({
    id,
    node_id: `PRRC_${id}`,
    user: { ...user, type: "User" },
    body,
    html_url: `https://github.com/lookover-dev/lookover-sandbox/pull/2#discussion_r${id}`,
    created_at: "2026-10-28T14:24:56Z",
    ...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }),
  });
  const { intake } = ports(
    withToken(TOKEN, (call) => {
      if (call.path === `${PULL}/comments?per_page=100`)
        return {
          status: 200,
          body: [
            inline(10, PERSON, `Lookover: off by one.\n\n${marker("F1")}`),
            inline(11, TEAMMATE, `Copied: ${marker("F9")}`),
            inline(12, TEAMMATE, "Won't fix: the caller checks it.", 10),
          ],
        };
      if (call.method === "POST" && call.path === "/graphql")
        return { status: 200, body: { data: { nodes: [{ id: "PRRC_10", outdated: false }] } } };
      return undefined;
    }),
  );
  const threads = await intake.threads(CHANGE);
  expect(
    threads.map((t) => [t.commentId, t.findingId, t.replies.map((r) => [r.commentId, r.author])]),
  ).toEqual([[10, findingId("F1"), [[12, { ...TEAMMATE, bot: false }]]]]);
});
