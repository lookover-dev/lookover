// The service's events in demo mode: numbered on from the snapshot, replayed to a UI that reconnects, kept
// alive, and numbered on across a restart (ADR 0038).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { apply, type Event, type State } from "@lookover/contracts";
import {
  api,
  expectedChange1,
  home,
  messages,
  next,
  openApp,
  post,
  pr1,
  SANDBOX,
  SHA1_PUSHED,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

test("events are numbered on from the snapshot, and a refresh lists the pull requests again", async () => {
  const { service, host } = await start();
  const cookie = await openApp(service);
  const before: State = await snapshot(service, cookie);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));

  host.push({ repo: SANDBOX, number: 1 }, SHA1_PUSHED, pr1.diff);
  expect((await post(service, cookie, { type: "refresh" })).status).toBe(200);

  const pushed = await next(stream);
  expect(pushed.id).toBe("5");
  expect(pushed.event).toBe("event");
  // The commits the push brought, as the host counts them; no pusher but the author.
  const event: Event = {
    type: "change.pushed",
    seq: 5,
    at: T0,
    changeId: expectedChange1.id,
    sha: SHA1_PUSHED,
    commits: 1,
    by: "you",
  };
  expect(JSON.parse(pushed.data)).toEqual(event);

  // A tab that followed the event and one that loads the snapshot see the same thing (AGENTS.md rule 3).
  const state: State = await snapshot(service, cookie);
  expect(state.seq).toBe(5);
  expect(state.changes[expectedChange1.id]?.headSha).toBe(SHA1_PUSHED);
  expect(state).toEqual(apply(before, event));
  // A refresh that finds nothing new sends nothing.
  expect((await post(service, cookie, { type: "refresh" })).status).toBe(200);
  expect((await snapshot(service, cookie)).seq).toBe(5);
});

test("a UI that reconnects gets the events it missed, or is told to reload when they are gone", async () => {
  const { service, host } = await start({ eventsKept: 2 });
  const cookie = await openApp(service);
  host.push({ repo: SANDBOX, number: 1 }, SHA1_PUSHED, pr1.diff);
  await post(service, cookie, { type: "refresh" });

  // Events 1 to 5 happened; the buffer holds 4 and 5.
  const replay = messages(
    await fetch(api(service, "/events"), { headers: { cookie, "last-event-id": "3" } }),
  );
  expect((await next(replay)).id).toBe("4");
  expect((await next(replay)).id).toBe("5");

  const gone = messages(await fetch(api(service, "/events"), { headers: { cookie, "last-event-id": "2" } }));
  expect((await next(gone)).event).toBe("reload");

  // A number past the end (a tab left open across a data reset) has nothing to replay either.
  const past = messages(await fetch(`${api(service, "/events")}?after=40`, { headers: { cookie } }));
  expect((await next(past)).event).toBe("reload");
  // One that saw everything waits for what comes next.
  const current = await fetch(`${api(service, "/events")}?after=5`, { headers: { cookie } });
  expect(current.status).toBe(200);
  await current.body?.cancel();
  expect((await fetch(`${api(service, "/events")}?after=abc`, { headers: { cookie } })).status).toBe(400);
});

test("a quiet stream says it is alive every 15 s, as an event the browser sees, carrying the service's now", async () => {
  const { service, time } = await start();
  const cookie = await openApp(service);
  const stream = messages(await fetch(`${api(service, "/events")}?after=4`, { headers: { cookie } }));
  // Async generators queue their calls: the two reads wait for the next two messages, in order.
  const two = Promise.all([next(stream), next(stream)]);
  await time.advance(30_000);
  // Each keepalive says what time it is on the service's clock (ADR 0046): a tab follows it between events, and
  // never runs ahead of one standing still.
  const alive = (at: number) => ({ id: null, event: "keepalive", data: JSON.stringify({ at }) });
  expect(await two).toEqual([alive(T0 + 15_000), alive(T0 + 30_000)]);
});

test("a restart keeps the pull requests and goes on numbering", async () => {
  const dir = home();
  const first = await start({ home: dir });
  const cookie = await openApp(first.service);
  first.host.push({ repo: SANDBOX, number: 1 }, SHA1_PUSHED, pr1.diff);
  await post(first.service, cookie, { type: "refresh" });
  await first.service.stop();

  const second = await start({ home: dir, host: first.host });
  // A tab opened before the restart keeps its session: the cookie is the data folder's, the link's token is
  // the start's.
  expect((await fetch(api(second.service, "/snapshot"), { headers: { cookie } })).status).toBe(200);
  const cookie2 = await openApp(second.service);
  expect(cookie2).toBe(cookie);
  const state = await snapshot(second.service, cookie2);
  // The second start (6); its own listing finds nothing new.
  expect(state.seq).toBe(6);
  expect(state.changes["lookover-sandbox#1"]).toEqual({
    ...expectedChange1,
    headSha: SHA1_PUSHED,
    newCommits: 1,
  });
  expect(Object.keys(state.changes).sort()).toEqual(["lookover-sandbox#1", "lookover-sandbox#2"]);

  // A tab from before the restart reloads, even one that saw every number: what the service fixes at
  // start (since when it runs, the engines' health) is in no event it could replay (ADR 0038).
  const stale = messages(
    await fetch(`${api(second.service, "/events")}?after=5`, { headers: { cookie: cookie2 } }),
  );
  expect((await next(stale)).event).toBe("reload");
  // A tab of this service that saw everything waits for what comes next.
  const current = await fetch(`${api(second.service, "/events")}?after=6`, { headers: { cookie: cookie2 } });
  expect(current.status).toBe(200);
  await current.body?.cancel();
});
