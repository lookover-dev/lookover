// "Sign in" (ADR 0047): Lookover opens the vendor's own login and only watches. The opener is a port (`SignInOpener`):
// in live mode the login in a visible terminal (`@lookover/process/terminal` on `engines`' `signInCommand`, wired
// by `live.ts`), in demo mode the scripted engine's own sign-in, which flips its health a few seconds on. Once
// opened, the engine shows `signingIn` and its health is asked every 5 s on the room's timers, for up to 10 min:
// ready, `signingIn` is cleared and the queue takes, so a review that waited on the engine starts; any other state
// but signed out (gone, failing its self-test, at its limit) or the end, cleared, as the login can't help then.
// A run that found the engine signed out holds it so for its minute (the queue's `ranInto`): the looks go on. A second sign-in of an engine while one is pending is refused, as is one whose login
// didn't open (the engine not installed, no terminal program): nothing is shown then. The looks are the queue's
// (`checkEngine`): what changed is sent as `engine.changed`, and the self-test has its say as on any look.
// Stopping drops the looks armed and shows nothing more; a `signingIn` a stopped service left in the log is
// cleared by the next start (the room's).
// It must never know: which program signs in, how the terminal opens, or the queue's rules.
import type { EngineId, EngineState, EventBody } from "@lookover/contracts";
import type { Timers } from "./timers.ts";

/** How often the engine's health is asked while its sign-in is pending (ADR 0047). */
const LOOK_MS = 5_000;
/** How long a sign-in is watched before it is given up (ADR 0047). */
const LIMIT_MS = 10 * 60_000;

/** Whether the login opened; when it didn't, why, in the opener's words (for the console). */
export type SignInOpened = { opened: true } | { opened: false; reason: string };

/** What "Sign in" starts: the vendor's login of `engine`, for the user to complete. Never throws. */
export interface SignInOpener {
  open(engine: EngineId): Promise<SignInOpened>;
}

export interface SignInDeps {
  opener: SignInOpener;
  timers: Timers;
  clock: { now(): number };
  emit(body: EventBody): void;
  /** One look at the engine's health, what changed sent: the state it shows after, or null when the service stops. */
  look(engine: EngineId): Promise<EngineState | null>;
  /** The queue's take, once the engine is ready: the review that waited on it starts. */
  take(): void;
}

/** Why a sign-in didn't start. */
export type SignInRefusal = { refused: "pending" } | { refused: "not-opened"; reason: string };

export interface SignIn {
  /** Opens the login of `engine` and watches for it; "ok" once the watch began, else why not. */
  start(engine: EngineId): Promise<"ok" | SignInRefusal>;
  /** Drops every look armed: nothing of a stopped room fires later. */
  stop(): void;
}

export function createSignIn(d: SignInDeps): SignIn {
  /** The engines whose sign-in is pending (the login opening, or the looks going), with the look armed. */
  const pending = new Map<EngineId, { cancel: () => void }>();
  let stopped = false;

  const shown = (engine: EngineId, signingIn: boolean) =>
    d.emit({ type: "engine.changed", at: d.clock.now(), id: engine, patch: { signingIn } });

  /** The watch's end: the engine no longer shows signing in, ready or not. */
  const over = (engine: EngineId): void => {
    pending.delete(engine);
    shown(engine, false);
  };

  /** Arms the next look at `engine`, `until` the watch is given up. */
  const armLook = (engine: EngineId, until: number): void => {
    const watch = pending.get(engine);
    if (!watch || stopped) return;
    watch.cancel = d.timers.after(LOOK_MS, () => {
      void look(engine, until);
    });
  };

  const look = async (engine: EngineId, until: number): Promise<void> => {
    const state = await d.look(engine);
    // Stopping: the store may be closed, and nothing more is shown.
    if (state === null || stopped || !pending.has(engine)) return;
    if (state === "ready") {
      over(engine);
      d.take();
      return;
    }
    // Signed in or not, the login has nothing more to give: gone, failing its self-test, at its limit.
    if (state !== "signed-out" || d.clock.now() >= until) over(engine);
    else armLook(engine, until);
  };

  return {
    async start(engine) {
      if (pending.has(engine)) return { refused: "pending" };
      const watch = { cancel: () => {} };
      pending.set(engine, watch);
      const opened = await d.opener.open(engine);
      if (!opened.opened) {
        pending.delete(engine);
        return { refused: "not-opened", reason: opened.reason };
      }
      // Stopped while the login opened: the store is closing, and nothing is shown or watched.
      if (stopped) return { refused: "not-opened", reason: "the service is stopping" };
      shown(engine, true);
      armLook(engine, d.clock.now() + LIMIT_MS);
      return "ok";
    },
    stop() {
      stopped = true;
      for (const watch of pending.values()) watch.cancel();
      pending.clear();
    },
  };
}
