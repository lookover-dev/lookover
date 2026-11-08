// One account's group on Repositories (design-system.md "Repositories' group heads", "Sticky, collapsible group heads";
// ADR 0067, 0082): its head, which sticks under the top bar while the group scrolls past and collapses it from a
// chevron, then its rows unless it is collapsed.
import type { Command } from "@lookover/contracts";
import type { FocusEvent, ReactNode } from "react";
import { Icon, Switch } from "../ui/basics.tsx";
import type { RepositoryGroup } from "../view-model/accounts.ts";
import { HeldDetail } from "./common.tsx";
import { AccountAction } from "./github-app.tsx";

/**
 * A group of Repositories' head, on the account's head band: in one row of the table's columns, the chevron that
 * collapses the group with the account beside it, how many of its repositories are reviewed beside the account (under
 * it on a phone), held at every count it can say, then in the Pull requests column its cause's line held at every line
 * a cause can say and its one fix, its place as wide as every fix the account can have, then in the Reviewing column
 * the account's switch, a group of one's included, so a cause or a count changing moves nothing. The cause and the fix
 * are said twice, one shown: in the Pull requests column on a wide screen, in a row of their own under the head on a
 * phone, where that column has no width. A collapsed group keeps all of it. Under the filter every head has the line
 * of what the filter shows under its count, said while folded, held empty while open, so every head is as tall.
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
  const fix = (
    <span className="repos-group-fix" data-state={head.state}>
      <span className="t-small repos-group-cause">
        <HeldDetail shown={head.cause} details={head.held} />
      </span>
      <AccountAction link={head.fix} labels={head.labels} variant="secondary" />
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
            <span className="repos-group-count group-band-count">
              <HeldDetail shown={head.count} details={head.counts} />
              {head.shows === null ? null : (
                <span className="repos-group-shows" aria-hidden={head.shows.said ? undefined : true}>
                  {head.shows.line}
                </span>
              )}
            </span>
          </span>
        </th>
        <td className="repos-prs">{fix}</td>
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
      <tr className="repos-group repos-group-narrow group-band">
        <td colSpan={3}>{fix}</td>
      </tr>
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

/** An account's group: its head, then its rows unless it is collapsed. */
export function RepositoryGroupRows({
  group,
  collapsed,
  toggle,
  send,
  children,
}: {
  group: RepositoryGroup;
  collapsed: boolean;
  toggle: () => void;
  send: (command: Command) => void;
  children: ReactNode;
}) {
  return (
    <tbody>
      <GroupHead group={group} collapsed={collapsed} toggle={toggle} send={send} />
      {collapsed ? null : children}
    </tbody>
  );
}
