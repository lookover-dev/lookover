// What a round shows while it posts (ADR 0055, "What is posting"), on the fakes and the held clock: each post sent and
// each wait GitHub makes it take go to the app as `run.posting`, and the log file says a wait and a round given up.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Event, RunPosting } from "@lookover/contracts";
import {
  api,
  fakeEngines,
  messages,
  openApp,
  PLANTED,
  pr1,
  review,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;

/** `at` as the log file says it: the machine's local time. */
function local(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const postings = (events: Event[]): RunPosting[] =>
  events.flatMap((e) => (e.type === "run.posting" && e.changeId === PLANTED ? [e.posting] : []));

test("a post GitHub asks to wait shows the round's outbox: sent of owed, until when and why, then each post sent", async () => {
  const engines = fakeEngines({ reviews: 1 });
  const { service, host, time, logged } = await start({ engines, changes: [pr1] });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // The check and the review land; GitHub's secondary limit refuses the summary once: a minute's wait.
  host.refuseNext("rate_limited", { post: "summary" });
  expect((await review(service, cookie)).status).toBe(200);
  const seen = await until(events, "run.posting");
  while (postings(seen).at(-1)?.wait == null) seen.push(...(await until(events, "run.posting")));
  const refusedAt = time.now();
  await time.advance(MIN);
  seen.push(...(await until(events, "round.finished")));

  const until1 = refusedAt + MIN;
  expect(postings(seen)).toEqual([
    { sent: 0, owed: 4, wait: null },
    { sent: 1, owed: 4, wait: null },
    { sent: 2, owed: 4, wait: null },
    { sent: 2, owed: 4, wait: { until: until1, refusal: "rate_limited" } },
    { sent: 3, owed: 4, wait: null },
    { sent: 4, owed: 4, wait: null },
  ]);
  expect(seen.at(-1)).toMatchObject({ type: "round.finished", job: { state: "done" } });
  expect(logged).toContain(
    `lookover-sandbox#1 round 1 posts wait: GitHub asked to wait, trying again at ${local(until1)} (2 of 4 sent)`,
  );
  expect(logged.at(-1)).toBe("lookover-sandbox#1 round 1 posted: no open findings");
});

test("a post GitHub refuses for good is given up at once: no wait shown, and the log says the round's posts were given up", async () => {
  const engines = fakeEngines({ reviews: 1 });
  const { service, host, logged } = await start({ engines, changes: [pr1] });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.refuseNext("unauthorized", { post: "review" });
  expect((await review(service, cookie)).status).toBe(200);
  const seen = await until(events, "round.finished");

  expect(postings(seen)).toEqual([
    { sent: 0, owed: 4, wait: null },
    { sent: 1, owed: 4, wait: null },
  ]);
  expect(seen.at(-1)).toMatchObject({ job: { state: "failed", failure: { kind: "publish_failed" } } });
  expect(logged.filter((line) => line.includes("posts wait"))).toEqual([]);
  expect(logged.at(-1)).toMatch(
    /^lookover-sandbox#1 round 1 kept, its posts given up: GitHub refused the review/,
  );
});

test("an hour of GitHub not answering says each wait in the log, then the round given up", async () => {
  const engines = fakeEngines({ reviews: 1 });
  const { service, host, time, logged } = await start({ engines, changes: [pr1] });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.refuseNext("unavailable", { post: "review" });
  expect((await review(service, cookie)).status).toBe(200);
  const seen = await until(events, "run.posting");
  while (postings(seen).at(-1)?.wait == null) seen.push(...(await until(events, "run.posting")));
  const refusedAt = time.now();
  // The first wait is five seconds; GitHub stays down from then on.
  host.refuse("unavailable");
  await time.advance(65 * MIN);
  seen.push(...(await until(events, "round.finished")));

  expect(postings(seen)[2]).toEqual({
    sent: 1,
    owed: 4,
    wait: { until: refusedAt + 5_000, refusal: "unavailable" },
  });
  const waits = logged.filter((line) =>
    line.startsWith("lookover-sandbox#1 round 1 posts wait: GitHub did not answer"),
  );
  expect(waits.length).toBeGreaterThan(5);
  expect(waits[0]).toBe(
    `lookover-sandbox#1 round 1 posts wait: GitHub did not answer, trying again at ${local(refusedAt + 5_000)} (1 of 4 sent)`,
  );
  expect(logged).toContainEqual(
    expect.stringMatching(/^lookover-sandbox#1 round 1 kept, its posts given up: /),
  );
});
