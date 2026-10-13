// Running times tick in the browser (ADR 0058): one ticking now for the whole app, the service's `now` plus what the
// browser counted since it arrived (`view-model/ticking.ts`), redrawn once a second while a review runs. Nothing
// here goes through `apply`: the state is the service's, the ticking now only what the screens show of a running
// time. The clock's pace comes from the developer's tools in demo mode (its clock flows or stands still); the
// service's real clock flows at 1.
import type { State } from "@lookover/contracts";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { follow, somethingRuns, type Tick, tickingNow } from "./view-model/ticking.ts";

/** How fast the service's clock flows, in its milliseconds per browser millisecond. */
export interface ClockPace {
  subscribe(listener: () => void): () => void;
  get(): number;
  /** The app's state moved: a pace read from the service (demo mode's) may read it again. */
  moved?(): void;
}

/** The service's real clock: it flows with the browser's. */
export const REAL_PACE: ClockPace = { subscribe: () => () => undefined, get: () => 1 };

const SECOND = 1_000;

const TickingContext = createContext<number | null>(null);

/** Gives the screens the ticking now, redrawn once a second while a review runs, and not at all otherwise. */
export function TickingProvider({
  state,
  pace,
  children,
}: {
  state: State;
  pace: ClockPace;
  children: ReactNode;
}) {
  const rate = useSyncExternalStore(pace.subscribe, pace.get);
  const runs = somethingRuns(state.reviews);
  const [, redraw] = useState(0);
  // A clock standing still (demo mode's paused) has nothing to redraw.
  const ticks = runs && rate > 0;
  useEffect(() => {
    if (!ticks) return;
    const timer = setInterval(() => redraw((n) => n + 1), SECOND);
    return () => clearInterval(timer);
  }, [ticks]);
  useEffect(() => {
    // Each move of the state is a reason for demo mode's pace to look at its clock again; it decides when.
    void state.seq;
    void state.now;
    pace.moved?.();
  }, [pace, state.seq, state.now]);
  // The same `now` and pace give back the same tick, so a second render (StrictMode's) changes nothing.
  const tick = useRef<Tick | null>(null);
  tick.current = follow(tick.current, state.now, rate, Date.now());
  return (
    <TickingContext.Provider value={runs ? tickingNow(tick.current, Date.now()) : state.now}>
      {children}
    </TickingContext.Provider>
  );
}

/** The ticking now, for a running time; the service's `now` outside the provider. */
export function useTickingNow(state: State): number {
  return useContext(TickingContext) ?? state.now;
}
