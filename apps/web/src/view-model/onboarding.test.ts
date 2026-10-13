// What the setup's GitHub step, "Use an existing App", the App's slug and the links to GitHub say for a given
// snapshot (ADR 0053). Snapshots are built by hand: the view model reads state only.
import { expect, test } from "bun:test";
import {
  APP_FLOW,
  type Connection,
  type ConnectionApp,
  DEMO_API,
  type Engine,
  type EngineId,
  type GhWhy,
  GITHUB_WEB,
  type Repository,
  type ResolvedSettings,
  repositoryId,
  type SetupGitHub,
  type SetupGitHubRefusal,
  type State,
} from "@lookover/contracts";
import {
  addRepositoryLink,
  agentApp,
  aiStepActs,
  aiStepLabels,
  appText,
  chosenRepos,
  departedNotice,
  engineSetupText,
  GITHUB_STEP_TEXT,
  githubStep,
  NEW_KEY_TEXT,
  pullRequestLink,
  repositoriesFoot,
  USE_APP_TEXT,
  useAppRefusalText,
} from "./onboarding.ts";

const NOW = Date.UTC(2026, 9, 10, 10, 0, 0);

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
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

const APP: ConnectionApp = {
  id: 424242,
  slug: "lookover-q7x2ka",
  account: { id: 7, login: "sam", type: "User" },
  person: { id: 7, login: "sam" },
};

function repo(name: string): Repository {
  return { id: repositoryId(`sam/${name}`), owner: "sam", name, enabled: true, settings: DEFAULTS };
}

function connection(patch: Partial<Connection> = {}): Connection {
  return {
    id: null,
    state: "not-connected",
    cause: null,
    bot: null,
    app: null,
    installationId: null,
    web: GITHUB_WEB,
    since: NOW,
    limitUntil: null,
    gh: null,
    ...patch,
  };
}

/** Setup on its GitHub step, at `github`, the App known once GitHub made it. */
function onGitHub(
  github: SetupGitHub,
  patch: { refused?: SetupGitHubRefusal; repos?: Repository[]; connection?: Partial<Connection> } = {},
): State {
  const made = github !== "start" && github !== "waiting-for-app";
  return {
    seq: 0,
    now: NOW,
    setup: {
      done: false,
      step: "github",
      reached: "github",
      github,
      githubRefused: patch.refused ?? null,
      firstReviewChange: null,
    },
    engines: { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") },
    connection: connection({
      ...(made ? { app: APP, bot: `${APP.slug}[bot]` } : {}),
      ...(github === "done" || github === "nothing-granted"
        ? { installationId: 77, state: "connected" as const }
        : {}),
      ...patch.connection,
    }),
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
    repos: patch.repos ?? [],
    departed: [],
    rules: [],
    changes: {},
    reviews: {},
  };
}

// ---- the GitHub step ----

/** Every text a sub-step shows before it is done: its row is as tall as the tallest of them and its own (#285). */
const CREATE_HELD = [
  "GitHub may ask for your password, then you confirm.",
  "GitHub is open in another tab. Confirm there; this page sees it within a few seconds.",
];
const ACCESS_HELD = [
  "On GitHub, right after the App is made.",
  "On GitHub, pick “All repositories” or just the ones you want, then install. This page sees it within a few seconds.",
  "Installed, with no repository. On GitHub, pick “All repositories” or just the ones you want. Checking every few seconds…",
];
/** Every label a sub-step's action can show: its place is as wide as the widest, done or not. */
const CREATE_LABELS = ["Create it on GitHub", "Open GitHub again"];
const ACCESS_LABELS = ["Open GitHub again"];

test("every sub-step of the GitHub step holds every text it can show, so a row done keeps its height", () => {
  for (const at of ["start", "waiting-for-app", "waiting-for-install", "nothing-granted", "done"] as const) {
    const step = githubStep(onGitHub(at, { repos: [repo("app")] }));
    for (const one of [step.create, step.access]) {
      expect(one.held).toContain(one.text);
      expect(new Set(one.held).size).toBe(one.held.length);
    }
    expect(step.create.held).toEqual(expect.arrayContaining(CREATE_HELD));
    expect(step.access.held).toEqual(expect.arrayContaining(ACCESS_HELD));
  }
});

test("every sub-step of the GitHub step holds every action label it can show, so its action's place keeps its width once done", () => {
  for (const at of ["start", "waiting-for-app", "waiting-for-install", "nothing-granted", "done"] as const) {
    const step = githubStep(onGitHub(at, { repos: [repo("app")] }));
    expect(step.create.labels).toEqual(CREATE_LABELS);
    expect(step.access.labels).toEqual(ACCESS_LABELS);
    for (const one of [step.create, step.access])
      if (one.action !== null) expect(one.labels).toContain(one.action.label);
  }
});

test("before anything, the step offers to create the App on GitHub, saying GitHub may ask for the password", () => {
  const step = githubStep(onGitHub("start"));
  expect(step.create).toEqual({
    state: "current",
    text: "GitHub may ask for your password, then you confirm.",
    action: { label: "Create it on GitHub", href: APP_FLOW.manifest, createApp: true },
    held: CREATE_HELD,
    labels: CREATE_LABELS,
  });
  expect(step.access).toEqual({
    state: "later",
    text: "On GitHub, right after the App is made.",
    action: null,
    held: ACCESS_HELD,
    labels: ACCESS_LABELS,
  });
  expect(step.refused).toBeNull();
  expect(step.done).toBe(false);
});

test("while GitHub's page is open, the step waits, and offers that page again: no App yet, so the manifest page, for the place chosen now", () => {
  const step = githubStep(onGitHub("waiting-for-app"));
  expect(step.create).toEqual({
    state: "busy",
    text: "GitHub is open in another tab. Confirm there; this page sees it within a few seconds.",
    action: { label: "Open GitHub again", href: APP_FLOW.manifest, createApp: true },
    held: CREATE_HELD,
    labels: CREATE_LABELS,
  });
  expect(step.access.state).toBe("later");
});

test("once the App is made, it waits for the install, and GitHub again is the App's install page", () => {
  const step = githubStep(onGitHub("waiting-for-install"));
  expect(step.create).toEqual({
    state: "done",
    text: "Done: lookover-q7x2ka",
    action: null,
    held: [...CREATE_HELD, "Done: lookover-q7x2ka"],
    labels: CREATE_LABELS,
  });
  // The App not described yet: its bot, if known.
  const bot = githubStep(
    onGitHub("waiting-for-install", { connection: { app: null, bot: "sam-reviewer[bot]" } }),
  );
  expect(bot.create.text).toBe("Done: sam-reviewer[bot]");
  expect(bot.access.action).toBeNull();
  expect(step.access).toEqual({
    state: "busy",
    text: "On GitHub, pick “All repositories” or just the ones you want, then install. This page sees it within a few seconds.",
    action: {
      label: "Open GitHub again",
      href: "https://github.com/apps/lookover-q7x2ka/installations/new",
      createApp: false,
    },
    held: ACCESS_HELD,
    labels: ACCESS_LABELS,
  });
  expect(step.done).toBe(false);
});

test("installed with nothing granted, the step says so and opens the installation's settings", () => {
  const step = githubStep(onGitHub("nothing-granted"));
  expect(step.access).toEqual({
    state: "current",
    // As long as the wait for the install it follows, so the card keeps its two lines: nothing below it moves.
    text: "Installed, with no repository. On GitHub, pick “All repositories” or just the ones you want. Checking every few seconds…",
    action: {
      label: "Open GitHub again",
      href: "https://github.com/settings/installations/77",
      createApp: false,
    },
    held: ACCESS_HELD,
    labels: ACCESS_LABELS,
  });
  // No installation known yet: the install page, where GitHub lists it.
  const unknown = githubStep(onGitHub("nothing-granted", { connection: { installationId: null } }));
  expect(unknown.access.action?.href).toBe("https://github.com/apps/lookover-q7x2ka/installations/new");
});

test("installed with repositories, both sub-steps are done and the step can go on", () => {
  const step = githubStep(onGitHub("done", { repos: [repo("app"), repo("site")] }));
  expect(step.create.state).toBe("done");
  expect(step.access).toEqual({
    state: "done",
    text: "Done: 2 repositories",
    action: null,
    held: [...ACCESS_HELD, "Done: 2 repositories"],
    labels: ACCESS_LABELS,
  });
  expect(step.done).toBe(true);
  expect(githubStep(onGitHub("done", { repos: [repo("app")] })).access.text).toBe("Done: 1 repository");
});

test("a flow that stopped short says why, and creating it again is offered", () => {
  const cases: [SetupGitHubRefusal, string][] = [
    [
      "unreachable",
      "GitHub couldn't be reached to finish making the App. Within the hour, reload the tab GitHub sent back to try again.",
    ],
    ["expired", "GitHub's page ran out or was already used. Create it again."],
    ["refused", "GitHub refused to make the App. Create it again."],
    [
      "elsewhere",
      "GitHub made the App on another account than the one you chose. Lookover doesn't use it: you can delete it on GitHub. Create it again.",
    ],
  ];
  for (const [refused, text] of cases) {
    const step = githubStep(onGitHub("start", { refused }));
    expect([refused, step.refused]).toEqual([refused, text]);
    expect(step.create.action?.label).toBe("Create it on GitHub");
  }
});

test("in demo mode every link to GitHub goes to the service's fake of it, never github.com", () => {
  const demo = { web: DEMO_API.github };
  const hrefs = [
    githubStep(onGitHub("waiting-for-install", { connection: demo })).access.action?.href,
    githubStep(onGitHub("nothing-granted", { connection: demo })).access.action?.href,
    addRepositoryLink(onGitHub("done", { connection: demo }).connection),
  ];
  expect(hrefs).toEqual([
    "/api/v1/demo/github/apps/lookover-q7x2ka/installations/new",
    "/api/v1/demo/github/settings/installations/77",
    "/api/v1/demo/github/settings/installations/77",
  ]);
  for (const href of hrefs) expect(href).not.toContain("github.com");
});

// ---- the repositories step ----

test("the repositories step ticks what the installation granted, keeps what the owner unticked, and follows GitHub", () => {
  const [app, site, docs] = [repo("app"), repo("site"), repo("docs")];
  const unticked = new Map([[site.id, false]]);
  expect(chosenRepos([app, site], unticked)).toEqual([app.id]);
  // Granted on GitHub after the step opened: it arrives ticked. Removed on GitHub: it goes.
  expect(chosenRepos([app, site, docs], unticked)).toEqual([app.id, docs.id]);
  expect(chosenRepos([site, docs], unticked)).toEqual([docs.id]);
  // A repository the service has off stays off until ticked.
  const off = { ...docs, enabled: false };
  expect(chosenRepos([off], new Map())).toEqual([]);
  expect(chosenRepos([off], new Map([[off.id, true]]))).toEqual([off.id]);
});

// ---- "Use an existing App" ----

test("each refusal of an existing App says what is wrong, never the key", () => {
  expect(useAppRefusalText({ kind: "not-a-key" })).toBe(
    "That file holds no private key. Choose the .pem file GitHub gave you.",
  );
  expect(useAppRefusalText({ kind: "key-refused" })).toBe(
    "GitHub refused this id and key. Check the App id, and that the key is this App's.",
  );
  expect(useAppRefusalText({ kind: "missing-permissions", missing: ["checks"] })).toBe(
    "This App lacks Checks: write. Give it on GitHub, then try again.",
  );
  expect(
    useAppRefusalText({ kind: "missing-permissions", missing: ["contents", "pull_requests", "issues"] }),
  ).toBe(
    "This App lacks Contents: read, Pull requests: write and Issues: write. Give them on GitHub, then try again.",
  );
  expect(useAppRefusalText({ kind: "another-app" })).toBe(
    "Lookover already keeps another App here. Give that App's id, with a new key of its own.",
  );
  expect(useAppRefusalText({ kind: "unreachable" })).toBe("GitHub couldn't be reached. Try again.");
  expect(useAppRefusalText({ kind: "live-config" })).toBe(
    "live.json names this App: live runs don't change it.",
  );
});

test("an organisation's App refused says what gh said: who it is signed in as, and how to fix it", () => {
  expect(useAppRefusalText({ kind: "gh-missing" })).toBe(
    "An organisation's App needs the GitHub CLI to know you're a member: install gh, then run gh auth login. Then try again.",
  );
  expect(useAppRefusalText({ kind: "gh-signed-out" })).toBe(
    "An organisation's App needs gh signed in to know you're a member: run gh auth login. Then try again.",
  );
  expect(
    useAppRefusalText({ kind: "not-a-member", organisation: "acme", person: "sasensi", invited: false }),
  ).toBe(
    "gh is signed in as sasensi, who isn't a member of acme. Sign gh in as a member, or ask an admin of acme to add you.",
  );
  expect(
    useAppRefusalText({ kind: "not-a-member", organisation: "acme", person: "mira", invited: true }),
  ).toBe("mira is invited to acme but hasn't joined yet. Accept the invitation on GitHub, then try again.");
  expect(useAppRefusalText({ kind: "another-person", person: "otto", kept: "mira" })).toBe(
    "Lookover keeps this App for mira, and gh is signed in as otto. Sign gh in as mira, then try again.",
  );
  const unanswered = (why: GhWhy) => useAppRefusalText({ kind: "gh-unanswered", why });
  expect(unanswered("offline")).toBe("gh couldn't reach GitHub. Try again.");
  expect(unanswered("sso")).toBe(
    "gh isn't authorised for this organisation's single sign-on. Authorise it on GitHub, then try again.",
  );
  expect(unanswered("scope")).toBe(
    "gh can't read your organisations. Run gh auth refresh -s read:org, then try again.",
  );
  expect(unanswered("timeout")).toBe("gh didn't answer in time. Try again.");
  expect(unanswered("failed")).toBe("gh couldn't answer. Try again.");
});

test("the GitHub step says one refusal on its one line: the flow's first, else the refused click", () => {
  expect(githubStep(onGitHub("start"), { kind: "already-made" }).refused).toBe(
    "Lookover already keeps an App.",
  );
  expect(githubStep(onGitHub("start", { refused: "expired" }), { kind: "already-made" }).refused).toBe(
    "GitHub's page ran out or was already used. Create it again.",
  );
  expect(githubStep(onGitHub("start"), null).refused).toBeNull();
});

test("the GitHub step speaks of the owner's App, never of a bot, and promises nothing GitHub doesn't keep", () => {
  const words = [
    GITHUB_STEP_TEXT.title,
    GITHUB_STEP_TEXT.lead,
    GITHUB_STEP_TEXT.create,
    GITHUB_STEP_TEXT.access,
    ...GITHUB_STEP_TEXT.disclosures.flatMap((d) => [d.summary, d.body]),
    ...Object.values(USE_APP_TEXT),
  ].join(" ");
  expect(words).not.toMatch(/\bbot\b/i);
  expect(words).not.toContain("nothing to fill in");
  // Organisations are offered under "Create your App" (ADR 0059): no disclosure says they come later.
  expect(GITHUB_STEP_TEXT.disclosures.map((d) => d.summary)).toEqual([
    "Already using Lookover on another computer?",
    "Advanced: use an existing App",
  ]);
  expect(GITHUB_STEP_TEXT.create).toBe("Create your App");
});

// ---- the App's slug, for the agents ----

test("the App's slug is the line an agent on another computer takes, under one plain sentence, once there is an App", () => {
  expect(agentApp(connection({ app: APP }))).toEqual({
    sentence: {
      before: "On another computer, put this line in your coding agent's environment so its",
      command: "lookover wait",
      after: "finds this App:",
    },
    line: "LOOKOVER_APP=lookover-q7x2ka",
  });
  expect(agentApp(connection())).toBeNull();
});

test("Settings names the App and whose it is, and how a new key is given", () => {
  // A personal App: the account is the person's own, so nobody is named.
  expect(appText(connection({ app: APP }))).toBe(
    "lookover-q7x2ka, on your GitHub account. Pull requests opened by you or your agents are reviewed.",
  );
  expect(appText(connection())).toBe("No App yet.");
  // An organisation's App (ADR 0059): the organisation named, and the person, who isn't the account.
  const ledger: ConnectionApp = {
    ...APP,
    slug: "lookover-ledger-dev",
    account: { id: 338, login: "ledger-dev", type: "Organization" },
    person: { id: 1, login: "sasensi" },
  };
  expect(appText(connection({ app: ledger }))).toBe(
    "lookover-ledger-dev, on the ledger-dev organisation. Pull requests opened by you (sasensi) or your agents are reviewed.",
  );
  expect(NEW_KEY_TEXT).toBe(
    "For a new key, generate one on the App's page on GitHub, then give it here with the App's id. Lookover keeps one App: another App's id is refused.",
  );
});

// ---- links ----

test("Add a repository opens the installation's settings, or the install page before there is one", () => {
  expect(addRepositoryLink(connection({ app: APP, installationId: 77 }))).toBe(
    "https://github.com/settings/installations/77",
  );
  expect(addRepositoryLink(connection({ app: APP }))).toBe(
    "https://github.com/apps/lookover-q7x2ka/installations/new",
  );
  expect(addRepositoryLink(connection())).toBeNull();
  const acme = { ...APP, account: { id: 900, login: "acme", type: "Organization" as const } };
  expect(addRepositoryLink(connection({ app: acme, installationId: 77 }))).toBe(
    "https://github.com/organizations/acme/settings/installations/77",
  );
});

test("Repositories' foot names the bot and the account it is on (ADR 0059)", () => {
  const acme = { ...APP, account: { id: 900, login: "acme", type: "Organization" as const } };
  expect(repositoriesFoot(connection({ app: acme, bot: "lookover-acme[bot]" }))).toBe(
    "Connected to GitHub as lookover-acme[bot], on the acme organisation.",
  );
  expect(repositoriesFoot(connection({ app: APP, bot: "lookover-q7x2ka[bot]" }))).toBe(
    "Connected to GitHub as lookover-q7x2ka[bot], on your GitHub account.",
  );
  expect(repositoriesFoot(connection())).toBe("Connected to GitHub as nobody.");
});

test("a departed repository is said in one sentence, labelled Left, and Add it back opens the installation's settings (ADR 0059)", () => {
  const text =
    "left the App's installation and is no longer reviewed: moved, deleted, or taken off its access.";
  expect(departedNotice(connection({ app: APP, installationId: 77 }))).toEqual({
    label: "Left",
    text,
    addBack: "https://github.com/settings/installations/77",
  });
  const acme = { ...APP, account: { id: 900, login: "acme", type: "Organization" as const } };
  expect(departedNotice(connection({ app: acme, installationId: 78 }))).toEqual({
    label: "Left",
    text,
    addBack: "https://github.com/organizations/acme/settings/installations/78",
  });
  // No App kept any more: nothing to add it back to.
  expect(departedNotice(connection()).addBack).toBeNull();
});

test("Open on GitHub opens the real pull request in live mode, and the simulated page in demo mode", () => {
  const change = { repoId: repositoryId("sam/site"), number: 12 };
  expect(pullRequestLink(connection(), change)).toEqual({ href: "https://github.com/sam/site/pull/12" });
  expect(pullRequestLink(connection({ web: DEMO_API.github }), change)).toEqual({ path: "/github/site/12" });
});

test("the AI step waits for Continue (ADR 0058): both ready says so and offers Continue; one of two ready says which and offers it only; none, nothing", () => {
  const claude = engine("claude", "Claude");
  const codex = engine("codex", "Codex");
  const signedOut = { ...codex, state: "signed-out" } as const;
  expect(aiStepActs([claude, codex])).toEqual({ said: "Both are ready.", label: "Continue", enabled: true });
  expect(aiStepActs([claude, signedOut])).toEqual({
    said: "Claude is ready.",
    label: "Continue with Claude only",
    enabled: true,
  });
  expect(aiStepActs([{ ...claude, state: "signed-out" }, signedOut])).toEqual({
    said: "",
    label: "Sign in to continue",
    enabled: false,
  });
  // Continue keeps one width whichever label it shows: every one is laid out (`SameWidth`).
  expect(aiStepLabels([claude, codex])).toEqual([
    "Continue",
    "Continue with Claude only",
    "Continue with Codex only",
    "Sign in to continue",
  ]);
  // No copy says the step moves on by itself.
  for (const acts of [aiStepActs([claude, codex]), aiStepActs([claude, signedOut])]) {
    expect(acts.said).not.toContain("by itself");
    expect(acts.said).not.toContain("Moving on");
  }
});

test("each AI's line in the setup says its state; one that can't be used says why, the command included", () => {
  const codex = engine("codex", "Codex");
  expect(engineSetupText({ ...codex, detail: "ChatGPT Plus plan" })).toBe(
    "Ready · signed in, ChatGPT Plus plan · codex 1.0.0",
  );
  expect(engineSetupText({ ...codex, state: "missing", version: null })).toBe(
    "codex was not found on this computer",
  );
  const tooOld =
    "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.154.0. Update it, then check again: npm install -g @openai/codex@latest";
  expect(
    engineSetupText({
      ...codex,
      state: "missing",
      version: "0.154.0",
      detail: tooOld,
      unusable: { kind: "too-old", version: "0.154.0", model: "gpt-6.1-sol", needs: "0.162.0" },
    }),
  ).toBe(tooOld);
  expect(engineSetupText({ ...codex, state: "signed-out" })).toBe("Not signed in · codex 1.0.0 found");
  expect(engineSetupText({ ...codex, state: "signed-out", signingIn: true })).toBe(
    "A terminal is open. Sign in there; this page checks every few seconds.",
  );
});

test("an AI's line joins only the parts it has: no stray comma, no doubled separator, in any state (#256)", () => {
  const claude = engine("claude", "Claude");
  // Claude ready with no plan said: the detail is left out, not printed empty.
  expect(engineSetupText({ ...claude, version: "2.4.1" })).toBe("Ready · signed in · claude 2.4.1");
  expect(engineSetupText({ ...claude, version: "2.4.1", detail: "Claude Max plan" })).toBe(
    "Ready · signed in, Claude Max plan · claude 2.4.1",
  );
  // At its limit or failing the safety check, it is signed in: the line says the state as the status menu does.
  expect(engineSetupText({ ...claude, version: "2.4.1", state: "limit" })).toBe(
    "At its limit · signed in · claude 2.4.1",
  );
  expect(
    engineSetupText({ ...claude, version: "2.4.1", state: "failed-self-test", detail: "Claude Max plan" }),
  ).toBe("Didn't pass Lookover's safety check · signed in, Claude Max plan · claude 2.4.1");
  const states: Engine["state"][] = ["ready", "signed-out", "missing", "limit", "failed-self-test"];
  for (const state of states) {
    for (const detail of ["", "Claude Max plan"]) {
      for (const version of [null, "2.4.1"]) {
        for (const signingIn of [false, true]) {
          const line = engineSetupText({ ...claude, state, detail, version, signingIn });
          expect(line).not.toMatch(/,\s*(·|$)|·\s*·|,\s*,|^\s*·|·\s*$|null|undefined|\s{2}/);
          expect(line.trim()).toBe(line);
          expect(line).not.toBe("");
        }
      }
    }
  }
});
