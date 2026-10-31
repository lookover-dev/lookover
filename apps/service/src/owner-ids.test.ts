// A data folder from before ADR 0066, whose changes are `<name>#<n>`, through the service's door on the held demo
// clock and the fake host: the store's migration names them `<owner>/<name>#<n>`, the events kept from before keep
// the old ids (history) and the start sends the UI's state again in the new ones, so the pull request reviewed
// before is shown with its rounds, isn't reviewed again by the start, and "Review now" asks its round 2. A third start
// renames nothing again; a departed repository's review keeps its old id, as the store, holding no row of it, does.
import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { changeId, type RepositoryRef, type State } from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import {
  api,
  BOT,
  fakeEngines,
  home,
  messages,
  openApp,
  post,
  pr1,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const ID = changeId("sasensi/lookover-sandbox#1");
const OLD_ID = changeId("lookover-sandbox#1");
const LEDGER: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-api" };

/**
 * The data folder as a service from before ADR 0066 left it: every change id of `repos` its name and number alone, in
 * the store and in the events, and the migration that renames them not run yet.
 */
function asBefore(dir: string, repos: RepositoryRef[] = [SANDBOX]): void {
  const db = new Database(join(dir, "lookover.sqlite"), { strict: true });
  for (const { owner, name } of repos) {
    const old = (column: string) => `${column} = replace(${column}, '${owner}/${name}#', '${name}#')`;
    for (const table of ["jobs", "rounds", "plans", "dismissals"])
      db.run(`UPDATE ${table} SET ${old("change_id")}`);
    db.run(`UPDATE setup SET ${old("first_review_change")}`);
    db.run(`UPDATE events SET body = replace(body, '"${owner}/${name}#', '"${name}#')`);
  }
  db.run("DELETE FROM migrations WHERE name = '20261030090000-change-ids-with-owner'");
  db.close();
}

/** How many `state.replaced` events the data folder's log holds. */
function replacedIn(dir: string): number {
  const db = new Database(join(dir, "lookover.sqlite"), { strict: true, readonly: true });
  const row = db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM events WHERE json_extract(body, '$.type') = 'state.replaced'",
    )
    .get();
  db.close();
  return row?.n ?? 0;
}

/** The change ids the store's rounds keep, in order. */
function roundsIn(dir: string): string[] {
  const db = new Database(join(dir, "lookover.sqlite"), { strict: true, readonly: true });
  const rows = db.query<{ id: string }, []>("SELECT DISTINCT change_id AS id FROM rounds ORDER BY id").all();
  db.close();
  return rows.map((r) => r.id);
}

test("a data folder from before keeps its history under the new ids: no review again at start, and the next is round 2", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [], clock: time });
  const first = await start({ home: dir, host, time, engines: fakeEngines({ reviews: 2 }) });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  host.open(pr1);
  await time.advance(MIN);
  await until(stream, "round.finished");
  await first.service.stop();
  asBefore(dir);

  const second = await start({ home: dir, host, time, engines: fakeEngines({ reviews: 1 }), idsFrom: 100 });
  const cookie2 = await openApp(second.service);
  const state: State = await snapshot(second.service, cookie2);
  expect(Object.keys(state.changes)).toEqual([ID]);
  expect(Object.keys(state.reviews)).toEqual([ID]);
  expect(state.reviews[ID]?.changeId).toBe(ID);
  expect(state.reviews[ID]?.rounds.map((r) => r.n)).toEqual([1]);
  // The start and its listings review nothing again: one check on GitHub, round 1's.
  await time.advance(5 * MIN);
  expect(host.view({ repo: SANDBOX, number: 1 }).checks).toHaveLength(1);

  const after = messages(await fetch(api(second.service, "/events"), { headers: { cookie: cookie2 } }));
  const asked = await post(second.service, cookie2, { type: "review.request", changeId: ID });
  expect(asked.status).toBe(200);
  await until(after, "round.finished");
  const reviewed: State = await snapshot(second.service, cookie2);
  expect(reviewed.reviews[ID]?.rounds.map((r) => r.n)).toEqual([1, 2]);
  expect(Object.keys(reviewed.changes)).toEqual([ID]);
  expect(reviewed.changes[OLD_ID]).toBeUndefined();
  await second.service.stop();
  expect(replacedIn(dir)).toBe(1);

  // A third start finds every id in the new shape: nothing is renamed, nor sent again.
  const third = await start({ home: dir, host, time, engines: fakeEngines(), idsFrom: 200 });
  const again: State = await snapshot(third.service, await openApp(third.service));
  expect(Object.keys(again.changes)).toEqual([ID]);
  expect(Object.keys(again.reviews)).toEqual([ID]);
  expect(again.reviews[ID]?.rounds.map((r) => r.n)).toEqual([1, 2]);
  await third.service.stop();
  expect(replacedIn(dir)).toBe(1);
});

test("a departed repository's review keeps its old id, as the store does, while a watched one's is renamed", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, repositories: [LEDGER], bot: BOT, changes: [], clock: time });
  const repos = [SANDBOX, LEDGER];
  const first = await start({ home: dir, host, time, repos, engines: fakeEngines({ reviews: 4 }) });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));
  host.open(pr1);
  host.open({ ...pr1, repo: LEDGER, url: "https://github.com/sasensi/ledger-api/pull/1" });
  await time.advance(MIN);
  await until(stream, "round.finished");
  await until(stream, "round.finished");
  host.removeRepository(LEDGER);
  await time.advance(5 * MIN);
  const left: State = await snapshot(first.service, cookie);
  expect(left.departed.map((d) => d.name)).toEqual([LEDGER.name]);
  await first.service.stop();
  asBefore(dir, repos);

  const second = await start({ home: dir, host, time, repos, engines: fakeEngines(), idsFrom: 100 });
  const state: State = await snapshot(second.service, await openApp(second.service));
  expect(Object.keys(state.reviews).sort()).toEqual(["ledger-api#1", ID]);
  expect(roundsIn(dir)).toEqual(["ledger-api#1", ID]);
});
