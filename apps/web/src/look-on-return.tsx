// Coming back reads at once (ADR 0088): while an install look runs, the person back from GitHub's tab, or its window,
// has the installations listed at that moment, not up to 4 s later. The window gaining focus and the tab shown again
// are one return: the first sends `connection.look`, the other nothing, until the tab has gone again (blurred or
// hidden). With no look running, a return sends nothing. The command goes through the store, never asking to unlock:
// a return isn't an action of the person's.
import type { Command } from "@lookover/contracts";
import { useEffect, useRef } from "react";
import { isLocked, useApp, useAppState } from "./store.tsx";
import { LOOK, lookRuns, signedIn } from "./view-model/accounts.ts";

/** The tab's presence: `onChange` calls its listener with true as it comes back (focused, shown), false as it goes. */
export interface Presence {
  onChange(listener: (here: boolean) => void): () => void;
}

/** The browser's: the window's focus and blur, and the document's visibility. */
const browserPresence: Presence = {
  onChange: (listener) => {
    const focus = () => listener(true);
    const blur = () => listener(false);
    const visibility = () => listener(document.visibilityState === "visible");
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  },
};

/** Sends `connection.look` once per return to the tab while `running` (a look runs, read as the return comes). */
function useLookOnReturn(running: boolean, send: (command: Command) => void, presence: Presence): void {
  const now = useRef({ running, send });
  useEffect(() => {
    now.current = { running, send };
  });
  useEffect(() => {
    let away = false;
    return presence.onChange((here) => {
      if (!here) {
        away = true;
        return;
      }
      if (!away) return;
      away = false;
      if (now.current.running) now.current.send(LOOK);
    });
  }, [presence]);
}

/**
 * The app's: the look the state says runs, under a sign-in, sent through the store unless it would ask to unlock.
 * `presence` is the browser's but in tests.
 */
export function LookOnReturn({ presence = browserPresence }: { presence?: Presence }) {
  const { connection } = useAppState();
  const { store } = useApp();
  useLookOnReturn(
    signedIn(connection) && lookRuns(connection),
    (command) => {
      if (!isLocked(store.get())) void store.send(command);
    },
    presence,
  );
  return null;
}
