// Onboarding for real (ADR 0053): each AI's line in the setup's first step, what the setup's GitHub step shows at
// each of its states, what "Use an existing App" says when it is refused, the App's slug for the agents, and the
// links to GitHub's pages. Every link is built on `Connection.web`, so demo mode stays on the service's fake of
// GitHub and never opens github.com.
import {
  APP_FLOW,
  APP_PERMISSIONS,
  type AppPermission,
  type Change,
  type Connection,
  type CreateAppRefusal,
  createAppRefusalText,
  type Engine,
  type GhWhy,
  GITHUB_WEB,
  ghFixText,
  githubLinks,
  type Repository,
  type RepositoryId,
  type SetupGitHubRefusal,
  type State,
  USE_EXISTING_APP,
  type UseAppRefusal,
  upperFirst,
} from "@lookover/contracts";
import { itOrThem, plural, type WithCommand } from "./format.ts";
import { accountText, engineStateText } from "./health.ts";

/**
 * An AI's line in the setup's first step: ready with its plan and version, signing in, signed out, or not found; one
 * signed in but at its limit or failing the safety check says that state in the status menu's words; one whose
 * program was found but can't be used (too old for its model, only npm's launcher) says why, in the service's words
 * (`Engine.detail`). A part the engine doesn't have (no plan said, no version read) is left out with its separator
 * (#256).
 */
export function engineSetupText(e: Engine): string {
  const program = e.version ? `${e.cli} ${e.version}` : e.cli;
  const signedIn = `${e.detail ? `signed in, ${e.detail}` : "signed in"} · ${program}`;
  if (e.state === "ready") return `Ready · ${signedIn}`;
  if (e.state === "limit" || e.state === "failed-self-test") {
    return `${upperFirst(engineStateText(e))} · ${signedIn}`;
  }
  if (e.state === "missing") return e.detail || `${e.cli} was not found on this computer`;
  if (e.signingIn) return "A terminal is open. Sign in there; this page checks every few seconds.";
  return `Not signed in · ${program} found`;
}

/** The AI step's last row: what it says beside Continue, and Continue's label and whether it is enabled. */
export interface AiStepActs {
  said: string;
  label: string;
  enabled: boolean;
}

/**
 * The AI step's last row (ADR 0058, "Setup's Continue"): the step never moves on by itself, and says it is satisfied
 * beside an enabled Continue. Every AI ready says so; one of several ready names it and offers to go on with it only;
 * none ready, Continue waits for a sign-in.
 */
export function aiStepActs(engines: readonly Engine[]): AiStepActs {
  const ready = engines.filter((e) => e.state === "ready");
  const [first] = ready;
  if (first === undefined) return { said: "", label: SIGN_IN_TO_CONTINUE, enabled: false };
  const all = ready.length === engines.length;
  return {
    said: all && ready.length > 1 ? "Both are ready." : `${first.name} is ready.`,
    label: all ? "Continue" : onlyWith(first),
    enabled: true,
  };
}

const SIGN_IN_TO_CONTINUE = "Sign in to continue";
const onlyWith = (e: Engine) => `Continue with ${e.name} only`;

/** Every label the AI step's Continue can take with these AIs, so it keeps the widest one's width (`SameWidth`). */
export const aiStepLabels = (engines: readonly Engine[]): string[] => [
  "Continue",
  ...engines.map(onlyWith),
  SIGN_IN_TO_CONTINUE,
];

/** A sub-step's state square: done, waiting on GitHub, the one to do now, or not yet. */
type SubStepState = "done" | "busy" | "current" | "later";

/**
 * What a sub-step offers: a page to open in a new tab. `createApp`: the page opens only once the service took the
 * place chosen (`connection.createApp`, ADR 0059), setup then waiting for the App; refused, it doesn't open, and the
 * step says why. The page itself opens the flow. Always a secondary button: the step's one primary is its Continue
 * ("Setup's Continue"), even while it waits for the step.
 */
export interface StepLink {
  label: string;
  href: string;
  createApp: boolean;
}

interface SubStepView {
  state: SubStepState;
  text: string;
  action: StepLink | null;
  /** Every text the sub-step can show, `text` among them: its row is as tall as the tallest, so nothing moves. */
  held: string[];
  /**
   * Every label its action can show, `action`'s among them: the action's place is as wide as the widest, with none
   * shown too (done), so its text wraps the same in every state.
   */
  labels: string[];
}

/** The GitHub step: making the App, then installing it; why the flow stopped short; whether the step can go on. */
export interface GitHubStepView {
  create: SubStepView;
  access: SubStepView;
  refused: string | null;
  done: boolean;
}

const REFUSED: Record<SetupGitHubRefusal, string> = {
  unreachable:
    "GitHub couldn't be reached to finish making the App. Within the hour, reload the tab GitHub sent back to try again.",
  expired: "GitHub's page ran out or was already used. Create it again.",
  refused: "GitHub refused to make the App. Create it again.",
  elsewhere:
    "GitHub made the App on another account than the one you chose. Lookover doesn't use it: you can delete it on GitHub. Create it again.",
};

const AGAIN = "Open GitHub again";

/**
 * Where the App's repositories are chosen ("Add a repository", the setup's "Open GitHub again"): its installation's
 * settings once there is one, else its install page; null before there is an App.
 */
export function addRepositoryLink(connection: Connection): string | null {
  const { app, installationId, web } = connection;
  if (app === null) return null;
  if (installationId !== null) return githubLinks.installation(web, app.account, installationId);
  return githubLinks.install(web, app.slug);
}

/** What a sub-step says before it is done, by the state it is in; its done text is its own. */
const CREATE_TEXT = {
  start: "GitHub may ask for your password, then you confirm.",
  waiting: "GitHub is open in another tab. Confirm there; this page sees it within a few seconds.",
} as const;
const ACCESS_TEXT = {
  later: "On GitHub, right after the App is made.",
  waiting:
    "On GitHub, pick “All repositories” or just the ones you want, then install. This page sees it within a few seconds.",
  // As long as the wait for the install, so the card keeps its two lines (nothing shifts).
  nothing:
    "Installed, with no repository. On GitHub, pick “All repositories” or just the ones you want. Checking every few seconds…",
} as const;

/** Every action label each sub-step can show. */
const CREATE = "Create it on GitHub";
const CREATE_LABELS = [CREATE, AGAIN];
const ACCESS_LABELS = [AGAIN];

/**
 * The view, holding every text the sub-step can show (those before it is done, and the one it shows) and every action
 * label.
 */
const held = (
  texts: Record<string, string>,
  labels: string[],
  view: Omit<SubStepView, "held" | "labels">,
): SubStepView => ({
  ...view,
  held: [...new Set([...Object.values(texts), view.text])],
  labels,
});

function createView(state: State): SubStepView {
  const { github } = state.setup;
  const { app } = state.connection;
  if (github === "start") {
    return held(CREATE_TEXT, CREATE_LABELS, {
      state: "current",
      text: CREATE_TEXT.start,
      action: { label: CREATE, href: APP_FLOW.manifest, createApp: true },
    });
  }
  if (github === "waiting-for-app") {
    // No App is kept yet: GitHub again is the page that posts the manifest, a new flow, for the place chosen now.
    return held(CREATE_TEXT, CREATE_LABELS, {
      state: "busy",
      text: CREATE_TEXT.waiting,
      action: { label: AGAIN, href: APP_FLOW.manifest, createApp: true },
    });
  }
  const made = app?.slug ?? state.connection.bot;
  return held(CREATE_TEXT, CREATE_LABELS, {
    state: "done",
    text: made ? `Done: ${made}` : "Done",
    action: null,
  });
}

function accessView(state: State): SubStepView {
  const { github } = state.setup;
  const { app, web } = state.connection;
  const link = (href: string | null): StepLink | null =>
    href === null ? null : { label: AGAIN, href, createApp: false };
  switch (github) {
    case "start":
    case "waiting-for-app":
      return held(ACCESS_TEXT, ACCESS_LABELS, { state: "later", text: ACCESS_TEXT.later, action: null });
    case "waiting-for-install":
      return held(ACCESS_TEXT, ACCESS_LABELS, {
        state: "busy",
        text: ACCESS_TEXT.waiting,
        action: link(app ? githubLinks.install(web, app.slug) : null),
      });
    case "nothing-granted":
      return held(ACCESS_TEXT, ACCESS_LABELS, {
        state: "current",
        text: ACCESS_TEXT.nothing,
        action: link(addRepositoryLink(state.connection)),
      });
    case "done":
      return held(ACCESS_TEXT, ACCESS_LABELS, {
        state: "done",
        text: `Done: ${plural(state.repos.length, "repository", "repositories")}`,
        action: null,
      });
  }
}

/**
 * The setup's GitHub step at the state the service says it is in (`Setup.github`). `createApp`: "Create it on GitHub"
 * refused by the service, said on the step's one refusal line when the flow itself has nothing to say.
 */
export function githubStep(state: State, createApp: CreateAppRefusal | null = null): GitHubStepView {
  const { github, githubRefused } = state.setup;
  const refused =
    githubRefused !== null
      ? REFUSED[githubRefused]
      : createApp !== null
        ? createAppRefusalText(createApp)
        : null;
  return {
    create: createView(state),
    access: accessView(state),
    refused,
    done: github === "done",
  };
}

/** The GitHub step's words: its sentence, its two sub-steps and its disclosures (glossary: the App, never a bot). */
export const GITHUB_STEP_TEXT = {
  title: "Connect GitHub.",
  lead: "Lookover reviews as your own GitHub App, so its reviews are clearly its own and your agents can wait for them. GitHub makes it for you: confirm with your password, rename it if you like. Its key stays on this computer.",
  create: "Create your App",
  access: "Choose which repositories it can see",
  /** Beside Continue once the step is done: setup waits for the owner (ADR 0058). */
  done: "GitHub is connected.",
  disclosures: [
    {
      summary: "Already using Lookover on another computer?",
      body: `Use the same App here: generate a new key for it on GitHub, then give its id and the key under “${USE_EXISTING_APP}”, below.`,
    },
    {
      summary: USE_EXISTING_APP,
      body: "An App made before, for Lookover or by hand, with Lookover's permissions: on your account, or on an organisation where gh is signed in as a member.",
    },
  ],
} as const;

/** "Use an existing App"'s words, around its two fields. */
export const USE_APP_TEXT = {
  idLabel: "App id",
  idHelp: "On the App's page on GitHub, under “About”.",
  keyLabel: "Private key",
  keyHelp: "Generated on the App's page. Read once, kept encrypted on this computer, never shown.",
  keyPlaceholder: "The .pem file GitHub gave you",
  submit: "Use this App",
} as const;

/**
 * The repositories the setup's repositories step sends as on: each as the owner ticked it here, else as the service
 * has it. The list is the installation's, so one granted on GitHub meanwhile arrives ticked and one removed goes.
 */
export function chosenRepos(
  repos: readonly Repository[],
  choices: ReadonlyMap<RepositoryId, boolean>,
): RepositoryId[] {
  return repos.filter((r) => choices.get(r.id) ?? r.enabled).map((r) => r.id);
}

/** Each permission as GitHub's App settings page names it, with the level Lookover needs (ADR 0022). */
const PERMISSION_NAME: Record<AppPermission, string> = {
  metadata: "Metadata",
  contents: "Contents",
  pull_requests: "Pull requests",
  checks: "Checks",
  issues: "Issues",
};

/** "Contents: read, Pull requests: write and Issues: write" */
function permissionList(missing: AppPermission[]): string {
  const names = missing.map((p) => `${PERMISSION_NAME[p]}: ${APP_PERMISSIONS[p]}`);
  const last = names.pop();
  return names.length === 0 ? (last ?? "") : `${names.join(", ")} and ${last}`;
}

/** Why the person's own `gh` couldn't say whether they are a member of an organisation's App, and what to do. */
const GH_UNANSWERED: Record<GhWhy, string> = {
  offline: "gh couldn't reach GitHub. Try again.",
  sso: "gh isn't authorised for this organisation's single sign-on. Authorise it on GitHub, then try again.",
  scope: "gh can't read your organisations. Run gh auth refresh -s read:org, then try again.",
  timeout: "gh didn't answer in time. Try again.",
  failed: "gh couldn't answer. Try again.",
};

/**
 * Why "Use an existing App" was refused, said under its form (the setup's and Settings' alike). Never the key: the
 * refusal carries none.
 */
export function useAppRefusalText(refusal: UseAppRefusal): string {
  switch (refusal.kind) {
    case "not-a-key":
      return "That file holds no private key. Choose the .pem file GitHub gave you.";
    case "key-refused":
      return "GitHub refused this id and key. Check the App id, and that the key is this App's.";
    case "gh-missing":
      return `An organisation's App needs the GitHub CLI to know you're a member: ${ghFixText("gh-missing")}. Then try again.`;
    case "gh-signed-out":
      return `An organisation's App needs gh signed in to know you're a member: ${ghFixText("gh-signed-out")}. Then try again.`;
    case "gh-unanswered":
      return GH_UNANSWERED[refusal.why];
    case "not-a-member":
      return refusal.invited
        ? `${refusal.person} is invited to ${refusal.organisation} but hasn't joined yet. Accept the invitation on GitHub, then try again.`
        : `gh is signed in as ${refusal.person}, who isn't a member of ${refusal.organisation}. Sign gh in as a member, or ask an admin of ${refusal.organisation} to add you.`;
    case "another-person":
      return `Lookover keeps this App for ${refusal.kept}, and gh is signed in as ${refusal.person}. Sign gh in as ${refusal.kept}, then try again.`;
    case "missing-permissions":
      return `This App lacks ${permissionList(refusal.missing)}. Give ${itOrThem(refusal.missing.length)} on GitHub, then try again.`;
    case "another-app":
      return "Lookover already keeps another App here. Give that App's id, with a new key of its own.";
    case "unreachable":
      return "GitHub couldn't be reached. Try again.";
    case "live-config":
      return "live.json names this App: live runs don't change it.";
  }
}

/** Settings › GitHub's line for an agent on another computer, under the one sentence saying what it is for. */
export interface AgentAppLine {
  sentence: WithCommand;
  line: string;
}

const AGENT_APP_SENTENCE: WithCommand = {
  before: "On another computer, put this line in your coding agent's environment so its",
  command: "lookover wait",
  after: "finds this App:",
};

/**
 * The App's slug as `lookover wait` takes it on another computer (on this one it reads the data folder's App, ADR
 * 0058); null before there is an App.
 */
export function agentApp(connection: Connection): AgentAppLine | null {
  return connection.app
    ? { sentence: AGENT_APP_SENTENCE, line: `LOOKOVER_APP=${connection.app.slug}` }
    : null;
}

/**
 * Settings' GitHub line: the App, the account it is on, and the person whose pull requests it reviews (ADR 0059),
 * who is the account itself on a personal account.
 */
export function appText(connection: Connection): string {
  const { app } = connection;
  if (app === null) return "No App yet.";
  const you = app.account.id === app.person.id ? "you" : `you (${app.person.login})`;
  return `${app.slug}, on ${accountText(app)}. Pull requests opened by ${you} or your agents are reviewed.`;
}

/** Repositories' foot: the bot Lookover acts as, and the account the App is on (ADR 0059). */
export function repositoriesFoot(connection: Connection): string {
  const { app, bot } = connection;
  return `Connected to GitHub as ${bot ?? "nobody"}${app ? `, on ${accountText(app)}` : ""}.`;
}

/**
 * A repository the installation stopped listing (ADR 0059), as Repositories says it until it is back or dismissed:
 * labelled "Left" (nothing waits on the person: the status says all good), after its name, that it is no longer
 * reviewed and where it may have gone; and "Add it back", the installation's settings (null with no App kept).
 */
export function departedNotice(connection: Connection): {
  label: string;
  text: string;
  addBack: string | null;
} {
  return {
    label: "Left",
    text: "left the App's installation and is no longer reviewed: moved, deleted, or taken off its access.",
    addBack: addRepositoryLink(connection),
  };
}

/** Above "Use an existing App" in Settings: how a refused or lost key is replaced (ADR 0053). */
export const NEW_KEY_TEXT =
  "For a new key, generate one on the App's page on GitHub, then give it here with the App's id. Lookover keeps one App: another App's id is refused.";

/**
 * "Open on GitHub": the real pull request in live mode, a page in a new tab; in demo mode the app's own simulated
 * GitHub page, which tells the story GitHub would.
 */
export function pullRequestLink(
  connection: Connection,
  change: Pick<Change, "repoId" | "number">,
): { href: string } | { path: string } {
  const [owner = "", name = ""] = change.repoId.split("/");
  if (connection.web === GITHUB_WEB)
    return { href: githubLinks.pullRequest(GITHUB_WEB, { owner, name }, change.number) };
  return { path: `/github/${name}/${change.number}` };
}
