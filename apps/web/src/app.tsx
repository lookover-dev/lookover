import type { Command } from "@lookover/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import type { WebMode } from "./dev/mode.ts";
import { GitHubMock } from "./screens/github.tsx";
import { AllReviews, Home } from "./screens/home.tsx";
import { Review } from "./screens/review.tsx";
import { Logs, Repositories, RepositoryPage, Settings, SettingsSection } from "./screens/settings.tsx";
import { Setup } from "./screens/setup.tsx";
import { Alerts, Palette, Shortcuts, TabBar, TopBar, useGlobalKeys } from "./shell.tsx";
import {
  AppContext,
  type AppServices,
  cancelHeld,
  type Held,
  StateProvider,
  type Store,
  sendOrHold,
  unlockAndSend,
  useApp,
  useStoreState,
  useStoreStatus,
} from "./store.tsx";
import { type ClockPace, REAL_PACE, TickingProvider } from "./ticking.tsx";
import { Button, PageLoading, Session } from "./ui/basics.tsx";
import { Dialog, ToastProvider, useToast } from "./ui/layers.tsx";
import { type Refusal, refusalToast, sessionLost } from "./view-model/refusal.ts";

/**
 * The app's screens. A route added or removed here is one in `ROUTES` of scripts/proof-shots.ts too (the screen
 * each shows, for `bun run proof`); scripts/proof-shots.test.ts fails until both lists match.
 */
function Main() {
  const { openPalette, openShortcuts } = useApp();
  const { pathname } = useLocation();
  useGlobalKeys(openPalette, openShortcuts);
  return (
    <div className="app">
      <TopBar />
      <Alerts />
      <div className="route" key={pathname}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/reviews" element={<AllReviews />} />
          <Route path="/reviews/:owner/:name/:number" element={<Review />} />
          <Route path="/repositories" element={<Repositories />} />
          <Route path="/repositories/:owner/:name" element={<RepositoryPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/:section" element={<SettingsSection />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </div>
      <TabBar />
    </div>
  );
}

/**
 * The toast of a refused command: said once per refusal; the band keeps the line (design-system.md). None for an App
 * refused, nor a sign-in refused while the setup shows (`setup`): the form or the GitHub step says it in place.
 */
function RefusalToast({ refusal, setup }: { refusal: Refusal | null; setup: boolean }) {
  const toast = useToast();
  // `setup` is read as the refusal comes, never watched: a refusal is said once, the setup finishing later says nothing.
  useEffect(() => {
    const text = refusal ? refusalToast(refusal, { setup }) : null;
    if (text !== null) toast({ text, tone: "need" });
  }, [refusal, toast]);
  return null;
}

/** The developer drawer and, in demo mode, the demo's pages, built by `main.tsx` from `src/dev`. */
export interface DevTools {
  routes: ReactNode;
  drawer: ReactNode;
  /** In demo mode, how its clock flows, which the running times follow (ADR 0058); the real clock's otherwise. */
  pace?: ClockPace;
}

/**
 * `dev` is the drawer and the demo pages from `src/dev`; the app itself never talks to the demo driver (ADR 0046).
 * `mode` is the build's (`dev/mode.ts`): the session screen names the program's command or the developer's.
 */
export function App({
  store,
  embedded,
  dev,
  mode,
}: {
  store: Store;
  embedded: boolean;
  dev: DevTools | null;
  mode: WebMode;
}) {
  const state = useStoreState(store);
  const { session, refusal } = useStoreStatus(store);
  const [palette, setPalette] = useState<"all" | "review" | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [locked, setLocked] = useState<Held | null>(null);

  const send = useCallback(
    (command: Command, sent?: () => void, refused?: () => void) => {
      const held = sendOrHold(store, command, sent, refused);
      if (held) setLocked(held);
    },
    [store],
  );
  const cancel = () => {
    cancelHeld(locked);
    setLocked(null);
  };
  const openPalette = useCallback((mode: "all" | "review" = "all") => setPalette(mode), []);
  const openShortcuts = useCallback(() => setShortcuts(true), []);
  const app = useMemo<AppServices>(
    () => ({ store, send, embedded, mode, openPalette, openShortcuts }),
    [store, send, embedded, mode, openPalette, openShortcuts],
  );

  // The service no longer knows this tab (#68): the one screen shown without a state, whatever was loaded.
  if (session !== "open") return <Session words={sessionLost(mode, session.open)} />;
  if (!state) return <PageLoading />;
  return (
    <AppContext.Provider value={app}>
      <StateProvider value={state}>
        <ToastProvider>
          <RefusalToast refusal={refusal} setup={!state.setup.done} />
          <TickingProvider state={state} pace={dev?.pace ?? REAL_PACE}>
            <Routes>
              <Route path="/github/:owner/:name/:number" element={<GitHubMock />} />
              {dev?.routes}
              <Route path="*" element={state.setup.done ? <Main /> : <Setup />} />
            </Routes>
          </TickingProvider>
          {state.setup.done ? <Palette mode={palette} onClose={() => setPalette(null)} /> : null}
          <Shortcuts open={shortcuts} onClose={() => setShortcuts(false)} />
          <Dialog
            open={locked !== null}
            onClose={cancel}
            title="Unlock to make changes?"
            actions={
              <>
                <Button variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (locked) unlockAndSend(store, locked);
                    setLocked(null);
                  }}
                >
                  Unlock with passkey
                </Button>
              </>
            }
          >
            <p>
              This Lookover runs on a server. Looking is free; changing something asks for your passkey once
              per session.
            </p>
          </Dialog>
          {dev && !embedded ? dev.drawer : null}
        </ToastProvider>
      </StateProvider>
    </AppContext.Provider>
  );
}
