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
  type ConnectionAccount,
  type ConnectionApp,
  type ConnectionId,
  type ConnectionWay,
  changeIdOf,
  changeNameParts,
  connectionId,
  type Engine,
  type EngineHealth,
  type EngineId,
  type EngineState,
  type Event,
  type EventBody,
  engineHealthText,
  engineName,
  type HostLogin,
  type LoginItemKind,
  type Repository,
  type RepositoryId,
  type RepositoryRef,
  type ResolvedSettings,
  type Rule,
  repositoryId,
  repositoryName,
  repositoryRefOf,
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
  /** The way Lookover is on GitHub (ADR 0066); null with neither an App nor a sign-in. */
  way: ConnectionWay | null;
  /** The connection's id once installed (`connectionIdOf` the bot, or the person on `shared`); null with neither. */
  connectionId: ConnectionId | null;
  /** The person signed in to the shared App (ADR 0066); null on `own` and with neither. */
  person: HostLogin | null;
  /** The App's bot, `<slug>[bot]`; null with no App (ADR 0053), and on `shared`. */
  bot: string | null;
  /** The owner's App, never its key; null with none. Shown once the setup says it is made. */
  app: ConnectionApp | null;
  /** Each account reached, with its installation and its own cause (ADR 0066), once listed; none before. */
  accounts: ConnectionAccount[];
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

/**
 * The connection's id, once installed: of the bot on `own`, of the person's login on `shared` (ADR 0066), the bot's
 * `[bot]` keeping the two apart.
 */
export const connectionIdOf = (poster: string) => connectionId(`github:${poster}`);

/** The id the UI knows a repository by. */
export const repoIdOf = (repo: RepositoryRef) => repositoryId(repositoryName(repo));

/** The change's number on the host, which its id ends with (contracts' `changeIdOf`). */
export function numberOf(id: ChangeId): number {
  const parts = changeNameParts(id);
  if (parts === null) throw new Error(`${id} names no change number`);
  return parts.number;
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

/**
 * The changes the UI shows whose author moved from "you" to "other" or back, as the store's facts say it now, sent
 * again (`change.opened` on a change shown keeps what Lookover kept of it): another person signed in to the shared App,
 * or an own App in place of it, works for someone else (ADR 0066), so "is it yours" is asked again, in the events a tab
 * replays too. None when nobody's changed.
 */
export function ownershipMoved(
  shown: State,
  facts: ReadonlyMap<ChangeId, ChangeFacts>,
  at: number,
): EventBody[] {
  const moved: EventBody[] = [];
  for (const [id, { author }] of facts) {
    const change = shown.changes[id];
    if (change !== undefined && change.author !== author)
      moved.push({ type: "change.opened", at, change: { ...change, author } });
  }
  return moved;
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
 * The connection the setup leads to: the bot's, or the person's on `shared`, once it is installed; until then none,
 * with its way, and its name and its App once created (ADR 0053, ADR 0066). No sign-in waits at start.
 */
function connectionOf(f: Facts): State["connection"] {
  const installed = appInstalled(f.setup) && f.connectionId !== null;
  const made = appMade(f.setup);
  return {
    id: installed ? f.connectionId : null,
    state: installed ? "connected" : "not-connected",
    cause: null,
    way: f.way,
    signIn: null,
    person: f.person,
    bot: made ? f.bot : null,
    app: made ? f.app : null,
    accounts: installed ? f.accounts : [],
    unreached: [],
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

/** A change's id as named before ADR 0066, by its repository's name alone (`<name>#<n>`), read; null for another. */
function oldName(id: ChangeId): { repository: string; number: number } | null {
  const parts = changeNameParts(id);
  return parts !== null && !parts.repository.includes("/") ? parts : null;
}

/** Each change id named before ADR 0066 the state holds, with its new one, as `ownerNamed` says. */
function ownerNames(state: State): Map<ChangeId, ChangeId> {
  const owners = new Map<string, string>();
  for (const repo of state.repos) owners.set(repo.name, repo.owner);
  const renamed = new Map<ChangeId, ChangeId>();
  for (const change of Object.values(state.changes)) {
    const repo = repositoryRefOf(change.repoId);
    if (oldName(change.id) && repo !== null) renamed.set(change.id, changeIdOf(repo, change.number));
  }
  for (const { changeId: id } of Object.values(state.reviews)) {
    const old = oldName(id);
    const owner = old && owners.get(old.repository);
    if (old && !renamed.has(id) && owner)
      renamed.set(id, changeIdOf({ owner, name: old.repository }, old.number));
  }
  return renamed;
}

/**
 * The UI's state with every change named `<owner>/<name>#<n>` (ADR 0066), as the store names it once migrated, when
 * the events a data folder kept from before name some `<name>#<n>` (they are history, kept as written); null when
 * none does. A change takes its repository's id; a review whose change is gone, the owner of the watched repository
 * of that name (before ADR 0066 a name had one owner), else it stays as it was: a departed repository's included,
 * as the migration, which names ids from the store's repositories and holds no row of a departed one, leaves it.
 */
function ownerNamed(state: State): State | null {
  const renamed = ownerNames(state);
  if (renamed.size === 0) return null;
  const named = (id: ChangeId) => renamed.get(id) ?? id;
  const changes: State["changes"] = {};
  for (const change of Object.values(state.changes))
    changes[named(change.id)] = { ...change, id: named(change.id) };
  const reviews: State["reviews"] = {};
  for (const review of Object.values(state.reviews)) {
    const turn = review.job?.turn;
    const job =
      review.job === null || turn?.behind !== "engines"
        ? review.job
        : { ...review.job, turn: { ...turn, changes: turn.changes.map(named) } };
    reviews[named(review.changeId)] = { ...review, changeId: named(review.changeId), job };
  }
  const first = state.setup.firstReviewChange;
  const setup = first === null ? state.setup : { ...state.setup, firstReviewChange: named(first) };
  return { ...state, changes, reviews, setup };
}

/**
 * What a start sends when the events kept name changes as before ADR 0066 (`ownerNamed`): the UI's state in the
 * store's ids, as `state.replaced`, so a UI follows it by `apply` like any event (AGENTS.md rule 3); else nothing.
 */
export function ownerNamedLeft(shown: State, at: number): EventBody[] {
  const named = ownerNamed(shown);
  return named === null ? [] : [{ type: "state.replaced", at, state: named }];
}
