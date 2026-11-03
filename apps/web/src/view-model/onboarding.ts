// Onboarding for real (ADR 0053): each AI's line in the setup's first step, the repositories the setup's repositories
// step sends, and the links to GitHub's pages. Setup's GitHub step is Sign in with GitHub, the one way in
// (`sign-in.ts`, ADR 0073). Every link is built on `Connection.web`, so demo mode stays on the service's fake of
// GitHub and never opens github.com.
import {
  type Change,
  type Connection,
  type DepartedRepository,
  type Engine,
  GITHUB_WEB,
  githubLinks,
  type Repository,
  type RepositoryId,
  repositoryRefOf,
  upperFirst,
} from "@lookover/contracts";
import { sharedRepositoriesLink, signedIn } from "./accounts.ts";
import { connectionText, engineStateText } from "./health.ts";

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

/**
 * What comes after the install, on its own line under a missing AI's row in setup (#431): the service's line says how
 * to install it and to check again, as the alert band and the status menu say it; only the setup row adds the sign-in
 * that follows. Null when its program was found (too old, only npm's launcher: its line says what to do) or there is
 * nothing to install.
 */
export function engineSetupNext(e: Engine): string | null {
  return e.state === "missing" && e.version === null && e.unusable === null
    ? "Once it's found, sign in here if it asks."
    : null;
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

/**
 * Where the App's repositories are chosen ("Add a repository", ADR 0067): `sharedRepositoriesLink`'s; null while
 * nobody is signed in.
 */
export function addRepositoryLink(connection: Connection): string | null {
  return signedIn(connection) ? sharedRepositoriesLink(connection) : null;
}

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

/**
 * Repositories' foot (ADR 0066): the person who posts and every account reached, in GitHub's order, while GitHub takes
 * the sign-in; else what the status menu says of it; nobody signed in, not connected.
 */
export function repositoriesFoot(connection: Connection): string {
  const { person, accounts } = connection;
  if (connection.state === "not-connected" || person === null) return "Not connected to GitHub.";
  if (connection.state !== "connected") return `Not connected to GitHub: ${connectionText(connection)}.`;
  const logins = accounts.map((a) => a.account.login);
  const last = logins.pop();
  const on =
    last === undefined ? "" : `, on ${logins.length > 0 ? `${logins.join(", ")} and ${last}` : last}`;
  return `Signed in to GitHub as ${person.login}${on}.`;
}

/**
 * A repository the installation stopped listing (ADR 0059), as Repositories says it until it is back or dismissed:
 * labelled "Left" (nothing waits on the person: the status says all good), after its name, that it is no longer
 * reviewed and where it may have gone; and "Add it back" (ADR 0067): its account's installation settings when the
 * person owns it and it is installed, else GitHub's install page.
 */
export function departedNotice(
  connection: Connection,
  repo: Pick<DepartedRepository, "owner">,
): {
  label: string;
  text: string;
  addBack: string;
} {
  return {
    label: "Left",
    text: "left the App's installation and is no longer reviewed: moved, deleted, or taken off its access.",
    addBack: sharedRepositoriesLink(connection, repo.owner),
  };
}

/**
 * "Open on GitHub": the real pull request in live mode, a page in a new tab; in demo mode the app's own simulated
 * GitHub page, which tells the story GitHub would.
 */
export function pullRequestLink(
  connection: Connection,
  change: Pick<Change, "repoId" | "number">,
): { href: string } | { path: string } {
  const repo = repositoryRefOf(change.repoId) ?? { owner: "", name: "" };
  if (connection.web === GITHUB_WEB)
    return { href: githubLinks.pullRequest(GITHUB_WEB, repo, change.number) };
  return { path: `/github/${repo.owner}/${repo.name}/${change.number}` };
}
