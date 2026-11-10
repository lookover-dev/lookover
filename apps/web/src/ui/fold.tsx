// A group folds by its rows (ADR 0087, design-system.md "Motion"): opening a group, its rows come in; folding it, they
// leave through the presence, and the group's height changes once they have left. Rows move only when the fold
// changes: rows there when the group first showed, or brought and taken by a search or a filter, come and go still.
//
// `FoldRows` takes the group's rows as keyed elements, as the group had them, and hands each its `fold`: whether it
// leaves (its element adds the `leaving` class), whether it came in by the fold opening (`data-unfolded`, what the
// entry is keyed on), and the presence's mark. A row spreads `foldMarks(fold)` on its element. A row keeps
// `data-unfolded` while its entry plays, as it mounts with the fold (or as a row that returns while leaving loses
// `.leaving`); once that entry has ended or been cancelled it loses the attribute, so a later move of its element in the
// page (React re-inserting it as the list reorders) replays nothing. Folded and opened again, it plays anew.
//
// `chosenBy` is compared by identity: the caller passes the same set while the search and the filter stand (the
// choice's `held`), a new one only when either changed. A set built afresh every render would read as a change in
// every render, and every fold would go still.
import type { RepositoryId } from "@lookover/contracts";
import {
  Children,
  cloneElement,
  isValidElement,
  type Key,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";
import { entryOver, type LeavingMark, PresenceList } from "./presence.tsx";

/** What a row of a fold is handed. */
export interface Fold {
  leaving: boolean;
  /** It came in as the fold opened: its entry plays. */
  unfolded: boolean;
  mark: LeavingMark;
}

/** What a row spreads on its element: the presence's mark, and `data-unfolded` when it came in by the fold. */
export const foldMarks = (fold: Fold | undefined) =>
  fold === undefined ? {} : { ...fold.mark, "data-unfolded": fold.unfolded ? "" : undefined };

type Row = ReactElement<{ fold?: Fold }>;

/**
 * A group's rows, shown while `open` (a folded group passes none: what leaves is kept here). `chosenBy` is what chose
 * the rows (the search's and the filter's held set, null for every one; by identity): a render where it changed adds
 * and removes rows, and opens or folds groups, without motion. A fold opening in any other render brings its rows in
 * by the fold; one closing sends them out through the presence.
 */
export function FoldRows({
  open,
  chosenBy,
  children,
}: {
  open: boolean;
  chosenBy: ReadonlySet<RepositoryId> | null;
  children: ReactNode;
}) {
  const rows = Children.toArray(children).filter((child) => isValidElement<{ fold?: Fold }>(child));
  const last = useRef<{
    open: boolean;
    chosenBy: ReadonlySet<RepositoryId> | null;
    unfolded: Set<Key>;
    /** Counts the fold's openings: an entry that ends after the group folded or opened again changes nothing. */
    opening: number;
  }>({
    open,
    chosenBy,
    unfolded: new Set(),
    opening: 0,
  });
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const same = last.current.chosenBy === chosenBy;
  const opened = open && !last.current.open && same;
  const unfolded = new Set(
    open ? rows.map(keyOf).filter((key) => opened || last.current.unfolded.has(key)) : [],
  );
  // Each row's element, so its entry can be heard ending; each row's ref is kept, so React keeps the element's.
  const elements = useRef(new Map<Key, Element>());
  const refs = useRef(new Map<Key, { mark: LeavingMark["ref"]; ref: LeavingMark["ref"] }>());
  const refOf = (key: Key, mark: LeavingMark["ref"]) => {
    const kept = refs.current.get(key);
    if (kept?.mark === mark) return kept.ref;
    const ref: LeavingMark["ref"] = (el) => {
      if (el) elements.current.set(key, el);
      else elements.current.delete(key);
      return mark(el);
    };
    refs.current.set(key, { mark, ref });
    return ref;
  };
  const watched = useRef(new Map<Key, number>());
  useLayoutEffect(() => {
    const opening = last.current.opening + (opened ? 1 : 0);
    last.current = { open, chosenBy, unfolded, opening };
    for (const key of unfolded) {
      const el = elements.current.get(key);
      if (!el || watched.current.get(key) === opening) continue;
      watched.current.set(key, opening);
      entryOver(el, () => {
        if (last.current.opening !== opening || !last.current.unfolded.delete(key)) return;
        rerender();
      });
    }
  });
  return (
    <PresenceList items={open ? rows : NO_ROWS} keyOf={keyOf} exits={!open && same}>
      {(row, { leaving, mark }) =>
        cloneElement(row, {
          fold: {
            leaving,
            unfolded: unfolded.has(keyOf(row)),
            mark: { ...mark, ref: refOf(keyOf(row), mark.ref) },
          },
        })
      }
    </PresenceList>
  );
}

const NO_ROWS: readonly Row[] = [];
/** `Children.toArray` gives every element a key. */
const keyOf = (row: Row): Key => row.key ?? "";
