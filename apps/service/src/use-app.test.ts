// "Use an existing App" (`connection.useApp`, ADR 0053), through the service's door on the held demo clock and the
// fake GitHub, which owns the App: an App checked with its own token before anything is kept (a personal owner, or
// an organisation the person's own `gh` is an active member of, ADR 0059; ADR 0022's permissions, each one missing
// named), then kept and its install waited for; another App's id refused while one is kept, the kept App's id taking
// a new key (the fix for a refused or lost key); `live.json`'s App never replaced. Each refusal is data (`useApp`)
// beside `error`, and no answer, log, event or file but the App store's holds the key.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  APP_PERMISSIONS,
  type AppCredentials,
  type Gh,
  type HostApp,
  type UseAppRefusal,
} from "@lookover/contracts";
import { DemoClock, FakeGitHost, type FakeGitHostOptions, memoryGh } from "@lookover/testkit";
import { appStore, memoryKeychain, type StoredApp } from "./index.ts";
import { filesWithKeyText, hasKeyText } from "./key-scan.test-support.ts";
import {
  ACME,
  ACME_WEB,
  BOT,
  home,
  meeting,
  OWNER,
  onFakeGitHub,
  openApp,
  personalApp,
  post,
  pr1,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

/** A key file GitHub never handed out for the fake's App: PEM-shaped, so it reaches GitHub. */
const FOREIGN_KEY = "-----BEGIN RSA PRIVATE KEY-----\nnot-this-apps-key\n-----END RSA PRIVATE KEY-----\n";

/** Another App of the owner's, with every permission: what a second setup tab gives with `FOREIGN_KEY`. */
const OTHER_APP: HostApp = {
  id: 42,
  slug: "lookover-other",
  owner: { ...OWNER, type: "User" },
  permissions: { ...APP_PERMISSIONS },
};

/**
 * A service on a data folder with an App store, the fake's App installed or not. `kept`: the fake's App already in
 * the App store (the setup done); else none (the setup at its GitHub step). `app` changes how GitHub describes the
 * App (an organisation's, say).
 */
async function serviceOn(
  options: {
    host?: Partial<FakeGitHostOptions>;
    kept?: boolean | StoredApp;
    app?: (app: HostApp) => HostApp;
    gh?: Gh;
  } = {},
) {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, ...options.host });
  const dir = home();
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  if (options.kept !== undefined && options.kept !== false) {
    const kept = options.kept === true ? personalApp(1, "lookover-spike-sasensi") : options.kept;
    await apps.write(kept, host.credentials().key);
  }
  const { given: _, ...side } = onFakeGitHub(host);
  const describe = options.app ?? ((app) => app);
  const installations = {
    ...side.installations,
    app: async (credentials: AppCredentials) => describe(await side.installations.app(credentials)),
  };
  const lines: string[] = [];
  const { service } = await start({
    home: dir,
    host,
    time,
    github: { ...side, installations, apps },
    log: (line) => lines.push(line),
    ...(options.gh === undefined ? {} : { gh: options.gh }),
  });
  const cookie = await openApp(service);
  /** The command sent, and its answer: status, body and the text as sent. */
  const useApp = async (appId: number, key: string) => {
    const answer = await post(service, cookie, { type: "connection.useApp", appId, key });
    const text = await answer.text();
    const body: unknown = JSON.parse(text);
    return { status: answer.status, body, text };
  };
  return { time, host, dir, apps, service, cookie, useApp, lines };
}

test("an App of the owner's with every permission: kept, shown, and its install waited for", async () => {
  const { host, apps, service, cookie, useApp } = await serviceOn({ host: { installed: false } });
  const { id, key } = host.credentials();

  expect(await useApp(id, key)).toMatchObject({ status: 200, body: { ok: true } });

  expect(await apps.read()).toMatchObject({ state: "kept", app: { id }, privateKey: key });
  const state = await snapshot(service, cookie);
  expect(state.setup).toMatchObject({ github: "waiting-for-install", githubRefused: null });
  expect(state.connection).toMatchObject({
    bot: BOT.login,
    app: { id, account: { ...OWNER, type: "User" }, person: OWNER },
  });
});

test("a wrong key, a wrong id, a file with no key and GitHub unreachable are refused with why, and nothing is kept", async () => {
  const { host, apps, service, cookie, useApp } = await serviceOn({ host: { installed: false } });
  const { id, key } = host.credentials();

  expect(await useApp(id, FOREIGN_KEY)).toMatchObject({
    status: 409,
    body: { error: expect.any(String), useApp: { kind: "key-refused" } },
  });
  expect(await useApp(id + 7, key)).toMatchObject({ status: 409, body: { useApp: { kind: "key-refused" } } });
  expect(await useApp(id, "a shopping list, not a key")).toMatchObject({
    status: 409,
    body: { useApp: { kind: "not-a-key" } },
  });
  host.refuse("unavailable");
  expect(await useApp(id, key)).toMatchObject({ status: 502, body: { useApp: { kind: "unreachable" } } });
  // A rate limit is GitHub out of reach for now, as the manifest flow says it too: try again later.
  host.refuse("rate_limited", { retryAt: T0 + 60_000 });
  expect(await useApp(id, key)).toMatchObject({ status: 502, body: { useApp: { kind: "unreachable" } } });

  expect(await apps.read()).toEqual({ state: "none" });
  const state = await snapshot(service, cookie);
  expect(state.setup).toMatchObject({ github: "start" });
  expect(state.connection).toMatchObject({ app: null, bot: null });
});

// ---- An organisation's App (ADR 0059): taken when the person's own `gh` is signed in as an active member of the
// App's organisation, admin or not, and kept for that person; refused with why otherwise. A personal App never asks
// `gh`.

/** A member of ACME's: the person an admin handed the App to. */
const MIRA = { id: 5150, login: "mira" };

/** GitHub with ACME's App, made by an admin and not installed yet: what a member is handed. */
const ACME_APP = {
  host: { repo: ACME_WEB, changes: [], app: { owner: ACME }, installed: false },
  // GitHub's own description of the App: ACME's, as the fake holds it.
  app: (app: HostApp): HostApp => ({ ...app, owner: { ...ACME } }),
};

/** `gh`, each read it is asked named in `asked`. */
function counted(gh: Gh) {
  const asked: string[] = [];
  const reads: Gh = {
    person: () => {
      asked.push("person");
      return gh.person();
    },
    adminOrganisations: () => {
      asked.push("adminOrganisations");
      return gh.adminOrganisations();
    },
    membership: (organisation) => {
      asked.push(`membership ${organisation}`);
      return gh.membership(organisation);
    },
  };
  return { reads, asked };
}

/** `gh` signed in as `person`, with that membership of ACME (none: not a member). */
function ghAs(person: { id: number; login: string }, state?: "active" | "pending") {
  const gh = memoryGh({ as: person });
  if (state !== undefined) gh.join(ACME, person, { state, admin: false });
  return gh;
}

test("an organisation's App is taken for an active member, admin or not, and kept for the person gh is signed in as", async () => {
  const { reads, asked } = counted(ghAs(MIRA, "active"));
  const { host, apps, service, cookie, useApp } = await serviceOn({ ...ACME_APP, gh: reads });
  const { id, key } = host.credentials();

  expect(await useApp(id, key)).toMatchObject({ status: 200, body: { ok: true } });

  expect(asked).toEqual(["membership acme"]);
  expect(await apps.read()).toMatchObject({ state: "kept", app: { id, account: ACME, person: MIRA } });
  const state = await snapshot(service, cookie);
  expect(state.setup).toMatchObject({ github: "waiting-for-install", githubRefused: null });
  expect(state.connection).toMatchObject({ app: { id, account: ACME, person: MIRA } });
});

test("an organisation's App is refused with why unless gh is signed in as an active member, and nothing is kept", async () => {
  const offline = () => {
    const gh = ghAs(MIRA, "active");
    gh.fail("offline");
    return gh;
  };
  const cases: [string, () => Gh | undefined, UseAppRefusal][] = [
    ["no gh at all", () => undefined, { kind: "gh-missing" }],
    ["gh not installed", () => memoryGh({ as: "missing" }), { kind: "gh-missing" }],
    ["gh signed out", () => memoryGh({ as: null }), { kind: "gh-signed-out" }],
    ["gh offline", offline, { kind: "gh-unanswered", why: "offline" }],
    [
      "gh signed in as someone else",
      () => ghAs(OWNER),
      { kind: "not-a-member", organisation: "acme", person: "sasensi", invited: false },
    ],
    [
      "invited, not joined yet",
      () => ghAs(MIRA, "pending"),
      { kind: "not-a-member", organisation: "acme", person: "mira", invited: true },
    ],
  ];
  for (const [name, gh, refusal] of cases) {
    const given = gh();
    const { host, apps, service, cookie, useApp, lines } = await serviceOn({
      ...ACME_APP,
      ...(given === undefined ? {} : { gh: given }),
    });
    const { id, key } = host.credentials();
    expect([name, await useApp(id, key)]).toMatchObject([name, { status: 409, body: { useApp: refusal } }]);
    expect([name, await apps.read()]).toEqual([name, { state: "none" }]);
    expect([name, (await snapshot(service, cookie)).connection]).toMatchObject([name, { app: null }]);
    // `gh`'s own words go to the log only, never to the answer.
    if (refusal.kind === "gh-unanswered")
      expect(lines).toContain(
        "gh couldn't answer for the organisation (offline): error connecting to api.github.com",
      );
    await service.stop();
  }
});

/** A member of ACME's other than MIRA. */
const OTTO = { id: 5151, login: "otto" };

/** ACME's App kept for MIRA, installed: a new key for it is what heals a refused or lost one. */
const ACME_KEPT = {
  host: { repo: ACME_WEB, changes: [], app: { owner: ACME } },
  app: ACME_APP.app,
  kept: { id: 1, slug: "lookover-spike-sasensi", account: { ...ACME }, person: { ...MIRA } },
};

test("the kept organisation App's new key keeps its person: refused when gh names another, taken when gh can't answer", async () => {
  const offline = ghAs(MIRA, "active");
  offline.fail("offline");
  const cases: [string, Gh | undefined, UseAppRefusal | null][] = [
    [
      "gh signed in as another member",
      ghAs(OTTO, "active"),
      { kind: "another-person", person: "otto", kept: "mira" },
    ],
    ["gh offline", offline, null],
    ["gh signed out", memoryGh({ as: null }), null],
    ["no gh at all", undefined, null],
    // The person kept, no longer a member: still theirs, as it was.
    ["gh signed in as the person kept", ghAs(MIRA), null],
  ];
  for (const [name, gh, refusal] of cases) {
    const { host, apps, service, cookie, useApp } = await serviceOn({
      ...ACME_KEPT,
      ...(gh === undefined ? {} : { gh }),
    });
    const before = host.credentials().key;
    host.revokeKey();
    const key = host.generateKey();
    const answer = await useApp(1, key);
    expect([name, answer]).toMatchObject([
      name,
      refusal === null ? { status: 200, body: { ok: true } } : { status: 409, body: { useApp: refusal } },
    ]);
    expect([name, await apps.read()]).toMatchObject([
      name,
      { state: "kept", app: ACME_KEPT.kept, privateKey: refusal === null ? key : before },
    ]);
    expect([name, (await snapshot(service, cookie)).connection]).toMatchObject([
      name,
      { app: { account: ACME, person: MIRA } },
    ]);
    await service.stop();
  }
});

test("a personal App never asks gh", async () => {
  const { reads, asked } = counted(ghAs(MIRA, "active"));
  const { host, apps, useApp } = await serviceOn({ host: { installed: false }, gh: reads });
  const { id, key } = host.credentials();
  expect(await useApp(id, key)).toMatchObject({ status: 200, body: { ok: true } });
  expect(await apps.read()).toMatchObject({ state: "kept", app: { person: OWNER } });
  expect(asked).toEqual([]);
});

test("an App lacking permissions is refused, each one short named in ADR 0022's order", async () => {
  const { host, apps, useApp } = await serviceOn({
    host: {
      installed: false,
      app: { permissions: { metadata: "read", contents: "write", pull_requests: "read", issues: "write" } },
    },
  });
  const { id, key } = host.credentials();
  expect(await useApp(id, key)).toMatchObject({
    status: 409,
    body: { useApp: { kind: "missing-permissions", missing: ["pull_requests", "checks"] } },
  });
  expect(await apps.read()).toEqual({ state: "none" });
});

test("another App's id is refused while one is kept, before GitHub is asked; the App kept stays", async () => {
  const { host, apps, useApp } = await serviceOn({ kept: true });
  const before = await apps.read();
  expect(await useApp(2, host.generateKey())).toMatchObject({
    status: 409,
    body: { useApp: { kind: "another-app" } },
  });
  expect(await apps.read()).toEqual(before);
});

test("two setup tabs give two Apps at once: one is kept, the other refused as another App, and the first keeps its key", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, installed: false });
  const dir = home();
  const apps = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  const { given: _, ...side } = onFakeGitHub(host);
  const meet = meeting();
  const installations = {
    ...side.installations,
    // GitHub describes the second App too, each check held until the other is under way.
    app: (credentials: AppCredentials) =>
      meet(() =>
        credentials.id === OTHER_APP.id ? Promise.resolve(OTHER_APP) : side.installations.app(credentials),
      ),
  };
  const { service } = await start({
    home: dir,
    host,
    time,
    github: { ...side, installations, apps },
    log: () => {},
  });
  const cookie = await openApp(service);
  const { id, key } = host.credentials();

  const answers = await Promise.all([
    post(service, cookie, { type: "connection.useApp", appId: id, key }),
    post(service, cookie, { type: "connection.useApp", appId: OTHER_APP.id, key: FOREIGN_KEY }),
  ]);
  const bodies = await Promise.all(answers.map((a) => a.json()));
  const kept = answers.findIndex((a) => a.status === 200);
  expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
  expect(bodies[1 - kept]).toMatchObject({ useApp: { kind: "another-app" } });
  expect(await apps.read()).toMatchObject({
    state: "kept",
    app: { id: kept === 0 ? id : OTHER_APP.id },
    privateKey: kept === 0 ? key : FOREIGN_KEY,
  });
});

test("the kept App's new key heals a refused key: kept in its place, reconnected and listed", async () => {
  const { host, apps, service, cookie, useApp } = await serviceOn({ kept: true });
  host.revokeKey();
  expect((await post(service, cookie, { type: "connection.reconnect" })).status).toBe(502);
  expect((await snapshot(service, cookie)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "key-refused" },
  });

  const key = host.generateKey();
  expect(await useApp(1, key)).toMatchObject({ status: 200, body: { ok: true } });

  expect(await apps.read()).toMatchObject({ state: "kept", app: { id: 1 }, privateKey: key });
  const state = await snapshot(service, cookie);
  expect(state.connection).toMatchObject({ state: "connected", cause: null });
  expect(state.setup).toMatchObject({ done: true, github: "done" });
});

test("the kept App's new key is kept even when GitHub can't be reached for the reconnect: the connection says why", async () => {
  // GitHub describes the App, then goes down before the reconnect lists its installation.
  let host: FakeGitHost | null = null;
  const served = await serviceOn({
    kept: true,
    app: (app) => {
      host?.refuse("unavailable");
      return app;
    },
  });
  host = served.host;
  const { apps, service, cookie, useApp } = served;
  host.revokeKey();
  const key = host.generateKey();

  expect(await useApp(1, key)).toMatchObject({ status: 200, body: { ok: true } });

  expect(await apps.read()).toMatchObject({ state: "kept", app: { id: 1 }, privateKey: key });
  expect((await snapshot(service, cookie)).connection).toMatchObject({
    state: "disconnected",
    cause: { kind: "unreachable" },
  });
});

test("live.json's App is never replaced: any id refused as live.json's, before GitHub is asked", async () => {
  const { service, host } = await start();
  const cookie = await openApp(service);
  const key = host.generateKey();
  // GitHub down: an id checked there would answer unreachable.
  host.refuse("unavailable");
  for (const appId of [1, 2]) {
    const answer = await post(service, cookie, { type: "connection.useApp", appId, key });
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({
      error: "the App was refused: live-config",
      useApp: { kind: "live-config" },
    });
  }
});

test("no key text in any answer, log line or file but the App store's, after an App kept and refused", async () => {
  const { host, dir, apps, service, cookie, useApp, lines } = await serviceOn({ host: { installed: false } });
  const { id, key } = host.credentials();
  const answers = [
    await useApp(id, FOREIGN_KEY),
    await useApp(id + 7, key),
    await useApp(id, key),
    await useApp(id + 1, key),
  ];
  expect(answers.map((a) => a.status)).toEqual([409, 409, 200, 409]);
  const known = [key, FOREIGN_KEY];
  for (const { text } of answers) expect(hasKeyText(text, known)).toBe(false);
  for (const line of lines) expect(hasKeyText(line, known)).toBe(false);
  expect(hasKeyText(JSON.stringify(await snapshot(service, cookie)), known)).toBe(false);
  // Kept in the keychain's envelope: no unencrypted file is excepted.
  expect(await apps.read()).toMatchObject({ state: "kept", protection: "keychain" });
  expect(await filesWithKeyText(dir, { known })).toEqual([]);
});
