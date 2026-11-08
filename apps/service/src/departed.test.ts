// A repository the installation stops listing (ADR 0059), through the service's door on the held demo clock and the
// fake GitHub: said departed once in the snapshot, with when it left, kept across a restart, also when it left while
// the service was stopped; no longer said once the installation lists it again, or once the person dismisses it
// (`repos.dismiss`, ADR 0082: one `repo.dismissed` for each repository named and said departed, the others passed
// over), which is refused when none of them is said departed.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { type Event, type RepositoryRef, repositoryId } from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import {
  api,
  home,
  messages,
  OWNER,
  openApp,
  post,
  SANDBOX,
  SHARED_BOT,
  snapshot,
  start,
  startRoom,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const LEDGER: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-api" };
const WEB: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-web" };
const LEDGER_ID = repositoryId(`${LEDGER.owner}/${LEDGER.name}`);
const WEB_ID = repositoryId(`${WEB.owner}/${WEB.name}`);
const DOCS: RepositoryRef = { owner: SANDBOX.owner, name: "ledger-docs" };
const DOCS_ID = repositoryId(`${DOCS.owner}/${DOCS.name}`);

/** The fake GitHub, its App installed on the sandbox, ledger-api, ledger-web and ledger-docs. */
const hostOn = (time: DemoClock) =>
  new FakeGitHost({
    repo: SANDBOX,
    repositories: [LEDGER, WEB, DOCS],
    bot: SHARED_BOT,
    person: OWNER,
    changes: [],
    clock: time,
  });

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
  const dismiss = (...repoIds: string[]) => post(service, cookie, { type: "repos.dismiss", repoIds });

  expect((await dismiss(LEDGER_ID)).status).toBe(404);

  host.removeRepository(LEDGER);
  host.removeRepository(WEB);
  await time.advance(5 * MIN);
  expect((await snapshot(service, cookie)).departed.map((d: { id: string }) => d.id)).toEqual([
    LEDGER_ID,
    WEB_ID,
  ]);

  expect((await dismiss(LEDGER_ID)).status).toBe(200);
  expect((await snapshot(service, cookie)).departed.map((d: { id: string }) => d.id)).toEqual([WEB_ID]);
  expect((await dismiss(LEDGER_ID)).status).toBe(404);
  await service.stop();

  const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, repos: [SANDBOX, LEDGER, WEB] });
  expect(room.snapshot().departed.map((d) => d.id)).toEqual([WEB_ID]);
});

test("a list dismissed at once: one event for each repository said departed, the others passed over, none said refused, an empty list or the old command not parsed", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  const { service } = await start({ home: home(), host, time, repos: [SANDBOX, LEDGER, WEB, DOCS] });
  const cookie = await openApp(service);
  const dismiss = (...repoIds: string[]) => post(service, cookie, { type: "repos.dismiss", repoIds });

  host.removeRepository(LEDGER);
  host.removeRepository(WEB);
  await time.advance(5 * MIN);

  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  // The sandbox is watched, never departed; elsewhere is unknown: both passed over. Ledger named twice is one event.
  expect(
    (await dismiss(LEDGER_ID, `${SANDBOX.owner}/${SANDBOX.name}`, WEB_ID, LEDGER_ID, "sasensi/elsewhere"))
      .status,
  ).toBe(200);
  // A command whose one event closes what the dismissal sent.
  expect((await post(service, cookie, { type: "setup.goto", step: "repos" })).status).toBe(200);
  const sent = (await until(stream, "setup.changed")).filter((e: Event) => e.type === "repo.dismissed");
  expect(sent.map((e) => (e.type === "repo.dismissed" ? e.repoId : null))).toEqual([LEDGER_ID, WEB_ID]);
  expect((await snapshot(service, cookie)).departed).toEqual([]);

  expect((await dismiss(LEDGER_ID, "sasensi/elsewhere")).status).toBe(404);
  expect((await dismiss()).status).toBe(400);
  expect((await post(service, cookie, { type: "repo.dismiss", repoId: LEDGER_ID })).status).toBe(400);
});

test("a repository departing as Dismiss all names the earlier ones is still said afterwards, after a restart too", async () => {
  const time = new DemoClock({ at: T0 });
  const host = hostOn(time);
  const dir = home();
  const repos = [SANDBOX, LEDGER, WEB, DOCS];
  const { service } = await start({ home: dir, host, time, repos });
  const cookie = await openApp(service);

  host.removeRepository(LEDGER);
  host.removeRepository(WEB);
  await time.advance(5 * MIN);
  // The line shows ledger-api and ledger-web; ledger-docs leaves before Dismiss all lands.
  const shown = (await snapshot(service, cookie)).departed.map((d: { id: string }) => d.id);
  host.removeRepository(DOCS);
  await time.advance(5 * MIN);
  expect((await post(service, cookie, { type: "repos.dismiss", repoIds: shown })).status).toBe(200);
  expect((await snapshot(service, cookie)).departed.map((d: { id: string }) => d.id)).toEqual([DOCS_ID]);
  await service.stop();

  const { room } = await startRoom({ home: dir, host, time, idsFrom: 100, repos });
  expect(room.snapshot().departed.map((d) => d.id)).toEqual([DOCS_ID]);
});
