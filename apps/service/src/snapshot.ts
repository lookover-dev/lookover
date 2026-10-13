// The snapshot the UI shows: the facts at start (the setup as the store keeps it and the connection it leads to,
// running, the engines' health taken at start) with the events kept in the store applied on top with `apply`,
// exactly as the UI applies them (all of them once at start, then each as the service sends it), so a tab that
// followed the events and one that loaded the snapshot see the same thing (AGENTS.md rule 3). Also the facts the
// service turns the host's into: the UI's `Repository` and `Change`, and what the queue and the run read of an open
// change and a repository's settings.
import {
  apply,
  type Change,
  type ChangeId,
  type CodingAgent,
  type ConnectionApp,
  changeId,
  connectionId,
  type Engine,
  type EngineHealth,
  type EngineId,
  type EngineState,
  type Event,
  engineHealthText,
  engineName,
  type LoginItemKind,
  type Repository,
  type RepositoryId,
  type RepositoryRef,
  type ResolvedSettings,
  type Rule,
  repositoryId,
  repositoryName,
  type SettingValues,
  type Setup,
  type State,
} from "@lookover/contracts";
import { resolve, settingValues } from "@lookover/settings";
import type { InboxEntry, OpenChange, Store } from "@lookover/store";

export interface Facts {
  now: number;
  /** When this service started: the connection, the engines and the service have been as they are since. */
  startedAt: number;
  version: string;
  /** Lookover's command (ADR 0058), as this start reads it. */
  command: string;
  /** Your coding agent (ADR 0058), as the machine said it at start. */
  agent: CodingAgent;
  /** The App's bot, `<slug>[bot]`; null with no App (ADR 0053). */
  bot: string | null;
  /** The owner's App, never its key; null with none. Shown once the setup says it is made. */
  app: ConnectionApp | null;
  /** The App's installation on the owner's account, once listed; null before. */
  installationId: number | null;
  /** GitHub's web address the app's links are built on (ADR 0053): GitHub's own in live mode, its fake in demo mode. */
  web: string;
  /** Each engine's health at start, and the state it shows: its health's, once its self-test had its say. */
  engines: Record<EngineId, { health: EngineHealth; state: EngineState }>;
  /** The first-run setup as the store keeps it (ADR 0047). */
  setup: Setup;
  /** Whether the owner chose to start Lookover at login, as the store keeps it beside the setup (ADR 0049). */
  startAtLogin: boolean;
  /** Whether the machine says Lookover is registered to start at login, as read at start (ADR 0054). */
  startsAtLogin: boolean;
  /** Where that registration is: the machine's, or development's in memory (ADR 0054). */
  loginItem: LoginItemKind;
  /**
   * Whether the UI reaches this service from another device, so a session starts view-only until unlocked. Only a
   * demo scenario's world says so (S11): no service is reached from elsewhere until a server mode exists.
   */
  remote?: boolean;
}

/** A data folder set up: what live mode starts with until onboarding (row 7) walks the owner through it. */
export const SET_UP: Setup = {
  done: true,
  step: "background",
  reached: "background",
  github: "done",
  githubRefused: null,
  firstReviewChange: null,
};

/** A data folder no one set up: its first step, nothing done (ADR 0053's live mode with no App named). */
export const NEW_OWNER: Setup = {
  done: false,
  step: "ai",
  reached: "ai",
  github: "start",
  githubRefused: null,
  firstReviewChange: null,
};

/**
 * Whether the App is on GitHub, as the setup says (ADR 0047, ADR 0053): installed, with repositories or none.
 * Until then there is no connection, and nothing to list.
 */
export const appInstalled = (setup: Setup): boolean =>
  setup.github === "done" || setup.github === "nothing-granted";

/** Whether the App is made, as the setup says: given or created, installed or not yet. */
export const appMade = (setup: Setup): boolean =>
  setup.github !== "start" && setup.github !== "waiting-for-app";

/** The connection's id, once the bot is installed. */
export const connectionIdOf = (bot: string) => connectionId(`github:${bot}`);

/** The id the UI knows a repository by. */
export const repoIdOf = (repo: RepositoryRef) => repositoryId(repositoryName(repo));
export const changeIdOf = (repo: RepositoryRef, number: number): ChangeId =>
  changeId(`${changePrefixOf(repo)}${number}`);

/** What every id of the repository's changes starts with (`changeIdOf`). */
export const changePrefixOf = (repo: RepositoryRef): string => `${repo.name}#`;

/** The change's number on the host, which its id ends with (`changeIdOf`). */
export function numberOf(id: ChangeId): number {
  const number = Number(id.slice(id.lastIndexOf("#") + 1));
  if (!Number.isInteger(number) || number < 1) throw new Error(`${id} names no change number`);
  return number;
}

/**
 * The watched repository: its switch (`enabled`, as the store keeps it, ADR 0047), and its settings, as its files
 * resolve them (ADR 0049).
 */
export function repositoryOf(repo: RepositoryRef, enabled: boolean, settings: ResolvedSettings): Repository {
  return { id: repoIdOf(repo), owner: repo.owner, name: repo.name, enabled, settings };
}

/** The owner's changes are "you" (ADR 0016); the host gives no other identity than the author's. */
export function changeOf(
  { repo, change, writtenBy, firstSeenAt }: InboxEntry,
  owner: { id: number },
): Change {
  return {
    id: changeIdOf(repo, change.number),
    repoId: repoIdOf(repo),
    number: change.number,
    title: change.title,
    openedBy: change.author.login,
    author: change.author.id === owner.id ? "you" : "other",
    writtenBy,
    headSha: change.head.sha,
    openedAt: firstSeenAt,
    draft: change.draft,
    fork: change.fork,
    newCommits: 0,
  };
}

/** The engine's state as the UI shows it, from its health. The skeleton never sees a plan limit here. */
export function engineStateOf(health: EngineHealth): EngineState {
  return !health.installed ? "missing" : health.signedIn ? "ready" : "signed-out";
}

/** The engine's detail as the status menu says it, from its health: why it can't be used, or nothing. */
export function engineDetailOf(id: EngineId, health: EngineHealth): string {
  return health.why === undefined ? "" : engineHealthText(health.why, id);
}

/** What the queue and the run read of an open change: the inbox's, never the UI's state (#64). */
export type ChangeFacts = Pick<
  Change,
  "repoId" | "number" | "headSha" | "writtenBy" | "author" | "draft" | "fork"
>;

/**
 * The open changes as the inbox keeps them, by id. The owner's are "you" (ADR 0016); who wrote each, as the poll
 * read it from the host (ADR 0044).
 */
export function changeFactsOf(open: OpenChange[], owner: { id: number }): Map<ChangeId, ChangeFacts> {
  return new Map(
    open.map((c) => [
      changeIdOf(c.repo, c.number),
      {
        repoId: repoIdOf(c.repo),
        number: c.number,
        headSha: c.head,
        writtenBy: c.writtenBy,
        author: c.authorId === owner.id ? "you" : "other",
        draft: c.draft,
        fork: c.fork,
      },
    ]),
  );
}

/** The settings in force for a repository (its files read over the defaults), and whether it is reviewed at all. */
export interface SettingsInForce {
  enabled: boolean;
  values: SettingValues;
}

/**
 * A repository's rules as the service gives them (ADR 0048): the store's, each on unless the repository's settings
 * file switches it off (`switchedOff`, ADR 0049), and off with any rule it is nested in that is (`parentOff`), its
 * own switch kept. What the UI shows and what a round's passes and reconcile read.
 */
export function rulesOf(
  store: Pick<Store, "rules">,
  repoId: RepositoryId,
  switchedOff: (rule: Pick<Rule, "source" | "text">) => boolean,
): Rule[] {
  const kept = store.rules.of(repoId);
  const off = new Set(kept.filter((rule) => switchedOff(rule)).map((rule) => rule.id));
  return kept.map(({ parentIds, ...rule }) => ({
    ...rule,
    enabled: !off.has(rule.id),
    parentOff: parentIds.some((id) => off.has(id)),
    nested: kept.filter((other) => other.parentIds.includes(rule.id)).length,
  }));
}

/** The settings in force for `repo`: as its settings files said them last (ADR 0049). */
export function settingsOf(repo: Repository): SettingsInForce {
  return { enabled: repo.enabled, values: settingValues(repo.settings) };
}

function engineOf(id: EngineId, { health, state }: Facts["engines"][EngineId], since: number): Engine {
  return {
    id,
    name: engineName(id),
    cli: id,
    version: health.version,
    state,
    detail: engineDetailOf(id, health),
    unusable: health.why ?? null,
    since,
    limitUntil: null,
    signingIn: false,
  };
}

/**
 * The connection the setup leads to: the bot's once it is installed; until then none, with its name and its App once
 * created (ADR 0053).
 */
function connectionOf(f: Facts): State["connection"] {
  const installed = appInstalled(f.setup) && f.bot !== null;
  const made = appMade(f.setup);
  return {
    id: installed && f.bot !== null ? connectionIdOf(f.bot) : null,
    state: installed ? "connected" : "not-connected",
    cause: null,
    bot: made ? f.bot : null,
    app: made ? f.app : null,
    installationId: installed ? f.installationId : null,
    web: f.web,
    since: f.startedAt,
    limitUntil: null,
    gh: null,
  };
}

/** The state before any event: the setup as kept, the connection it leads to, and nothing the host said yet. */
function base(f: Facts): State {
  return {
    seq: 0,
    now: f.now,
    setup: f.setup,
    engines: {
      claude: engineOf("claude", f.engines.claude, f.startedAt),
      codex: engineOf("codex", f.engines.codex, f.startedAt),
    },
    connection: connectionOf(f),
    service: {
      state: "running",
      since: f.startedAt,
      version: f.version,
      command: f.command,
      agent: f.agent,
      startAtLogin: f.startAtLogin,
      startsAtLogin: f.startsAtLogin,
      loginItem: f.loginItem,
      paused: null,
      remote: f.remote ?? false,
      unlocked: false,
      checks: null,
    },
    settings: resolve([]),
    repos: [],
    departed: [],
    rules: [],
    changes: {},
    reviews: {},
  };
}

/** The snapshot: the base with every event applied, current up to the last one. */
export function snapshotOf(f: Facts, events: Event[]): State {
  return events.reduce(apply, base(f));
}
