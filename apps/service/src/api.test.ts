// The service's HTTP API in demo mode: the one-time link, the session cookie, who may call it, the snapshot
// it serves and the commands it checks.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Review, repositoryId } from "@lookover/contracts";
import { openStore } from "@lookover/store";
import { diskSettingsFiles } from "./index.ts";
import {
  api,
  BOT,
  expectedChange1,
  home,
  linkOf,
  messages,
  openApp,
  personalApp,
  post,
  SANDBOX_SETTINGS,
  SHA1,
  SHA2,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
  writeSettings,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const expectedReview1: Review = {
  changeId: expectedChange1.id,
  job: null,
  run: null,
  loop: null,
  rounds: [],
  findings: [],
  preview: false,
  updatedAt: T0,
  timeline: [{ at: T0, sha: SHA1, kind: "opened", by: "sasensi" }],
};

test("the one-time token becomes a cookie, and the snapshot lists the sandbox's pull requests", async () => {
  const { service } = await start();
  const cookie = await openApp(service);
  // The token opens the app once.
  expect((await fetch(linkOf(service), { redirect: "manual" })).status).toBe(403);

  const state = await snapshot(service, cookie);
  // The start, the repository, two pull requests.
  expect(state.seq).toBe(4);
  expect(state.now).toBe(T0);
  // Lookover's defaults, nothing of the owner's yet.
  const lookoverDefault = (value: unknown) => ({ value, origin: "lookover-default", overrode: null });
  const settings = {
    strictness: lookoverDefault("recommended"),
    reviewers: lookoverDefault("both"),
    depth: lookoverDefault("standard"),
    onOpen: lookoverDefault(true),
    onPush: lookoverDefault(false),
  };
  expect(state.settings).toEqual(settings);
  expect(state.repos).toEqual([
    {
      id: "sasensi/lookover-sandbox",
      owner: "sasensi",
      name: "lookover-sandbox",
      enabled: true,
      settings,
      // Nothing reviewed yet: "Too noisy?" would remove nothing (ADR 0049).
      noise: { reviews: 0, postedBelowBlocking: 0, raisedByRule: {} },
    },
  ]);
  expect(state.changes).toEqual({
    "lookover-sandbox#1": expectedChange1,
    "lookover-sandbox#2": {
      ...expectedChange1,
      id: "lookover-sandbox#2",
      number: 2,
      title: "Bump the dev dependencies",
      openedBy: "octocat",
      author: "other",
      headSha: SHA2,
      draft: true,
    },
  });
  expect(state.reviews["lookover-sandbox#1"]).toEqual(expectedReview1);
  expect(state.setup.done).toBe(true);
  expect(state.connection).toEqual({
    id: "github:lookover-spike-sasensi[bot]",
    state: "connected",
    cause: null,
    bot: BOT.login,
    // The fake's App (its first id) and its first installation, on the owner's account (ADR 0053).
    app: personalApp(1, "lookover-spike-sasensi"),
    installationId: 60_000_001,
    web: "https://github.com",
    since: T0,
    limitUntil: null,
    // The person's own `gh`, read only when the setup's GitHub step asks (ADR 0059).
    gh: null,
  });
  expect(state.engines.claude).toMatchObject({ state: "ready", version: "2.4.1" });
  expect(state.engines.codex).toMatchObject({ state: "missing", version: null });
  expect(state.service).toMatchObject({
    state: "running",
    since: T0,
    version: "0.1.0",
    paused: null,
    remote: false,
  });
});

test("requests without the cookie, from a foreign origin or with a wrong host are refused", async () => {
  const { service } = await start();
  const cookie = await openApp(service);
  const url = api(service, "/snapshot");

  const anonymous = await fetch(url);
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(anonymous.headers.get("access-control-allow-origin")).toBeNull();

  const fine = await fetch(url, { headers: { cookie } });
  expect(fine.status).toBe(200);
  expect(fine.headers.get("content-security-policy")).toContain("default-src 'self'");

  expect((await fetch(url, { headers: { cookie, origin: "http://evil.test" } })).status).toBe(403);
  expect((await fetch(url, { headers: { cookie, host: "lookover.evil.test" } })).status).toBe(403);
  // A GET from another site carries no Origin, but the browser says where it came from.
  expect((await fetch(url, { headers: { cookie, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  expect((await fetch(url, { headers: { cookie, "sec-fetch-site": "same-origin" } })).status).toBe(200);
  expect((await post(service, cookie, { type: "refresh" }, "http://evil.test")).status).toBe(403);
  // A command without an Origin header did not come from the app.
  const noOrigin = await fetch(api(service, "/commands"), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: "refresh" }),
  });
  expect(noOrigin.status).toBe(403);
});

test("a session file left empty or garbled by a crash is made again, never taken as a secret", async () => {
  const dir = home();
  writeFileSync(join(dir, "session"), "");
  const { service } = await start({ home: dir });
  const cookie = await openApp(service);
  expect(cookie).toMatch(/^lookover-[0-9a-f]{8}=[A-Za-z0-9_-]{32}$/);
  const [name, secret] = cookie.split("=");
  expect((await fetch(api(service, "/snapshot"), { headers: { cookie: `${name}=` } })).status).toBe(401);
  expect(readFileSync(join(dir, "session"), "utf8")).toBe(secret ?? "");
});

test("start at login is the owner's choice, kept: on at first, sent as service.changed, still off after a restart (ADR 0054)", async () => {
  const dir = home();
  const first = await start({ home: dir });
  const cookie = await openApp(first.service);
  expect((await snapshot(first.service, cookie)).service.startAtLogin).toBe(true);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));

  expect((await post(first.service, cookie, { type: "service.startAtLogin", on: false })).status).toBe(200);
  expect(await until(stream, "service.changed")).toMatchObject([
    { type: "service.changed", patch: { startAtLogin: false } },
  ]);
  expect((await snapshot(first.service, cookie)).service.startAtLogin).toBe(false);
  await first.service.stop();

  const second = await start({ home: dir, host: first.host });
  expect((await snapshot(second.service, await openApp(second.service))).service.startAtLogin).toBe(false);
});

test("a start at login kept but stopped before its event is sent at the next start, so the snapshot says what the store keeps (ADR 0049)", async () => {
  const dir = home();
  const first = await start({ home: dir });
  const cookie = await openApp(first.service);
  expect((await post(first.service, cookie, { type: "service.startAtLogin", on: true })).status).toBe(200);
  await first.service.stop();
  // The service stopped between the store's write and its event: the store says off, the last event on.
  const store = openStore({ home: dir, durable: false });
  store.setup.keepStartAtLogin(false);
  store.close();

  const second = await start({ home: dir, host: first.host });
  const state = await snapshot(second.service, await openApp(second.service));
  expect(state.service.startAtLogin).toBe(false);
});

const SANDBOX_ID = "sasensi/lookover-sandbox";
const own = (key: string, value: unknown) => ({ type: "repo.setSetting", repoId: SANDBOX_ID, key, value });

test("settings are kept in their files and sent as settings.changed; quick writes to one file all land, and a restart reads back every key and a hand edit (ADR 0049)", async () => {
  const dir = home();
  const first = await start({ home: dir });
  const cookie = await openApp(first.service);
  const stream = messages(await fetch(api(first.service, "/events"), { headers: { cookie } }));

  const owner = await post(first.service, cookie, {
    type: "settings.set",
    key: "strictness",
    value: "blocking",
  });
  expect(owner.status).toBe(200);
  const blocking = {
    value: "blocking",
    origin: "owner-default",
    overrode: { value: "recommended", origin: "lookover-default" },
  };
  expect(await until(stream, "settings.changed")).toMatchObject([
    {
      type: "settings.changed",
      settings: { strictness: blocking },
      repos: { [SANDBOX_ID]: { strictness: blocking } },
    },
  ]);
  // Four clicks at once on one file: each write reads what the one before wrote.
  const answers = await Promise.all([
    post(first.service, cookie, own("depth", "deep")),
    post(first.service, cookie, own("reviewers", "claude")),
    post(first.service, cookie, own("onOpen", false)),
    post(first.service, cookie, own("onPush", true)),
  ]);
  expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
  const reset = await post(first.service, cookie, {
    type: "repo.resetSetting",
    repoId: SANDBOX_ID,
    key: "onOpen",
  });
  expect(reset.status).toBe(200);
  expect(readFileSync(join(dir, "settings.yaml"), "utf8")).toBe(
    "$schema: lookover.settings/v1\nversion: 1\nstrictness: blocking\n",
  );
  expect(readFileSync(join(dir, SANDBOX_SETTINGS), "utf8")).toBe(
    "$schema: lookover.settings/v1\nversion: 1\nreviewers: claude\ndepth: deep\nonPush: true\n",
  );
  await first.service.stop();
  // A hand edit while stopped counts from the next start.
  writeSettings(dir, "settings.yaml", "$schema: lookover.settings/v1\nversion: 1\nstrictness: everything\n");

  const second = await start({ home: dir, host: first.host });
  const state = await snapshot(second.service, await openApp(second.service));
  const everything = {
    value: "everything",
    origin: "owner-default",
    overrode: { value: "recommended", origin: "lookover-default" },
  };
  expect(state.settings).toMatchObject({ strictness: everything, depth: { value: "standard" } });
  expect(state.repos[0].settings).toEqual({
    strictness: everything,
    reviewers: {
      value: "claude",
      origin: "owner-repository",
      overrode: { value: "both", origin: "lookover-default" },
    },
    depth: {
      value: "deep",
      origin: "owner-repository",
      overrode: { value: "standard", origin: "lookover-default" },
    },
    onOpen: { value: true, origin: "lookover-default", overrode: null },
    onPush: {
      value: true,
      origin: "owner-repository",
      overrode: { value: false, origin: "lookover-default" },
    },
  });
});

test("settings files that don't read or can't be opened, left while stopped, never stop a start: ignored, named by Run checks, and a write to one refused with its error (ADR 0049)", async () => {
  const dir = home();
  const first = await start({ home: dir });
  await first.service.stop();
  writeSettings(dir, SANDBOX_SETTINGS, "$schema: lookover.settings/v1\nversion: 1\ndepht: deep\n");
  // A folder where the owner's file should be: it can't be read at all.
  mkdirSync(join(dir, "settings.yaml"));

  const { service } = await start({ home: dir, host: first.host });
  const cookie = await openApp(service);
  const unreadable = { file: "settings.yaml", problem: "unreadable", key: null };
  const invalid = { file: SANDBOX_SETTINGS, problem: "unknown_key", key: "depht" };
  expect((await post(service, cookie, { type: "service.runChecks" })).status).toBe(200);
  const state = await snapshot(service, cookie);
  expect(state.service.checks.items).toContainEqual({ check: "settings", invalid: [unreadable, invalid] });
  expect(state.repos[0].settings.depth).toEqual({
    value: "standard",
    origin: "lookover-default",
    overrode: null,
  });

  const refused = await post(service, cookie, own("depth", "quick"));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: `${SANDBOX_SETTINGS} doesn't read`, invalid });
  expect(readFileSync(join(dir, SANDBOX_SETTINGS), "utf8")).toContain("depht: deep");
});

test("a settings write that fails is refused with the file and why, and nothing is sent (ADR 0049)", async () => {
  const dir = home();
  const held = Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  const settingsFiles = diskSettingsFiles(dir, { rename: () => Promise.reject(held), platform: "win32" });
  const { service } = await start({ home: dir, settingsFiles });
  const cookie = await openApp(service);
  const before = (await snapshot(service, cookie)).seq;

  const unwritten = await post(service, cookie, { type: "settings.set", key: "depth", value: "deep" });
  expect(unwritten.status).toBe(500);
  expect(await unwritten.json()).toEqual({
    error: "settings.yaml was not written",
    unwritten: { file: "settings.yaml", why: "held-open" },
  });
  expect((await snapshot(service, cookie)).seq).toBe(before);
  expect(readdirSync(dir).filter((name) => name.includes("settings"))).toEqual([]);
});

test("a repository whose name can't be a path (con) has its writes refused, and nothing is made for it (ADR 0049)", async () => {
  const dir = home();
  // A rule its last round read: the rule's switch is the repository's, refused as its settings are.
  const store = openStore({ home: dir, durable: false });
  const rule1 = {
    id: "r-1",
    file: "REVIEW.md" as const,
    line: 3,
    text: "Name things plainly.",
    parentIds: [],
  };
  store.rules.read(repositoryId("sasensi/con"), [rule1]);
  store.close();
  const { service } = await start({ home: dir, repo: { owner: "sasensi", name: "con" } });
  const cookie = await openApp(service);
  const refused = await post(service, cookie, {
    type: "repo.setSetting",
    repoId: "sasensi/con",
    key: "depth",
    value: "deep",
  });
  expect(refused.status).toBe(409);
  const unnamed = { error: "this repository's name can't be a settings file", refused: "unnamed" };
  expect(await refused.json()).toEqual(unnamed);
  const rule = await post(service, cookie, { type: "rule.setEnabled", ruleId: "r-1", enabled: false });
  expect(rule.status).toBe(409);
  expect(await rule.json()).toEqual(unnamed);
  expect(existsSync(join(dir, "sasensi"))).toBe(false);
  expect(readdirSync(dir).filter((name) => name.includes("settings"))).toEqual([]);
});

test("commands are checked, and the ones the skeleton doesn't do say so", async () => {
  const { service } = await start();
  const cookie = await openApp(service);

  // A repository the service doesn't watch has no settings here; a value of another key's is not a setting.
  const depth = { type: "repo.setSetting", repoId: "sam/app", key: "depth", value: "deep" };
  expect((await post(service, cookie, depth)).status).toBe(404);
  expect((await post(service, cookie, own("strictness", true))).status).toBe(400);
  expect((await post(service, cookie, { type: "settings.set", key: "onPush", value: "deep" })).status).toBe(
    400,
  );
  const unknown = await post(service, cookie, { type: "review.request", changeId: "no-such#9" });
  expect(unknown.status).toBe(404);

  const wrong = await post(service, cookie, { type: "service.pause", for: "a while" });
  expect(wrong.status).toBe(400);
  expect((await post(service, cookie, { type: "no.such" })).status).toBe(400);
  expect((await post(service, cookie, "not even an object")).status).toBe(400);
});

test("Use an existing App refused answers why as `useApp` beside `error`, and nothing answers, logs or keeps its key (ADR 0053)", async () => {
  const lines: string[] = [];
  const said: string[] = [];
  const console_ = { log: console.log, error: console.error, warn: console.warn };
  const hear = (...args: unknown[]) => said.push(args.map(String).join(" "));
  console.log = hear;
  console.error = hear;
  console.warn = hear;
  try {
    const { service } = await start({ log: (line) => lines.push(line) });
    const cookie = await openApp(service);
    const key =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0secret0key0text\n-----END RSA PRIVATE KEY-----\n";

    // The service runs as live.json's App: any App is refused, in the shape the web reads (`answer.useApp`).
    const given = await post(service, cookie, { type: "connection.useApp", appId: 4242, key });
    expect(given.status).toBe(409);
    const answer = await given.text();
    expect(JSON.parse(answer)).toEqual({
      error: "the App was refused: live-config",
      useApp: { kind: "live-config" },
    });
    // Sent malformed, the parse's refusal names what is wrong, never the key.
    const malformed = await post(service, cookie, { type: "connection.useApp", appId: "4242", key });
    expect(malformed.status).toBe(400);
    const refusal = await malformed.text();
    const empty = await post(service, cookie, { type: "connection.useApp", appId: 4242, key: "" });
    expect(empty.status).toBe(400);

    const state = JSON.stringify(await snapshot(service, cookie));
    for (const text of [answer, refusal, state, ...lines, ...said]) expect(text).not.toContain("secret0key");
  } finally {
    Object.assign(console, console_);
  }
});

test("in live mode, every dev verb answers 501 with the reason (a load, a fault, the clock verbs), and the demo listing 404: nothing scripted touches a real repository", async () => {
  const { service } = await start({ live: true });
  const cookie = await openApp(service);
  const loaded = await post(service, cookie, { type: "demo.load", id: "S10" });
  expect(loaded.status).toBe(501);
  expect(await loaded.json()).toEqual({ error: "no scenario to load in live mode" });
  const injected = await post(service, cookie, { type: "demo.inject", fault: "you-push" });
  expect(injected.status).toBe(501);
  expect(await injected.json()).toEqual({ error: "nothing scripted in live mode" });
  const listing = await fetch(api(service, "/demo"), { headers: { cookie } });
  expect(listing.status).toBe(404);
  expect((await fetch(api(service, "/demo/pages/expired"), { headers: { cookie } })).status).toBe(404);
  const verbs = [
    { type: "demo.clock", running: true, speed: 60 },
    { type: "demo.advance", ms: 60_000 },
    { type: "demo.step" },
  ];
  for (const verb of verbs) {
    const refused = await post(service, cookie, verb);
    expect(refused.status).toBe(501);
    expect(await refused.json()).toEqual({ error: "no demo clock in live mode" });
  }
  // The clock stood where it was: nothing moved, nothing was sent.
  expect(await snapshot(service, cookie)).toMatchObject({ seq: 4, now: T0 });
});
