// What the setup's GitHub step says, Sign in with GitHub (ADR 0066, ADR 0073: the one way in), for a given snapshot: the code,
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
import {
  codeToast,
  GITHUB_SETTINGS_TEXT,
  githubSettings,
  SIGN_IN_TEXT,
  signInEnd,
  signInStep,
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
      firstReviewChange: null,
    },
    engines: { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") },
    connection: {
      id: null,
      state: "not-connected",
      cause: null,
      signIn: null,
      person: null,
      accounts: [],
      listed: true,
      listingCause: null,
      look: null,
      unreached: [],
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
      ...connection,
    },
    service: {
      state: "running",
      since: NOW,
      version: "0.1.0",
      command: "lookover",
      agent: { path: { reach: "no", folder: "~/.local/bin" }, offer: "binary", skills: [] },
      startAtLogin: true,
      atLogin: "this",
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

// ---- the start ----

test("at the start: Sign in with GitHub is the one way in, the accounts come after", () => {
  const view = step(at("start"));
  expect(view.signIn).toMatchObject({
    state: "current",
    text: "You enter a code on GitHub, then authorise Lookover there.",
    code: null,
  });
  expect(view.accounts).toMatchObject({ state: "later", text: "Right after you sign in." });
  expect(view.primary).toEqual({ label: "Sign in with GitHub", enabled: true, starts: true });
  expect(view.refused).toBeNull();
  expect(view.done).toBe(false);
  expect(JSON.stringify(view)).not.toMatch(/own App|existing App|key/i);
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
});

test("the code carries the device code's class (#476), in setup and in Settings", () => {
  const device = { before: "Enter", command: "WDJB-MJHT", kind: "device-code" };
  expect(step(at("start", { signIn: CODE })).signIn.text).toMatchObject(device);
  expect(settings(connected({ signIn: CODE })).signIn.text).toMatchObject(device);
});

test("a code still shown past its expiry is being finished, not expired: GitHub took it and the service asks who", () => {
  const view = step({ ...at("start", { signIn: CODE }), now: CODE.expiresAt + MIN });
  expect(view.signIn).toMatchObject({ state: "busy", text: "Finishing the sign-in with GitHub…" });
  expect(view.refused).toBeNull();
});

// ---- how a sign-in ended ----

test("the code gone without a sign-in: ran out at its expiry, else GitHub didn't sign in; cancelled here, nothing said", () => {
  const out = at("start");
  expect(signInEnd(CODE, out.connection, CODE.expiresAt, false)).toBe("expired");
  expect(signInEnd(CODE, out.connection, NOW + 2 * MIN, false)).toBe("ended");
  expect(signInEnd(CODE, out.connection, NOW + 2 * MIN, true)).toBeNull();
  // Still waiting, signed in, or no code seen: nothing ended.
  expect(signInEnd(CODE, at("start", { signIn: CODE }).connection, NOW, false)).toBeNull();
  expect(signInEnd(CODE, at("waiting-for-install", { person: SASENSI }).connection, NOW, false)).toBeNull();
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
});

// ---- signed in ----

test("signed in, the accounts not listed yet: your own row looking, no action, no other account; Continue waits", () => {
  const view = step(at("waiting-for-install", { person: SASENSI, listed: false }));
  expect(view.signIn).toMatchObject({ state: "done", text: "Signed in as sasensi.", code: null });
  expect(view.accounts).toMatchObject({
    state: "busy",
    text: "Looking for your accounts on GitHub.",
  });
  expect(view.accounts.list.rows.map((r) => [r.name, r.state, r.detail, r.fix, r.status])).toEqual([
    ["sasensi", "looking", "Looking…", null, null],
  ]);
  expect(JSON.stringify(view)).not.toContain("Not installed");
  expect(view.primary).toEqual({ label: "Continue", enabled: false, starts: false });
});

test("signed in, the listing refused: your own row says the cause and its fix instead of looking (ADR 0086)", () => {
  // The install check's refusal is the connection's and the listing's: the service sends both.
  const row = (cause: Connection["cause"]) => {
    const [only, ...rest] = step(
      at("waiting-for-install", { person: SASENSI, listed: false, cause, listingCause: cause }),
    ).accounts.list.rows;
    expect(rest).toEqual([]);
    return [only?.name, only?.state, only?.detail, only?.fix, only?.labels];
  };
  expect(row({ kind: "unreachable" })).toEqual([
    "sasensi",
    "needs-you",
    "GitHub can't be reached. Lookover tries again every minute.",
    null,
    [],
  ]);
  const sso = { label: "Sign in with SSO", href: "https://github.com/orgs/ledger-co/sso" };
  expect(row({ kind: "sso", organisation: "ledger-co", url: sso.href })).toEqual([
    "sasensi",
    "needs-you",
    "ledger-co asks you to sign in with SSO.",
    sso,
    [sso.label],
  ]);
  const install = {
    label: "Install on sasensi",
    href: "https://github.com/apps/lookover-dev/installations/new",
    command: { type: "connection.look" },
  } as const;
  // `uninstalled`: the App was installed and no longer is, said as on any account it left.
  expect(row({ kind: "uninstalled", suspended: false })).toEqual([
    "sasensi",
    "needs-you",
    "No longer installed.",
    install,
    [install.label],
  ]);
  const [, , suspended, unsuspend] = row({ kind: "uninstalled", suspended: true, suspendedBy: "octo" });
  expect([suspended, unsuspend]).toEqual([
    "Suspended by octo.",
    { label: "Unsuspend it on GitHub", href: install.href, command: install.command },
  ]);
});

test("signed in, listed, installed nowhere: your own account not installed with Install on it, as before", () => {
  const view = step(
    at("waiting-for-install", {
      person: SASENSI,
      listed: true,
      listingCause: null,
      unreached: [{ account: SASENSI, kind: "user", owner: true, askedAt: null }],
    }),
  );
  expect(view.accounts.text).toBe("Looking for your accounts on GitHub.");
  expect(view.accounts.list.rows.map((r) => [r.name, r.detail, r.fix?.label])).toEqual([
    ["sasensi", "Not installed.", "Install on sasensi"],
    ["Another account", "GitHub's page lists every account you belong to.", "Install on another account"],
  ]);
});

test("listed, the step still waiting on the repositories' first read: said, and an account with none yet is being read, not empty", () => {
  const accounts = [
    { account: { ...SASENSI, type: "User" as const }, installationId: 1, cause: null, owner: true },
    {
      account: { id: 4242, login: "ledger-co", type: "Organization" as const },
      installationId: 2,
      cause: null,
      owner: false,
    },
  ];
  const reading = step(
    at("waiting-for-install", { person: SASENSI, accounts }, [repo("sasensi", "ledger-api")]),
  );
  expect(reading.accounts).toMatchObject({ state: "busy", text: "Reading your accounts' repositories…" });
  expect(reading.accounts.list.rows.map((r) => [r.name, r.state, r.detail, r.fix?.label ?? null])).toEqual([
    ["sasensi", "installed", "1 repository.", null],
    ["ledger-co", "reading", "Reading its repositories…", null],
    [
      "Another account",
      "another",
      "GitHub's page lists every account you belong to.",
      "Install on another account",
    ],
  ]);
  const shown = reading.accounts.list.rows.flatMap((r) => [r.detail, r.fix?.label]);
  expect(shown).not.toContain("No repository yet.");
  expect(shown).not.toContain("Choose repositories");
  // The read done with none there: said as before, with its one fix.
  const done = step(at("done", { person: SASENSI, accounts }, [repo("sasensi", "ledger-api")]));
  expect(done.accounts.list.rows[1]).toMatchObject({
    detail: "No repository yet.",
    fix: { label: "Choose repositories" },
  });
});

test("the lead says what teammates see of a review posted as you", () => {
  expect(SIGN_IN_TEXT.lead).toBe(
    "Sign in with GitHub, and Lookover posts its reviews as you. Your teammates see your review written by you, each comment opening with Lookover's wordmark, its status in the pull request's description, and a Lookover check.",
  );
});

test("the accounts list: none before a sign-in; signed in, your accounts not reached with their install, Install on another account last", () => {
  expect(step(at("start")).accounts.list.rows).toEqual([]);
  const looking = at("waiting-for-install", {
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
    person: SASENSI,
    cause: { kind: "signed-out" },
    ...connection,
  });

test("signed out before the install: the step at its start again, why said plainly, never “Signed in”", () => {
  const view = step(signedOut());
  expect(view.signIn).toMatchObject({
    state: "current",
    text: "You enter a code on GitHub, then authorise Lookover there.",
    code: null,
  });
  expect(view.accounts).toMatchObject({ state: "later", text: "Right after you sign in." });
  expect(view.accounts.list.rows).toEqual([]);
  expect(view.primary).toEqual({ label: "Sign in with GitHub", enabled: true, starts: true });
  expect(view.refused).toBe("You're signed out of GitHub. Sign in again.");
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
    id: connectionId("github:sasensi"),
    state: "connected",
    person: SASENSI,
    accounts,
  } as const;
  const view = step(at("done", connection, repos));
  expect(view.signIn).toMatchObject({ state: "done", text: "Signed in as sasensi." });
  // ledger-dev still asks for SSO: the step is done, and says the rest can wait, not that every account is.
  expect(view.accounts).toMatchObject({
    state: "done",
    text: "Enough to go on. The rest can wait.",
  });
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

test("done with every account installed and used: more accounts any time; one still without it: the rest can wait", () => {
  const person = { person: SASENSI, id: connectionId("github:sasensi") };
  const own = { account: { ...SASENSI, type: "User" as const }, installationId: 1, cause: null, owner: true };
  const used = [repo("sasensi", "ledger-api")];
  const all = step(at("done", { ...person, accounts: [own] }, used));
  expect(all.accounts.text).toBe("Install it on more accounts any time.");
  const unreached = [
    {
      account: { id: 4242, login: "ledger-labs" },
      kind: "organisation" as const,
      owner: true,
      askedAt: null,
    },
  ];
  const some = step(at("done", { ...person, accounts: [own], unreached }, used));
  expect(some.accounts).toMatchObject({
    state: "done",
    text: "Enough to go on. The rest can wait.",
  });
});

test("installed with no repository: said, GitHub's page in the list", () => {
  const view = step(at("nothing-granted", { person: SASENSI, id: connectionId("github:sasensi") }));
  expect(view.accounts).toMatchObject({
    state: "current",
    text: "Installed, with no repository chosen.",
  });
  expect(view.accounts.list.rows.at(-1)?.fix?.href).toBe(
    "https://github.com/apps/lookover-dev/installations/new",
  );
});

test("every link is built on the connection's web address: demo mode's stays on GitHub's fake", () => {
  const view = step(at("waiting-for-install", { person: SASENSI, web: DEMO_API.github }));
  expect(view.accounts.list.rows.at(-1)?.fix?.href).toBe(
    `${DEMO_API.github}/apps/lookover-dev/installations/new`,
  );
});

// ---- Settings › GitHub (ADR 0067) ----

const settings = (state: State) => githubSettings(state, { timeZone: UTC });

/** Signed in to the shared App and connected, with one account reached. */
const connected = (connection: Partial<Connection> = {}) =>
  at("done", {
    id: connectionId("github:sasensi"),
    state: "connected",
    person: SASENSI,
    accounts: [{ account: { ...SASENSI, type: "User" }, installationId: 1, cause: null, owner: true }],
    ...connection,
  });

test("Settings › GitHub: who is signed in, Sign in again, the accounts list; nothing else offered", () => {
  const view = settings(connected());
  expect(view.signIn).toMatchObject({ text: "Signed in as sasensi.", code: null });
  expect(view.list.rows.map((r) => r.account)).toEqual(["sasensi", null]);
  expect(JSON.stringify(view)).not.toContain("No App yet");
  expect(GITHUB_SETTINGS_TEXT).toEqual({ title: "Signed in with GitHub", again: "Sign in again" });
});

test("Sign in again while connected: the code in place, the accounts still listed; cancelled, signed in as before", () => {
  const waiting = settings(connected({ signIn: CODE }));
  expect(waiting.signIn).toMatchObject({
    text: { before: "Enter", command: "WDJB-MJHT", after: "on GitHub. It works until 10:15." },
    code: CODE,
  });
  expect(waiting.list.rows).toHaveLength(2);
  // Past its expiry and still shown, GitHub took it: the service asks who signed in.
  const finishing = settings({ ...connected({ signIn: CODE }), now: CODE.expiresAt + MIN });
  expect(finishing.signIn.text).toBe("Finishing the sign-in with GitHub…");
  // Cancel clears the code only: the sign-in kept is said again.
  const cancelled = settings(connected());
  expect(cancelled.signIn.text).toBe("Signed in as sasensi.");
});

test("Settings › GitHub signed in again, the accounts not listed yet: your own row looking, nothing said missing", () => {
  const view = settings(connected({ accounts: [], listed: false }));
  expect(view.signIn.text).toBe("Signed in as sasensi.");
  expect(view.list.rows.map((r) => [r.name, r.detail, r.fix])).toEqual([["sasensi", "Looking…", null]]);
});

test("Settings › GitHub signed in again, the accounts' listing refused while the repositories answer: the listing's cause, not looking", () => {
  const view = settings(
    connected({ accounts: [], listed: false, cause: null, listingCause: { kind: "unreachable" } }),
  );
  expect(view.list.rows.map((r) => [r.name, r.state, r.detail, r.fix])).toEqual([
    ["sasensi", "needs-you", "GitHub can't be reached. Lookover tries again every minute.", null],
  ]);
});

test("Settings › GitHub signed out: said, Sign in again offered, no list", () => {
  const view = settings(connected({ cause: { kind: "signed-out" }, state: "disconnected" }));
  expect(view.signIn).toMatchObject({ text: "You're signed out of GitHub.", code: null });
  expect(view.list.rows).toEqual([]);
});

test("Settings › GitHub before a sign-in: signed out, Sign in again offered, no list; never an App of its own", () => {
  const view = settings(at("start"));
  expect(view.signIn).toMatchObject({ text: "You're signed out of GitHub.", code: null });
  expect(view.list.rows).toEqual([]);
  expect(JSON.stringify(view)).not.toMatch(/own App|existing App|No App yet|key/i);
});

test("Settings › GitHub with nobody signed in and the connection down: signed out, Sign in again", () => {
  const view = settings(connected({ person: null, cause: { kind: "signed-out" }, state: "disconnected" }));
  expect(view.signIn.text).toBe("You're signed out of GitHub.");
  expect(JSON.stringify(view)).not.toMatch(/new key|Use an existing App/);
});

// ---- the look line (ADR 0088) ----

/** A look begun at `NOW`, its last listing at 10:00:04. */
const LOOKING = {
  since: NOW,
  until: NOW + 3 * MIN,
  lookedAt: NOW + 4000,
  ended: null,
  arrived: null,
  stopped: null,
};

test("Your accounts says the look line's state in its own line while a look runs or once it ended, with Check again", () => {
  const person = { person: SASENSI, id: connectionId("github:sasensi") };
  const own = { account: { ...SASENSI, type: "User" as const }, installationId: 1, cause: null, owner: true };
  const used = [repo("sasensi", "ledger-api")];
  const looking = step(at("done", { ...person, accounts: [own], look: LOOKING }, used));
  expect(looking.accounts).toMatchObject({
    state: "done",
    text: ["Looking every few seconds, last at ", { time: "10:00:04" }, "."],
    look: { state: "looking", again: { label: "Check again", command: { type: "connection.look" } } },
  });
  const arrived = {
    ...LOOKING,
    ended: NOW + 8000,
    arrived: { accounts: ["ledger-labs"], back: [], repositories: 3 },
  };
  expect(step(at("done", { ...person, accounts: [own], look: arrived }, used)).accounts.text).toEqual([
    "ledger-labs arrived: 3 repositories.",
  ]);
  // No look yet: the step's own line, Check again still there.
  const idle = step(at("done", { ...person, accounts: [own] }, used)).accounts;
  expect(idle.text).toBe("Install it on more accounts any time.");
  expect(idle.look?.again.label).toBe("Check again");
  // Not listed yet: the step's own line says where it is.
  expect(step(at("waiting-for-install", { ...person, listed: false, look: LOOKING })).accounts.text).toBe(
    "Looking for your accounts on GitHub.",
  );
});

test("before a sign-in there is no look line, nor Check again: nobody to look for", () => {
  expect(step(at("start")).accounts.look).toBeNull();
  expect(settings(at("start")).look).toBeNull();
});

test("Settings › GitHub ends its accounts card on the look line, idle too", () => {
  expect(settings(connected()).look).toMatchObject({
    state: "idle",
    words: ["Lookover checks GitHub every 2 minutes."],
    again: { label: "Check again" },
  });
  expect(settings(connected({ look: LOOKING })).look?.state).toBe("looking");
});
