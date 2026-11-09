// View-model tests: what Home, the status pill and the alert band say for a given snapshot.
// They hold the sentence and pill assertions the scenario tests once held (ADR 0037).
// Snapshots are built by hand: the view model reads state only.
import { expect, test } from "bun:test";
import {
  type ConnectionAccount,
  type ConnectionCause,
  changeId,
  commitSha,
  DEMO_API,
  type Engine,
  type EngineId,
  emptyReview,
  type Finding,
  findingId,
  GITHUB_WEB,
  type JobState,
  jobId,
  type LoopState,
  type Repository,
  type ResolvedSettings,
  type Review,
  type ReviewJob,
  repositoryId,
  runId,
  type Severity,
  type SkipReason,
  type State,
  type Turn,
} from "@lookover/contracts";
import { allReviews } from "./filters.ts";
import { repositoryLabel, SEPARATOR } from "./format.ts";
import { scopeTabs } from "./scope.ts";
import {
  authorLabel,
  bandOn,
  type ChangeReview,
  canReviewAgain,
  changeLabel,
  changeReviewAt,
  changeReviews,
  chip,
  differences,
  failedNotice,
  gitHubPrimary,
  homeGroups,
  listedReviews,
  lookedOver,
  nextStep,
  nothingReviewedYet,
  notReviewed,
  openVerdict,
  type Problem,
  paletteReviews,
  pill,
  problems,
  REVIEW_BUTTON,
  REVIEW_KEY,
  reviewAgainNote,
  reviewButton,
  reviewButtonPrimary,
  reviewLabel,
  reviewMeta,
  rowAction,
  rowMeta,
  sendElsewhere,
  sentence,
  settledVerdict,
  skipWhy,
  status,
  statusLine,
  statusMenuGroups,
  statusMenuLines,
  waitNotice,
} from "./select.ts";

const NOW = Date.UTC(2026, 9, 3, 10, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Every key at Lookover's default. */
const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

function engine(id: EngineId, name: string, cli: string): Engine {
  return {
    id,
    name,
    cli,
    version: "1.0.0",
    state: "ready",
    detail: "Max plan",
    unusable: null,
    since: NOW - 3 * HOUR,
    limitUntil: null,
    signingIn: false,
  };
}

/** Set up, everything connected and running, one repository, no pull requests. */
function calm(): State {
  return {
    seq: 0,
    now: NOW,
    setup: {
      done: true,
      step: "background",
      reached: "background",
      github: "done",
      firstReviewChange: null,
    },
    engines: { claude: engine("claude", "Claude", "claude"), codex: engine("codex", "Codex", "codex") },
    connection: {
      id: null,
      state: "connected",
      cause: null,
      accounts: [],
      unreached: [],
      signIn: null,
      person: { id: 7, login: "sam" },
      web: GITHUB_WEB,
      since: NOW - 3 * HOUR,
      limitUntil: null,
    },
    service: {
      state: "running",
      since: NOW - 3 * HOUR,
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
    repos: [
      {
        id: repositoryId("sam/app"),
        owner: "sam",
        name: "app",
        enabled: true,
        settings: DEFAULTS,
      },
    ],
    departed: [],
    rules: [],
    changes: {},
    reviews: {},
  };
}

/** Where a review stands, in short: each sets the job, the run and the loop the way the service would. */
type Status =
  | "none"
  | "skipped"
  | "queued"
  | "deferred"
  | "running"
  | "to-fix"
  | "needs-you"
  | "clean"
  | "settled";

const SHA = commitSha("a1f9c2e");

function levels(status: Status, at: number): Partial<Review> {
  const job = (state: JobState, more: Partial<ReviewJob> = {}): ReviewJob => ({
    id: jobId(`job-${at}`),
    sha: SHA,
    trigger: "opened",
    state,
    deferral: null,
    stepIn: null,
    askedBy: null,
    skip: null,
    cancel: null,
    failure: null,
    turn: null,
    ...more,
  });
  const round = {
    n: 1,
    sha: SHA,
    base: null,
    reviewer: "claude" as const,
    secondFind: null,
    confirmer: null,
    confirmFallback: null,
    confirmFailure: null,
    ruledOut: [],
    startedAt: at - 3 * MIN,
    endedAt: at,
    raised: 0,
    verifiedFixed: 0,
    open: 0,
    steps: [],
    sessions: [],
  };
  const done = (loop: LoopState): Partial<Review> => ({ job: job("done"), loop, rounds: [round] });
  switch (status) {
    case "none":
      return {};
    case "skipped":
      return { job: job("skipped", { skip: "not-yours" }) };
    case "queued":
      return { job: job("queued") };
    case "deferred":
      return { job: job("deferred", { deferral: { reason: "engine-signed-out", engine: "claude" } }) };
    case "running":
      return {
        job: job("running"),
        run: {
          id: runId(`run-${at}`),
          reviewer: "claude",
          secondFinder: null,
          confirmer: null,
          confirmFallback: null,
          sha: SHA,
          preview: false,
          startedAt: at - 3 * MIN,
          step: "finding",
          stepAt: at - MIN,
          steps: [],
          activities: [],
          posting: null,
        },
      };
    case "to-fix":
      return done("open");
    case "needs-you":
      return done("needs_owner");
    case "clean":
      return done("settled");
    case "settled":
      return { ...done("settled"), findings: [finding("s", "should_fix", "verified_fixed")] };
  }
}

/** Adds the change `sam/app#n` whose review stands at `status`, last updated `ago` ms before now. */
function withChange(
  state: State,
  n: number,
  status: Status,
  ago = 10 * MIN,
  extra: Partial<Review> = {},
): State {
  const id = changeId(`sam/app#${n}`);
  const at = NOW - ago;
  const review: Review = { ...emptyReview(id, at), ...levels(status, at), ...extra };
  return {
    ...state,
    changes: {
      ...state.changes,
      [id]: {
        id,
        repoId: repositoryId("sam/app"),
        number: n,
        title: `Change ${n}`,
        openedBy: "sam",
        author: "agent",
        writtenBy: "claude",
        headSha: commitSha("a1f9c2e"),
        openedAt: at - HOUR,
        draft: false,
        newCommits: 0,
      },
    },
    reviews: { ...state.reviews, [id]: review },
  };
}

function withEngine(state: State, id: EngineId, patch: Partial<Engine>): State {
  return { ...state, engines: { ...state.engines, [id]: { ...state.engines[id], ...patch } } };
}

const signedOut = (state: State, id: EngineId) => withEngine(state, id, { state: "signed-out" });
const paused = (state: State): State => ({
  ...state,
  service: { ...state.service, paused: { since: NOW - HOUR, until: null } },
});

// ---- a change's address and label ----

test("two repositories of one name on two accounts: each change is found at its owner's address and labelled with its owner (ADR 0066)", () => {
  const ours = withChange(calm(), 1, "to-fix");
  const mine = ours.changes[changeId("sam/app#1")];
  const review = ours.reviews[changeId("sam/app#1")];
  if (!mine || !review) throw new Error("No change");
  const theirs = { ...mine, id: changeId("acme/app#1"), repoId: repositoryId("acme/app") };
  const st: State = {
    ...ours,
    repos: [
      ...ours.repos,
      { id: repositoryId("acme/app"), owner: "acme", name: "app", enabled: true, settings: DEFAULTS },
    ],
    changes: { ...ours.changes, [theirs.id]: theirs },
    reviews: { ...ours.reviews, [theirs.id]: { ...review, changeId: theirs.id } },
  };
  expect(changeReviewAt(st, "acme", "app", "1")?.change.id).toBe(theirs.id);
  expect(changeReviewAt(st, "sam", "app", "1")?.change.id).toBe(mine.id);
  expect(changeReviewAt(st, "nobody", "app", "1")).toBeNull();
  expect(changeLabel(theirs)).toBe("acme/app #1");
  expect(changeLabel(mine)).toBe("sam/app #1");
  // Repositories lists each account's, owner and name (ADR 0066): two apps, never one twice.
  expect(st.repos.map(repositoryLabel)).toEqual(["sam/app", "acme/app"]);
});

// ---- Home's empty state: where a pull request would come from ----

const repo = (owner: string, name: string, enabled = true): Repository => ({
  id: repositoryId(`${owner}/${name}`),
  owner,
  name,
  enabled,
  settings: DEFAULTS,
});

test("nothing reviewed and no repository listed: the empty state waits for the App to see one", () => {
  expect(nothingReviewedYet([])).toBe(
    "Once the App can see a repository on GitHub, its pull requests will show up here.",
  );
});

test("nothing reviewed and none of the repositories listed on: the empty state says where to turn one on", () => {
  expect(nothingReviewedYet([repo("sam", "app", false)])).toBe(
    "Turn on a repository in Repositories and its pull requests will show up here.",
  );
});

test("nothing reviewed: the empty state names the one repository on, by its name", () => {
  expect(nothingReviewedYet([repo("sam", "app"), repo("sam", "web", false)])).toBe(
    "Open a pull request in app and it will show up here.",
  );
});

test("nothing reviewed: distinct names are said alone, the last after “or”", () => {
  expect(nothingReviewedYet([repo("sam", "app"), repo("acme", "web")])).toBe(
    "Open a pull request in app or web and it will show up here.",
  );
});

test("nothing reviewed: two repositories of one name under two owners are each said with their owner (#536)", () => {
  expect(
    nothingReviewedYet([repo("sasensi", "lookover-sandbox"), repo("lookover-dev", "lookover-sandbox")]),
  ).toBe(
    "Open a pull request in sasensi/lookover-sandbox or lookover-dev/lookover-sandbox and it will show up here.",
  );
});

test("nothing reviewed: of three, only the two whose names repeat, in any case, get their owner; one turned off repeats nothing", () => {
  expect(
    nothingReviewedYet([
      repo("sam", "App"),
      repo("acme", "app"),
      repo("sam", "web"),
      repo("old", "web", false),
    ]),
  ).toBe("Open a pull request in sam/App, acme/app or web and it will show up here.");
});

// ---- problems: what the alert band lists ----

test("a healthy service has no problems", () => {
  expect(problems(calm())).toEqual([]);
});

test("each problem comes with the one command that fixes it, GitHub first", () => {
  // No "service" problem: a service that answers is running, and a stopped one can't be told to start from its
  // own UI (ADR 0046).
  let st = calm();
  st = { ...st, connection: { ...st.connection, state: "disconnected" } };
  st = withEngine(st, "claude", { state: "missing" });
  st = signedOut(st, "codex");
  const list = problems(st);
  expect(list.map((p) => [p.id, p.tone, p.title])).toEqual([
    ["connection", "need", "GitHub is disconnected"],
    ["claude", "need", "Claude is not installed"],
    ["codex", "need", "Codex is signed out"],
  ]);
  expect(list.map((p) => (p.fix && "command" in p.fix ? p.fix.command : null))).toEqual([
    { type: "connection.reconnect" },
    { type: "engine.check" },
    { type: "engine.signIn", id: "codex" },
  ]);
});

/** Disconnected for `cause`, sam signed in and the App installed on their account, on `web`. */
function down(cause: ConnectionCause, web: string = GITHUB_WEB): State {
  const st = calm();
  return {
    ...st,
    connection: {
      ...st.connection,
      state: "disconnected",
      cause,
      since: NOW - 5 * MIN,
      web,
      accounts: [
        { account: { id: 7, login: "sam", type: "User" }, installationId: 77, cause: null, owner: null },
      ],
    },
  };
}

const SIGNED_OUT: Partial<Problem> = {
  short: "GitHub signed out",
  title: "You're signed out of GitHub",
  detail: "GitHub no longer takes your sign-in. Reviews cannot be read or posted until you sign in again.",
  fix: { label: "Sign in again", command: { type: "connection.signIn" } },
};

test("each connection cause is said with its one fix: a command, or a link that opens GitHub (ADR 0053, ADR 0067)", () => {
  const cases: [ConnectionCause, Partial<Problem>][] = [
    [
      { kind: "uninstalled", suspended: false },
      {
        short: "GitHub App uninstalled",
        title: "Lookover's App is no longer installed",
        detail:
          "lookover-dev is installed on none of your GitHub accounts. Reviews cannot be read or posted until it is installed again.",
        fix: { label: "Install on sam", href: "https://github.com/apps/lookover-dev/installations/new" },
      },
    ],
    [
      { kind: "uninstalled", suspended: true },
      {
        short: "GitHub App suspended",
        title: "Lookover's App is suspended on GitHub",
        detail: "Reviews cannot be read or posted until you unsuspend it on GitHub.",
        fix: { label: "Unsuspend it on GitHub", href: "https://github.com/settings/installations/77" },
      },
    ],
    [{ kind: "signed-out" }, SIGNED_OUT],
  ];
  for (const [cause, expected] of cases) {
    const [p, ...rest] = problems(down(cause));
    expect(rest).toEqual([]);
    expect([cause, p]).toEqual([
      cause,
      expect.objectContaining({ id: "connection", tone: "need", ...expected }),
    ]);
    expect(JSON.stringify(p)).not.toMatch(/own App|existing App|key|Settings/);
  }
});

test("GitHub out of reach is a wait with no button: Lookover tries again every minute by itself (ADR 0070)", () => {
  const unreachable = down({ kind: "unreachable" });
  const [p, ...rest] = problems(unreachable);
  expect(rest).toEqual([]);
  expect(p).toMatchObject({
    id: "connection",
    tone: "warn",
    short: "GitHub unreachable",
    title: "GitHub can't be reached",
    fix: null,
  });
  // Since when, that nothing needs doing, and that nothing is lost.
  expect(p?.detail).toMatch(/^Since \d\d:55\. Lookover tries again every minute\. Nothing is lost\.$/);
  // It waits: Home counts nothing that needs the person, and the pill is amber.
  expect(sentence(unreachable).title).toBe("Nothing needs you.");
  expect(pill(unreachable)).toEqual({ tone: "warn", label: "GitHub unreachable" });
});

test("in demo mode a cause's link opens the service's fake of GitHub, never github.com", () => {
  const causes: ConnectionCause[] = [
    { kind: "uninstalled", suspended: false },
    { kind: "uninstalled", suspended: true },
  ];
  const hrefs = causes.map((c) => {
    const fix = problems(down(c, DEMO_API.github))[0]?.fix;
    return fix && "href" in fix ? fix.href : null;
  });
  expect(hrefs).toEqual([
    "/api/v1/demo/github/apps/lookover-dev/installations/new",
    "/api/v1/demo/github/settings/installations/77",
  ]);
});

test("signed out says only a new sign-in brings GitHub back (ADR 0066)", () => {
  const [p, ...rest] = problems(down({ kind: "signed-out" }));
  expect(rest).toEqual([]);
  expect(p).toEqual({
    id: "connection",
    tone: "need",
    busy: false,
    short: "GitHub signed out",
    title: "You're signed out of GitHub",
    detail: "GitHub no longer takes your sign-in. Reviews cannot be read or posted until you sign in again.",
    fix: { label: "Sign in again", command: { type: "connection.signIn" } },
  });
});

test("signed out, once Sign in again gave a code, shows the code and its one button (ADR 0073)", () => {
  const st = down({ kind: "signed-out" });
  const signIn = {
    userCode: "D054-61DE",
    verificationUri: "https://github.com/login/device",
    expiresAt: NOW + 15 * MIN,
  };
  const [p, ...rest] = problems({ ...st, connection: { ...st.connection, signIn } });
  expect(rest).toEqual([]);
  expect(p).toMatchObject({
    short: "GitHub signed out",
    title: "You're signed out of GitHub",
    detail: { before: "Enter", command: "D054-61DE", after: "on GitHub. It works until 10:15." },
    fix: { label: "Copy code and open GitHub", href: "https://github.com/login/device", copy: "D054-61DE" },
  });
});

test("signed out, once Sign in again gave a code, the problem says the code and its fix copies it and opens GitHub (ADR 0066)", () => {
  const st = down({ kind: "signed-out" });
  const signIn = {
    userCode: "D054-61DE",
    verificationUri: "https://github.com/login/device",
    expiresAt: NOW + 15 * MIN,
  };
  const [p, ...rest] = problems({ ...st, connection: { ...st.connection, signIn } });
  expect(rest).toEqual([]);
  expect(p).toEqual({
    id: "connection",
    tone: "need",
    busy: false,
    short: "GitHub signed out",
    title: "You're signed out of GitHub",
    detail: {
      before: "Enter",
      command: "D054-61DE",
      kind: "device-code",
      after: "on GitHub. It works until 10:15.",
    },
    fix: {
      label: "Copy code and open GitHub",
      href: "https://github.com/login/device",
      copy: "D054-61DE",
    },
  });
  // Past its expiry and still shown, the code was taken: the sign-in finishes, its button waiting.
  const later = problems({ ...st, now: NOW + 16 * MIN, connection: { ...st.connection, signIn } })[0];
  expect(later).toMatchObject({
    detail: "Finishing the sign-in with GitHub…",
    fix: { label: "Sign in again", command: { type: "connection.signIn" } },
    busy: true,
  });
});

test("an organisation asking for SSO says so, and opens the page GitHub gave for it (ADR 0066)", () => {
  const url = "https://github.com/orgs/acme/sso?authorization_request=A1B2";
  const [p, ...rest] = problems(down({ kind: "sso", organisation: "acme", url }));
  expect(rest).toEqual([]);
  expect(p).toEqual({
    id: "connection",
    tone: "need",
    busy: false,
    short: "GitHub SSO needed",
    title: "acme asks you to sign in with SSO",
    detail:
      "acme protects its repositories with single sign-on. Its reviews cannot be read or posted until you sign in there.",
    fix: { label: "Sign in with SSO", href: url },
  });
});

/** Signed in to the shared App on the person's account and on ledger-dev, which holds `cause`; connected. */
function onAccounts(cause: ConnectionAccount["cause"], owner: boolean | null = false): State {
  const st = calm();
  return {
    ...st,
    connection: {
      ...st.connection,
      accounts: [
        { account: { id: 7, login: "sam", type: "User" }, installationId: 77, cause: null, owner: null },
        {
          account: { id: 338, login: "ledger-dev", type: "Organization" },
          installationId: 78,
          cause,
          owner,
        },
      ],
    },
  };
}

test("one account asking for SSO on the shared App is that account's problem, the connection still up (ADR 0066)", () => {
  const [p, ...rest] = problems(onAccounts({ kind: "sso", organisation: "ledger-dev", url: null }));
  expect(rest).toEqual([]);
  expect(p).toEqual({
    id: "account:ledger-dev",
    account: "ledger-dev",
    tone: "need",
    busy: false,
    short: "ledger-dev needs SSO",
    title: "ledger-dev asks you to sign in with SSO",
    detail:
      "ledger-dev protects its repositories with single sign-on. Its reviews cannot be read or posted until you sign in there.",
    fix: { label: "Sign in with SSO", href: "https://github.com/orgs/ledger-dev/sso" },
  });
  // The pill names the account with the only problem.
  expect(pill(onAccounts({ kind: "sso", organisation: "ledger-dev", url: null }))).toEqual({
    tone: "need",
    label: "ledger-dev needs SSO",
  });
  expect(problems(onAccounts(null))).toEqual([]);
});

test("the shared App installed on none of the person's accounts any more: installed again from its page, not Reconnect", () => {
  const st = down({ kind: "uninstalled", suspended: false });
  const [p, ...rest] = problems({ ...st, connection: { ...st.connection, accounts: [] } });
  expect(rest).toEqual([]);
  expect(p).toMatchObject({
    id: "connection",
    short: "GitHub App uninstalled",
    title: "Lookover's App is no longer installed",
    detail:
      "lookover-dev is installed on none of your GitHub accounts. Reviews cannot be read or posted until it is installed again.",
    // The accounts list's words (ADR 0067): the person's own account is always listed, Install on it.
    fix: { label: "Install on sam", href: "https://github.com/apps/lookover-dev/installations/new" },
  });
});

test("one account's installation suspended on the shared App, the person a member there: ask an owner, naming who suspended it", () => {
  const [p] = problems(onAccounts({ kind: "uninstalled", suspended: true, suspendedBy: "mira" }));
  expect(p).toEqual({
    id: "account:ledger-dev",
    account: "ledger-dev",
    tone: "need",
    busy: false,
    short: "App suspended on ledger-dev",
    title: "Lookover's App is suspended on ledger-dev",
    detail:
      "Its repositories' reviews cannot be read or posted until an owner of ledger-dev unsuspends it on GitHub. mira suspended it.",
    fix: {
      label: "Ask an owner of ledger-dev",
      href: "https://github.com/orgs/ledger-dev/people?query=role%3Aowner",
    },
  });
  // Nobody said whether the person owns it, nor who suspended it: a member's fix, nobody named.
  const [unknown] = problems(onAccounts({ kind: "uninstalled", suspended: true }, null));
  expect(unknown).toMatchObject({
    detail:
      "Its repositories' reviews cannot be read or posted until an owner of ledger-dev unsuspends it on GitHub.",
    fix: { label: "Ask an owner of ledger-dev" },
  });
});

test("one account's installation suspended on an organisation the person owns: they unsuspend it, from that installation's page", () => {
  const [p] = problems(onAccounts({ kind: "uninstalled", suspended: true, suspendedBy: "mira" }, true));
  expect(p).toMatchObject({
    short: "App suspended on ledger-dev",
    detail:
      "Its repositories' reviews cannot be read or posted until you unsuspend it on GitHub. mira suspended it.",
    fix: {
      label: "Unsuspend it on GitHub",
      href: "https://github.com/organizations/ledger-dev/settings/installations/78",
    },
  });
});

test("one account's installation gone, still listed: installed there again by an owner, asked for by a member", () => {
  const [member] = problems(onAccounts({ kind: "uninstalled", suspended: false }));
  expect(member).toMatchObject({
    id: "account:ledger-dev",
    account: "ledger-dev",
    short: "App uninstalled on ledger-dev",
    title: "Lookover's App is no longer installed on ledger-dev",
    detail:
      "Its repositories' reviews cannot be read or posted until an owner of ledger-dev installs it there again.",
    fix: {
      label: "Ask an owner of ledger-dev",
      href: "https://github.com/orgs/ledger-dev/people?query=role%3Aowner",
    },
  });
  const [owner] = problems(onAccounts({ kind: "uninstalled", suspended: false }, true));
  expect(owner).toMatchObject({
    detail: "Its repositories' reviews cannot be read or posted until you install it there again.",
    fix: { label: "Install on ledger-dev", href: "https://github.com/apps/lookover-dev/installations/new" },
  });
});

test("two accounts with a problem: the pill counts them, the status menu lists both", () => {
  const st = onAccounts({ kind: "sso", organisation: "ledger-dev", url: null });
  const [sam, ...rest] = st.connection.accounts;
  if (sam === undefined) throw new Error("sam is listed first");
  const both: State = {
    ...st,
    connection: {
      ...st.connection,
      accounts: [{ ...sam, owner: true, cause: { kind: "uninstalled", suspended: true } }, ...rest],
    },
  };
  expect(pill(both)).toEqual({ tone: "need", label: "2 things need attention" });
  // Each its own line, leading, in GitHub's order, each with its fix; GitHub's connection itself is fine, with them.
  expect(
    statusMenuLines(both).map((l) => [l.id, l.text, l.dot, l.problem?.fix?.label ?? null, l.leads]),
  ).toEqual([
    ["account:sam", "Lookover's App is suspended on sam", "need", "Unsuspend it on GitHub", true],
    ["account:ledger-dev", "ledger-dev asks you to sign in with SSO", "need", "Sign in with SSO", true],
    ["claude", "Claude: ready", "ok", null, false],
    ["codex", "Codex: ready", "ok", null, false],
    ["github", "GitHub: connected as sam", "ok", null, false],
    ["service", "Service: running, starts at login", "ok", null, false],
  ]);
});

/** The status menu in short: each line's words and dot. */
const menuOf = (state: State) => statusMenuLines(state).map((l) => [l.text, l.dot]);

test("the status menu: every line fine, each its green dot, in the menu's order", () => {
  expect(menuOf(calm())).toEqual([
    ["Claude: ready", "ok"],
    ["Codex: ready", "ok"],
    ["GitHub: connected as sam", "ok"],
    ["Service: running, starts at login", "ok"],
  ]);
});

test("the status menu: the lines with a problem lead, an account's problem a line of its own, the fine lines keep the green dot", () => {
  // S16: Codex signed out, the App suspended on ledger-dev: in the band's order, the account's first, at the same level
  // as Codex's (2026-11-08: nested in GitHub's, the two problems read as unequal); GitHub's connection is fine.
  const st = signedOut(onAccounts({ kind: "uninstalled", suspended: true }), "codex");
  expect(menuOf(st)).toEqual([
    ["Lookover's App is suspended on ledger-dev", "need"],
    ["Codex: signed out", "need"],
    ["Claude: ready", "ok"],
    ["GitHub: connected as sam", "ok"],
    ["Service: running, starts at login", "ok"],
  ]);
  const codex = statusMenuLines(st).find((l) => l.id === "codex");
  expect(codex?.problem?.fix?.label).toBe("Sign in");
  const suspended = statusMenuLines(st).find((l) => l.id === "account:ledger-dev");
  expect(suspended?.problem?.fix?.label).toBe("Ask an owner of ledger-dev");
});

test("the status menu: the lines that lead are marked, so the menu sets them apart from the fine ones", () => {
  const st = signedOut(onAccounts({ kind: "uninstalled", suspended: true }), "codex");
  expect(statusMenuLines(st).map((l) => [l.id, l.leads])).toEqual([
    ["account:ledger-dev", true],
    ["codex", true],
    ["claude", false],
    ["github", false],
    ["service", false],
  ]);
  expect(statusMenuLines(calm()).some((l) => l.leads)).toBe(false);
});

test("the status menu: the fine lines get a heading, Fine, only under a problem; alone, Status already says it", () => {
  const troubled = statusMenuGroups(statusMenuLines(signedOut(calm(), "codex")));
  expect(troubled.leads.map((l) => l.id)).toEqual(["codex"]);
  expect(troubled.fine.map((l) => l.id)).toEqual(["claude", "github", "service"]);
  expect(troubled.fineHeading).toBe("Fine");
  const fine = statusMenuGroups(statusMenuLines(calm()));
  expect(fine.leads).toEqual([]);
  expect(fine.fine.length).toBeGreaterThan(0);
  expect(fine.fineHeading).toBeNull();
  // every line in trouble: no fine well, so no heading over nothing
  expect(statusMenuGroups(troubled.leads).fineHeading).toBeNull();
});

test("the status menu: an AI failing its safety check, start at login refused and an account's problem lead in the band's order", () => {
  const st = withEngine(onAccounts({ kind: "sso", organisation: "ledger-dev", url: null }), "claude", {
    state: "failed-self-test",
  });
  const refused: State = { ...st, service: { ...st.service, startAtLogin: true, atLogin: "none" } };
  expect(menuOf(refused)).toEqual([
    ["ledger-dev asks you to sign in with SSO", "need"],
    ["Claude: didn't pass Lookover's safety check", "need"],
    ["Service: running, doesn't start at login", "need"],
    ["Codex: ready", "ok"],
    ["GitHub: connected as sam", "ok"],
  ]);
});

test("the status menu: an AI at its limit waits, amber, first", () => {
  expect(menuOf(withEngine(calm(), "codex", { state: "limit" }))).toEqual([
    ["Codex: at its limit", "warn"],
    ["Claude: ready", "ok"],
    ["GitHub: connected as sam", "ok"],
    ["Service: running, starts at login", "ok"],
  ]);
});

test("the status menu: another Lookover holding the start at login is fine, its line in its place", () => {
  const st = calm();
  const other = { other: String.raw`"C:\Program Files\Lookover\lookover.exe" start --no-open` };
  expect(menuOf({ ...st, service: { ...st.service, atLogin: other } })).toEqual([
    ["Claude: ready", "ok"],
    ["Codex: ready", "ok"],
    ["GitHub: connected as sam", "ok"],
    ["Service: running, another Lookover starts at login", "ok"],
  ]);
});

test("the status menu: an AI that doesn't review is grey, in its place, while the pill says all good", () => {
  const st = signedOut(calm(), "codex");
  const reviewers = {
    value: "claude",
    origin: "owner-default",
    overrode: { value: "both", origin: "lookover-default" },
  } as const;
  const claudeOnly = { ...st, settings: { ...st.settings, reviewers } };
  expect(pill(claudeOnly)).toEqual({ tone: "ok", label: "All good" });
  expect(menuOf(claudeOnly)).toEqual([
    ["Claude: ready", "ok"],
    ["Codex: signed out", "mute"],
    ["GitHub: connected as sam", "ok"],
    ["Service: running, starts at login", "ok"],
  ]);
});

test("the status menu's GitHub line: a wait GitHub asked for is amber, a cause takes its tone, with the connection's fix on the line", () => {
  const limited = { ...calm(), connection: { ...calm().connection, limitUntil: NOW + 5 * MIN } };
  const wait = statusMenuLines(limited).find((l) => l.id === "github");
  expect(wait).toMatchObject({
    text: "GitHub: connected as sam",
    dot: "warn",
    problem: { id: "connection" },
  });
  expect(statusMenuLines(limited)[0]?.id).toBe("github");
  const out = statusMenuLines(down({ kind: "signed-out" })).find((l) => l.id === "github");
  expect(out).toMatchObject({ text: "GitHub: signed out", dot: "need" });
  expect(out?.problem?.fix?.label).toBe("Sign in again");
  expect(statusMenuLines(down({ kind: "unreachable" })).find((l) => l.id === "github")?.dot).toBe("warn");
  // The connection waits on GitHub's limit while ledger-dev asks for SSO: each says its own.
  const st = onAccounts({ kind: "sso", organisation: "ledger-dev", url: null });
  const both = statusMenuLines({ ...st, connection: { ...st.connection, limitUntil: NOW + 5 * MIN } });
  expect(both.filter((l) => l.leads).map((l) => [l.id, l.dot, l.problem?.id])).toEqual([
    ["github", "warn", "connection"],
    ["account:ledger-dev", "need", "account:ledger-dev"],
  ]);
});

test("an organisation asking for SSO with no page from GitHub opens the organisation's SSO page", () => {
  const [p] = problems(down({ kind: "sso", organisation: "acme", url: null }));
  expect(p?.fix).toEqual({ label: "Sign in with SSO", href: "https://github.com/orgs/acme/sso" });
});

test("an AI at its limit is a warning with nothing to do", () => {
  const [limit, ...rest] = problems(withEngine(calm(), "codex", { state: "limit", limitUntil: null }));
  expect(rest).toEqual([]);
  expect(limit).toMatchObject({
    id: "codex",
    tone: "warn",
    short: "Codex at its limit",
    title: "Codex reached its limit",
    detail: "Reviews wait until it resets.",
    fix: null,
  });
});

test("an AI at its limit says until when on the service's clock, with the day when it isn't today (ADR 0055)", () => {
  // bun test runs in UTC: the service's clock reads 22:00 on Sunday 11 October.
  const now = Date.parse("2026-10-11T22:00:00Z");
  const detail = (limitUntil: number) =>
    problems({ ...withEngine(calm(), "codex", { state: "limit", limitUntil }), now })[0]?.detail;
  expect([
    detail(Date.parse("2026-10-11T23:15:00Z")),
    detail(Date.parse("2026-10-12T01:00:00Z")),
    detail(Date.parse("2026-10-14T10:11:00Z")),
  ]).toEqual([
    "Reviews wait until 23:15.",
    "Reviews wait until tomorrow 01:00.",
    "Reviews wait until Wed 14 Oct, 10:11.",
  ]);
});

test("an AI whose version failed Lookover's safety check needs you: that version, update or downgrade it, then check again (ADR 0044)", () => {
  const [failed, ...rest] = problems(
    withEngine(calm(), "codex", { state: "failed-self-test", version: "0.155.0" }),
  );
  expect(rest).toEqual([]);
  expect(failed).toMatchObject({
    id: "codex",
    tone: "need",
    short: "Codex needs attention",
    title: "Codex didn't pass Lookover's safety check",
    detail:
      "codex 0.155.0 changed something Lookover relies on, so its reviews wait. Update or downgrade it, then check again.",
    fix: { label: "Check again", command: { type: "engine.check" } },
  });
  // A version the program didn't print: "this version".
  const [unknown] = problems(withEngine(calm(), "codex", { state: "failed-self-test", version: null }));
  expect(unknown?.detail).toBe(
    "This version of codex changed something Lookover relies on, so its reviews wait. Update or downgrade it, then check again.",
  );
});

test("an AI whose safety check couldn't finish needs you: nothing failed, and Try again runs it again (ADR 0075)", () => {
  const [unfinished, ...rest] = problems(
    withEngine(calm(), "codex", { state: "self-test-unfinished", version: "0.166.0" }),
  );
  expect(rest).toEqual([]);
  expect(unfinished).toMatchObject({
    id: "codex",
    tone: "need",
    short: "Codex needs attention",
    title: "Codex couldn't finish Lookover's safety check",
    detail:
      "The check ended before it could tell either way: nothing failed. Codex's reviews wait until it passes.",
    fix: { label: "Try again", command: { type: "engine.check" } },
    busy: false,
  });
});

test("signed out or missing, an AI says why: a signed-out one's detail replaces the general line (#89), a missing one's is said as it is", () => {
  const apiKey =
    "Codex is signed in with an API key. Lookover uses your ChatGPT plan only: sign in with ChatGPT.";
  const [signedOutWhy] = problems(withEngine(calm(), "codex", { state: "signed-out", detail: apiKey }));
  expect(signedOutWhy).toMatchObject({ title: "Codex is signed out", detail: apiKey });
  const npm =
    "Only npm's claude launcher was found, and it runs Claude through Node. Install the native claude program, then check again.";
  const [missingWhy] = problems(withEngine(calm(), "claude", { state: "missing", detail: npm }));
  expect(missingWhy).toMatchObject({ title: "Claude is not installed", detail: npm });
  // Signing in, the terminal's line comes first; with no detail, the general lines stay.
  const [signingIn] = problems(
    withEngine(calm(), "codex", { state: "signed-out", detail: apiKey, signingIn: true }),
  );
  expect(signingIn?.detail).toBe("A terminal is open. Sign in there; this page checks every few seconds.");
  // Too old for its model: said so with the update command, and checked again; never a Sign in.
  const tooOld =
    "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.154.0. Update it, then check again: npm install -g @openai/codex@latest";
  const [old] = problems(
    withEngine(calm(), "codex", {
      state: "missing",
      version: "0.154.0",
      detail: tooOld,
      unusable: { kind: "too-old", version: "0.154.0", model: "gpt-6.1-sol", needs: "0.162.0" },
    }),
  );
  expect(old).toEqual({
    id: "codex",
    tone: "need",
    short: "Codex needs attention",
    title: "Codex is too old",
    detail: tooOld,
    fix: { label: "Check again", command: { type: "engine.check" } },
    busy: false,
  });
  // Not installed: the service's line, with the command that installs it on this machine (ADR 0070), as it is.
  const install =
    "The claude program was not found on this computer. Install it, then check again: curl -fsSL https://claude.ai/install.sh | bash";
  const [notFound] = problems(withEngine(calm(), "claude", { state: "missing", detail: install }));
  expect(notFound?.detail).toBe(install);
});

test("GitHub asking to wait is a warning with nothing to do, until the time it gave", () => {
  const st = calm();
  const limited = { ...st, connection: { ...st.connection, limitUntil: NOW + 20 * 60_000 } };
  const [limit, ...rest] = problems(limited);
  expect(rest).toEqual([]);
  expect(limit).toMatchObject({
    id: "connection",
    tone: "warn",
    short: "GitHub asks to wait",
    title: "GitHub asks Lookover to wait",
    fix: null,
  });
  // The hour is the machine's own: the minutes are what the time GitHub gave says.
  expect(limit?.detail).toMatch(/^Lookover checks GitHub again at \d\d:20\. Nothing is lost\.$/);
  expect(problems({ ...limited, now: NOW + 20 * 60_000 })).toEqual([]);
});

test("an AI that does not review is not a problem", () => {
  const st = signedOut(calm(), "codex");
  const reviewers = {
    value: "claude",
    origin: "owner-default",
    overrode: { value: "both", origin: "lookover-default" },
  } as const;
  expect(problems({ ...st, settings: { ...st.settings, reviewers } })).toEqual([]);
});

test("nothing is a problem before setup is done", () => {
  const st = signedOut(calm(), "codex");
  expect(problems({ ...st, setup: { ...st.setup, done: false } })).toEqual([]);
});

test("a signed-out AI is fixed with Sign in, never Fix", () => {
  const [p] = problems(signedOut(calm(), "claude"));
  expect(p?.fix).toEqual({ label: "Sign in", command: { type: "engine.signIn", id: "claude" } });
});

test("a sign-in in progress shows as busy", () => {
  const [p] = problems(withEngine(calm(), "claude", { state: "signed-out", signingIn: true }));
  expect(p?.busy).toBe(true);
  expect(p?.detail).toBe("A terminal is open. Sign in there; this page checks every few seconds.");
});

test("start at login not as chosen needs you, with Settings' row as its one fix, until the registration matches (ADR 0054)", () => {
  const atLogin = (startAtLogin: boolean, startsAtLogin: boolean, loginItem: "os" | "stand-in" = "os") => {
    const st = calm();
    return {
      ...st,
      service: {
        ...st.service,
        startAtLogin,
        atLogin: startsAtLogin ? ("this" as const) : ("none" as const),
        loginItem,
      },
    };
  };
  const openSettings = { label: "Open Settings", path: "/settings#login" };
  const refused = atLogin(true, false);
  expect(problems(refused)).toEqual([
    {
      id: "login",
      tone: "need",
      short: "Start at login refused",
      title: "This computer refused to start Lookover at login",
      detail: "Turn “Start at login” off and on in Settings to try again.",
      fix: openSettings,
      busy: false,
    },
  ]);
  expect(pill(refused)).toEqual({ tone: "need", label: "Start at login refused" });
  expect(sentence(refused).title).toBe("Nothing else needs you.");
  expect(problems(atLogin(false, true))).toEqual([
    {
      id: "login",
      tone: "need",
      short: "Still starts at login",
      title: "This computer still starts Lookover at login",
      detail: "Turn “Start at login” on and off in Settings to try again.",
      fix: openSettings,
      busy: false,
    },
  ]);
  // On Settings the band offers no way to the page already open (#274); on any other page it does.
  const [login] = problems(refused);
  if (!login) throw new Error("No problem");
  expect(bandOn(login, "/settings")).toEqual({ ...login, fix: null });
  expect(bandOn(login, "/").fix).toEqual(openSettings);
  const [signedOut] = problems(withEngine(calm(), "claude", { state: "signed-out", since: NOW - MIN }));
  expect(bandOn(signedOut ?? login, "/settings").fix).toEqual({
    label: "Sign in",
    command: { type: "engine.signIn", id: "claude" },
  });
  // Matched again: nothing to say.
  expect(problems(atLogin(true, true))).toEqual([]);
  expect(problems(atLogin(false, false))).toEqual([]);
  expect(pill(atLogin(true, true))).toEqual({ tone: "ok", label: "All good" });
  // In development the registration is the fake's: nothing on the machine to fix.
  expect(problems(atLogin(true, false, "stand-in"))).toEqual([]);
  // Another install holds it: no band, a test copy is always so (ADR 0068).
  const other = { other: String.raw`"C:\Program Files\Lookover\lookover.exe" start --no-open` };
  const taken = { ...refused, service: { ...refused.service, atLogin: other } };
  expect(problems(taken)).toEqual([]);
  // Nothing is registered before the setup is done.
  const setUp = refused.setup;
  expect(problems({ ...refused, setup: { ...setUp, done: false } })).toEqual([]);
});

// ---- pill: the status pill in the top bar ----

test("the pill says all good when nothing is wrong", () => {
  expect(pill(calm())).toEqual({ tone: "ok", label: "All good" });
});

test("the pill names a single problem, pink when it needs you, amber when it only waits (ADR 0070)", () => {
  expect(pill(signedOut(calm(), "claude"))).toEqual({ tone: "need", label: "Claude needs attention" });
  expect(pill(withEngine(calm(), "codex", { state: "limit", limitUntil: null }))).toEqual({
    tone: "warn",
    label: "Codex at its limit",
  });
});

test("the pill counts several problems", () => {
  let st = calm();
  st = { ...st, connection: { ...st.connection, state: "disconnected" } };
  st = withEngine(withEngine(st, "claude", { state: "missing" }), "codex", { state: "missing" });
  expect(pill(st)).toEqual({ tone: "need", label: "3 things need attention" });
});

test("the pill is pink when any problem needs you, amber and waiting when every one only waits (ADR 0070)", () => {
  const codexLimit = withEngine(calm(), "codex", { state: "limit", limitUntil: null });
  const bothWait = { ...codexLimit, connection: { ...codexLimit.connection, limitUntil: NOW + 5 * MIN } };
  expect(pill(bothWait)).toEqual({ tone: "warn", label: "2 things waiting" });
  // A wait never hides one that needs you.
  expect(pill(signedOut(bothWait, "claude"))).toEqual({ tone: "need", label: "3 things need attention" });
});

test("the pill says paused, unless a problem needs saying", () => {
  expect(pill(paused(calm()))).toEqual({ tone: "mute", label: "Paused" });
  const st = paused(calm());
  expect(pill({ ...st, connection: { ...st.connection, state: "disconnected" } })).toEqual({
    tone: "need",
    label: "GitHub disconnected",
  });
});

// ---- sentence: the line at the top of Home ----

test("a quiet day says nothing needs you and when the last review was", () => {
  const st = withChange(withChange(calm(), 1, "settled", 2 * HOUR), 2, "clean", 12 * MIN);
  expect(sentence(st)).toEqual({
    title: "Nothing needs you.",
    small: "2 pull requests reviewed today, the last one 12 min ago.",
  });
});

test("a day without reviews says so", () => {
  expect(sentence(calm())).toEqual({
    title: "Nothing needs you.",
    small: "No pull request reviewed yet today.",
  });
});

test("a running row's time counts from the ticking now the screen gives, else the service's", () => {
  const st = withChange(calm(), 1, "running", 0);
  const [first] = changeReviews(st);
  if (!first) throw new Error("No review");
  expect(statusLine(st, first)).toBe("reading the code · 3 min");
  expect(statusLine(st, first, st.now + 5_000)).toBe("reading the code · 3 min 5 s");
});

test("a row's meta line is its parts, in order, each its own: the screen puts one separator between them", () => {
  const running = withChange(calm(), 1, "running", 0);
  // A separator inside a part holds its dot to what follows, as the screen's between parts (`SEPARATOR`), so a
  // wrapped line never ends on "written by Claude ·".
  expect(rowMeta(running, firstOf(running), running.now + 5_000)).toEqual([
    { kind: "change", text: "sam/app #1" },
    { kind: "text", text: `by sam${SEPARATOR}written by Claude` },
    { kind: "running", doing: "reading the code", time: "3 min 5 s" },
  ]);
  // A finished one says how long ago, after where it stands.
  const settled = withChange(calm(), 2, "settled");
  expect(rowMeta(settled, firstOf(settled))).toEqual([
    { kind: "change", text: "sam/app #2" },
    { kind: "text", text: `by sam${SEPARATOR}written by Claude` },
    { kind: "text", text: "1 finding, all closed in 1 round" },
    { kind: "text", text: "10 min" },
  ]);
  const toFix = withChange(calm(), 3, "to-fix");
  const parts = rowMeta(toFix, firstOf(toFix));
  expect(parts.map((part) => part.kind)).toEqual(["change", "text", "text"]);
  for (const part of parts) expect("text" in part ? part.text : "").not.toContain(" · ");
});

test("running and waiting reviews are counted, not called out", () => {
  const st = withChange(withChange(calm(), 1, "running"), 2, "queued");
  expect(sentence(st)).toEqual({ title: "Nothing needs you.", small: "1 reviewing now · 1 waiting" });
});

test("a pause still says so under a problem: what needs you comes first, the pause stays in sight", () => {
  const st = withChange(paused(signedOut(calm(), "claude")), 1, "deferred", 5 * MIN);
  expect(sentence(st)).toEqual({
    title: "Nothing else needs you.",
    small: "paused until you resume · 1 waiting · Codex ready",
  });
  const own = withChange(paused(calm()), 1, "needs-you");
  expect(sentence(own).small.startsWith("paused until you resume")).toBe(true);
});

test("pull requests with an escalated finding need you, and are counted", () => {
  expect(sentence(withChange(calm(), 1, "needs-you")).title).toBe("1 pull request needs you.");
  expect(sentence(withChange(withChange(calm(), 1, "needs-you"), 2, "needs-you")).title).toBe(
    "2 pull requests need you.",
  );
});

test("a review waiting for a signed-out AI is not one more thing: the AI is, in the band", () => {
  const st = withChange(signedOut(calm(), "claude"), 1, "deferred", 5 * MIN);
  expect(sentence(st).title).toBe("Nothing else needs you.");
  expect(homeGroups(st, "mine").waiting.map((i) => String(i.change.id))).toEqual(["sam/app#1"]);
});

test("the headline speaks of the reviews, never of the band's problems, which the band says once (round 5)", () => {
  // The design system's Home: Claude signed out, a review waiting on it, nothing of the person's own to do.
  const waiting = withChange(signedOut(calm(), "claude"), 1, "deferred", 5 * MIN);
  expect(sentence(waiting).title).toBe("Nothing else needs you.");
  // A finding escalated beside it: the pull request, as without the problem.
  const own = withChange(waiting, 2, "needs-you");
  expect(sentence(own).title).toBe("1 pull request needs you.");
  // No name of a problem in any headline: GitHub, both AIs, start at login, an account's.
  const disconnected = { ...calm().connection, state: "disconnected" as const };
  const both = signedOut(signedOut(calm(), "claude"), "codex");
  const refused: State = {
    ...signedOut(calm(), "claude"),
    service: { ...calm().service, startAtLogin: true, atLogin: "none", loginItem: "os" },
  };
  const sso = onAccounts({ kind: "sso", organisation: "ledger-dev", url: null });
  for (const st of [{ ...calm(), connection: disconnected }, both, refused, sso]) {
    expect(problems(st).some((p) => p.tone === "need")).toBe(true);
    expect(sentence(st).title).toBe("Nothing else needs you.");
  }
  expect(sentence(withChange(withChange(both, 1, "needs-you"), 2, "needs-you")).title).toBe(
    "2 pull requests need you.",
  );
  // Previews alone are read, whatever the band holds.
  const open = [finding("a", "blocking", "open")];
  expect(sentence(withPreview(both, 1, open)).title).toBe("1 preview to read.");
});

test("an AI at its limit does not need you", () => {
  const st = withEngine(calm(), "codex", { state: "limit" });
  expect(sentence(st).title).toBe("Nothing needs you.");
});

test("with a problem, the line names the one AI still ready", () => {
  expect(sentence(signedOut(calm(), "claude")).small).toBe("Codex ready");
});

test("“Review again” while paused says the request will wait, and until when (ADR 0040)", () => {
  expect(reviewAgainNote(calm())).toBeNull();
  const st = paused(calm());
  expect(reviewAgainNote(st)).toBe("Reviews are paused: this one waits until you resume.");
  const timed = { ...st, service: { ...st.service, paused: { since: NOW, until: NOW + HOUR } } };
  expect(reviewAgainNote(timed)).toMatch(/^Reviews are paused: this one waits until \d\d:\d\d\.$/);
});

test("paused reviews say until when", () => {
  expect(sentence(paused(calm()))).toEqual({ title: "Reviews are paused.", small: "until you resume" });
  expect(sentence(withChange(paused(calm()), 1, "clean")).small).toBe("until you resume · 1 reviewed today");
});

// ---- homeGroups: the sections of Home ----

test("Home groups reviews by what they need, today's finished ones last", () => {
  let st = calm();
  st = withChange(st, 1, "deferred", 1 * MIN);
  st = withChange(st, 2, "needs-you", 2 * MIN);
  st = withChange(st, 3, "running");
  st = withChange(st, 4, "queued");
  st = withChange(st, 5, "to-fix", 3 * HOUR);
  st = withChange(st, 6, "clean", 1 * HOUR);
  st = withChange(st, 7, "settled", 2 * HOUR);
  st = withChange(st, 8, "skipped", 4 * HOUR);
  st = withChange(st, 9, "settled", 20 * HOUR);
  st = withChange(st, 10, "none");
  const g = homeGroups(st, "mine");
  const ids = (list: { change: { id: string } }[]) => list.map((i) => String(i.change.id));
  expect(ids(g.needs)).toEqual(["sam/app#2"]);
  expect(ids(g.running)).toEqual(["sam/app#3"]);
  // A review that waits will run by itself: it never looks broken.
  expect(ids(g.waiting)).toEqual(["sam/app#1", "sam/app#4"]);
  // Most recent first; yesterday's review and the unreviewed draft are not on Home.
  expect(ids(g.earlier)).toEqual(["sam/app#6", "sam/app#7", "sam/app#5", "sam/app#8"]);
});

// ---- statusLine: the line under a row's title ----

function finding(id: string, severity: Severity, status: Finding["status"]): Finding {
  return {
    id: findingId(id),
    fingerprints: { location: `src/app.ts:1:${id}`, meaning: id },
    severity,
    category: "Correctness",
    title: id,
    file: "src/app.ts",
    side: "head",
    line: 1,
    endLine: null,
    lineText: null,
    anchoring: "reported",
    foundBy: "claude",
    confirmation: { verdict: "not_checked", demoted: false },
    body: "",
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    suggestion: null,
    status,
    posted: true,
    commented: false,
    raisedIn: 1,
    anchoredIn: 1,
    closedIn: null,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
  };
}

const lineOf = (state: State) => {
  const [first] = changeReviews(state);
  if (!first) throw new Error("No review");
  return statusLine(state, first);
};

test("a review with findings to fix counts the blocking ones, or else all of them", () => {
  const blocking = [finding("a", "blocking", "open"), finding("b", "should_fix", "open")];
  expect(lineOf(withChange(calm(), 1, "to-fix", MIN, { findings: blocking }))).toBe(
    "1 blocking finding open",
  );
  const rest = [
    finding("a", "should_fix", "open"),
    finding("b", "consider", "open"),
    finding("c", "blocking", "verified_fixed"),
  ];
  expect(lineOf(withChange(calm(), 1, "to-fix", MIN, { findings: rest }))).toBe("2 findings open");
});

test("a settled review says what stays in the app: a finding kept off the pull request is still open here", () => {
  // Only posted findings count (I-152): the loop settles while the unposted one is open.
  const kept = [
    finding("a", "blocking", "verified_fixed"),
    finding("b", "should_fix", "verified_fixed"),
    { ...finding("c", "consider", "open"), posted: false, raisedIn: 2 },
  ];
  expect(lineOf(withChange(calm(), 1, "settled", MIN, { findings: kept }))).toBe(
    "2 findings closed in 1 round · 1 finding stays here, not on GitHub",
  );
  const closed = [finding("a", "blocking", "verified_fixed")];
  expect(lineOf(withChange(calm(), 1, "settled", MIN, { findings: closed }))).toBe(
    "1 finding, all closed in 1 round",
  );
});

test("the settled verdict says the rest can go only when nothing stays in the app (ADR 0042)", () => {
  const verdictOf = (state: State) => {
    const [first] = changeReviews(state);
    if (!first) throw new Error("No review");
    return settledVerdict(first.review);
  };
  const kept = [
    finding("a", "blocking", "verified_fixed"),
    { ...finding("c", "consider", "open"), posted: false, raisedIn: 2 },
  ];
  expect(verdictOf(withChange(calm(), 1, "settled", MIN, { findings: kept }))).toEqual({
    closed: "1 finding closed in 1 round.",
    rest: "1 finding stays here, not on GitHub.",
  });
  const closed = [finding("a", "blocking", "verified_fixed")];
  expect(verdictOf(withChange(calm(), 1, "settled", MIN, { findings: closed }))).toEqual({
    closed: "1 finding, all closed in 1 round.",
    rest: "The rest can go.",
  });
});

const nextOf = (state: State) => {
  const [first] = changeReviews(state);
  if (!first) throw new Error("No review");
  return nextStep(first);
};

test("after findings to fix, the verdict says who acts next", () => {
  const open = [finding("a", "blocking", "open")];
  // `withChange` builds a change an agent wrote.
  expect(nextOf(withChange(calm(), 1, "to-fix", MIN, { findings: open }))).toBe(
    "The agent is working on it and will ask again.",
  );
  const byYou = withChange(calm(), 1, "to-fix", MIN, { findings: open });
  const change = byYou.changes[changeId("sam/app#1")];
  if (!change) throw new Error("No change");
  const yours = {
    ...byYou,
    changes: { [change.id]: { ...change, author: "you" as const, writtenBy: null } },
  };
  expect(nextOf(yours)).toBe("Push your fixes, then review again.");
  const pushed = { ...byYou, changes: { [change.id]: { ...change, newCommits: 2 } } };
  expect(nextOf(pushed)).toBe("2 new commits since this review. Review again to look at them.");
  const one = { ...byYou, changes: { [change.id]: { ...change, newCommits: 1 } } };
  expect(nextOf(one)).toBe("1 new commit since this review. Review again to look at it.");
  // Another author's change, even one an agent wrote: no loop of the owner's works on it.
  for (const writtenBy of ["claude", null] as const) {
    const theirs = { ...byYou, changes: { [change.id]: { ...change, author: "other" as const, writtenBy } } };
    expect(nextOf(theirs)).toBe("Review again once the author pushes fixes.");
  }
});

test("a preview posted nothing, so no agent is said to be working on its findings", () => {
  const open = [finding("a", "blocking", "open")];
  expect(nextOf(withChange(calm(), 1, "to-fix", MIN, { findings: open, preview: true }))).toBe(
    "This was a preview: nothing was posted on GitHub. Review again to post it.",
  );
});

// ---- a preview: the owner's to read (ADR 0072) ----

/** The change `sam/app#n` previewed: its findings open, nothing posted. */
function withPreview(state: State, n: number, findings: Finding[], newCommits = 0): State {
  const st = withChange(state, n, "to-fix", MIN, { findings, preview: true });
  const id = changeId(`sam/app#${n}`);
  const change = st.changes[id];
  if (!change) throw new Error("No change");
  return { ...st, changes: { ...st.changes, [id]: { ...change, newCommits } } };
}

const firstOf = (state: State) => {
  const [first] = changeReviews(state);
  if (!first) throw new Error("No review");
  return first;
};

test("a preview with one blocking finding and nothing else is the owner's to read", () => {
  const st = withPreview(calm(), 148, [finding("a", "blocking", "open")]);
  expect(sentence(st).title).toBe("1 preview to read.");
  expect(chip(firstOf(st))).toEqual({ tone: "need", label: "Preview" });
  expect(statusLine(st, firstOf(st))).toBe("1 blocking finding found · nothing posted");
  const g = homeGroups(st, "mine");
  expect(g.needs.map((i) => String(i.change.id))).toEqual(["sam/app#148"]);
  expect(g.earlier).toEqual([]);
});

test("two previews are counted as previews; their line counts what they found", () => {
  const open = [finding("a", "should_fix", "open"), finding("b", "consider", "open")];
  const st = withPreview(withPreview(calm(), 1, [finding("a", "blocking", "open")]), 2, open);
  expect(sentence(st).title).toBe("2 previews to read.");
  expect(statusLine(st, firstOf(withPreview(calm(), 2, open)))).toBe("2 findings found · nothing posted");
  const blocking = [finding("a", "blocking", "open"), finding("b", "blocking", "open")];
  const two = withPreview(calm(), 1, blocking);
  expect(statusLine(two, firstOf(two))).toBe("2 blocking findings found · nothing posted");
});

test("a preview is counted with the rest of what needs you", () => {
  const open = [finding("a", "blocking", "open")];
  expect(sentence(withChange(withPreview(calm(), 1, open), 2, "needs-you")).title).toBe(
    "2 pull requests need you.",
  );
  expect(sentence(withChange(withPreview(signedOut(calm(), "claude"), 1, open), 2, "needs-you")).title).toBe(
    "2 pull requests need you.",
  );
});

test("the same round posted stays To fix, the author's, under “Nothing needs you.”", () => {
  const st = withChange(calm(), 1, "to-fix", MIN, {
    findings: [finding("a", "blocking", "open")],
    preview: false,
  });
  expect(sentence(st).title).toBe("Nothing needs you.");
  expect(chip(firstOf(st))).toEqual({ tone: "warn", label: "To fix" });
  expect(statusLine(st, firstOf(st))).toBe("1 blocking finding open");
});

test("the review page's verdict says a preview's findings were found, a posted round's are to fix", () => {
  const open = [finding("a", "blocking", "open")];
  const commit = { commit: commitSha("a1f9c2e") };
  expect(openVerdict(firstOf(withPreview(calm(), 1, open)))).toEqual([
    "Looked over ",
    commit,
    ". One thing found, one blocking.",
  ]);
  expect(openVerdict(firstOf(withChange(calm(), 1, "to-fix", MIN, { findings: open })))).toEqual([
    "Looked over ",
    commit,
    ". One thing to fix, one blocking.",
  ]);
  // The counts one way: words for one, digits for more, never "One thing to fix, 1 blocking".
  const three = [
    finding("a", "blocking", "open"),
    finding("b", "blocking", "open"),
    finding("c", "should_fix", "open"),
  ];
  expect(openVerdict(firstOf(withChange(calm(), 1, "to-fix", MIN, { findings: three })))).toEqual([
    "Looked over ",
    commit,
    ". 3 things to fix, 2 blocking.",
  ]);
  const two = [finding("a", "should_fix", "open"), finding("b", "consider", "open")];
  expect(openVerdict(firstOf(withPreview(calm(), 1, two)))).toEqual([
    "Looked over ",
    commit,
    ". 2 things found.",
  ]);
});

test("a preview with new commits says so and keeps Review again, as To fix does", () => {
  const st = withPreview(calm(), 1, [finding("a", "blocking", "open")], 2);
  expect(statusLine(st, firstOf(st))).toBe("1 blocking finding found · nothing posted · 2 new commits");
  expect(rowAction(firstOf(st))).toEqual({
    label: REVIEW_BUTTON.again,
    command: { type: "review.request", changeId: changeId("sam/app#1") },
  });
  expect(rowAction(firstOf(withPreview(calm(), 1, [finding("a", "blocking", "open")])))).toBeNull();
});

test("a review that needs you says how many findings wait for your decision", () => {
  const findings = [finding("a", "blocking", "escalated"), finding("b", "should_fix", "open")];
  expect(lineOf(withChange(calm(), 1, "needs-you", MIN, { findings }))).toBe("1 finding needs your decision");
});

test("a waiting review says what it waits for, in plain words", () => {
  expect(lineOf(withChange(calm(), 1, "deferred"))).toBe("Claude is signed out");
  expect(lineOf(withChange(calm(), 1, "queued"))).toBe("waiting for its turn");
  const paused = withChange(calm(), 1, "queued", MIN, {
    job: {
      id: jobId("job-p"),
      sha: SHA,
      trigger: "opened",
      state: "deferred",
      deferral: { reason: "paused" },
      stepIn: null,
      askedBy: null,
      skip: null,
      cancel: null,
      failure: null,
      turn: null,
    },
  });
  expect(lineOf(paused)).toBe("reviews are paused");
});

test("a failed review's row says its cause; after a round, the loop's state, and the page says the failure above it (ADR 0081)", () => {
  const failed = (failure: ReviewJob["failure"]): ReviewJob => ({
    id: jobId("job-f"),
    sha: commitSha("b2e8d1f"),
    trigger: "push",
    state: "failed",
    deferral: null,
    stepIn: null,
    askedBy: null,
    skip: null,
    cancel: null,
    failure,
    turn: null,
  });
  const late = failed({
    kind: "prepare_failed",
    detail: "fetch_failed",
    engine: "claude",
    cause: "git_time_limit",
    limitMs: 600_000,
  });
  const stall = failed({
    kind: "prepare_failed",
    detail: "fetch_failed",
    engine: "claude",
    cause: "git_silent",
    limitMs: 120_000,
  });

  // Before any round: the row says the phrase, the chip "Failed", the page's notice says it, on which commit and
  // when, from the review's history.
  const timeline = [
    { at: NOW - 3 * MIN, sha: commitSha("b2e8d1f"), kind: "failed" as const, failure: late.failure },
  ];
  const first = withChange(calm(), 1, "none", MIN, { job: late, timeline });
  expect(lineOf(first)).toBe("getting the code ready ran past its 10-minute limit");
  expect(chip(firstOf(first))).toEqual({ tone: "need", label: "Failed" });
  // The commit and the time apart: the head ends on the commit, the time opens the line under it (round 6).
  expect(failedNotice(firstOf(first), NOW)).toEqual({
    head: ["Couldn't look over ", { commit: commitSha("b2e8d1f") }],
    sentence: "Getting the code ready ran past its 10-minute limit.",
    when: "3 min ago",
    next: "The repository or the change is too large to get ready in that time.",
  });

  // After a round: the row and the chip follow the loop (ADR 0029); the page says the failure above the round.
  const findings = [finding("a", "blocking", "open")];
  // When is read from the failed entry on the job's own commit, never from a newer one on another commit.
  const history = [
    { at: NOW - 4 * MIN, sha: commitSha("b2e8d1f"), kind: "failed" as const, failure: stall.failure },
    { at: NOW - MIN, sha: commitSha("0a1b2c3"), kind: "failed" as const, failure: late.failure },
  ];
  const after = withChange(calm(), 1, "to-fix", MIN, { job: stall, findings, timeline: history });
  expect(lineOf(after)).toBe("1 blocking finding open");
  expect(chip(firstOf(after))).toEqual({ tone: "warn", label: "To fix" });
  // Where another try can help, the notice says so under the cause; "Try again" above is the way.
  expect(failedNotice(firstOf(after), NOW)).toEqual({
    head: ["Couldn't look over ", { commit: commitSha("b2e8d1f") }],
    sentence: "Git sent nothing for 2 minutes while Lookover got the code ready.",
    when: "4 min ago",
    next: "Another try usually gets through.",
  });
  // A failure another try can't cure says what would change it.
  expect(failedNotice(firstOf(withChange(calm(), 1, "to-fix", MIN, { job: late, findings })), NOW)).toEqual({
    head: ["Couldn't look over ", { commit: commitSha("b2e8d1f") }],
    sentence: "Getting the code ready ran past its 10-minute limit.",
    when: null,
    next: "The repository or the change is too large to get ready in that time.",
  });
  // An engine with no usable review: what that means, said in the notice, not left to the log.
  const crashed = failed({
    kind: "review_failed",
    detail: "crashed",
    engine: "codex",
    cause: "engine_answer",
    limitMs: null,
  });
  expect(failedNotice(firstOf(withChange(calm(), 1, "none", MIN, { job: crashed })), NOW)).toEqual({
    head: ["Couldn't look over ", { commit: commitSha("b2e8d1f") }],
    sentence: "Codex gave no usable review.",
    when: null,
    next: "It stopped, or sent an answer Lookover couldn't read. Another try usually works.",
  });
  // No cause known: the notice promises nothing of another try, "Try again" above is the way.
  const unknown = failed({ kind: "unexpected", detail: "boom", engine: null, cause: null, limitMs: null });
  expect(failedNotice(firstOf(withChange(calm(), 1, "none", MIN, { job: unknown })), NOW)).toEqual({
    head: ["Couldn't look over ", { commit: commitSha("b2e8d1f") }],
    sentence: "Something went wrong in Lookover.",
    when: null,
    next: null,
  });
  // A round that ended well, or a job not failed: nothing above it.
  expect(failedNotice(firstOf(withChange(calm(), 1, "to-fix", MIN, { findings })), NOW)).toBeNull();

  // The page's one primary answers the failure: "Try again" where another try can help, before a round or after;
  // where it can't, the button asks for a review as ever, the notice saying what would change it.
  expect(reviewButton(firstOf(withChange(calm(), 1, "none", MIN, { job: stall })))).toBe("retry");
  expect(reviewButton(firstOf(after))).toBe("retry");
  expect(reviewButton(firstOf(first))).toBe("now");
  expect(reviewButton(firstOf(withChange(calm(), 1, "to-fix", MIN, { job: late, findings })))).toBe("again");
});

test("a review waiting its turn says what it waits behind, on its row and its page (ADR 0055)", () => {
  const APP2 = changeId("sam/app#2");
  const APP3 = changeId("sam/app#3");
  const busy = withChange(withChange(calm(), 2, "running"), 3, "running");
  /** Home's row line and the review page's notice for sam/app#1, queued behind `turn`. */
  const words = (turn: Turn | null, extra: Partial<Review> = {}, state = busy) => {
    const queued = withChange(state, 1, "queued", MIN, extra);
    const it = changeReviews(queued).find((c) => c.change.number === 1);
    if (!it?.review.job) throw new Error("No review");
    const waiting = { ...it, review: { ...it.review, job: { ...it.review.job, turn } } };
    return [statusLine(queued, waiting), waitNotice(queued, waiting)];
  };
  const engines = (engines: EngineId[], changes = [APP2], testing = false): Turn => ({
    behind: "engines",
    engines,
    changes,
    testing,
  });
  expect(words(engines(["claude"]))).toEqual([
    "Claude is reviewing sam/app #2",
    "Claude is reviewing sam/app #2. This one starts after it.",
  ]);
  expect(words(engines(["claude", "codex"]))).toEqual([
    "Claude and Codex are reviewing sam/app #2",
    "Claude and Codex are reviewing sam/app #2. This one starts after it.",
  ]);
  expect(words(engines(["claude", "codex"], [APP2, APP3]))).toEqual([
    "Claude and Codex are reviewing sam/app #2 and sam/app #3",
    "Claude and Codex are reviewing sam/app #2 and sam/app #3. This one starts after them.",
  ]);
  // A change gone from the list since is still another pull request.
  expect(words(engines(["claude"], [changeId("sam/app#9")]))).toEqual([
    "Claude is reviewing another pull request",
    "Claude is reviewing another pull request. This one starts after it.",
  ]);
  expect(words(engines(["codex"], [], true))).toEqual([
    "Codex is running its self-test",
    "Codex is running its self-test. This one starts after it.",
  ]);
  expect(words(engines(["claude", "codex"], [], true))).toEqual([
    "Claude and Codex are running their self-tests",
    "Claude and Codex are running their self-tests. This one starts after them.",
  ]);
  // Only an older review waiting for the same AI holds it: first come, first served.
  expect(words(engines(["claude"], []))).toEqual([
    "an earlier review goes first",
    "Another review is waiting for Claude first. This one starts after it.",
  ]);
  // Behind its own change: the round still running or posting, or the posts of a dismissal.
  const run = levels("running", NOW).run ?? null;
  const round1 = levels("to-fix", NOW).rounds ?? [];
  const change: Turn = { behind: "change" };
  expect(words(change, { run: run && { ...run, step: "publishing" }, rounds: round1 })).toEqual([
    "round 2 is still posting",
    "Round 2 is still posting. This one starts after it.",
  ]);
  expect(words(change, { run })).toEqual([
    "round 1 is still running",
    "Round 1 is still running. This one starts after it.",
  ]);
  expect(words(change)).toEqual([
    "earlier posts are still going out",
    "Earlier posts are still going out. This one starts after them.",
  ]);
  // Not said yet (the take has not looked at it): its turn.
  expect(words(null)).toEqual(["waiting for its turn", "It waits its turn and starts by itself."]);
});

test("reviews waiting for an AI can be sent to the other one when the service says it may step in, once it is ready", () => {
  // The service computes each deferred job's `stepIn` with `core`'s rule (ADR 0047); the app only counts.
  const deferredOn = (state: State, n: number, stepIn: EngineId | null) =>
    withChange(state, n, "deferred", MIN, {
      job: {
        id: jobId(`job-${n}`),
        sha: SHA,
        trigger: "opened",
        state: "deferred",
        deferral: { reason: "engine-signed-out", engine: "claude" },
        stepIn,
        askedBy: null,
        skip: null,
        cancel: null,
        failure: null,
        turn: null,
      },
    });
  let waiting = signedOut(calm(), "claude");
  waiting = deferredOn(waiting, 1, "codex");
  waiting = deferredOn(waiting, 2, "codex");
  // The third waits on Claude too, but nobody may step in for it: the repository uses Claude only, or Codex may
  // not review that change. The app doesn't know which, and needn't.
  waiting = deferredOn(waiting, 3, null);
  expect(sendElsewhere(waiting, "claude")).toEqual({ to: "codex", count: 2 });
  expect(sendElsewhere(waiting, "codex")).toBeNull();
  expect(sendElsewhere(signedOut(waiting, "codex"), "claude")).toBeNull();
  expect(sendElsewhere(signedOut(calm(), "claude"), "claude")).toBeNull();
});

test("the chip says where a review stands; round counts have no limit", () => {
  const chipOf = (status: Status, extra: Partial<Review> = {}) => {
    const [first] = changeReviews(withChange(calm(), 1, status, MIN, extra));
    if (!first) throw new Error("No review");
    return chip(first);
  };
  expect(chipOf("needs-you")).toEqual({ tone: "need", label: "Needs you" });
  expect(chipOf("deferred")).toEqual({ tone: "wait", label: "Waiting" });
  expect(chipOf("to-fix")).toEqual({ tone: "warn", label: "To fix" });
  expect(chipOf("clean")).toEqual({ tone: "ok", label: "Clean" });
  expect(chipOf("settled")).toEqual({ tone: "ok", label: "Settled" });
  const sixRounds = Array.from({ length: 6 }, (_, i) => ({
    n: i + 1,
    base: null,
    confirmer: null,
    confirmFallback: null,
    confirmFailure: null,
    ruledOut: [],
    sha: SHA,
    reviewer: "claude" as const,
    secondFind: null,
    startedAt: NOW - HOUR,
    endedAt: NOW - HOUR,
    raised: 0,
    verifiedFixed: 0,
    open: 1,
    steps: [],
    sessions: [],
  }));
  expect(chipOf("running", { rounds: sixRounds, loop: "open" })).toEqual({ tone: "run", label: "Round 7" });
});

/** The change `sam/app#9`, opened by Mira, skipped for `reason`, as Home and the review page see it. */
function skippedFor(reason: SkipReason): ChangeReview {
  const st = withChange(calm(), 9, "skipped");
  const id = changeId("sam/app#9");
  const review = st.reviews[id];
  const change = st.changes[id];
  const [repo] = st.repos;
  if (!review?.job || !change || !repo) throw new Error("No change");
  return {
    change: { ...change, openedBy: "mira", author: "other", fork: reason === "fork" },
    review: { ...review, job: { ...review.job, skip: reason } },
    repo,
  };
}

test("a fork skipped says so on Home, and the review page says why and how to have Claude review it (ADR 0048)", () => {
  const it = skippedFor("fork");
  // The review page's card reads "Not reviewed: it comes from a fork." (spec #134, story 19).
  expect(statusLine(calm(), it)).toBe("it comes from a fork");
  expect(skipWhy(it, "fork")).toEqual({
    text: "It comes from a fork, so its code could try to steer the reviewer. Lookover never reviews a pull request from a fork by itself.",
    ask: {
      lead: "To have Claude review it, comment",
      command: "/lookover review",
      tail: "on it, or use “Review now”.",
    },
  });
  expect(canReviewAgain(it)).toBe(true);
  expect(reviewLabel(it)).toBe("Review now");
});

test("the review button asks for a first review as Review now, and for any later one as Review again", () => {
  const st = withChange(calm(), 1, "settled");
  const id = changeId("sam/app#1");
  const change = st.changes[id];
  const review = st.reviews[id];
  const [repo] = st.repos;
  if (!change || !review || !repo) throw new Error("No change");
  expect(review.rounds.length).toBeGreaterThan(0);
  expect(reviewLabel({ change, review, repo })).toBe("Review again");
  expect(reviewLabel({ change, review: { ...review, rounds: [] }, repo })).toBe("Review now");
});

test("the review button says what it does in each state: asks now or again, or shows the review running or waiting", () => {
  const button = (status: Status, rounds?: []) => {
    const st = withChange(calm(), 1, status);
    const id = changeId("sam/app#1");
    const change = st.changes[id];
    const review = st.reviews[id];
    const [repo] = st.repos;
    if (!change || !review || !repo) throw new Error("No change");
    return reviewButton({ change, review: rounds ? { ...review, rounds } : review, repo });
  };
  expect([button("settled"), button("settled", []), button("running"), button("queued")]).toEqual([
    "again",
    "now",
    "running",
    "waiting",
  ]);
  expect(REVIEW_BUTTON).toEqual({
    now: "Review now",
    again: "Review again",
    retry: "Try again",
    running: "Reviewing…",
    waiting: "Waiting…",
  });
});

test("the line under a review's title: who opened, wrote and reviewed it, one separator between every two", () => {
  const it = firstOf(withChange(calm(), 1, "to-fix"));
  expect(reviewMeta(it.change, "Codex")).toBe(
    `by sam${SEPARATOR}written by Claude${SEPARATOR}reviewed by Codex`,
  );
  expect(reviewMeta({ ...it.change, writtenBy: null }, null)).toBe("by sam");
  // The author said as every row says it (`authorLabel`), never "opened by" here and "by" there.
  expect(reviewMeta(it.change, null).replaceAll(SEPARATOR, " · ")).toBe(authorLabel(it.change));
});

test("the review button is the page's primary only when it answers what needs the person", () => {
  const primary = (st: State) => reviewButtonPrimary(firstOf(st));
  const findings = [finding("a", "blocking", "open")];
  const withNew = (st: State, newCommits: number): State => {
    const id = changeId("sam/app#1");
    const change = st.changes[id];
    if (!change) throw new Error("No change");
    return { ...st, changes: { ...st.changes, [id]: { ...change, newCommits } } };
  };
  // Nothing needs the person: the agent works on the findings, the review settled, a finding only they can settle
  // (the button doesn't settle it), a review running or waiting.
  expect(primary(withChange(calm(), 1, "to-fix", MIN, { findings }))).toBe(false);
  expect(primary(withChange(calm(), 1, "settled"))).toBe(false);
  expect(primary(withChange(calm(), 1, "clean"))).toBe(false);
  expect(primary(withChange(calm(), 1, "needs-you"))).toBe(false);
  expect(primary(withChange(calm(), 1, "running"))).toBe(false);
  expect(primary(withChange(calm(), 1, "queued"))).toBe(false);
  // What needs them: new commits nobody looked at, a preview to post, a first review to ask for, a failure another
  // try can help.
  expect(primary(withNew(withChange(calm(), 1, "to-fix", MIN, { findings }), 2))).toBe(true);
  expect(primary(withNew(withChange(calm(), 1, "settled"), 1))).toBe(true);
  expect(primary(withPreview(calm(), 1, findings))).toBe(true);
  expect(primary(withChange(calm(), 1, "none"))).toBe(true);
  const failed = (cause: "git_silent" | "git_time_limit"): ReviewJob => ({
    id: jobId("job-f"),
    sha: commitSha("b2e8d1f"),
    trigger: "push",
    state: "failed",
    deferral: null,
    stepIn: null,
    askedBy: null,
    skip: null,
    cancel: null,
    failure: { kind: "prepare_failed", detail: "fetch_failed", engine: "claude", cause, limitMs: 120_000 },
    turn: null,
  });
  expect(primary(withChange(calm(), 1, "to-fix", MIN, { job: failed("git_silent"), findings }))).toBe(true);
  // A failure another try can't cure: the notice says what would change it, the button asks as ever.
  expect(primary(withChange(calm(), 1, "to-fix", MIN, { job: failed("git_time_limit"), findings }))).toBe(
    false,
  );
  // Before round 1 too: Review now is no answer to a failure another try can't cure (#644).
  expect(primary(withChange(calm(), 1, "none", MIN, { job: failed("git_time_limit") }))).toBe(false);
  // New commits after such a failure are what needs the person: nobody looked at them (#644).
  expect(
    primary(withNew(withChange(calm(), 1, "to-fix", MIN, { job: failed("git_time_limit"), findings }), 2)),
  ).toBe(true);
});

test("a review that needs the person has one filled primary: Open on GitHub, where they settle the thread (#644)", () => {
  const github = (st: State) => gitHubPrimary(firstOf(st));
  expect(github(withChange(calm(), 1, "needs-you"))).toBe(true);
  // Every other state, Open on GitHub stays a secondary.
  for (const kind of ["to-fix", "settled", "clean", "running", "queued", "none"] as const)
    expect(github(withChange(calm(), 1, kind))).toBe(false);
  // New commits on it: Review again is the primary, and the only one.
  const st = withChange(calm(), 1, "needs-you");
  const id = changeId("sam/app#1");
  const change = st.changes[id];
  if (!change) throw new Error("No change");
  const newer = firstOf({ ...st, changes: { ...st.changes, [id]: { ...change, newCommits: 1 } } });
  expect([reviewButtonPrimary(newer), gitHubPrimary(newer)]).toEqual([true, false]);
});

test("the shortcut list says every label R can press: Review now, Review again and Try again", () => {
  expect(REVIEW_KEY).toBe("Review now, Review again or Try again");
  for (const label of [REVIEW_BUTTON.now, REVIEW_BUTTON.again, REVIEW_BUTTON.retry])
    expect(REVIEW_KEY).toContain(label);
});

test("a change never asked for, opened with reviews on open off, says so, not that someone else opened it", () => {
  const st = withChange(calm(), 1, "none");
  const id = changeId("sam/app#1");
  const change = st.changes[id];
  const review = st.reviews[id];
  const [repo] = st.repos;
  if (!change || !review || !repo) throw new Error("No change");
  expect(skipWhy({ change, review, repo }, "on-open-off")).toEqual({
    text: "“When a pull request is opened” is off in Settings, so reviews start only when someone asks. Use “Review now” to ask.",
    ask: null,
  });
});

test("another author's pull request the person hasn't asked about says so, not that reviews on open are off (ADR 0078)", () => {
  const st = withChange(calm(), 9, "none");
  const id = changeId("sam/app#9");
  const change = st.changes[id];
  const review = st.reviews[id];
  const [repo] = st.repos;
  if (!change || !review || !repo) throw new Error("No change");
  const mira: ChangeReview = { change: { ...change, openedBy: "mira", author: "other" }, review, repo };
  const opened =
    "By itself, Lookover reviews only the pull requests opened by you or by your coding agents. This one was opened by mira, so nothing was posted on it.";
  expect(notReviewed(mira)).toEqual({
    title: "you haven't asked",
    why: {
      text: opened,
      ask: {
        lead: "To have it reviewed, comment",
        command: "/lookover review",
        tail: "on it, or use “Review now”.",
      },
    },
  });
  const fork = { ...mira, change: { ...mira.change, fork: true } };
  expect(notReviewed(fork)).toEqual({
    title: "you haven't asked",
    why: {
      text: `${opened} It comes from a fork, so only Claude would review it.`,
      ask: {
        lead: "To have Claude review it, comment",
        command: "/lookover review",
        tail: "on it, or use “Review now”.",
      },
    },
  });
  expect(canReviewAgain(mira)).toBe(true);
  // Where only Codex reviews, Codex never reviews another author's: Settings is the way, not the button.
  const codexRepo = {
    ...repo,
    settings: {
      ...repo.settings,
      reviewers: { value: "codex" as const, origin: "owner-repository" as const, overrode: null },
    },
  };
  const codexOnly: ChangeReview = { ...mira, repo: codexRepo };
  const settings =
    "Only Codex reviews in app, and it reviews only your own pull requests from this repository. To have this one reviewed, let Claude review too, in Settings.";
  expect(notReviewed(codexOnly)).toEqual({
    title: "you haven't asked",
    why: { text: `${opened} ${settings}`, ask: null },
  });
  expect(canReviewAgain(codexOnly)).toBe(false);
  const codexFork: ChangeReview = { ...fork, repo: codexRepo };
  expect(notReviewed(codexFork)).toEqual({
    title: "you haven't asked",
    why: { text: `${opened} It comes from a fork, so only Claude would review it. ${settings}`, ask: null },
  });
  expect(canReviewAgain(codexFork)).toBe(false);
  // The person's own, opened with reviews on open off, and a skip, each keep their card.
  const own: ChangeReview = { ...mira, change: { ...change, author: "you" } };
  expect(notReviewed(own)).toEqual({ title: "reviews on open are off", why: skipWhy(own, "on-open-off") });
  expect(notReviewed(skippedFor("fork"))).toEqual({
    title: "it comes from a fork",
    why: skipWhy(skippedFor("fork"), "fork"),
  });
});

test("where only Codex reviews, a fork or another author's change points to Settings, not to a request", () => {
  const codexOnly = (it: ChangeReview): ChangeReview => ({
    ...it,
    repo: {
      ...it.repo,
      settings: {
        ...it.repo.settings,
        reviewers: { value: "codex", origin: "owner-repository", overrode: null },
      },
    },
  });
  const fork = codexOnly(skippedFor("fork"));
  expect(skipWhy(fork, "fork")).toEqual({
    text: "It comes from a fork, so its code could try to steer the reviewer. Lookover never reviews a pull request from a fork by itself. Only Codex reviews in app, and it reviews only your own pull requests from this repository. To have this one reviewed, let Claude review too, in Settings.",
    ask: null,
  });
  expect(canReviewAgain(fork)).toBe(false);
  const other = codexOnly(skippedFor("not-yours"));
  expect(skipWhy(other, "not-yours").ask).toBeNull();
  expect(skipWhy(other, "not-yours").text).toContain("let Claude review too, in Settings.");
  expect(canReviewAgain(other)).toBe(false);
});

test("each skip explains itself, and only a skip a request reviews offers “Review now”", () => {
  const reasons: SkipReason[] = ["not-yours", "fork", "draft", "repo-off", "on-open-off", "codex-not-yours"];
  expect(reasons.map((reason) => [reason, skipWhy(skippedFor(reason), reason).text])).toEqual([
    [
      "not-yours",
      "By itself, Lookover reviews only the pull requests opened by you or by your coding agents. This one was opened by mira and nobody asked for a review, so it was skipped.",
    ],
    [
      "fork",
      "It comes from a fork, so its code could try to steer the reviewer. Lookover never reviews a pull request from a fork by itself.",
    ],
    ["draft", "Drafts are skipped. It is reviewed when it is marked ready."],
    ["repo-off", "Reviews are turned off for app. Turn them on in Repositories."],
    [
      "on-open-off",
      "“When a pull request is opened” is off in Settings, so reviews start only when someone asks. Use “Review now” to ask.",
    ],
    [
      "codex-not-yours",
      "Only Codex reviews in app, and it reviews only your own pull requests from this repository. To have this one reviewed, let Claude review too, in Settings.",
    ],
  ]);
  expect(reasons.filter((reason) => skipWhy(skippedFor(reason), reason).ask !== null)).toEqual([
    "not-yours",
    "fork",
  ]);
  expect(reasons.filter((reason) => canReviewAgain(skippedFor(reason)))).toEqual([
    "not-yours",
    "fork",
    "on-open-off",
  ]);
  expect(statusLine(calm(), skippedFor("codex-not-yours"))).toBe(
    "only Codex may review here, and it reviews only your own pull requests from this repository",
  );
});

test("a repository differs only in the settings it has of its own, not in the owner's defaults", () => {
  const [app] = calm().repos;
  if (!app) throw new Error("No repository");
  const repo: Repository = {
    ...app,
    settings: {
      ...DEFAULTS,
      strictness: {
        value: "blocking",
        origin: "owner-default",
        overrode: { value: "recommended", origin: "lookover-default" },
      },
      onPush: {
        value: true,
        origin: "owner-repository",
        overrode: { value: false, origin: "lookover-default" },
      },
      reviewers: {
        value: "codex",
        origin: "owner-repository",
        overrode: { value: "both", origin: "lookover-default" },
      },
    },
  };
  expect(differences(app)).toEqual([]);
  expect(differences(repo)).toEqual(["reviewers", "onPush"]);
});

test("the verdict names the commit it looked over by its first seven characters, as the rounds do", () => {
  const [it] = changeReviews(withChange(calm(), 1, "to-fix"));
  if (!it) throw new Error("No review");
  const whole = commitSha("9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6");
  const rounds = it.review.rounds.map((round) => ({ ...round, sha: whole }));
  expect(rounds.length).toBeGreaterThan(0);
  expect(lookedOver({ ...it, review: { ...it.review, rounds } })).toBe("9f8e7d6");
  // Before its first round, the commit it is looking over is the pull request's head.
  const head = commitSha("0123456789abcdef0123456789abcdef01234567");
  const fresh = { ...it, change: { ...it.change, headSha: head }, review: { ...it.review, rounds: [] } };
  expect(lookedOver(fresh)).toBe("0123456");
});

// ---- Mine and Everyone (ADR 0078) ----

/** The change `sam/app#n` as another author's, "ana"'s, and, when `asked`, its job asked for with Review now. */
function asOther(state: State, n: number, { asked = false } = {}): State {
  const id = changeId(`sam/app#${n}`);
  const change = state.changes[id];
  const review = state.reviews[id];
  if (!change || !review) throw new Error("No change");
  const job = asked && review.job ? { ...review.job, trigger: "manual" as const } : review.job;
  return {
    ...state,
    changes: { ...state.changes, [id]: { ...change, openedBy: "ana", author: "other", writtenBy: null } },
    reviews: { ...state.reviews, [id]: { ...review, job } },
  };
}

const numbers = (items: ChangeReview[]) => items.map((i) => i.change.number);

test("Home: Mine keeps the person's in every group; Everyone adds others' never asked as Not reviewed", () => {
  let st = withChange(calm(), 1, "to-fix", MIN);
  st = withChange(st, 2, "running", MIN);
  st = asOther(withChange(st, 3, "none", MIN), 3);
  st = asOther(withChange(st, 4, "skipped", MIN), 4);
  st = asOther(withChange(st, 5, "queued", MIN), 5, { asked: true });
  const mine = homeGroups(st, "mine");
  expect(numbers(mine.running)).toEqual([2]);
  expect(numbers(mine.waiting)).toEqual([5]);
  expect(numbers(mine.earlier)).toEqual([1]);
  expect(mine.notReviewed).toEqual([]);
  const everyone = homeGroups(st, "everyone");
  expect(numbers(everyone.running)).toEqual([2]);
  expect(numbers(everyone.waiting)).toEqual([5]);
  // An old skip of another's keeps its place among what ended today.
  expect(numbers(everyone.earlier).sort()).toEqual([1, 4]);
  expect(numbers(everyone.notReviewed)).toEqual([3]);
});

/** The change `sam/app#n` moved to the repository `sam/old`, which `on` says is on or off (ADR 0084). */
function inOld(state: State, n: number, on: boolean): State {
  const id = changeId(`sam/app#${n}`);
  const change = state.changes[id];
  if (!change) throw new Error("No change");
  const old = repositoryId("sam/old");
  const repos = state.repos.some((r) => r.id === old)
    ? state.repos.map((r) => (r.id === old ? { ...r, enabled: on } : r))
    : [...state.repos, { id: old, owner: "sam", name: "old", enabled: on, settings: DEFAULTS }];
  return { ...state, repos, changes: { ...state.changes, [id]: { ...change, repoId: old } } };
}

test("a repository that is off leaves Reviews: Home, All reviews, the tabs and their counts; on again, it is back", () => {
  const build = (on: boolean) => {
    let st = withChange(calm(), 1, "needs-you", MIN);
    st = inOld(withChange(st, 2, "needs-you", MIN), 2, on);
    return inOld(asOther(withChange(st, 3, "none", MIN), 3), 3, on);
  };
  const off = build(false);
  expect(numbers(listedReviews(off))).toEqual([1]);
  expect(numbers(homeGroups(off, "mine").needs)).toEqual([1]);
  expect(homeGroups(off, "everyone").notReviewed).toEqual([]);
  expect(numbers(homeGroups(off, "everyone").tab)).toEqual([1]);
  expect(numbers(allReviews(listedReviews(off), "everyone", "all", "", () => "").rows)).toEqual([1]);
  // Another's pull request in an off repository is no reason for the tabs.
  expect(scopeTabs(listedReviews(off), false)).toBeNull();
  expect(sentence(off).title).toBe("1 pull request needs you.");
  // Its review page, reached by its address, still opens, and its card, never asked, says the repository is off.
  const page = changeReviewAt(off, "sam", "old", "3");
  expect(page?.change.number).toBe(3);
  if (!page) throw new Error("No page");
  expect(notReviewed(page)).toEqual({ title: "this repository is off", why: skipWhy(page, "repo-off") });

  const on = build(true);
  expect(numbers(listedReviews(on)).sort()).toEqual([1, 2, 3]);
  expect(numbers(homeGroups(on, "everyone").notReviewed)).toEqual([3]);
  expect(scopeTabs(listedReviews(on), false)).toEqual([
    { value: "mine", label: "Mine", count: 2 },
    { value: "everyone", label: "Everyone", count: 3 },
  ]);
  expect(sentence(on).title).toBe("2 pull requests need you.");
});

test("a review queued or running when its repository is switched off stays listed until it ends", () => {
  let st = withChange(calm(), 1, "running", MIN);
  st = inOld(st, 1, false);
  st = inOld(withChange(st, 2, "deferred", MIN), 2, false);
  st = inOld(withChange(st, 3, "queued", MIN), 3, false);
  st = inOld(withChange(st, 4, "needs-you", MIN), 4, false);
  st = inOld(withChange(st, 5, "clean", MIN), 5, false);
  expect(numbers(listedReviews(st)).sort()).toEqual([1, 2, 3]);
  const mine = homeGroups(st, "mine");
  expect(numbers(mine.running)).toEqual([1]);
  expect(numbers(mine.waiting).sort()).toEqual([2, 3]);
  expect(sentence(st).small).toContain("1 reviewing now · 2 waiting");
  expect(numbers(paletteReviews(st, "all")).sort()).toEqual([1, 2, 3]);
  // The deferred one Codex may step in for is a row the status menu's count speaks of.
  const job = st.reviews[changeId("sam/app#2")]?.job;
  if (!job) throw new Error("No job");
  const offered = inOld(
    withChange(signedOut(st, "claude"), 2, "none", MIN, { job: { ...job, stepIn: "codex" } }),
    2,
    false,
  );
  expect(sendElsewhere(offered, "claude")).toEqual({ to: "codex", count: 1 });
  expect(numbers(homeGroups(offered, "mine").waiting).sort()).toEqual([2, 3]);
});

test("the palette leaves out a repository that is off, the person's own pull request included; on again, it is back", () => {
  const build = (on: boolean) => {
    const st = withChange(withChange(calm(), 1, "needs-you", MIN), 2, "needs-you", MIN);
    return inOld(st, 2, on);
  };
  const off = build(false);
  expect(numbers(paletteReviews(off, "review"))).toEqual([1]);
  expect(numbers(paletteReviews(off, "all"))).toEqual([1]);
  expect(numbers(paletteReviews(off, null))).toEqual([1]);
  const on = build(true);
  expect(numbers(paletteReviews(on, "review")).sort()).toEqual([1, 2]);
  expect(numbers(paletteReviews(on, "all")).sort()).toEqual([1, 2]);
});

test("Review now only on another's pull request never asked; an old skip's row keeps what it shows", () => {
  const never = firstOf(asOther(withChange(calm(), 1, "none"), 1));
  expect(rowAction(never)).toEqual({
    label: REVIEW_BUTTON.now,
    command: { type: "review.request", changeId: changeId("sam/app#1") },
  });
  expect(rowAction(firstOf(withChange(calm(), 1, "none")))).toBeNull();
  expect(rowAction(firstOf(asOther(withChange(calm(), 1, "skipped"), 1)))).toBeNull();
  expect(rowAction(firstOf(asOther(withChange(calm(), 1, "queued"), 1, { asked: true })))).toBeNull();
  expect(rowAction(firstOf(asOther(withChange(calm(), 1, "clean"), 1)))).toBeNull();
});

test("the row follows the page: no Review now where only Codex reviews another's, or the repository is off", () => {
  const never = firstOf(asOther(withChange(calm(), 1, "none"), 1));
  const codexOnly: ChangeReview = {
    ...never,
    repo: {
      ...never.repo,
      settings: {
        ...never.repo.settings,
        reviewers: { value: "codex", origin: "owner-repository", overrode: null },
      },
    },
  };
  expect(canReviewAgain(codexOnly)).toBe(false);
  expect(rowAction(codexOnly)).toBeNull();
  // A request in a repository switched off is skipped `repo-off`: the card says the repository is off, and offers nothing.
  const off: ChangeReview = { ...never, repo: { ...never.repo, enabled: false } };
  expect(notReviewed(off)).toEqual({ title: "this repository is off", why: skipWhy(off, "repo-off") });
  expect(notReviewed(off)?.why.ask).toBeNull();
  expect(canReviewAgain(off)).toBe(false);
  expect(rowAction(off)).toBeNull();
  // The person's own, never reviewed in a repository switched off, says the same.
  const ownOff: ChangeReview = { ...firstOf(withChange(calm(), 1, "none")), repo: off.repo };
  expect(notReviewed(ownOff)).toEqual({ title: "this repository is off", why: skipWhy(ownOff, "repo-off") });
  expect(canReviewAgain(ownOff)).toBe(false);
});

test('a row names who opened it the same way on every row, "by sam", then who wrote it (round 5)', () => {
  const { change } = firstOf(withChange(calm(), 1, "none"));
  const label = (author: "you" | "agent" | "other", openedBy: string, writtenBy: EngineId | null) =>
    authorLabel({ ...change, author, openedBy, writtenBy });
  expect(label("you", "sam", null)).toBe("by sam");
  expect(label("you", "sam", "claude")).toBe("by sam · written by Claude");
  expect(label("agent", "sam", "claude")).toBe("by sam · written by Claude");
  expect(label("agent", "sam", "codex")).toBe("by sam · written by Codex");
  expect(label("other", "ana", null)).toBe("by ana");
  expect(label("other", "ana", "claude")).toBe("by ana · written by Claude");
});

test("a skipped job that never said why shows as not reviewed, never as another author's", () => {
  const st = withChange(calm(), 1, "none", MIN, {
    job: { ...levelsJob(), state: "skipped", skip: null },
  });
  expect(status(firstOf(st))).toEqual({ kind: "not-asked" });
  expect(statusLine(st, firstOf(st))).toBe("not reviewed yet");
});

/** A job as `withChange` gives it, queued. */
function levelsJob(): ReviewJob {
  const job = withChange(calm(), 1, "queued").reviews[changeId("sam/app#1")]?.job;
  if (!job) throw new Error("No job");
  return job;
}
