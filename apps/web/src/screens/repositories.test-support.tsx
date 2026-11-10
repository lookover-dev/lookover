// What the Repositories screen's tests share: a world signed in with sasensi and fernhill reached, a store on a
// service that never answers, the screen rendered to markup on them, and the elements of a tree, to read a control's
// wiring there being no page to click in here.
import {
  type Change,
  type Command,
  type ConnectionAccount,
  changeId,
  commitSha,
  connectionId,
  GITHUB_WEB,
  type LookoverApi,
  type Repository,
  type ResolvedSettings,
  repositoryId,
  type State,
} from "@lookover/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AppContext, StateProvider, Store } from "../store.tsx";
import { PresenceList } from "../ui/presence.tsx";
import { Repositories } from "./settings.tsx";

const NOW = Date.UTC(2026, 10, 7, 10, 0, 0);

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

/** Pull request `n` open on `repo` ("fernhill/api"), opened by sasensi. */
export const change = (repo: string, n: number): Change => ({
  id: changeId(`${repo}#${n}`),
  repoId: repositoryId(repo),
  number: n,
  title: `Change ${n}`,
  openedBy: "sasensi",
  author: "you",
  writtenBy: null,
  headSha: commitSha("a1f9c2e"),
  openedAt: NOW,
  draft: false,
  fork: false,
  newCommits: 0,
});

export const repo = (owner: string, name: string, enabled = true): Repository => ({
  id: repositoryId(`${owner}/${name}`),
  owner,
  name,
  enabled,
  settings: DEFAULTS,
});

const account = (id: number, login: string, type: "User" | "Organization"): ConnectionAccount => ({
  account: { id, login, type },
  installationId: id + 10,
  cause: null,
  owner: true,
});

/** sasensi signed in, its own account and fernhill reached; by default fernhill's web is off, so fernhill is mixed. */
export function world(
  repos: Repository[] = [
    repo("sasensi", "ledger-api"),
    repo("sasensi", "dotfiles"),
    repo("fernhill", "api"),
    repo("fernhill", "web", false),
    repo("fernhill", "cli"),
  ],
): State {
  const engine = {
    cli: "",
    version: null,
    state: "ready" as const,
    detail: "",
    unusable: null,
    since: NOW,
    limitUntil: null,
    signingIn: false,
  };
  return {
    seq: 0,
    now: NOW,
    setup: { done: true, step: "background", reached: "background", github: "done", firstReviewChange: null },
    engines: {
      claude: { ...engine, id: "claude", name: "Claude" },
      codex: { ...engine, id: "codex", name: "Codex" },
    },
    connection: {
      id: connectionId("github:sasensi"),
      state: "connected",
      cause: null,
      signIn: null,
      person: { id: 1, login: "sasensi" },
      accounts: [account(1, "sasensi", "User"), account(2, "fernhill", "Organization")],
      listed: true,
      listingCause: null,
      unreached: [],
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
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

/**
 * Every element in a tree of elements, its components left unrendered but for the presence's list, whose items it
 * hands out as present (each item's elements are its render's).
 */
export function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (isValidElement<Parameters<typeof PresenceList<unknown>>[0]>(node) && node.type === PresenceList) {
    const { items, children } = node.props;
    const present = { leaving: false, mark: { ref: () => undefined } };
    return [node, ...items.flatMap((item) => elements(children(item, present)))];
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node, ...elements(node.props.children)];
}

/** A store on a service that never answers: what holds the app's memory while it is open. */
export function app(): Store {
  const api: LookoverApi = {
    snapshot: () => new Promise(() => undefined),
    subscribe: () => () => undefined,
    send: () => Promise.resolve(),
    logs: () => Promise.resolve([]),
    subscribeLogs: () => () => undefined,
  };
  return new Store(api);
}

/** What a screen renders in: the app on `store`, `state`, its commands to `send`. */
export function Providers({
  store,
  state,
  send = () => undefined,
  children,
}: {
  store: Store;
  state: State;
  send?: (command: Command) => void;
  children: ReactNode;
}) {
  return (
    <MemoryRouter>
      <AppContext.Provider
        value={{
          store,
          send,
          embedded: false,
          mode: "program",
          openPalette: () => undefined,
          openShortcuts: () => undefined,
        }}
      >
        <StateProvider value={state}>{children}</StateProvider>
      </AppContext.Provider>
    </MemoryRouter>
  );
}

/** The Repositories screen as it renders on `store`, `inside` it if given, its commands to `send`. */
export const screen = (
  store: Store,
  state = world(),
  Inside: () => ReactNode = Repositories,
  send: (command: Command) => void = () => undefined,
) => renderToStaticMarkup(screenOf(store, state, Inside, send));

/** The same screen as an element, for a test that renders it in a DOM and renders it again as the state moves. */
export const screenOf = (
  store: Store,
  state = world(),
  Inside: () => ReactNode = Repositories,
  send: (command: Command) => void = () => undefined,
): ReactElement => (
  <Providers store={store} state={state} send={send}>
    <Inside />
  </Providers>
);

/**
 * A group's rows on a page, by name (each row's `b`): `~` leaving, `+` come in by the fold (ADR 0087). A leaving row
 * is inert and hidden, and only a leaving one: else this throws.
 */
export const foldNames = (rows: readonly HTMLElement[]): string[] =>
  rows.map((row) => {
    const leaving = row.classList.contains("leaving");
    if (leaving !== row.hasAttribute("inert") || leaving !== (row.getAttribute("aria-hidden") === "true")) {
      throw new Error("a leaving row is inert and hidden, and only a leaving one");
    }
    const name = row.querySelector("b")?.textContent;
    return `${name}${leaving ? "~" : ""}${row.hasAttribute("data-unfolded") ? "+" : ""}`;
  });
