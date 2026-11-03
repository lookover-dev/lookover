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
import {
  bandOn,
  type ChangeReview,
  canReviewAgain,
  changeLabel,
  changeReviewAt,
  changeReviews,
  chip,
  differences,
  githubStatus,
  homeGroups,
  lookedOver,
  nextStep,
  openVerdict,
  type Problem,
  pill,
  problems,
  REVIEW_BUTTON,
  repositoryLabel,
  reviewAgainNote,
  reviewButton,
  reviewLabel,
  rowAction,
  sendElsewhere,
  sentence,
  settledVerdict,
  skipWhy,
  statusLine,
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
  const status = githubStatus(both);
  expect(status.ok).toBe(false);
  expect(status.text).toBe("connected as sam");
  expect(status.problems.map((p) => [p.id, p.short, p.fix?.label])).toEqual([
    ["account:sam", "App suspended on sam", "Unsuspend it on GitHub"],
    ["account:ledger-dev", "ledger-dev needs SSO", "Sign in with SSO"],
  ]);
});

test("the status menu's GitHub line: connected and nothing held, its dot on; a wait GitHub asked for listed, no fault; disconnected, its cause", () => {
  expect(githubStatus(onAccounts(null))).toEqual({
    ok: true,
    text: "connected as sam",
    tone: null,
    problems: [],
  });
  const limited = { ...calm(), connection: { ...calm().connection, limitUntil: NOW + 5 * MIN } };
  expect(githubStatus(limited)).toMatchObject({ ok: true, problems: [{ id: "connection", tone: "warn" }] });
  const st = down({ kind: "signed-out" });
  const out = githubStatus(st);
  expect(out.ok).toBe(false);
  expect(out.text).toBe("signed out");
  expect(out.problems.map((p) => p.fix?.label)).toEqual(["Sign in again"]);
  // The AIs and the service are the menu's other lines.
  expect(githubStatus(signedOut(onAccounts(null), "claude")).problems).toEqual([]);
});

test("the status menu's GitHub line takes the band's colour: amber when it only waits, pink when any problem under it needs the person (ADR 0070)", () => {
  const unreachable = githubStatus(down({ kind: "unreachable" }));
  expect(unreachable).toMatchObject({ ok: false, tone: "warn" });
  // The connection waits on GitHub's limit while ledger-dev asks for SSO: the line's dot is pink.
  const st = onAccounts({ kind: "sso", organisation: "ledger-dev", url: null });
  const both = githubStatus({ ...st, connection: { ...st.connection, limitUntil: NOW + 5 * MIN } });
  expect(both.problems.map((p) => [p.id, p.tone])).toEqual([
    ["connection", "warn"],
    ["account:ledger-dev", "need"],
  ]);
  expect(both).toMatchObject({ ok: false, tone: "need" });
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
  expect(sentence(refused).title).toBe("1 thing needs you.");
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

test("running and waiting reviews are counted, not called out", () => {
  const st = withChange(withChange(calm(), 1, "running"), 2, "queued");
  expect(sentence(st)).toEqual({ title: "Nothing needs you.", small: "1 reviewing now · 1 waiting" });
});

test("a pause still says so under a problem: what needs you comes first, the pause stays in sight", () => {
  const st = withChange(paused(signedOut(calm(), "claude")), 1, "deferred", 5 * MIN);
  expect(sentence(st)).toEqual({
    title: "1 thing needs you.",
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

test("a review waiting for a signed-out AI is not one more thing: the AI is", () => {
  const st = withChange(signedOut(calm(), "claude"), 1, "deferred", 5 * MIN);
  expect(sentence(st).title).toBe("1 thing needs you.");
  expect(homeGroups(st).waiting.map((i) => String(i.change.id))).toEqual(["sam/app#1"]);
});

test("problems count with pull requests", () => {
  // The design system's Home: a finding escalated, and a review waiting because Claude signed out.
  let st = withChange(signedOut(calm(), "claude"), 1, "needs-you");
  st = withChange(st, 2, "deferred", 5 * MIN);
  expect(sentence(st).title).toBe("2 things need you.");
  // A service problem on its own.
  st = calm();
  expect(sentence({ ...st, connection: { ...st.connection, state: "disconnected" } }).title).toBe(
    "1 thing needs you.",
  );
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
  const g = homeGroups(st);
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
  const g = homeGroups(st);
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
  expect(sentence(withPreview(signedOut(calm(), "claude"), 1, open)).title).toBe("2 things need you.");
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
  expect(openVerdict(firstOf(withPreview(calm(), 1, open)))).toBe(
    "Looked over a1f9c2e. One thing found, 1 blocking.",
  );
  expect(openVerdict(firstOf(withChange(calm(), 1, "to-fix", MIN, { findings: open })))).toBe(
    "Looked over a1f9c2e. One thing to fix, 1 blocking.",
  );
  const two = [finding("a", "should_fix", "open"), finding("b", "consider", "open")];
  expect(openVerdict(firstOf(withPreview(calm(), 1, two)))).toBe("Looked over a1f9c2e. 2 things found.");
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
      skip: null,
      cancel: null,
      failure: null,
      turn: null,
    },
  });
  expect(lineOf(paused)).toBe("reviews are paused");
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
  expect(chipOf("deferred")).toEqual({ tone: "warn", label: "Waiting" });
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
    text: "It comes from a fork, so its code could try to steer the reviewer. Lookover never reviews a pull request from a fork by itself, whoever opened it.",
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
    running: "Reviewing…",
    waiting: "Waiting…",
  });
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
    text: "It comes from a fork, so its code could try to steer the reviewer. Lookover never reviews a pull request from a fork by itself, whoever opened it. Only Codex reviews in app, and it reviews only your own pull requests from this repository. To have this one reviewed, let Claude review too, in Settings.",
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
      "It comes from a fork, so its code could try to steer the reviewer. Lookover never reviews a pull request from a fork by itself, whoever opened it.",
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
