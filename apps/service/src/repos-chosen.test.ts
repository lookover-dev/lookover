// Nothing before the repositories are chosen (ADR 0079): while setup shows Repositories, a pull request the person
// opens or pushes to asks nothing, so nothing reaches GitHub (no check, no status block, no reaction); their own
// `/lookover review` and Review now are answered as before. Once Continue on Repositories has sent `setup.chooseRepos`, the
// repositories kept on are reviewed as today: a new pull request, and a push to one opened before the choice. A start
// with the sign-in gone makes the choice again. Through the service's door, on the fakes and the held clock.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { type ChangeId, changeId, commitSha, type RepositoryRef } from "@lookover/contracts";
import type { FakeChange } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  messages,
  OWNER,
  openApp,
  post,
  pr1,
  review,
  SANDBOX,
  setupOn,
  snapshot,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const SANDBOX_ID = `${SANDBOX.owner}/${SANDBOX.name}`;

/** Another pull request of the owner's on the sandbox, on commits of its own. */
const another = (number: number, repo: RepositoryRef = SANDBOX): FakeChange => ({
  ...pr1,
  repo,
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
  head: { ref: `branch-${number}`, sha: commitSha(`${number}`.padStart(7, "e").padEnd(40, "0")) },
});
const idOf = (number: number): ChangeId => changeId(`${SANDBOX_ID}#${number}`);
const ref = (number: number) => ({ repo: SANDBOX, number });
const pushed = (number: number) => commitSha(`${number}`.padStart(7, "f").padEnd(40, "1"));

/** Setup at Repositories, reviews after every push on: a push would ask, were the repositories chosen. */
async function atRepositories() {
  const started = await start({
    changes: [pr1],
    setup: setupOn("repos"),
    repositorySettings: { onPush: true },
    engines: fakeEngines({ reviews: 3 }),
  });
  const cookie = await openApp(started.service);
  const stream = messages(await fetch(api(started.service, "/events"), { headers: { cookie } }));
  return { ...started, cookie, stream };
}

test("while setup shows Repositories, a pull request opened and pushed to asks nothing: no job, nothing on GitHub", async () => {
  const { service, host, time, cookie, stream } = await atRepositories();
  host.open(another(7));
  await time.advance(MIN);
  await until(stream, "change.opened");
  host.push(ref(7), pushed(7), pr1.diff);
  await time.advance(MIN);
  // The fork of the person's own, whose skip would be told: not told either.
  host.open({ ...another(8), fork: true });
  await time.advance(MIN);
  await until(stream, "change.opened");
  await time.advance(MIN);

  const state = await snapshot(service, cookie);
  expect(state.changes[idOf(7)]?.headSha).toBe(pushed(7));
  expect([state.reviews[idOf(7)]?.job ?? null, state.reviews[idOf(8)]?.job ?? null]).toEqual([null, null]);
  expect(host.posts).toEqual([]);
  expect(host.view(ref(7))).toMatchObject({ description: "", checks: [] });
  expect(host.view(ref(8))).toMatchObject({ description: "", checks: [] });
});

test("the person's /lookover review before the choice is answered: a job and 👀", async () => {
  const { service, host, time, cookie, stream } = await atRepositories();
  host.open(another(7));
  await time.advance(MIN);
  await until(stream, "change.opened");
  const comment = host.seedComment(ref(7), { author: OWNER, body: "/lookover review" });
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).find((e) => e.type === "job.changed")).toMatchObject({
    changeId: idOf(7),
    job: { trigger: "comment" },
  });
  expect(host.posts[0]).toMatchObject({ kind: "reaction", reaction: "eyes", commentId: comment });
  expect((await snapshot(service, cookie)).reviews[idOf(7)]?.job).toMatchObject({ trigger: "comment" });
});

test("after Continue on Repositories, a new pull request is asked a review, and so is a push to one opened before", async () => {
  const { service, host, time, cookie, stream } = await atRepositories();
  host.open(another(7));
  await time.advance(MIN);
  await until(stream, "change.opened");

  const choose = { type: "setup.chooseRepos", enabled: [SANDBOX_ID] };
  expect((await post(service, cookie, choose)).status).toBe(200);
  host.open(another(8));
  await time.advance(MIN);
  expect((await until(stream, "job.changed")).find((e) => e.type === "job.changed")).toMatchObject({
    changeId: idOf(8),
    job: { trigger: "opened" },
  });

  host.push(ref(7), pushed(7), pr1.diff);
  await time.advance(MIN);
  await time.advance(MIN);
  expect((await snapshot(service, cookie)).reviews[idOf(7)]?.job).toMatchObject({
    trigger: "push",
    sha: pushed(7),
  });
});

test("Review now before the choice is asked as before: a job, and its round posted with its check", async () => {
  const { service, host, time, cookie, stream } = await atRepositories();
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(stream, "job.changed")).find((e) => e.type === "job.changed")).toMatchObject({
    changeId: idOf(1),
    job: { trigger: "manual" },
  });
  await until(stream, "round.finished");
  await time.advance(0);
  expect(host.posts.map((p) => p.kind)).toEqual([
    "check.created",
    "check.updated",
    "status.written",
    "status.written",
    "check.completed",
  ]);
  expect(host.view(ref(1)).checks).toMatchObject([{ status: "completed", conclusion: "success" }]);
});
