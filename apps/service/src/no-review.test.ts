// A round with no line comment posts no review (ADR 0074, "Posting order"): whether the round owes one is kept when
// it is saved, and the status block lands its ledger instead, also when GitHub refuses it; a restart looks for a review
// by its marker only when one was owed. On the fakes and the held clock; the scripted retrieval gives no diff unless
// told, so every finding is off the diff.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { statusOf } from "@lookover/contracts";
import { FakeGitHost } from "@lookover/testkit";
import {
  api,
  fakeEngines,
  home,
  lastEvent,
  messages,
  ONE_FINDING,
  OWNER,
  onTheDiff,
  openApp,
  pr1,
  review,
  roundWritten,
  SANDBOX,
  SHARED_BOT,
  sinceStart,
  start,
  stopAll,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const PR1 = { repo: SANDBOX, number: 1 };

/** A host that counts the reviews looked for by their marker. */
class CountingFinds extends FakeGitHost {
  finds = 0;

  override findReview(...args: Parameters<FakeGitHost["findReview"]>): Promise<string | null> {
    this.finds++;
    return super.findReview(...args);
  }
}

/**
 * A host that keeps the first round's status block it is asked to write (not the one the check follower writes as the
 * job runs), then holds its answer until `stopped`, and fails it then: the service stopped after GitHub took the post
 * that lands the round, before Lookover marked it sent. `kept` settles once the block is on the host.
 */
class StatusKeptThenStopped extends CountingFinds {
  private armed = true;
  private heard = () => {};
  readonly kept = new Promise<void>((resolve) => {
    this.heard = resolve;
  });
  private stop = () => {};
  private readonly stoppedYet = new Promise<void>((resolve) => {
    this.stop = resolve;
  });

  stopped(): void {
    this.stop();
  }

  override async upsertStatus(...args: Parameters<FakeGitHost["upsertStatus"]>): Promise<void> {
    await super.upsertStatus(...args);
    const description = this.view(args[0]).description;
    if (!this.armed || !roundWritten({ kind: "status.written", description })) return;
    this.armed = false;
    this.heard();
    await this.stoppedYet;
    throw new Error("the service stopped while GitHub answered the status block");
  }
}

test("a round with no finding posts no review: the status block and the check only", async () => {
  const engines = fakeEngines({ reviews: 1 });
  const { service, host } = await start({ engines, changes: [pr1] });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({ job: { state: "done" } });
  const shown = host.view(PR1);
  expect(shown.reviews).toEqual([]);
  expect(shown.comments).toEqual([]);
  expect(statusOf(shown.description)).toStartWith("### ");
  expect(statusOf(shown.description)).toContain(" · Nothing to fix\n\nRound 1 · ");
  expect(shown.checks.map((c) => `${c.status} ${c.conclusion}`)).toEqual(["completed success"]);
});

test("a round whose findings are all off the diff posts no review, and its status block lands them: the next round posts none again", async () => {
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const { service, host } = await start({ engines, changes: [pr1] });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "done" },
    findings: [{ id: "F1", posted: true }],
  });
  expect(host.view(PR1).reviews).toEqual([]);
  expect(statusOf(host.view(PR1).description)).toContain(
    "The key is logged · `src/total.ts` line 3\n  Not in the diff:",
  );

  engines.answer({ outcome: "ok", text: ONE_FINDING });
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "done" },
    round: { n: 2 },
    findings: [{ id: "F1", status: "open", posted: true }],
  });
  expect(host.view(PR1).reviews).toEqual([]);
});

test("a round with no review whose status block GitHub refuses still lands its ledger: the next round posts its findings no more", async () => {
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const { service, host } = await start({ engines, changes: [pr1], log: () => {} });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // The round's block, after the one the check follower writes as the job runs.
  host.refuseNext("unauthorized", { post: "status", skip: 1 });
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "failed", failure: { kind: "publish_failed" } },
    findings: [{ id: "F1", posted: true }],
  });

  engines.answer({ outcome: "ok", text: ONE_FINDING });
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "done" },
    round: { n: 2 },
    findings: [{ id: "F1", posted: true }],
  });
  expect(host.view(PR1).reviews).toEqual([]);
});

test("a round with a line comment posts its review", async () => {
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const retrieval = onTheDiff();
  const { service, host } = await start({ engines, retrieval, changes: [pr1] });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "done" },
    findings: [{ id: "F1", posted: true, commented: true }],
  });
  expect(host.view(PR1).reviews.map((r) => r.comments.length)).toEqual([1]);
});

test("a service stopped after the status block that lands a round with no review resumes once: no review looked for, none posted, no second write", async () => {
  const dir = home();
  const engines = fakeEngines();
  engines.answer({ outcome: "ok", text: ONE_FINDING });
  const host = new StatusKeptThenStopped({ repo: SANDBOX, bot: SHARED_BOT, person: OWNER, changes: [pr1] });
  const first = await start({ home: dir, host, engines });
  await review(first.service, await openApp(first.service));
  await host.kept;
  await first.service.stop();
  host.stopped();
  await first.time.advance(0);
  const written = host.posts.filter((p) => p.kind === "status.written").length;
  // Looking over as the job ran, then the round's.
  expect(written).toBe(2);
  const ran = engines.runs.length;

  const last = lastEvent(dir);
  const second = await start({ home: dir, host, engines, time: first.time, idsFrom: 100, log: () => {} });
  const seen = await until(
    await sinceStart(second.service, await openApp(second.service), last),
    "round.finished",
  );
  expect(seen.at(-1)).toMatchObject({
    job: { state: "done" },
    round: { n: 1 },
    findings: [{ id: "F1", posted: true }],
  });
  // Nothing is found again: the posts resume.
  expect(engines.runs).toHaveLength(ran);
  expect(host.finds).toBe(0);
  const shown = host.view(PR1);
  expect(shown.reviews).toEqual([]);
  // The block written again is the same: nothing more is written.
  expect(host.posts.filter((p) => p.kind === "status.written")).toHaveLength(written);
  expect(statusOf(shown.description)).toContain("The key is logged");
  expect(shown.checks.map((c) => c.status)).toEqual(["completed"]);
});
