// One account's group on Repositories (design-system.md "Repositories' group heads", "Sticky, collapsible group heads";
// ADR 0067, 0082): its head, which sticks under the top bar while the group scrolls past and collapses it from a
// chevron, then its rows unless it is collapsed, folding by them.
import type { Command, RepositoryId } from "@lookover/contracts";
import type { FocusEvent, ReactNode } from "react";
import { Icon, Switch } from "../ui/basics.tsx";
import { FoldRows } from "../ui/fold.tsx";
import type { RepositoryGroup } from "../view-model/accounts.ts";
import { AccountAction } from "./github-app.tsx";

/**
 * A group of Repositories' head, on the account's head band. Its first row, the one that sticks, holds only what every
 * head has, in the table's columns: the chevron that collapses the group with the account beside it, how many of its
 * repositories are reviewed beside the account (under it on a phone), the Pull requests column empty, then in the
 * Reviewing column the account's switch, a group of one's included. Then, only while it says something, a second row
 * across the table that scrolls with the group, wide as on a phone: its cause's line and its one fix, its place as wide
 * as every fix the account can have, or, folded under a filter, how many of it the filter shows. So every head's stuck
 * row is as tall, and a head with no cause holds no room for one (ADR 0086). A collapsed group keeps all of it.
 */
export function GroupHead({
  group,
  collapsed,
  toggle,
  send,
}: {
  group: RepositoryGroup;
  collapsed: boolean;
  toggle: () => void;
  send: (command: Command) => void;
}) {
  const { head, control } = group;
  const fix =
    head.cause === null && head.shows === null ? null : (
      <span className="repos-group-fix" data-state={head.state}>
        {head.shows === null ? null : <span className="t-small repos-group-shows">{head.shows}</span>}
        {head.cause === null ? null : <span className="t-small repos-group-cause">{head.cause}</span>}
        {head.cause === null ? null : (
          <AccountAction link={head.fix} labels={head.labels} variant="secondary" />
        )}
      </span>
    );
  return (
    <>
      <tr className="repos-group group-band" onFocus={uncover}>
        <th scope="rowgroup">
          <span className="repos-group-title">
            <button
              type="button"
              className="group-toggle repos-group-toggle"
              aria-label={head.toggleLabel}
              aria-expanded={!collapsed}
              onClick={toggle}
            >
              <Icon name="next" />
              <span className="repos-group-account group-band-name" title={head.account}>
                {head.account}
              </span>
            </button>
            <span className="repos-group-count group-band-count">{head.count}</span>
          </span>
        </th>
        <td className="repos-prs">
          <span className="repos-group-line" />
        </td>
        <td>
          <span className="repos-group-switch">
            {control === null ? null : (
              <Switch
                checked={group.allOn}
                label={control.label}
                onChange={(enabled) => send({ ...control.command, enabled })}
              />
            )}
          </span>
        </td>
      </tr>
      {fix === null ? null : (
        <tr className="repos-group repos-group-more group-band">
          <td colSpan={3}>{fix}</td>
        </tr>
      )}
    </>
  );
}

/**
 * How far the page scrolls when a head's control takes focus, from where its `group` (its `tbody`) is, the bottom of
 * the head's cell and the line heads stick at, all from the viewport's top. A table cell sticks for the whole table, so
 * a group scrolled past keeps its head stuck under every later one: focused there, the page scrolls back to the
 * group's top, its head shown in its place. Shown (in its place, or stuck over its own rows): 0.
 */
export function uncoverBy(
  group: { top: number; bottom: number },
  cellBottom: number,
  stuckAt: number,
): number {
  return cellBottom > group.bottom + 1 ? group.top - stuckAt : 0;
}

/** A head's control taking focus is never left under a later head (`uncoverBy`). */
function uncover(event: FocusEvent<HTMLTableRowElement>) {
  const group = event.currentTarget.parentElement;
  const cell = event.target.closest("th, td");
  if (group === null || cell === null) return;
  const by = uncoverBy(
    group.getBoundingClientRect(),
    cell.getBoundingClientRect().bottom,
    Number.parseFloat(getComputedStyle(cell).top),
  );
  if (by !== 0) window.scrollBy({ top: by });
}

/**
 * An account's group: its head, then its rows unless it is collapsed. Its rows fold (`FoldRows`, ADR 0087): they come
 * in as it opens and leave as it folds, its height changing once they have left; `chosenBy` is what chose them (the
 * search's and the filter's held set, by identity), whose change moves none.
 */
export function RepositoryGroupRows({
  group,
  collapsed,
  chosenBy,
  toggle,
  send,
  children,
}: {
  group: RepositoryGroup;
  collapsed: boolean;
  chosenBy: ReadonlySet<RepositoryId> | null;
  toggle: () => void;
  send: (command: Command) => void;
  children: ReactNode;
}) {
  return (
    <tbody>
      <GroupHead group={group} collapsed={collapsed} toggle={toggle} send={send} />
      <FoldRows open={!collapsed} chosenBy={chosenBy}>
        {collapsed ? null : children}
      </FoldRows>
    </tbody>
  );
}
