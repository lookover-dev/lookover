// The ports on the person's session (ADR 0066, ADR 0073): intake and the writer ask the session who posts, and
// `findCheck` filters by the session's App. The payloads are GitHub's as spike 20 recorded
// them (`spikes/20-shared-app/results.json`): a review, its line comments and replies posted with the person's
// token are the person's, with no `performed_via_github_app`.
import { expect, test } from "bun:test";
import { commitSha, FINDING_MARKER, findingId, REVIEW_MARKER, SHARED_APP } from "@lookover/contracts";
import { AT, type Route, stubGitHub, withToken } from "./github.test-support.ts";
import { createGitHub, type Session } from "./index.ts";

const REPO = { owner: "lookover-dev", name: "lookover-sandbox" };
const CHANGE = { repo: REPO, number: 2 };
const PULL = "/repos/lookover-dev/lookover-sandbox/pulls/2";
/** The signed-in person, as spike 20's `GET /user` gave them. */
const PERSON = { id: 11247504, login: "sasensi" };
/** A teammate on the same pull request. */
const TEAMMATE = { id: 5550001, login: "teammate" };
const TOKEN = "ghu_person";
/** A session that posts as the person: one token for every repository, the shared App's id. */
const personSession: Session = {
  appId: SHARED_APP.id,
  withToken: (_repo, call) => call(TOKEN),
  poster: () => Promise.resolve(PERSON),
};

function ports(...routes: Route[]) {
  const api = stubGitHub(...routes);
  const github = createGitHub({ session: personSession, fetch: api.fetch, clock: { now: () => AT } });
  return { calls: api.calls, writer: github.writer, intake: github.intake };
}

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
