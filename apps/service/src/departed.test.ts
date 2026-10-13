// A repository the installation stops listing (ADR 0059), through the service's door on the held demo clock and the
// fake GitHub: said departed once in the snapshot, with when it left, kept across a restart, also when it left while
// the service was stopped; no longer said once the installation lists it again, or once the person dismisses it
// (`repo.dismiss`), which is refused for a repository not said departed.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { type RepositoryRef, repositoryId } from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import {
  BOT,
  home,
  openApp,
  post,
  SANDBOX,
  snapshot,
  start,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const LEDGER: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-api" };
const WEB: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-web" };
const LEDGER_ID = repositoryId(`${LEDGER.owner}/${LEDGER.name}`);
const WEB_ID = repositoryId(`${WEB.owner}/${WEB.name}`);

/** The fake GitHub, its App installed on the sandbox, ledger-api and ledger-web. */
const hostOn = (time: DemoClock) =>
  new FakeGitHost({ repo: SANDBOX, repositories: [LEDGER, WEB], bot: BOT, changes: [], clock: time });

test("a repository the installation stops listing is said departed, kept across a restart, and no longer said once listed again", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  const dir = home();
  const first = await startRoom({ home: dir, host, time, repos: [SANDBOX, LEDGER, WEB] });
  expect(first.room.snapshot().departed).toEqual([]);

  host.removeRepository(LEDGER);
  await time.advance(5 * MIN);
  // The next poll finds its token refused, and the installation is listed again at once.
  const left = T0 + MIN;
  expect(first.room.snapshot().departed).toEqual([
    { id: LEDGER_ID, owner: LEDGER.owner, name: LEDGER.name, at: left },
  ]);
  await first.room.stop();

  const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, repos: [SANDBOX, LEDGER, WEB] });
  expect(room.snapshot().departed).toEqual([
    { id: LEDGER_ID, owner: LEDGER.owner, name: LEDGER.name, at: left },
  ]);

  host.addRepository(LEDGER);
  await time.advance(5 * MIN);
  expect(room.snapshot().repos.map((r) => r.id)).toContain(LEDGER_ID);
  expect(room.snapshot().departed).toEqual([]);
});

test("a repository that left while the service was stopped is said departed at the start", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  const dir = home();
  const first = await startRoom({ home: dir, host, time, repos: [SANDBOX, LEDGER, WEB] });
  await first.room.stop();

  host.removeRepository(WEB);
  await time.advance(MIN);
  const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, repos: [SANDBOX, LEDGER, WEB] });
  expect(room.snapshot().departed).toEqual([{ id: WEB_ID, owner: WEB.owner, name: WEB.name, at: T0 + MIN }]);
});

test("a departed repository dismissed is no longer said, after a restart too; one not said departed is refused", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  const dir = home();
  const { service } = await start({ home: dir, host, time, repos: [SANDBOX, LEDGER, WEB] });
  const cookie = await openApp(service);

  expect((await post(service, cookie, { type: "repo.dismiss", repoId: LEDGER_ID })).status).toBe(404);

  host.removeRepository(LEDGER);
  host.removeRepository(WEB);
  await time.advance(5 * MIN);
  expect((await snapshot(service, cookie)).departed.map((d: { id: string }) => d.id)).toEqual([
    LEDGER_ID,
    WEB_ID,
  ]);

  expect((await post(service, cookie, { type: "repo.dismiss", repoId: LEDGER_ID })).status).toBe(200);
  expect((await snapshot(service, cookie)).departed.map((d: { id: string }) => d.id)).toEqual([WEB_ID]);
  expect((await post(service, cookie, { type: "repo.dismiss", repoId: LEDGER_ID })).status).toBe(404);
  await service.stop();

  const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, repos: [SANDBOX, LEDGER, WEB] });
  expect(room.snapshot().departed.map((d) => d.id)).toEqual([WEB_ID]);
});
