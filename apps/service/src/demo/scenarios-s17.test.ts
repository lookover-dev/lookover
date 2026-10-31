// S17 through the drawer's door (ADR 0046, ADR 0067): setup's GitHub step, signed in to the shared App, with every
// state an account can be in: one reached, one asking for SSO, the person's own account and an organisation they own
// without the App, and one where they are a member, which they ask an owner to install it on. GitHub's fake install
// page offers each account its way: Install where they own it, Request where they are a member.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { githubLinks, type State } from "@lookover/contracts";
import { scenarioOf } from "../index.ts";
import { eventually, TEST_LIMIT_MS } from "../service.test-support.ts";
import {
  following,
  inject,
  load,
  onGitHub,
  send,
  snapshotOf,
  startScenario,
  stopAll,
  T0,
} from "./demo.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);

let door: Awaited<ReturnType<typeof startScenario>>;
beforeAll(async () => {
  door = await startScenario(scenarioOf("S10"));
});
afterAll(stopAll);

/** S17 loaded, once the person's `gh` (read after the start) has named their organisations. */
async function loaded(): Promise<State> {
  const { status, body } = await load(door, "S17");
  expect({ status, body }).toEqual({ status: 200, body: { ok: true } });
  const state = await eventually(
    () => snapshotOf(door),
    (s) => s.connection.unreached.length === 3,
  );
  expect(state.now).toBe(T0);
  return state;
}

/** Each unreached account as a row: login, kind, owner, asked. */
const unreachedOf = (state: State) =>
  state.connection.unreached.map((u) => [u.account.login, u.kind, u.owner, u.askedAt !== null]);

test("S17 stands at setup's GitHub step, signed in, with an account in every state", async () => {
  const state = await loaded();
  expect(state.setup).toMatchObject({ done: false, step: "github", github: "done" });
  expect(state.connection).toMatchObject({
    way: "shared",
    state: "connected",
    cause: null,
    person: { id: 1, login: "sasensi" },
  });
  expect(state.connection.accounts.map((a) => [a.account.login, a.owner, a.cause?.kind ?? null])).toEqual([
    ["ledger-dev", true, null],
    ["ledger-ops", false, "sso"],
  ]);
  expect(unreachedOf(state)).toEqual([
    ["sasensi", "user", true, false],
    ["ledger-labs", "organisation", true, false],
    ["ledger-hq", "organisation", false, false],
  ]);
});

test("GitHub's install page offers each account its way: Install where the person owns it, Request where a member", async () => {
  await loaded();
  const picker = await onGitHub(door, "/apps/lookover-dev/installations/new");
  expect(picker).toContain("sasensi");
  expect(picker).toContain('href="?target=ledger-labs">Install</a>');
  expect(picker).toContain('href="?target=ledger-hq">Request</a>');
  // ledger-dev has it already: configured, not installed again.
  expect(picker).toContain("ledger-dev");
  expect(picker).not.toContain("?target=ledger-dev");

  const request = await onGitHub(door, "/apps/lookover-dev/installations/new?target=ledger-hq");
  expect(request).toContain("Request");
  expect(request).toContain("An owner of ledger-hq");
  const sent = await onGitHub(door, "/apps/lookover-dev/installations/new?target=ledger-hq", [
    ["action", "request"],
  ]);
  expect(sent).toContain("Request sent");
  // A request records nothing on GitHub's side: ledger-hq is still without the App.
  expect(unreachedOf(await snapshotOf(door)).map(([login]) => login)).toContain("ledger-hq");
});

test("asked to install on ledger-hq, the setup shows it waiting for an owner; an owned organisation is refused", async () => {
  await loaded();
  const asked = await send(door, { type: "connection.askToInstall", account: "ledger-hq" });
  expect(asked.status).toBe(200);
  const waiting = await snapshotOf(door);
  expect(unreachedOf(waiting).at(-1)).toEqual(["ledger-hq", "organisation", false, true]);
  expect(waiting.connection.unreached.at(-1)?.askedAt).toBe(T0);

  const owned = await send(door, { type: "connection.askToInstall", account: "ledger-labs" });
  expect({ status: owned.status, body: await owned.json() }).toMatchObject({
    status: 409,
    body: { askToInstall: "owner" },
  });
});

test("installed from GitHub's page on ledger-labs, the person's own organisation is reached at the next listing", async () => {
  await loaded();
  const page = await onGitHub(door, "/apps/lookover-dev/installations/new?target=ledger-labs", [
    ["action", "install"],
  ]);
  expect(page).toContain("Installed on ledger-labs");
  expect((await send(door, { type: "connection.reconnect" })).status).toBe(200);
  const reached = await eventually(
    () => snapshotOf(door),
    (s) => s.connection.accounts.some((a) => a.account.login === "ledger-labs"),
  );
  expect(reached.connection.accounts.map((a) => a.account.login)).toEqual([
    "ledger-dev",
    "ledger-ops",
    "ledger-labs",
  ]);
  expect(unreachedOf(reached).map(([login]) => login)).toEqual(["sasensi", "ledger-hq"]);
});

/** An account reached, by its login. */
const reachedOf = (state: State, login: string) => {
  const found = state.connection.accounts.find((a) => a.account.login === login);
  if (found === undefined) throw new Error(`${login} is not reached`);
  return found;
};

test("each account's link lands on GitHub's fake: ledger-dev's settings, ledger-ops' SSO, ledger-hq's owners", async () => {
  const state = await loaded();
  const { web } = state.connection;

  // ledger-dev, the person's: Add a repository and Choose repositories open its installation's settings.
  const dev = reachedOf(state, "ledger-dev");
  const settings = await following(door, githubLinks.installation(web, dev.account, dev.installationId));
  expect(settings).toContain("ledger-dev/ledger-api");
  expect(settings).toContain("Installed.");

  // ledger-ops asks for SSO with no page of its own: the organisation's SSO page.
  expect(reachedOf(state, "ledger-ops").cause).toMatchObject({ kind: "sso", url: null });
  expect(await following(door, githubLinks.sso(web, "ledger-ops"))).toContain("Continue");

  // ledger-hq, a member's: Ask an owner of ledger-hq, once asked, lists mira.
  expect((await send(door, { type: "connection.askToInstall", account: "ledger-hq" })).status).toBe(200);
  expect(await following(door, githubLinks.owners(web, "ledger-hq"))).toContain("<li>mira</li>");

  // The install page names each account installed with Configure, its installation's settings.
  const picker = await following(door, githubLinks.install(web, "lookover-dev"));
  expect(picker).toContain(githubLinks.installation(web, dev.account, dev.installationId));
});

test("suspended on ledger-dev, which the person owns: Unsuspend it on GitHub lifts it, and the account is fine again", async () => {
  await loaded();
  expect(await inject(door, "organisation-suspended")).toBe(200);
  const dev = reachedOf(await snapshotOf(door), "ledger-dev");
  expect(dev.cause).toMatchObject({ kind: "uninstalled", suspended: true });
  const settings = githubLinks.installation(
    (await snapshotOf(door)).connection.web,
    dev.account,
    dev.installationId,
  );

  expect(await following(door, settings)).toContain("Unsuspend</button>");
  expect(await following(door, settings, [["action", "unsuspend"]])).toContain("Installed.");
  expect((await send(door, { type: "connection.reconnect" })).status).toBe(200);

  const fine = await eventually(
    () => snapshotOf(door),
    (s) => reachedOf(s, "ledger-dev").cause === null,
  );
  expect(fine.connection.state).toBe("connected");
});
