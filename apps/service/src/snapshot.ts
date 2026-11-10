// The snapshot the UI shows: the facts at start (the setup as the store keeps it and the connection it leads to,
// running, the engines' health taken at start) with the events kept in the store applied on top with `apply`,
// exactly as the UI applies them (all of them once at start, then each as the service sends it), so a tab that
// followed the events and one that loaded the snapshot see the same thing (AGENTS.md rule 3). The replay is read, not
// trusted (ADR 0085): an event `apply` throws on is skipped, what the state's schema can't read is dropped, and the
// start states its own facts over the rest (`startOf`). Also the facts the service turns the host's into: the UI's
// `Repository` and `Change`, and what the queue and the run read of an open change and a repository's settings.
import { isDeepStrictEqual } from "node:util";
import {
  apply,
  type Change,
  type ChangeId,
  type CodingAgent,
  type ConnectionAccount,
  type ConnectionCause,
  type ConnectionId,
  changeIdOf,
  changeNameParts,
  connectionId,
  type Dropped,
  type Engine,
  type EngineHealth,
  type EngineId,
  type EngineState,
  type Event,
  type EventBody,
  engineDetailText,
  engineName,
  type HostLogin,
  type LoginHolder,
  type LoginItemKind,
  type Repository,
  type RepositoryId,
  type RepositoryRef,
  type ResolvedSettings,
  type Rule,
  readState,
  repositoryId,
  repositoryName,
  repositoryRefOf,
  type Service,
  type SettingValues,
  type Setup,
  type State,
  UnknownEvent,
} from "@lookover/contracts";
import { resolve, settingValues } from "@lookover/settings";
import type { InboxEntry, OpenChange, Store } from "@lookover/store";
import type { Skipped } from "./log-lines.ts";
import { said } from "./said.ts";

export interface Facts {
  now: number;
  /** When this service started: the connection, the engines and the service have been as they are since. */
  startedAt: number;
  version: string;
  /** Lookover's command (ADR 0058), as this start reads it. */
  command: string;
  /** Your coding agent (ADR 0058), as the machine said it at start. */
  agent: CodingAgent;
  /** The connection's id once installed (`connectionIdOf` the person); null before a sign-in. */
  connectionId: ConnectionId | null;
  /** The person signed in to the shared App (ADR 0066); null before a sign-in. */
  person: HostLogin | null;
  /** Each account reached, with its installation and its own cause (ADR 0066), once listed; none before. */
  accounts: ConnectionAccount[];
  /**
   * Whether the start's listing of the installations answered under the sign-in held at start (ADR 0086): false when
   * it wasn't asked or was refused.
   */
  listed: boolean;
  /** What refused the start's listing, when it was asked and refused (`Connection.listingCause`); else null. */
  listingCause: ConnectionCause | null;
  /** GitHub's web address the app's links are built on (ADR 0053): GitHub's own in live mode, its fake in demo mode. */
  web: string;
  /** Each engine's health at start, and the state it shows: its health's, once its self-test had its say. */
  engines: Record<EngineId, { health: EngineHealth; state: EngineState }>;
  /** The first-run setup as the store keeps it (ADR 0047). */
  setup: Setup;
  /** Whether the owner chose to start Lookover at login, as the store keeps it beside the setup (ADR 0049). */
  startAtLogin: boolean;
  /** Who the machine says holds start at login, as read at start (ADR 0054, ADR 0068). */
  atLogin: LoginHolder;
  /** Where that registration is: the machine's, or development's in memory (ADR 0054). */
  loginItem: LoginItemKind;
  /** The machine the commands the app gives are for (an AI's install, ADR 0070), as Node names it. */
  platform: NodeJS.Platform;
  /** The pause the store keeps (ADR 0040): until when reviews hold; null when none is set. */
  paused: Service["paused"];
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
  firstReviewChange: null,
};

/** A data folder no one set up: its first step, nothing done (ADR 0053's program on a fresh data folder). */
export const NEW_OWNER: Setup = {
  done: false,
  step: "ai",
  reached: "ai",
  github: "start",
  firstReviewChange: null,
};

/**
 * Whether the shared App is installed, as the setup says (ADR 0047, ADR 0053): with repositories or none. Until then
 * there is no connection, and nothing to list.
 */
export const appInstalled = (setup: Setup): boolean =>
  setup.github === "done" || setup.github === "nothing-granted";

/** Whether the setup's GitHub step is past its sign-in, as the setup says: installed or not yet (ADR 0073). */
export const signedInAtSetup = (setup: Setup): boolean => setup.github !== "start";

/** The connection's id, once installed: of the person's login (ADR 0066). */
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
export function changeOf({ repo, change, writtenBy }: InboxEntry, owner: { id: number }): Change {
  return {
    id: changeIdOf(repo, change.number),
    repoId: repoIdOf(repo),
    number: change.number,
    title: change.title,
    openedBy: change.author.login,
    author: change.author.id === owner.id ? "you" : "other",
    writtenBy,
    headSha: change.head.sha,
    openedAt: change.openedAt,
    draft: change.draft,
    fork: change.fork,
    newCommits: 0,
  };
}

/** The engine's state as the UI shows it, from its health. The skeleton never sees a plan limit here. */
export function engineStateOf(health: EngineHealth): EngineState {
  return !health.installed ? "missing" : health.signedIn ? "ready" : "signed-out";
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
 * again (`change.opened` on a change shown keeps what Lookover kept of it): another person signed in to the shared App
 * works for someone else (ADR 0066), so "is it yours" is asked again, in the events a tab replays too. None when nobody's changed.
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
    nestedIn: parentIds.length > 0,
    nested: kept.filter((other) => other.parentIds.includes(rule.id)).length,
  }));
}

/** The settings in force for `repo`: as its settings files said them last (ADR 0049). */
export function settingsOf(repo: Repository): SettingsInForce {
  return { enabled: repo.enabled, values: settingValues(repo.settings) };
}

function engineOf(
  id: EngineId,
  { health, state }: Facts["engines"][EngineId],
  since: number,
  platform: NodeJS.Platform,
): Engine {
  return {
    id,
    name: engineName(id),
    cli: id,
    version: health.version,
    state,
    detail: engineDetailText(id, health, platform),
    unusable: health.why ?? null,
    since,
    limitUntil: null,
    signingIn: false,
  };
}

/**
 * The connection the setup leads to: the person's, once the shared App is installed; until then none, with who is
 * signed in (ADR 0053, ADR 0066). No sign-in waits at start.
 */
function connectionOf(f: Facts): State["connection"] {
  const installed = appInstalled(f.setup) && f.connectionId !== null;
  return {
    id: installed ? f.connectionId : null,
    state: installed ? "connected" : "not-connected",
    cause: null,
    signIn: null,
    person: f.person,
    accounts: installed ? f.accounts : [],
    listed: f.listed,
    listingCause: f.listingCause,
    unreached: [],
    web: f.web,
    since: f.startedAt,
    limitUntil: null,
  };
}

/** The state before any event: the setup as kept, the connection it leads to, and nothing the host said yet. */
function base(f: Facts): State {
  return {
    seq: 0,
    now: f.now,
    setup: f.setup,
    engines: {
      claude: engineOf("claude", f.engines.claude, f.startedAt, f.platform),
      codex: engineOf("codex", f.engines.codex, f.startedAt, f.platform),
    },
    connection: connectionOf(f),
    service: {
      state: "running",
      since: f.startedAt,
      version: f.version,
      command: f.command,
      agent: f.agent,
      startAtLogin: f.startAtLogin,
      atLogin: f.atLogin,
      loginItem: f.loginItem,
      paused: f.paused,
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

/**
 * The snapshot: the base with every event applied, current up to the last one, and each event skipped because
 * `apply` threw on it (one an older version wrote, or of a type a newer one wrote, ADR 0085), in order: the state
 * stays the last one applied.
 */
function snapshotOf(f: Facts, events: Event[]): { state: State; skipped: Skipped[] } {
  const skipped: Skipped[] = [];
  let state = base(f);
  for (const event of events) {
    try {
      state = apply(state, event);
    } catch (error) {
      const why: Skipped["why"] =
        error instanceof UnknownEvent ? { kind: "unknown" } : { kind: "threw", message: said(error) };
      skipped.push({ seq: event.seq, type: String(event.type), why });
    }
  }
  return { state, skipped };
}

/** What a start serves (ADR 0085): the state it sends first, that first event, and what it dropped and skipped. */
export interface Started {
  /** The UI's state as this start states it: what it read of the replay, its own facts on it, renamed (ADR 0066). */
  state: State;
  /**
   * The start's first event: the state as one `state.replaced` when it differs from the replay (a piece dropped, an
   * id renamed), else the service's own facts as `service.changed`.
   */
  first: EventBody;
  dropped: Dropped[];
  skipped: Skipped[];
  /**
   * Where the state read first differs from the replay when nothing was dropped (a key the schema strips that a
   * replayed object carried beyond its type), its fields joined by dots; null when they agree or a drop explains it.
   * The state read is still the one sent and served.
   */
  differs: string | null;
}

/**
 * The start's state (ADR 0085): the log replayed, read through the state's schema against the base (what can't be
 * read is dropped; a section that can't, the start's own), the service's own facts set on it, and the ids named
 * before ADR 0066 renamed. The start at login and who holds it stay as replayed: `startAtLoginLeft` and
 * `atLoginLeft` compare them with the store and the machine.
 */
export function startOf(f: Facts, events: Event[]): Started {
  const own = base(f);
  const { state: replayed, skipped } = snapshotOf(f, events);
  const { state: read, dropped } = readState(replayed, own);
  const stated = withOwnFacts(read, f);
  const state = ownerNamed(stated) ?? stated;
  const asReplayed = withOwnFacts(replayed, f);
  const first: EventBody = isDeepStrictEqual(state, asReplayed)
    ? { type: "service.changed", at: f.startedAt, patch: ownFactsOf(f) }
    : { type: "state.replaced", at: f.startedAt, state };
  const differs = dropped.length === 0 ? firstDifference(asReplayed, stated) : null;
  return { state, first, dropped, skipped, differs };
}

/** The first path, fields joined by dots, where `a` and `b` differ; null when they are deeply equal. */
function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (isDeepStrictEqual(a, b)) return null;
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return path;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const at = path === "" ? key : `${path}.${key}`;
    if (!(key in a) || !(key in b)) return at;
    const inner = firstDifference(a[key], b[key], at);
    if (inner !== null) return inner;
  }
  return path;
}

/** An object or a list: the walk steps into a list by its indexes, so this isn't `readState`'s record test. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The service's facts a start states over whatever the log replayed: running since now, this version, its command,
 * its agent, its login item, the pause the store keeps, no check results (they read the process that ran them) and
 * locked; remote only when the start was told.
 */
function ownFactsOf(f: Facts): Partial<Service> {
  return {
    state: "running",
    since: f.startedAt,
    version: f.version,
    command: f.command,
    agent: f.agent,
    loginItem: f.loginItem,
    ...(f.remote === undefined ? {} : { remote: f.remote }),
    paused: f.paused,
    unlocked: false,
    checks: null,
  };
}

/** `state` with the start's own facts on its service, at the start's time at least. */
const withOwnFacts = (state: State, f: Facts): State => ({
  ...state,
  now: Math.max(state.now, f.now),
  service: { ...state.service, ...ownFactsOf(f) },
});

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
 * Each watched repository the store has listed and the state lacks (`watched`, as the UI is told of it), sent again
 * (ADR 0085): what an older version wrote of it was dropped at start.
 */
export function reposLeft(shown: State, watched: Repository[], at: number): EventBody[] {
  const known = new Set(shown.repos.map((repo) => repo.id));
  return watched
    .filter((repo) => !known.has(repo.id))
    .map((repo): EventBody => ({ type: "repo.added", at, repo }));
}

/**
 * Each open change a listing holds and the state lacks, sent again (ADR 0085): what an older version wrote of it was
 * dropped at start, and the store, which keeps no title, has only the listing to send it from.
 */
export function changesLeft(
  shown: Pick<State, "changes">,
  listed: InboxEntry[],
  owner: { id: number },
  at: number,
): EventBody[] {
  return listed
    .map((entry) => changeOf(entry, owner))
    .filter((change) => shown.changes[change.id] === undefined)
    .map((change): EventBody => ({ type: "change.opened", at, change }));
}
