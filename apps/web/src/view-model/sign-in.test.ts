// What the setup's GitHub step says on its first way, Sign in with GitHub (ADR 0066), for a given snapshot: the code,
// the wait, how a sign-in ended, then who you are and the accounts reached. Snapshots are built by hand: the view
// model reads state only.
import { expect, test } from "bun:test";
import {
  type Connection,
  connectionId,
  DEMO_API,
  type DeviceCode,
  type Engine,
  type EngineId,
  GITHUB_WEB,
  type Repository,
  type ResolvedSettings,
  repositoryId,
  type SetupGitHub,
  type State,
} from "@lookover/contracts";
import { githubStep } from "./onboarding.ts";
import {
  bothWays,
  codeToast,
  GITHUB_SETTINGS_TEXT,
  githubSettings,
  SIGN_IN_TEXT,
  signInEnd,
  signInStep,
  wayShown,
} from "./sign-in.ts";

test("a code copied as GitHub's page opens says so, and one the clipboard didn't take is to be typed", () => {
  expect(codeToast("ABCD-1234", true)).toBe("ABCD-1234 copied.");
  expect(codeToast("ABCD-1234", false)).toBe("Type ABCD-1234 on GitHub.");
});

/** 2026-10-30 10:00 UTC; times are said in UTC here. */
const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const UTC = "UTC";
const MIN = 60_000;
/** The person signed in. */
const SASENSI = { id: 1, login: "sasensi" };

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

/** A code GitHub gave at `NOW`, for 15 minutes. */
const CODE: DeviceCode = {
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresAt: NOW + 15 * MIN,
};

function engine(id: EngineId, name: string): Engine {
  return {
    id,
    name,
    cli: id,
    version: "1.0.0",
    state: "ready",
    detail: "",
    unusable: null,
    since: NOW,
    limitUntil: null,
    signingIn: false,
  };
}

function repo(owner: string, name: string): Repository {
  return { id: repositoryId(`${owner}/${name}`), owner, name, enabled: true, settings: DEFAULTS };
}

/** Setup on its GitHub step, at `github`, the connection as `connection` says. */
function at(github: SetupGitHub, connection: Partial<Connection> = {}, repos: Repository[] = []): State {
  return {
    seq: 0,
    now: NOW,
    setup: {
      done: false,
      step: "github",
      reached: "github",
      github,
      githubRefused: null,
      firstReviewChange: null,
    },
    engines: { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") },
    connection: {
      id: null,
      state: "not-connected",
      cause: null,
      way: null,
      signIn: null,
      person: null,
      bot: null,
      app: null,
      accounts: [],
      unreached: [],
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
      gh: null,
      ...connection,
    },
    service: {
      state: "running",
      since: NOW,
      version: "0.1.0",
      command: "lookover",
      agent: { path: { reach: "no", folder: "~/.local/bin" }, offer: "binary", skills: [] },
      startAtLogin: true,
      startsAtLogin: true,
      loginItem: "os",
      paused: null,
      remote: false,
      unlocked: false,
      checks: null,
    },
    settings: DEFAULTS,
    repos,
    departed: [],
    rules: [],
    changes: {},
    reviews: {},
  };
}

const step = (state: State, o: Parameters<typeof signInStep>[1] = {}) =>
  signInStep(state, { timeZone: UTC, ...o });

// ---- which way shows ----

test("the step starts on Sign in with GitHub; Use your own App, an App being made, or one kept show today's flow", () => {
  expect(wayShown(at("start"), null)).toBe("shared");
  expect(wayShown(at("start"), "own")).toBe("own");
  expect(wayShown(at("waiting-for-app"), null)).toBe("own");
  expect(wayShown(at("waiting-for-install", { way: "own" }), null)).toBe("own");
  // Signed in, the sign-in shows, whatever was chosen here before.
  expect(wayShown(at("waiting-for-install", { way: "shared" }), "own")).toBe("shared");
});

// ---- the start ----

test("at the start: Sign in with GitHub starts it, Use your own App is offered, the accounts come after", () => {
  const view = step(at("start"));
  expect(view.signIn).toMatchObject({
    state: "current",
    text: "You enter a code on GitHub. No App to create, no key to keep.",
    code: null,
  });
  expect(view.accounts).toMatchObject({ state: "later", text: "Right after you sign in." });
  expect(view.primary).toEqual({ label: "Sign in with GitHub", enabled: true, starts: true });
  expect(view.ownApp).toBe(true);
  expect(view.refused).toBeNull();
  expect(view.done).toBe(false);
});

// ---- the code ----

test("a code waiting: shown with until when it works, copied and opened by one button; Continue waits", () => {
  const view = step(at("start", { signIn: CODE }));
  expect(view.signIn).toMatchObject({
    state: "busy",
    text: {
      before: "Enter",
      command: "WDJB-MJHT",
      after: "on GitHub. It works until 10:15.",
    },
    code: CODE,
  });
  expect(view.primary).toEqual({ label: "Continue", enabled: false, starts: false });
  // Use your own App stays: taking it gives the sign-in up.
  expect(view.ownApp).toBe(true);
});

test("a code still shown past its expiry is being finished, not expired: GitHub took it and the service asks who", () => {
  const view = step({ ...at("start", { signIn: CODE }), now: CODE.expiresAt + MIN });
  expect(view.signIn).toMatchObject({ state: "busy", text: "Finishing the sign-in with GitHub…" });
  expect(view.refused).toBeNull();
});

test("every text the sign-in row can show is held, the code's with a code as long, so nothing moves when it comes", () => {
  const start = step(at("start"));
  const waiting = step(at("start", { signIn: CODE }));
  // The same texts, the code given added: as long as the one held for it.
  expect(waiting.signIn.held).toEqual([...start.signIn.held, waiting.signIn.text]);
  for (const view of [start, waiting]) {
    expect(view.signIn.held).toContainEqual(view.signIn.text);
    expect(view.accounts.held).toContainEqual(view.accounts.text);
  }
  expect(start.signIn.held).toContainEqual({
    before: "Enter",
    command: "XXXX-XXXX",
    after: "on GitHub. It works until 10:15.",
  });
});

// ---- how a sign-in ended ----

test("the code gone without a sign-in: ran out at its expiry, else GitHub didn't sign in; cancelled here, nothing said", () => {
  const out = at("start");
  expect(signInEnd(CODE, out.connection, CODE.expiresAt, false)).toBe("expired");
  expect(signInEnd(CODE, out.connection, NOW + 2 * MIN, false)).toBe("ended");
  expect(signInEnd(CODE, out.connection, NOW + 2 * MIN, true)).toBeNull();
  // Still waiting, signed in, or no code seen: nothing ended.
  expect(signInEnd(CODE, at("start", { signIn: CODE }).connection, NOW, false)).toBeNull();
  expect(signInEnd(CODE, at("waiting-for-install", { way: "shared" }).connection, NOW, false)).toBeNull();
  expect(signInEnd(null, out.connection, NOW, false)).toBeNull();
});

test("an ended sign-in is said on the refusal line, and Sign in with GitHub starts again", () => {
  expect(step(at("start"), { end: "expired" })).toMatchObject({
    refused: "The code ran out before it was entered. Sign in with GitHub for a new one.",
    primary: { label: "Sign in with GitHub", enabled: true, starts: true },
  });
  expect(step(at("start"), { end: "ended" }).refused).toBe(
    "GitHub didn't sign you in. Sign in with GitHub to try again.",
  );
});

test("a start refused says why on the refusal line", () => {
  expect(step(at("start"), { refusal: "github" }).refused).toBe("GitHub didn't give a code. Try again.");
  expect(step(at("start"), { refusal: "pending" }).refused).toBe("A sign-in already waits for its code.");
  expect(step(at("start"), { refusal: "own-app" }).refused).toBe("Lookover already uses your own App here.");
  expect(step(at("start"), { refusal: "unavailable" }).refused).toBe(
    "Signing in with GitHub isn't offered here.",
  );
});

// ---- signed in ----

test("signed in, the accounts looked for: who you are already, the list offering the installs; nothing else to choose", () => {
  const view = step(at("waiting-for-install", { way: "shared", person: SASENSI }));
  expect(view.signIn).toMatchObject({ state: "done", text: "Signed in as sasensi.", code: null });
  expect(view.accounts).toMatchObject({
    state: "busy",
    text: "Looking for your accounts with Lookover's App.",
  });
  expect(view.accounts.list.rows.at(-1)?.fix).toEqual({
    label: "Install on another account",
    href: "https://github.com/apps/lookover-dev/installations/new",
  });
  expect(view.primary).toEqual({ label: "Continue", enabled: false, starts: false });
  expect(view.ownApp).toBe(false);
});

test("the lead says what teammates see of a review posted as you", () => {
  expect(SIGN_IN_TEXT.lead).toBe(
    "Sign in with GitHub, and Lookover posts its reviews as you. Your teammates see your review written by you, opening with “Lookover”, a summary with Lookover's badge, and a Lookover check. Or use an App of your own.",
  );
});

test("the accounts list: none before a sign-in; signed in, your accounts not reached with their install, Install on another account last", () => {
  expect(step(at("start")).accounts.list.rows).toEqual([]);
  const looking = at("waiting-for-install", {
    way: "shared",
    person: SASENSI,
    unreached: [
      { account: SASENSI, kind: "user", owner: true, askedAt: null },
      { account: { id: 4242, login: "ledger-co" }, kind: "organisation", owner: false, askedAt: null },
    ],
  });
  expect(step(looking).accounts.list.rows.map((r) => [r.state, r.fix?.label])).toEqual([
    ["not-installed", "Install on sasensi"],
    ["not-installed", "Ask to install on ledger-co"],
    ["another", "Install on another account"],
  ]);
});

// ---- signed out before the install ----

/** Signed in before the install, then the sign-in lost (the keychain) or revoked: the install's check says so. */
const signedOut = (connection: Partial<Connection> = {}) =>
  at("waiting-for-install", {
    way: "shared",
    person: SASENSI,
    cause: { kind: "signed-out" },
    ...connection,
  });

test("signed out before the install: both ways again, why said plainly, never “Signed in”", () => {
  const view = step(signedOut());
  expect(view.signIn).toMatchObject({
    state: "current",
    text: "You enter a code on GitHub. No App to create, no key to keep.",
    code: null,
  });
  expect(view.accounts).toMatchObject({ state: "later", text: "Right after you sign in." });
  expect(view.accounts.list.rows).toEqual([]);
  expect(view.primary).toEqual({ label: "Sign in with GitHub", enabled: true, starts: true });
  expect(view.ownApp).toBe(true);
  expect(view.refused).toBe("You're signed out of GitHub. Sign in again, or use your own App.");
  expect(view.done).toBe(false);
});

test("signed out before the install: a new code shows as at the start, and how it ended is said", () => {
  const waiting = step(signedOut({ signIn: CODE }));
  expect(waiting.signIn).toMatchObject({ state: "busy", code: CODE });
  expect(waiting.primary).toEqual({ label: "Continue", enabled: false, starts: false });
  expect(waiting.refused).toBeNull();
  expect(signInEnd(CODE, signedOut().connection, CODE.expiresAt, false)).toBe("expired");
  expect(step(signedOut(), { end: "ended" }).refused).toBe(
    "GitHub didn't sign you in. Sign in with GitHub to try again.",
  );
});

test("signed out before the install: Use your own App shows today's flow from its start, and Back offers both ways", () => {
  expect(wayShown(signedOut(), null)).toBe("shared");
  expect(wayShown(signedOut(), "own")).toBe("own");
  expect(bothWays(signedOut())).toBe(true);
  expect(bothWays(at("start"))).toBe(true);
  expect(bothWays(at("waiting-for-app"))).toBe(false);
  expect(bothWays(at("waiting-for-install", { way: "shared", person: SASENSI }))).toBe(false);
  const own = githubStep(signedOut());
  expect(own.create).toMatchObject({ state: "current", text: githubStep(at("start")).create.text });
  expect(own.access.state).toBe("later");
  expect(own.done).toBe(false);
  // Its App asked of GitHub, today's flow goes on, the sign-in lost beside it.
  expect(wayShown({ ...signedOut(), setup: { ...signedOut().setup, github: "waiting-for-app" } }, null)).toBe(
    "own",
  );
});

test("signed in and installed: who you are, then the list, each account reached in GitHub's order with its repositories or its cause; Continue goes on", () => {
  // The repositories in another order than the accounts: the accounts' is GitHub's, and the row's.
  const repos = [
    repo("ledger-co", "billing"),
    repo("sasensi", "ledger-api"),
    repo("Ledger-Labs", "tools"),
    repo("sasensi", "ledger-web"),
  ];
  const accounts = [
    { account: { ...SASENSI, type: "User" as const }, installationId: 1, cause: null, owner: null },
    {
      account: { id: 4242, login: "ledger-co", type: "Organization" as const },
      installationId: 2,
      cause: null,
      owner: null,
    },
    {
      account: { id: 4343, login: "ledger-labs", type: "Organization" as const },
      installationId: 3,
      cause: null,
      owner: null,
    },
    {
      account: { id: 4444, login: "ledger-dev", type: "Organization" as const },
      installationId: 4,
      cause: { kind: "sso", organisation: "ledger-dev", url: null } as const,
      owner: null,
    },
  ];
  const connection = {
    way: "shared",
    id: connectionId("github:sasensi"),
    state: "connected",
    person: SASENSI,
    accounts,
  } as const;
  const view = step(at("done", connection, repos));
  expect(view.signIn).toMatchObject({ state: "done", text: "Signed in as sasensi." });
  expect(view.accounts).toMatchObject({ state: "done", text: "Install it on more accounts any time." });
  expect(view.accounts.list.rows.map((r) => [r.account, r.detail])).toEqual([
    ["sasensi", "2 repositories."],
    ["ledger-co", "1 repository."],
    ["ledger-labs", "1 repository."],
    ["ledger-dev", "Asks you to sign in with SSO."],
    [null, "GitHub's page lists every account you belong to."],
  ]);
  expect(view.primary).toEqual({ label: "Continue", enabled: true, starts: false });
  expect(view.done).toBe(true);
  expect(SIGN_IN_TEXT.done).toBe("GitHub is connected.");
});

test("installed with no repository: said, GitHub's page in the list", () => {
  const view = step(
    at("nothing-granted", { way: "shared", person: SASENSI, id: connectionId("github:sasensi") }),
  );
  expect(view.accounts).toMatchObject({
    state: "current",
    text: "Installed, with no repository. On GitHub, pick the ones it may see.",
  });
  expect(view.accounts.list.rows.at(-1)?.fix?.href).toBe(
    "https://github.com/apps/lookover-dev/installations/new",
  );
});

test("every link is built on the connection's web address: demo mode's stays on GitHub's fake", () => {
  const view = step(at("waiting-for-install", { way: "shared", person: SASENSI, web: DEMO_API.github }));
  expect(view.accounts.list.rows.at(-1)?.fix?.href).toBe(
    `${DEMO_API.github}/apps/lookover-dev/installations/new`,
  );
});

// ---- Settings › GitHub (ADR 0067) ----

const settings = (state: State) => githubSettings(state, { timeZone: UTC });

/** Signed in to the shared App and connected, with one account reached. */
const connected = (connection: Partial<Connection> = {}) =>
  at("done", {
    way: "shared",
    id: connectionId("github:sasensi"),
    state: "connected",
    person: SASENSI,
    accounts: [{ account: { ...SASENSI, type: "User" }, installationId: 1, cause: null, owner: true }],
    ...connection,
  });

test("Settings › GitHub on the shared App: who is signed in, Sign in again, the accounts list; never “No App yet”", () => {
  const view = settings(connected());
  if (view.way !== "shared") throw new Error("expected the shared App's settings");
  expect(view.signIn).toMatchObject({ text: "Signed in as sasensi.", code: null });
  expect(view.list.rows.map((r) => r.account)).toEqual(["sasensi", null]);
  expect(JSON.stringify(view)).not.toContain("No App yet");
  expect(GITHUB_SETTINGS_TEXT).toEqual({
    title: "Signed in with GitHub",
    again: "Sign in again",
    own: "Use your own App",
    ownBody:
      "Your own App replaces the sign-in: Lookover then posts as the App, not as you. Give its id and its private key.",
  });
});

test("Sign in again while connected: the code in place, the accounts still listed; cancelled, signed in as before", () => {
  const waiting = settings(connected({ signIn: CODE }));
  if (waiting.way !== "shared") throw new Error("expected the shared App's settings");
  expect(waiting.signIn).toMatchObject({
    text: { before: "Enter", command: "WDJB-MJHT", after: "on GitHub. It works until 10:15." },
    code: CODE,
  });
  expect(waiting.list.rows).toHaveLength(2);
  // Past its expiry and still shown, GitHub took it: the service asks who signed in.
  const finishing = settings({ ...connected({ signIn: CODE }), now: CODE.expiresAt + MIN });
  if (finishing.way !== "shared") throw new Error("expected the shared App's settings");
  expect(finishing.signIn.text).toBe("Finishing the sign-in with GitHub…");
  // Cancel clears the code only: the sign-in kept is said again, and every text was held, so nothing moved.
  const cancelled = settings(connected());
  if (cancelled.way !== "shared") throw new Error("expected the shared App's settings");
  expect(cancelled.signIn.text).toBe("Signed in as sasensi.");
  for (const view of [waiting, finishing, cancelled]) {
    expect(view.signIn.held).toContainEqual(view.signIn.text);
    expect(view.signIn.held).toContainEqual("Signed in as sasensi.");
    expect(view.signIn.held).toContainEqual("You're signed out of GitHub.");
  }
});

test("Settings › GitHub signed out of the shared App: said, Sign in again offered, no list", () => {
  const view = settings(connected({ cause: { kind: "signed-out" }, state: "disconnected" }));
  if (view.way !== "shared") throw new Error("expected the shared App's settings");
  expect(view.signIn).toMatchObject({ text: "You're signed out of GitHub.", code: null });
  expect(view.list.rows).toEqual([]);
});

test("Settings › GitHub on your own App, or before either way: the App's line, as before", () => {
  expect(settings(at("start"))).toEqual({ way: "own", text: "No App yet." });
  const own = settings(at("done", { way: "own" }));
  expect(own.way).toBe("own");
});
