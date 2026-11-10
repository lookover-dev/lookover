// What leaves stays until its motion ends, and what was there from the start never enters (ADR 0087, design-system.md
// "Motion"). Two things beside each other:
//
// - `Presence` (one thing) and `PresenceList` (keyed items): what stops being present is kept, marked leaving (the
//   `leaving` class the item writes, `data-leaving`, `inert`, `aria-hidden`), until every finite animation on its
//   elements and their subtrees has finished or been cancelled, read once the leaving mark is committed; with none
//   running it goes at once. No wrapper element: each item gets `leaving` and a `mark` to spread on each of its
//   elements. It never delays the change: state, focus and the next action happen when the person acts.
// - `FirstPaint` and `useArrived`: what mounted after the gate's first commit is marked, so CSS entries play only on
//   things that arrived, never on a page's first paint. `useEntry` adds what came back while it left: the same
//   element, it plays its entry again, the first paint's included.
//
// Loops (an infinite animation in the subtree: the eyes, a pulse) are never waited on. Under reduced motion nothing
// runs, so everything leaves at once. One safety bound, the presence's own and no component's: a leave still held
// twice the longest motion token (`--d-4`) after it began on the page's timeline goes anyway, so a finite animation
// paused in a leaving subtree never holds it forever. Measured on `document.timeline`, which a page whose timeline
// stands still (proof's frames) doesn't move.
import {
  createContext,
  Fragment,
  type Key,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";

/** Spread on each element of a shown item: the presence watches its animations, and marks it while it leaves. */
export interface LeavingMark {
  ref: (el: Element | null) => (() => void) | undefined;
  "data-leaving"?: "";
  inert?: boolean;
  "aria-hidden"?: true;
}

/** What each shown item is handed: whether it is leaving (its elements add the `leaving` class), and its mark. */
export interface Shown {
  leaving: boolean;
  mark: LeavingMark;
}

/**
 * What an element of a shown item spreads: its class `base`, with `leaving` added while it leaves, and its mark. A
 * prop that must win over the mark (an `aria-hidden` always on, a merged `ref`) comes after the spread.
 */
export function leavingProps(
  base: string,
  shown: Shown | undefined,
): { className: string } & Partial<LeavingMark> {
  return { className: shown?.leaving ? `${base} leaving` : base, ...shown?.mark };
}

/** One thing, shown while `present`, kept while it leaves. `exits={false}`: its removal goes at once. */
export function Presence({
  present,
  exits = true,
  children,
}: {
  present: boolean;
  exits?: boolean;
  children: (shown: Shown) => ReactNode;
}) {
  return (
    <PresenceList items={present ? ONE : NONE} keyOf={only} exits={exits}>
      {(_item, shown) => children(shown)}
    </PresenceList>
  );
}
const ONE = [true] as const;
const NONE: readonly true[] = [];
const only = () => "only";

/**
 * Keyed items, each kept in its place after it is removed until it has left. `exits` says whether a removal animates,
 * read in the render where the item goes: `false` (or a `false` for that item) removes it at once, as a search, a
 * filter or a change of scope does. An item that comes back while leaving is the same element, no longer leaving.
 * `empty` shows once nothing is in the list, present or leaving: what says "none" never stands beside a last item's exit.
 */
export function PresenceList<T>({
  items,
  keyOf,
  exits,
  empty = null,
  children,
}: {
  items: readonly T[];
  keyOf: (item: T) => Key;
  exits: boolean | ((item: T) => boolean);
  empty?: ReactNode;
  children: (item: T, shown: Shown) => ReactNode;
}) {
  const previous = useRef<Entry<T>[]>([]);
  const done = useRef(new WeakSet<object>());
  const watched = useRef(new WeakSet<object>());
  const elements = useRef(new Map<Key, Set<Element>>());
  const refs = useRef(new Map<Key, LeavingMark["ref"]>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const list = merge(previous.current, items, keyOf, exits, done.current);

  // After each commit, the leaving mark is on the page: each new leave reads what runs, and is done when it ends.
  useLayoutEffect(() => {
    previous.current = list;
    forget(list, elements.current, refs.current);
    let goneAtOnce = false;
    for (const entry of list) {
      const token = entry.leaving;
      if (!token || watched.current.has(token)) continue;
      watched.current.add(token);
      const running = [...(elements.current.get(entry.key) ?? [])].flatMap(exitsOf);
      if (running.length === 0) {
        done.current.add(token);
        goneAtOnce = true;
      } else {
        const ended = () => done.current.has(token);
        const end = () => {
          if (ended()) return;
          done.current.add(token);
          rerender();
        };
        void Promise.allSettled(running.map((a) => a.finished)).then(end);
        bound(end, ended);
      }
    }
    if (goneAtOnce) rerender();
  });

  const refOf = (key: Key) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (el) => {
        if (!el) return undefined;
        const set = elements.current.get(key) ?? new Set();
        elements.current.set(key, set.add(el));
        return () => {
          set.delete(el);
        };
      };
      refs.current.set(key, ref);
    }
    return ref;
  };

  if (list.length === 0) return empty;
  return list.map((entry) => (
    <Fragment key={entry.key}>
      {children(entry.item, {
        leaving: entry.leaving !== null,
        mark: entry.leaving
          ? { ref: refOf(entry.key), "data-leaving": "", inert: true, "aria-hidden": true }
          : { ref: refOf(entry.key) },
      })}
    </Fragment>
  ));
}

/** The elements and refs of items no longer shown. */
function forget(list: Entry<unknown>[], elements: Map<Key, unknown>, refs: Map<Key, unknown>) {
  const keys = new Set(list.map((e) => e.key));
  for (const key of [...elements.keys(), ...refs.keys()]) {
    if (keys.has(key)) continue;
    elements.delete(key);
    refs.delete(key);
  }
}

interface Entry<T> {
  key: Key;
  item: T;
  /** While leaving, the token of this leave (a fresh object each time it starts leaving); `null` while present. */
  leaving: object | null;
}

/**
 * The items as given, each removed one kept after what it followed, unless its leave is done or this render removes it
 * without motion: a search during a fold's exit drops what was still leaving.
 */
function merge<T>(
  previous: Entry<T>[],
  items: readonly T[],
  keyOf: (item: T) => Key,
  exits: boolean | ((item: T) => boolean),
  done: WeakSet<object>,
): Entry<T>[] {
  const present = items.map((item) => ({ key: keyOf(item), item, leaving: null }));
  const keys = new Set(present.map((e) => e.key));
  const HEAD = Symbol("head");
  const after = new Map<Key | symbol, Entry<T>[]>();
  let anchor: Key | symbol = HEAD;
  for (const entry of previous) {
    if (keys.has(entry.key)) {
      anchor = entry.key;
      continue;
    }
    const animates = typeof exits === "function" ? exits(entry.item) : exits;
    const leaving = animates ? (entry.leaving ?? {}) : null;
    if (!leaving || done.has(leaving)) continue;
    after.set(anchor, [...(after.get(anchor) ?? []), { ...entry, leaving }]);
  }
  return [...(after.get(HEAD) ?? []), ...present.flatMap((e) => [e, ...(after.get(e.key) ?? [])])];
}

/** The animations a leaving element waits on: its own and its subtree's, loops left out (they never end). */
function exitsOf(el: Element): Animation[] {
  return el.getAnimations({ subtree: true }).filter(runs);
}

/** Whether an animation is still to end: not finished, and not a loop. */
const runs = (a: Animation) =>
  a.playState !== "finished" && (a.effect?.getComputedTiming().endTime ?? 0) !== Infinity;

/** The longest motion token: a leave held twice its length is held by something that will never end. */
const LONGEST = "--d-4";

/**
 * Calls `end`, unless `ended` already, once the page's timeline has moved twice the longest motion token on, re-armed
 * while it stands still. Without the token (a test's page with no stylesheet) there is no bound: the animations alone
 * decide.
 */
function bound(end: () => void, ended: () => boolean) {
  const limit = 2 * duration(getComputedStyle(document.documentElement).getPropertyValue(LONGEST));
  if (!(limit > 0)) return;
  const now = () => {
    const t = document.timeline?.currentTime;
    return typeof t === "number" ? t : performance.now();
  };
  const begun = now();
  const check = () => {
    if (ended()) return;
    const left = limit - (now() - begun);
    if (left <= 0) end();
    else setTimeout(check, left);
  };
  setTimeout(check, limit);
}

/** A CSS duration in ms ("320ms", "0.32s"); NaN for anything else. */
function duration(value: string): number {
  const m = /^\s*([\d.]+)(ms|s)\s*$/.exec(value);
  if (!m) return Number.NaN;
  return Number(m[1]) * (m[2] === "s" ? 1000 : 1);
}

const Gate = createContext<{ readonly current: boolean }>({ current: false });

/**
 * The first-paint gate: what mounts under it after its first commit has arrived (`useArrived`); what its first commit
 * held was there from the start. The app holds one around its screens once its state is loaded.
 */
export function FirstPaint({ children }: { children: ReactNode }) {
  const passed = useRef(false);
  useEffect(() => {
    passed.current = true;
  }, []);
  return <Gate.Provider value={passed}>{children}</Gate.Provider>;
}

/**
 * Whether the calling component mounted after its gate's first commit, fixed for its life. Outside any gate, never: a
 * thing rendered alone (a static test) plays no entry. Mark the element with `data-arrived` and key its CSS entry on it.
 */
export function useArrived(): boolean {
  const gate = useContext(Gate);
  const [arrived] = useState(() => gate.current);
  return arrived;
}

/** The mark an element that `arrived` carries, which its CSS entry is keyed on; none on one there from the start. */
export function arrivedProps(arrived: boolean): { "data-arrived"?: "" } {
  return arrived ? { "data-arrived": "" } : {};
}

/**
 * A shown item's entry, played once: it enters if it mounted `fresh` (read once, as it mounts) or came back while it was
 * leaving, the same element (`leaving` going from true to false); `arrived` is `useArrived`'s, or true once it came
 * back, so a row there from the first paint plays its entry too. Once the entry that the mark started has ended or been
 * cancelled, `enters` is false again: the element keeps no entry for a later move in the page (React re-inserting it
 * as its list reorders) to replay. With none running at the commit (reduced motion, no stylesheet) the mark stays and
 * starts nothing. Leaving wins over entering: the caller writes `leaving` first. Spread `props` on the element.
 */
export function useEntry(
  fresh: boolean | undefined,
  shown: Shown | undefined,
): {
  leaving: boolean;
  enters: boolean;
  props: { "data-arrived"?: "" } & Partial<LeavingMark> & Pick<LeavingMark, "ref">;
} {
  const leaving = shown?.leaving ?? false;
  const arrived = useArrived();
  const [enters, setEnters] = useState(fresh ?? false);
  const [returned, setReturned] = useState(false);
  const [wasLeaving, setWasLeaving] = useState(leaving);
  // Adjusted while rendering, as React advises for state that follows a prop: the class is right in the first commit.
  if (wasLeaving !== leaving) {
    setWasLeaving(leaving);
    if (!leaving) {
      setEnters(true);
      setReturned(true);
    }
  }
  const node = useRef<Element | null>(null);
  const markRef = shown?.mark.ref;
  const ref = useCallback(
    (el: Element | null) => {
      node.current = el;
      return markRef?.(el);
    },
    [markRef],
  );
  // After the commit that put the mark on, what it started runs: once it is over, the mark goes.
  const playing = enters && !leaving;
  useLayoutEffect(() => {
    const el = node.current;
    if (!playing || !el) return;
    return entryOver(el, () => setEnters(false));
  }, [playing]);
  return { leaving, enters, props: { ...arrivedProps(arrived || returned), ...shown?.mark, ref } };
}

/**
 * Calls `over` once what runs on `el` itself now (the entry its mark just started) has ended or been cancelled; never
 * if nothing runs (reduced motion). Call it after the commit that put the mark on; it returns what stops listening.
 */
export function entryOver(el: Element, over: () => void): () => void {
  const running = el.getAnimations().filter(runs);
  let listening = running.length > 0;
  if (listening)
    void Promise.allSettled(running.map((a) => a.finished)).then(() => {
      if (listening) over();
    });
  return () => {
    listening = false;
  };
}
