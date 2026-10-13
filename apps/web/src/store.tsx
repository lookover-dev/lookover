// The UI's copy of the state: a snapshot from the service, kept current by applying its events.
// Every event goes through `apply`, a replaced snapshot included (AGENTS.md rule 3). Beside the copy, what the
// store knows of the service's answers: the last command it refused, kept as the notice until dismissed (the
// band's Refused line and the toast), and whether the session this tab holds is gone (the session screen, #68).
// A refusal never surfaces as an unhandled rejection: the console gets the service's JSON, the person the words.
import {
  apply,
  type Change,
  type Command,
  type Event,
  type LookoverApi,
  type State,
} from "@lookover/contracts";
import { createContext, useContext, useState, useSyncExternalStore } from "react";
import { openOf, Refused } from "./api/http.ts";
import type { WebMode } from "./dev/mode.ts";
import { THEME_KEY } from "./theme-key.ts";
import { type Refusal, refusalOf } from "./view-model/refusal.ts";

/** What the HTTP client adds to `LookoverApi`: it says when the service no longer knows the session. */
export interface SessionAware {
  onSessionLost(listener: (open: string | null) => void): () => void;
}

export interface StoreStatus {
  /**
   * `lost` once the service answered 401: the link this tab was opened with is spent. With it, the command that
   * opens Lookover as the 401 named it (`NoSession.open`, ADR 0058), for the session screen; null when it named
   * none (development, or a body that didn't say).
   */
  session: "open" | { lost: true; open: string | null };
  /** The last refused command, until dismissed. A new object each time, so a repeat is said again. */
  refusal: Refusal | null;
}

/** A command as the console may say it: "Use an existing App" without its key (ADR 0053). */
const withoutKey = (command: Command): Command =>
  command.type === "connection.useApp" ? { ...command, key: "(not shown)" } : command;

export class Store {
  state: State | null = null;
  private status: StoreStatus = { session: "open", refusal: null };
  /** Events that arrived before the first snapshot: applied on it once it comes. */
  private early: Event[] = [];
  private listeners = new Set<() => void>();

  readonly api: LookoverApi;

  constructor(api: LookoverApi & Partial<SessionAware>) {
    this.api = api;
    api.subscribe((event) => {
      if (this.state) this.state = apply(this.state, event);
      else this.early.push(event);
      this.changed();
    });
    api.onSessionLost?.((open) => this.lost(open));
    api.snapshot().then(
      (snapshot) => {
        // Events the snapshot already includes change nothing: `apply` skips them by their number.
        this.state = this.early.reduce(apply, snapshot);
        this.early = [];
        this.changed();
      },
      (error: unknown) => {
        // A 401 is the session screen; anything else keeps the loading eyes, and the console the reason.
        if (error instanceof Refused && error.status === 401) this.lost(openOf(error.answer));
        else console.error("Lookover's snapshot could not be loaded", error);
      },
    );
  }

  /**
   * Sends a command and says whether the service took it; a refusal becomes the notice, never an unhandled
   * rejection.
   */
  send = (command: Command): Promise<boolean> =>
    this.api.send(command).then(
      () => true,
      (error: unknown) => {
        console.error(
          "Lookover refused a command",
          withoutKey(command),
          error instanceof Refused ? error.answer : error,
        );
        this.status = { ...this.status, refusal: refusalOf(error, withoutKey(command)) };
        this.changed();
        return false;
      },
    );

  /** Clears the notice: the × on the band's Refused line. */
  dismiss = (): void => {
    if (!this.status.refusal) return;
    this.status = { ...this.status, refusal: null };
    this.changed();
  };

  private lost(open: string | null): void {
    if (this.status.session !== "open") return;
    this.status = { ...this.status, session: { lost: true, open } };
    this.changed();
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = () => this.state;
  getStatus = () => this.status;
}

/**
 * A command held for the unlock dialog, with what follows it once the service took it (its toast), and what
 * follows it when it is not taken: refused, its unlock refused, or the dialog cancelled (the save stamp goes).
 */
export interface Held {
  command: Command;
  sent?: (() => void) | undefined;
  refused?: (() => void) | undefined;
}

/** Whether a change must ask to unlock first: a server this session reaches from afar and has not unlocked. */
export const isLocked = (state: State | null): boolean =>
  state?.service.remote === true && !state.service.unlocked;

/**
 * Sends a command and runs `sent` once the service took it, or `refused` once it refused it, or, on a server
 * this session has not unlocked, holds all three for the unlock dialog: reading is free, the first change of a
 * session asks to unlock. Returns what it held, if anything. A refusal says nothing more: it is the notice.
 */
export function sendOrHold(
  store: Store,
  command: Command,
  sent?: () => void,
  refused?: () => void,
): Held | null {
  if (isLocked(store.get())) return { command, sent, refused };
  void store.send(command).then((took) => (took ? sent : refused)?.());
  return null;
}

/** The unlock dialog cancelled: nothing is sent, and what waits on an answer (the save stamp) hears no. */
export function cancelHeld(held: Held | null): void {
  held?.refused?.();
}

/**
 * The unlock dialog's answer: unlocks, then sends the held command once the unlock is taken, then runs what
 * follows it once that is taken too. A refusal on the way stops there, and runs what follows a refusal.
 */
export function unlockAndSend(store: Store, held: Held): void {
  void (async () => {
    const took = (await store.send({ type: "service.unlock" })) && (await store.send(held.command));
    (took ? held.sent : held.refused)?.();
  })();
}

export interface AppServices {
  store: Store;
  /**
   * Sends a command; in server mode the first action of a session asks to unlock. `sent` runs once the service
   * took the command, after the unlock if one was asked, never if it was cancelled or refused: a toast saying it
   * was done. `refused` runs when it was refused or the unlock cancelled: the save stamp going.
   */
  send: (command: Command, sent?: () => void, refused?: () => void) => void;
  embedded: boolean;
  /** The build's mode (`dev/mode.ts`): which command the copy names, the program's or the developer's. */
  mode: WebMode;
  openPalette: (mode?: "all" | "review") => void;
  openShortcuts: () => void;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const app = useContext(AppContext);
  if (!app) throw new Error("AppContext is missing");
  return app;
}

export function useStoreState(store: Store): State | null {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useStoreStatus(store: Store): StoreStatus {
  return useSyncExternalStore(store.subscribe, store.getStatus);
}

const StateContext = createContext<State | null>(null);
export const StateProvider = StateContext.Provider;

export function useAppState(): State {
  const state = useContext(StateContext);
  if (!state) throw new Error("State is not loaded");
  return state;
}

export const useSend = () => useApp().send;

export type Theme = "dark" | "light" | "system";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "system" ? t : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme = readTheme()): void {
  const light =
    theme === "light" || (theme === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  if (light) document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}

/** Dark is the default. The choice is a preference of this browser, not a review setting. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return [
    theme,
    (next) => {
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
      setTheme(next);
    },
  ];
}

const repoName = (change: Change) => change.repoId.split("/")[1] ?? change.repoId;
export const reviewPath = (change: Change) => `/reviews/${repoName(change)}/${change.number}`;
