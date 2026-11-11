// Coming back reads at once (ADR 0088, 0091): while an install look runs, the person back from GitHub's tab, or its
// window, has the installations listed at that moment, not up to 4 s later. The window gaining focus and the tab
// shown again are one return: the first sends `connection.returned` (`RETURNED`), the other nothing, until
// the tab has gone again (blurred or hidden). Whether a look runs is the service's to say: a hidden tab's copy is
// behind (its events wait for it to be shown), so a look ended or begun meanwhile reads wrong; the service lists only
// while one runs, its end unmoved, and does nothing else. The command goes through the store, never asking to unlock:
// a return isn't an action of the person's, and its refusal is said nowhere (`saysNothing`).
import type { Command } from "@lookover/contracts";
import { useEffect, useRef } from "react";
import { isLocked, useApp, useAppState } from "./store.tsx";
import { signedIn } from "./view-model/accounts.ts";

/** The command a return sends (ADR 0091): the service lists at once while a look runs, else does nothing. */
export const RETURNED = { type: "connection.returned" } as const satisfies Command;

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

/** Sends `RETURNED` once per return to the tab while `sending` (signed in, read as the return comes). */
function useLookOnReturn(sending: boolean, send: (command: Command) => void, presence: Presence): void {
  const now = useRef({ sending, send });
  useEffect(() => {
    now.current = { sending, send };
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
      if (now.current.sending) now.current.send(RETURNED);
    });
  }, [presence]);
}

/**
 * The app's: under a sign-in, whatever the copy says of the look, sent through the store unless it would ask to
 * unlock.
 * `presence` is the browser's but in tests.
 */
export function LookOnReturn({ presence = browserPresence }: { presence?: Presence }) {
  const { connection } = useAppState();
  const { store } = useApp();
  useLookOnReturn(
    signedIn(connection),
    (command) => {
      if (!isLocked(store.get())) void store.send(command);
    },
    presence,
  );
  return null;
}
