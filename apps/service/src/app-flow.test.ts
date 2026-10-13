// The manifest flow over HTTP (ADR 0053): the session-checked page that opens a flow and posts the manifest to GitHub
// under its own policy, GitHub played by the fake (the App made as GitHub's page makes it, its code converted once);
// the callback, reached with no session and from another site, accepting only the state of a flow opened in the last
// hour, used up only by a conversion that succeeded, kept across a restart; the App kept and adopted; the install's
// setup page; and "Create it on GitHub" recording the setup's state only, refused once an App is kept or under
// `live.json`. The key is never anywhere but the App store.
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API,
  APP_FLOW,
  APP_PERMISSIONS,
  type CreateAppRefusal,
  createAppRefusalText,
  type Gh,
  GITHUB_WEB,
  githubLinks,
  type HostAccount,
  type HostApp,
  type HostInstallations,
  type Setup,
  type State,
} from "@lookover/contracts";
import { openStore } from "@lookover/store";
import { DemoClock, FakeGitHost, memoryGh } from "@lookover/testkit";
import { appStore, type GitHubSide, type Membership, memoryKeychain, type StoredApp } from "./index.ts";
import { filesWithKeyText, hasKeyText } from "./key-scan.test-support.ts";
import {
  ACME,
  ACME_WEB,
  BOT,
  home,
  meeting,
  OWNER,
  openApp,
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

const MIN = 60_000;

/** The owner on the GitHub step, no App made yet. */
const ON_GITHUB: Setup = {
  done: false,
  step: "github",
  reached: "github",
  github: "start",
  githubRefused: null,
  firstReviewChange: null,
};

/** GitHub as the fake plays it with no App made yet, the App store in `dir` on a fake keychain. */
function noAppYet(host: FakeGitHost, dir: string, more: Partial<GitHubSide> = {}): GitHubSide {
  return {
    installations: host,
    connect: ({ key }) => {
      host.useKey(key);
      return { intake: host, writer: host };
    },
    apps: appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} }),
    ...more,
  };
}

/** A new owner's service on the fake GitHub, its data folder `dir`; the lines it logged. */
async function newOwner(
  o: { dir?: string; time?: DemoClock; host?: FakeGitHost; side?: Partial<GitHubSide>; gh?: Gh } = {},
) {
  const dir = o.dir ?? home();
  const time = o.time ?? new DemoClock({ at: T0 });
  const host =
    o.host ?? new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time, app: { made: false } });
  const logged: string[] = [];
  const { service } = await start({
    home: dir,
    host,
    time,
    setup: ON_GITHUB,
    github: noAppYet(host, dir, o.side),
    log: (line) => logged.push(line),
    ...(o.gh === undefined ? {} : { gh: o.gh }),
  });
  const cookie = await openApp(service);
  return { service, cookie, host, time, dir, logged };
}

type Door = Awaited<ReturnType<typeof newOwner>>;

const fromHtml = (s: string) =>
  s.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** The page "Create it on GitHub" opens, read as the browser reads it: its form, its policy, its state. */
async function manifestPage({ service, cookie }: Pick<Door, "service" | "cookie">) {
  const res = await fetch(`${service.origin}${APP_FLOW.manifest}`, {
    headers: { cookie, "sec-fetch-site": "same-origin" },
  });
  // The page that posts the manifest, or "No new App here" (409): a stand-alone page either way.
  const html = await standalone(res, res.status === 409 ? 409 : 200);
  const action = fromHtml(/<form[^>]* action="([^"]*)"/.exec(html)?.[1] ?? "");
  const manifest = fromHtml(/name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "");
  const state = action === "" ? "" : (new URL(action, service.origin).searchParams.get("state") ?? "");
  return { res, html, action, manifest, state };
}

/** GitHub's redirect back to the callback, from github.com: no session cookie, another site. */
function callback({ service }: Pick<Door, "service">, query: Record<string, string>) {
  return fetch(`${service.origin}${APP_FLOW.callback}?${new URLSearchParams(query)}`, {
    redirect: "manual",
    headers: { "sec-fetch-site": "cross-site" },
  });
}

/**
 * A page of the flow as the browser reads it (ADR 0058, design system "Stand-alone page"), checked: its status, its
 * own policy (nothing but its one style and one script, by the policy's nonce, no base, no frame, no form but the
 * manifest page's), no `style` attribute, the eyes, and `back` (Back to setup, or Back to Lookover once setup is
 * done), a link to the app (the manifest page has Continue to GitHub in its place). Its HTML.
 */
async function standalone(res: Response, status: number, back = "Back to setup"): Promise<string> {
  const html = await res.text();
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  const policy = (res.headers.get("content-security-policy") ?? "").split("; ");
  const style = policy.find((p) => p.startsWith("style-src")) ?? "";
  const nonce = /^style-src 'nonce-([^']+)'$/.exec(style)?.[1] ?? "";
  expect(nonce.length).toBeGreaterThanOrEqual(16);
  const posting = html.includes('<form id="manifest"');
  expect(policy).toEqual([
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    posting ? `form-action ${GITHUB_WEB}/` : "form-action 'none'",
  ]);
  expect(html.match(/<style\b[^>]*>/g)).toEqual([`<style nonce="${nonce}">`]);
  expect(html.match(/<script\b[^>]*>/g)).toEqual([`<script nonce="${nonce}">`]);
  expect(html).not.toMatch(/<[^>]*\sstyle=/);
  expect(html).toContain('aria-label="Lookover"');
  expect(html.includes(`<a class="btn btn-primary" href="/">${back}</a>`)).toBe(!posting);
  return html;
}

test("once setup is done, the pages lead back to Lookover, not to setup", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: BOT,
    changes: [pr1],
    clock: time,
    app: { made: false },
  });
  const dir = home();
  const { service } = await start({
    home: dir,
    host,
    time,
    setup: { ...ON_GITHUB, done: true },
    github: noAppYet(host, dir),
  });
  const installed = await fetch(`${service.origin}${APP_FLOW.installed}`, {
    headers: { "sec-fetch-site": "cross-site" },
  });
  const text = await standalone(installed, 200, "Back to Lookover");
  expect(text).toContain("Your repositories show in Lookover within a few seconds.");
  const refused = await callback({ service }, { code: "c", state: "never-opened" });
  expect(await standalone(refused, 400, "Back to Lookover")).not.toContain("Back to setup");
});

/** The owner makes the App on GitHub's page from the manifest: the code GitHub sends back. */
const confirmed = (host: FakeGitHost, manifest: string) => host.createApp(JSON.parse(manifest));

test("the page: session-checked, under its own policy, posting the manifest to GitHub with a new state", async () => {
  const door = await newOwner();
  const { service, cookie } = door;
  expect((await fetch(`${service.origin}${APP_FLOW.manifest}`)).status).toBe(401);

  const page = await manifestPage(door);
  expect(page.res.status).toBe(200);
  expect(page.res.headers.get("content-type")).toMatch(/^text\/html/);
  expect(page.res.headers.get("referrer-policy")).toBe("strict-origin");
  const policy = page.res.headers.get("content-security-policy") ?? "";
  // Its own form-action, GitHub's and nothing else; its one script carries the nonce the policy names.
  expect(policy).toContain(`form-action ${GITHUB_WEB}/`);
  expect(policy).not.toContain("form-action 'self'");
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce).toBeDefined();
  expect(page.html).toContain(`<script nonce="${nonce}">`);
  expect(page.html).toContain("GitHub may ask for your password, then you confirm.");
  expect(page.action).toBe(githubLinks.newApp(GITHUB_WEB, null, page.state));
  expect(page.state.length).toBeGreaterThanOrEqual(32);
  expect(JSON.parse(page.manifest)).toMatchObject({
    name: expect.stringMatching(/^lookover-[a-z0-9]{6}$/),
    public: false,
    redirect_url: `${service.origin}${APP_FLOW.callback}`,
    setup_url: `${service.origin}${APP_FLOW.installed}`,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  });
  // A second page is a second flow; every other page keeps the app's policy.
  expect((await manifestPage(door)).state).not.toBe(page.state);
  const other = await fetch(`${service.origin}${API.snapshot}`, { headers: { cookie } });
  expect(other.headers.get("content-security-policy")).toContain("form-action 'self'");
});

test("the callback converts the code of a flow opened, keeps and adopts the App, and sends the tab to its install page with no referrer", async () => {
  const door = await newOwner();
  const { service, cookie, host, time, dir, logged } = door;
  const page = await manifestPage(door);
  const code = confirmed(host, page.manifest);

  const back = await callback(door, { code, state: page.state });
  expect(back.status).toBe(303);
  const slug = host.onGitHub().app?.slug ?? "";
  expect(back.headers.get("location")).toBe(githubLinks.install(GITHUB_WEB, slug));
  expect(back.headers.get("referrer-policy")).toBe("no-referrer");
  const made: State = await snapshot(service, cookie);
  expect(made.setup).toMatchObject({ github: "waiting-for-install", githubRefused: null });
  expect(made.connection).toMatchObject({ app: { slug }, bot: `${slug}[bot]` });

  // Installed on GitHub: GitHub's setup page brings the tab back, which trusts nothing it is given.
  host.install();
  await time.advance(4_000);
  const installed = await fetch(
    `${service.origin}${APP_FLOW.installed}?installation_id=<b>echo-9</b>&setup_action=echo-install`,
    { headers: { "sec-fetch-site": "cross-site" } },
  );
  const text = await standalone(installed, 200);
  // A heading, as every stand-alone page's: no full stop, in the page or in the tab's title.
  expect(text).toContain('<h1 class="t-h2">Lookover is installed</h1>');
  expect(text).toContain("<title>Lookover is installed · Lookover</title>");
  expect(text).toContain("Your repositories show in setup within a few seconds.");
  expect(text).not.toContain("echo-");
  const done: State = await snapshot(service, cookie);
  expect(done.setup).toMatchObject({ github: "done", step: "github", reached: "repos" });
  expect(done.connection.state).toBe("connected");

  // Used up: the same redirect again (the tab reloaded) converts nothing, and says the App is kept.
  const again = await callback(door, { code, state: page.state });
  const againText = await standalone(again, 409);
  expect(againText).toContain("Lookover already keeps an App");
  expect(againText).toContain("Setup goes on with the App Lookover keeps.");

  // The key is in the App store only: no key text in the data folder, the events, the snapshot or the log.
  const { key } = host.credentials();
  expect(readdirSync(join(dir, "github")).filter((f) => f.endsWith(".key"))).toHaveLength(1);
  expect(key).toContain("PRIVATE KEY");
  expect(await filesWithKeyText(dir, { known: [key] })).toEqual([]);
  const store = openStore({ home: dir, durable: false });
  const log = JSON.stringify(store.events.all());
  store.close();
  expect(log).toContain(slug);
  expect(hasKeyText(log, [key])).toBe(false);
  expect(hasKeyText(JSON.stringify(done), [key])).toBe(false);
  expect(logged.some((line) => hasKeyText(line, [key]) || line.includes(code))).toBe(false);
  // The code and the state are nowhere either: the store keeps the state's hash only.
  for (const secret of [code, page.state]) expect(log).not.toContain(secret);
  expect(filesHolding(dir, [code, page.state])).toEqual([]);
});

/** The files under `dir`, the SQLite database and its journal included, holding any of `texts`. */
function filesHolding(dir: string, texts: string[]): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => {
      const content = readFileSync(file).toString("latin1");
      return texts.some((t) => content.includes(t));
    });
}

test("the App made but not kept: the page says so, the log names no key and no code, and the redirect again converts nothing", async () => {
  const dir = home();
  const kept = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  const door = await newOwner({
    dir,
    side: {
      apps: {
        read: () => kept.read(),
        write: async () => {
          throw new Error("the keychain is locked");
        },
        keepMembership: (membership) => kept.keepMembership(membership),
      },
    },
  });
  const converted = spyOn(door.host, "convertManifest");
  const page = await manifestPage(door);
  const code = confirmed(door.host, page.manifest);

  const failed = await callback(door, { code, state: page.state });
  expect(await standalone(failed, 500)).toContain("Lookover couldn't keep the App's key");
  const { key } = door.host.credentials();
  expect(door.logged.some((line) => line.includes("the keychain is locked"))).toBe(true);
  expect(door.logged.some((line) => hasKeyText(line, [key]) || line.includes(code))).toBe(false);

  const again = await callback(door, { code, state: page.state });
  expect(again.status).toBe(400);
  expect(converted).toHaveBeenCalledTimes(1);
  expect((await snapshot(door.service, door.cookie)).connection).toMatchObject({ app: null });
});

test("the same redirect twice at once: one keeps the App, the other is told it is kept, the code converted once", async () => {
  const door = await newOwner();
  const converted = spyOn(door.host, "convertManifest");
  const page = await manifestPage(door);
  const code = confirmed(door.host, page.manifest);

  const answers = await Promise.all([
    callback(door, { code, state: page.state }),
    callback(door, { code, state: page.state }),
  ]);
  expect(answers.map((a) => a.status).sort()).toEqual([303, 409]);
  expect(converted).toHaveBeenCalledTimes(1);
  expect((await snapshot(door.service, door.cookie)).connection.app).toMatchObject({
    slug: door.host.onGitHub().app?.slug,
  });
});

test("GitHub's redirect and Use an existing App at once, for two Apps: one is kept, the other refused", async () => {
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: BOT,
    changes: [pr1],
    clock: time,
    app: { made: false },
  });
  const meet = meeting();
  /** Another App of the owner's, with every permission, given in a second tab. */
  const other: HostApp = {
    id: 42,
    slug: "lookover-other",
    owner: { id: 1, login: SANDBOX.owner, type: "User" },
    permissions: { ...APP_PERMISSIONS },
  };
  // GitHub held at the conversion and at the other App's check until both are under way.
  const installations: HostInstallations = {
    convertManifest: (code) => meet(() => host.convertManifest(code)),
    app: (credentials) =>
      meet(() => (credentials.id === other.id ? Promise.resolve(other) : host.app(credentials))),
    installation: (credentials) => host.installation(credentials),
    repositories: (credentials, id) => host.repositories(credentials, id),
  };
  const door = await newOwner({ time, host, side: { installations } });
  const page = await manifestPage(door);
  const code = confirmed(host, page.manifest);
  const key = "-----BEGIN RSA PRIVATE KEY-----\nanother-apps-key\n-----END RSA PRIVATE KEY-----\n";

  const [back, used] = await Promise.all([
    callback(door, { code, state: page.state }),
    post(door.service, door.cookie, { type: "connection.useApp", appId: other.id, key }),
  ]);
  const backText = await back.text();
  const usedBody = await used.json();
  const app = (await snapshot(door.service, door.cookie)).connection.app;
  if (back.status === 303) {
    expect(used.status).toBe(409);
    expect(usedBody).toMatchObject({ useApp: { kind: "another-app" } });
    expect(app).toMatchObject({ slug: host.onGitHub().app?.slug });
  } else {
    expect(back.status).toBe(409);
    expect(backText).toContain("Lookover already keeps an App");
    expect(used.status).toBe(200);
    expect(app).toMatchObject({ id: other.id });
  }
});

test("a forged state, or one with no code, is refused with nothing converted and the setup as it was", async () => {
  const door = await newOwner();
  const page = await manifestPage(door);
  const code = confirmed(door.host, page.manifest);

  for (const query of [{ code, state: "<i>echo-forged</i>" }, { code }, { state: page.state }]) {
    const refused = await standalone(await callback(door, query), 400);
    expect(refused).toContain("Back in setup, choose “Create it on GitHub” again.");
    expect(refused).not.toContain("echo-");
  }
  expect((await snapshot(door.service, door.cookie)).setup).toMatchObject(ON_GITHUB);
  // The code was never spent.
  expect(await door.host.convertManifest(code)).toMatchObject({ app: { slug: expect.any(String) } });
});

test("a flow opened more than an hour ago is refused, and the setup says GitHub's page ran out", async () => {
  const door = await newOwner();
  const page = await manifestPage(door);
  const code = confirmed(door.host, page.manifest);
  await door.time.advance(60 * MIN + 1);
  const refused = await standalone(await callback(door, { code, state: page.state }), 400);
  expect(refused).toContain("Back in setup, choose “Create it on GitHub” again.");
  expect((await snapshot(door.service, door.cookie)).setup).toMatchObject({ githubRefused: "expired" });
});

test("GitHub refusing the conversion: the page says so and what to do, and the setup says GitHub refused", async () => {
  const door = await newOwner();
  const page = await manifestPage(door);
  const code = confirmed(door.host, page.manifest);
  door.host.refuse("unauthorized");
  const refused = await standalone(await callback(door, { code, state: page.state }), 400);
  expect(refused).toContain("GitHub refused to make the App");
  expect(refused).toContain("Back in setup, choose “Create it on GitHub” again.");
  expect((await snapshot(door.service, door.cookie)).setup).toMatchObject({ githubRefused: "refused" });
});

test("GitHub out of reach for the conversion: the flow stays open, and the same redirect reloaded within the hour finishes", async () => {
  const door = await newOwner();
  const page = await manifestPage(door);
  const code = confirmed(door.host, page.manifest);
  door.host.refuse("unavailable");
  const down = await callback(door, { code, state: page.state });
  expect(await standalone(down, 502)).toContain("reload this page");
  expect((await snapshot(door.service, door.cookie)).setup).toMatchObject({
    github: "start",
    githubRefused: "unreachable",
  });

  door.host.refuse(null);
  await door.time.advance(10 * MIN);
  const back = await callback(door, { code, state: page.state });
  expect(back.status).toBe(303);
  expect((await snapshot(door.service, door.cookie)).setup).toMatchObject({
    github: "waiting-for-install",
    githubRefused: null,
  });
});

test("a restart between the page and GitHub's redirect: the flow is kept, and the callback finishes", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({
    repo: SANDBOX,
    bot: BOT,
    changes: [pr1],
    clock: time,
    app: { made: false },
  });
  const first = await newOwner({ dir, time, host });
  const page = await manifestPage(first);
  const code = confirmed(host, page.manifest);
  await first.service.stop();

  const again = await newOwner({ dir, time, host });
  const back = await callback(again, { code, state: page.state });
  expect(back.status).toBe(303);
  expect((await snapshot(again.service, again.cookie)).connection.app).toMatchObject({
    slug: host.onGitHub().app?.slug,
  });
});

test("Create it on GitHub records that the setup waits for the App, nothing more; refused once an App is kept", async () => {
  const door = await newOwner();
  const { service, cookie, host, time } = door;
  expect((await post(service, cookie, { type: "connection.createApp", organisation: null })).status).toBe(
    200,
  );
  await time.advance(MIN);
  const waiting: State = await snapshot(service, cookie);
  expect(waiting.setup).toMatchObject({ github: "waiting-for-app", githubRefused: null });
  expect(waiting.connection).toMatchObject({ app: null, bot: null });

  const page = await manifestPage(door);
  await callback(door, { code: confirmed(host, page.manifest), state: page.state });
  const refused = await post(service, cookie, { type: "connection.createApp", organisation: null });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: "Lookover already keeps an App.",
    createApp: { kind: "already-made" },
  });
  const again = await manifestPage(door);
  expect(again.res.status).toBe(409);
  expect(again.state).toBe("");
});

test("under live.json, the page and Create it on GitHub refuse: live runs never create an App", async () => {
  const door = await newOwner({ side: { liveConfig: true } });
  const refused = await post(door.service, door.cookie, { type: "connection.createApp", organisation: null });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: "Live runs use the test App; they never create one.",
    createApp: { kind: "live-config" },
  });
  const page = await manifestPage(door);
  expect(page.res.status).toBe(409);
  expect(page.html).toContain("Live runs use the test App");
  expect(page.state).toBe("");
  expect((await snapshot(door.service, door.cookie)).setup).toMatchObject(ON_GITHUB);
});

// ---- On an organisation (ADR 0059): where the App is made is chosen on "Create it on GitHub", only among the
// organisations the person's own `gh` lists as theirs to admin, kept with the flow, and the App kept on the
// organisation for that person. Your own account never asks `gh`.

/** An organisation where the owner is a member, not an admin. */
const TEAMMATES = { id: 9100, login: "teammates" };

/** `gh` signed in as the owner, an admin of ACME and a member of TEAMMATES; each read it is asked named in `asked`. */
function ownersGh() {
  const gh = memoryGh({ as: OWNER });
  gh.join(ACME, OWNER, { state: "active", admin: true });
  gh.join(TEAMMATES, OWNER, { state: "active", admin: false });
  const asked: string[] = [];
  const counted: Gh = {
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
  return { gh, counted, asked };
}

/** ACME on the fake, no App made yet: the App a manifest makes is the organisation's. */
const acmeWithNoApp = (time: DemoClock) =>
  new FakeGitHost({ repo: ACME_WEB, bot: BOT, changes: [], clock: time, app: { owner: ACME, made: false } });

/** The App store in `dir`, each App it is given recorded. */
function recordingApps(dir: string) {
  const kept = appStore({ home: dir, keychain: memoryKeychain(), userOnly: async () => {} });
  const written: StoredApp[] = [];
  const apps = {
    read: () => kept.read(),
    write: (app: StoredApp, key: string) => {
      written.push(app);
      return kept.write(app, key);
    },
    keepMembership: (membership: Membership) => kept.keepMembership(membership),
  };
  return { apps, written };
}

test("on an organisation: the page posts the manifest to its new App page, and the App is kept on it for the person gh is signed in as", async () => {
  const time = new DemoClock({ at: T0 });
  const host = acmeWithNoApp(time);
  const dir = home();
  const { apps, written } = recordingApps(dir);
  const { counted } = ownersGh();
  const door = await newOwner({ dir, time, host, side: { apps }, gh: counted });

  // The login as the person may write it: GitHub's logins are matched without case.
  const chosen = await post(door.service, door.cookie, {
    type: "connection.createApp",
    organisation: "ACME",
  });
  expect(chosen.status).toBe(200);
  const page = await manifestPage(door);
  expect(page.action).toBe(`https://github.com/organizations/acme/settings/apps/new?state=${page.state}`);
  // GitHub makes it on the organisation, whose conversion names it as the App's account.
  const code = confirmed(host, page.manifest);
  const back = await callback(door, { code, state: page.state });
  expect(back.status).toBe(303);
  const slug = host.onGitHub().app?.slug ?? "";
  expect(back.headers.get("location")).toBe(githubLinks.install(GITHUB_WEB, slug));

  const made = { id: host.onGitHub().app?.id ?? 0, slug, account: ACME, person: OWNER };
  expect(written).toEqual([made]);
  const shown: State = await snapshot(door.service, door.cookie);
  expect(shown.connection.app).toEqual(made);
  expect(shown.setup).toMatchObject({ github: "waiting-for-install", githubRefused: null });
});

test("on an organisation the person left before GitHub's redirect: the App is kept, gh asked, and nothing is listed for them once installed", async () => {
  const time = new DemoClock({ at: T0 });
  const host = acmeWithNoApp(time);
  const dir = home();
  const { apps, written } = recordingApps(dir);
  const { gh, counted } = ownersGh();
  const door = await newOwner({ dir, time, host, side: { apps }, gh: counted });
  await post(door.service, door.cookie, { type: "connection.createApp", organisation: "acme" });
  const page = await manifestPage(door);
  const code = confirmed(host, page.manifest);

  gh.leave("acme", OWNER);
  expect((await callback(door, { code, state: page.state })).status).toBe(303);
  expect(written).toHaveLength(1);
  expect(door.logged).toContain(
    "sasensi is no longer a member of acme: reviews stop until an admin adds them back",
  );
  host.install();
  await time.advance(8_000);
  const shown: State = await snapshot(door.service, door.cookie);
  expect(shown.repos).toEqual([]);
  expect(shown.setup).toMatchObject({ github: "waiting-for-install" });
});

test("the page makes the App where Create it on GitHub said, never where its own address says, after a restart too", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = acmeWithNoApp(time);
  const { counted } = ownersGh();
  const first = await newOwner({ dir, time, host, gh: counted });
  await post(first.service, first.cookie, { type: "connection.createApp", organisation: "acme" });
  await first.service.stop();

  const again = await newOwner({ dir, time, host, gh: counted });
  for (const query of ["?organisation=evil", "?org=evil&organisation=", ""]) {
    const res = await fetch(`${again.service.origin}${APP_FLOW.manifest}${query}`, {
      headers: { cookie: again.cookie, "sec-fetch-site": "same-origin" },
    });
    const action = fromHtml(/<form[^>]* action="([^"]*)"/.exec(await res.text())?.[1] ?? "");
    expect(action).toStartWith("https://github.com/organizations/acme/settings/apps/new?state=");
  }

  // Your own account chosen again: the next page is your own account's.
  await post(again.service, again.cookie, { type: "connection.createApp", organisation: null });
  const yours = await manifestPage(again);
  expect(yours.action).toBe(githubLinks.newApp(GITHUB_WEB, null, yours.state));
});

test("on your own account, nothing asks gh: not Create it on GitHub, the page, nor the callback", async () => {
  const dir = home();
  const { apps, written } = recordingApps(dir);
  const { counted, asked } = ownersGh();
  const door = await newOwner({ dir, side: { apps }, gh: counted });

  const chosen = await post(door.service, door.cookie, { type: "connection.createApp", organisation: null });
  expect(chosen.status).toBe(200);
  const page = await manifestPage(door);
  expect(page.action).toBe(githubLinks.newApp(GITHUB_WEB, null, page.state));
  const back = await callback(door, { code: confirmed(door.host, page.manifest), state: page.state });
  expect(back.status).toBe(303);

  expect(asked).toEqual([]);
  // The person is the App's own account, as GitHub's conversion names it.
  const owner = { id: 1, login: SANDBOX.owner };
  const made = door.host.onGitHub().app;
  expect(written).toEqual([
    {
      id: made?.id ?? 0,
      slug: made?.slug ?? "",
      account: { ...owner, type: "User" as const },
      person: owner,
    },
  ]);
});

test("an organisation gh doesn't list as the person's to admin is refused, as is any when gh can't say", async () => {
  const time = new DemoClock({ at: T0 });
  const failing = (why: "offline" | "scope") => () => {
    const { gh } = ownersGh();
    gh.fail(why);
    return gh;
  };
  const cases: [string, () => Gh | undefined, string, CreateAppRefusal][] = [
    ["a member only", () => ownersGh().counted, "teammates", { kind: "not-an-admin" }],
    ["none of theirs", () => ownersGh().counted, "elsewhere", { kind: "not-an-admin" }],
    ["no gh at all", () => undefined, "acme", { kind: "gh-missing" }],
    ["gh not installed", () => memoryGh({ as: "missing" }), "acme", { kind: "gh-missing" }],
    ["gh signed out", () => memoryGh({ as: null }), "acme", { kind: "gh-signed-out" }],
    ["gh offline", failing("offline"), "acme", { kind: "gh-unanswered", why: "offline" }],
    ["gh without read:org", failing("scope"), "acme", { kind: "gh-unanswered", why: "scope" }],
  ];
  for (const [name, ghOf, organisation, refusal] of cases) {
    const gh = ghOf();
    const door = await newOwner({ time, host: acmeWithNoApp(time), ...(gh === undefined ? {} : { gh }) });
    const refused = await post(door.service, door.cookie, { type: "connection.createApp", organisation });
    expect([name, refused.status]).toEqual([name, 409]);
    expect([name, await refused.json()]).toEqual([
      name,
      { error: createAppRefusalText(refusal), createApp: refusal },
    ]);
    // Nothing waits for the App, and the page refuses: it never falls back to your own account.
    expect((await snapshot(door.service, door.cookie)).setup).toMatchObject(ON_GITHUB);
    const page = await manifestPage(door);
    expect([name, page.res.status, page.state]).toEqual([name, 409, ""]);
    expect(page.html).toContain("Choose where to make the App");
    await door.service.stop();
  }
});

/** The owner's `gh`, its organisations held until `answer` is called: "Create it on GitHub" waits on it meanwhile. */
function slowGh() {
  const { gh, asked } = ownersGh();
  let answer = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const slow: Gh = {
    person: () => gh.person(),
    adminOrganisations: async () => {
      asked.push("adminOrganisations");
      await held;
      return gh.adminOrganisations();
    },
    membership: (organisation) => gh.membership(organisation),
  };
  /** Until gh is being asked for the organisations. */
  const asking = async () => {
    while (!asked.includes("adminOrganisations")) await Bun.sleep(1);
  };
  return { slow, answer, asking };
}

test("the page opened while gh is read for the organisation chosen waits for it, then posts there or refuses", async () => {
  const time = new DemoClock({ at: T0 });
  const cases: [string, string | null, string, string | null][] = [
    // Your own account was the place before: the page waits, and goes to the organisation.
    ["your own account before", null, "acme", "https://github.com/organizations/acme/settings/apps/new"],
    // An organisation before, one gh doesn't list now: the page refuses, never posting to the one before.
    ["acme before, refused", "acme", "teammates", null],
  ];
  for (const [name, before, organisation, posted] of cases) {
    const { slow, answer, asking } = slowGh();
    const door = await newOwner({ time, host: acmeWithNoApp(time), gh: slow });
    if (before !== null) {
      answer();
      await post(door.service, door.cookie, { type: "connection.createApp", organisation: before });
    }
    const chosen = post(door.service, door.cookie, { type: "connection.createApp", organisation });
    await asking();
    // The screen opens the page as it sends the command: the page comes while gh is still being read.
    const opening = manifestPage(door);
    await Bun.sleep(20);
    answer();
    await chosen;
    const page = await opening;
    if (posted === null) {
      expect([name, page.res.status, page.state]).toEqual([name, 409, ""]);
      expect(page.html).toContain("Choose where to make the App");
    } else expect([name, page.action]).toEqual([name, `${posted}?state=${page.state}`]);
    await door.service.stop();
  }
});

test("the last Create it on GitHub wins: your own account chosen while gh is read for an organisation, the page goes to yours", async () => {
  const time = new DemoClock({ at: T0 });
  const { slow, answer, asking } = slowGh();
  const door = await newOwner({ time, host: acmeWithNoApp(time), gh: slow });
  const acme = post(door.service, door.cookie, { type: "connection.createApp", organisation: "acme" });
  await asking();
  const yours = await post(door.service, door.cookie, { type: "connection.createApp", organisation: null });
  expect(yours.status).toBe(200);
  answer();
  await acme;
  const page = await manifestPage(door);
  expect(page.action).toBe(githubLinks.newApp(GITHUB_WEB, null, page.state));
});

test("a refused Create it on GitHub leaves no place to make the App, after a restart too, until one is chosen", async () => {
  const dir = home();
  const time = new DemoClock({ at: T0 });
  const host = acmeWithNoApp(time);
  const { counted } = ownersGh();
  const first = await newOwner({ dir, time, host, gh: counted });
  await post(first.service, first.cookie, { type: "connection.createApp", organisation: "acme" });
  const refused = await post(first.service, first.cookie, {
    type: "connection.createApp",
    organisation: "teammates",
  });
  expect(refused.status).toBe(409);
  await first.service.stop();

  const again = await newOwner({ dir, time, host, gh: counted });
  const page = await manifestPage(again);
  expect([page.res.status, page.state]).toEqual([409, ""]);
  await post(again.service, again.cookie, { type: "connection.createApp", organisation: null });
  const yours = await manifestPage(again);
  expect(yours.action).toBe(githubLinks.newApp(GITHUB_WEB, null, yours.state));
});

test("an App GitHub made elsewhere than the place chosen is not kept, and the page and the setup say where it is", async () => {
  // Whatever page was posted to, the fake makes the App on its own account.
  const cases: [string, HostAccount, string | null, string][] = [
    [
      "an organisation chosen, made on a person's",
      { id: 1, login: SANDBOX.owner, type: "User" },
      "acme",
      "acme",
    ],
    ["your own account chosen, made on an organisation", ACME, null, "your GitHub account"],
    ["an organisation chosen, made on another of its login", { ...ACME, id: 9999 }, "acme", "acme"],
  ];
  for (const [name, owner, organisation, asked] of cases) {
    const dir = home();
    const time = new DemoClock({ at: T0 });
    const host = new FakeGitHost({
      repo: owner.type === "User" ? SANDBOX : ACME_WEB,
      bot: BOT,
      changes: [],
      clock: time,
      app: { owner, made: false },
    });
    const { apps, written } = recordingApps(dir);
    const { counted } = ownersGh();
    const door = await newOwner({ dir, time, host, side: { apps }, gh: counted });
    await post(door.service, door.cookie, { type: "connection.createApp", organisation });
    const page = await manifestPage(door);

    const back = await callback(door, { code: confirmed(host, page.manifest), state: page.state });
    const slug = host.onGitHub().app?.slug ?? "";
    const html = fromHtml(await standalone(back, 400));
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    expect([name, title]).toEqual([name, "GitHub made the App on another account · Lookover"]);
    expect(html).toContain(`GitHub made ${slug} on ${owner.login}, not on ${asked}.`);
    expect(html).toContain("Lookover doesn't use it: you can delete it in its settings on GitHub.");
    expect(written).toEqual([]);
    const shown: State = await snapshot(door.service, door.cookie);
    expect(shown.connection.app).toBeNull();
    expect([name, shown.setup.githubRefused]).toEqual([name, "elsewhere"]);
    expect(door.logged).toContain(`${slug} was made on ${owner.login}, not on ${asked}: it isn't kept`);
    await door.service.stop();
  }
});

test("gh.check reads who gh is signed in as and the organisations they admin, which the setup's GitHub step shows", async () => {
  const time = new DemoClock({ at: T0 });
  const { gh } = ownersGh();
  const door = await newOwner({ time, host: acmeWithNoApp(time), gh });
  expect((await snapshot(door.service, door.cookie)).connection.gh).toBeNull();

  expect((await post(door.service, door.cookie, { type: "gh.check" })).status).toBe(200);
  expect((await snapshot(door.service, door.cookie)).connection.gh).toEqual({
    person: { kind: "signed-in", account: OWNER },
    organisations: { kind: "listed", organisations: [{ id: ACME.id, login: ACME.login }] },
  });

  // Signed out meanwhile: Create it on GitHub on the organisation reads it again, and the step shows why it refused.
  gh.signIn(null);
  await post(door.service, door.cookie, { type: "connection.createApp", organisation: "acme" });
  expect((await snapshot(door.service, door.cookie)).connection.gh).toEqual({
    person: { kind: "signed-out" },
    organisations: { kind: "signed-out" },
  });

  // gh can't answer: the step shows why, never gh's own words, which go to the log only.
  gh.signIn(OWNER);
  gh.fail("offline");
  await post(door.service, door.cookie, { type: "connection.createApp", organisation: "acme" });
  expect((await snapshot(door.service, door.cookie)).connection.gh).toEqual({
    person: { kind: "unanswered", why: "offline" },
    organisations: { kind: "unanswered", why: "offline" },
  });
  expect(door.logged.some((line) => line.includes("(offline)"))).toBe(true);
});
