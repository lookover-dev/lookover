// Pieces of onboarding for real (ADR 0053) that several screens show: a problem's one fix (a command, or a page on
// GitHub), "Open on GitHub", and (ADR 0067) the code's actions and the accounts list, the same in setup and
// Settings › GitHub.
import type { Change, Command, DeviceCode } from "@lookover/contracts";
import {
  type FocusEvent,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { useNavigate } from "react-router-dom";
import { useAppState, useSend } from "../store.tsx";
import { BusyStatus, Button, Icon, type IconName, LinkButton, SameWidth, StatusLine } from "../ui/basics.tsx";
import { useToast } from "../ui/layers.tsx";
import { FirstPaint, PresenceList, type Shown, useArrived, useEntry } from "../ui/presence.tsx";
import {
  type AccountLink,
  type AccountMark,
  type AccountRow,
  type AccountsList as AccountsListView,
  accountMark,
  LOOKING,
} from "../view-model/accounts.ts";
import { pullRequestLink } from "../view-model/onboarding.ts";
import type { Problem } from "../view-model/select.ts";
import { codeToast, SIGN_IN_TEXT } from "../view-model/sign-in.ts";

/** A `SameWidth` place's key while it shows nothing. */
const NONE = "";

/**
 * A sign-in row's actions while a code waits: the code copied and GitHub's page opened, or the sign-in given up. Their
 * place is kept, empty, when no code waits; `idle`, what it shows then instead (Settings' Sign in again).
 */
export function CodeActions({
  code,
  onCancel,
  idle = null,
}: {
  code: DeviceCode | null;
  onCancel: () => void;
  idle?: ReactNode;
}) {
  const copyCode = useCopyCode();
  const T = SIGN_IN_TEXT;
  const copy = () => {
    if (code !== null) copyCode(code.userCode);
  };
  return (
    <SameWidth
      shown={code === null ? NONE : "code"}
      labels={{
        [NONE]: idle,
        code: (
          <span className="code-actions">
            <LinkButton size="sm" href={code?.verificationUri ?? "about:blank"} onClick={copy}>
              {T.copy}
            </LinkButton>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {T.cancel}
            </Button>
          </span>
        ),
      }}
    />
  );
}

/**
 * One of an account row's action places, as wide as the widest of `labels` and no wider: its link,
 * when it has one, opened in a new tab, its command sent as it opens (Ask to install's, which keeps the ask); a label
 * wider than the place is cut with an ellipsis, said whole on hover; with none, `idle` in its place, if anything.
 * Repositories' group heads hold their fix in one.
 */
export function AccountAction({
  link,
  labels,
  variant,
  className,
  idle = null,
  beside = null,
  besideLabels = [],
}: {
  link: AccountLink | null;
  labels: readonly string[];
  variant: "secondary" | "ghost";
  className?: string;
  idle?: ReactNode;
  /** After the link, inside the same place, taking its room from the link's (Ask again's icon on a waiting row). */
  beside?: ReactNode;
  /** The labels of `labels` the link shows with `beside` after it: their floor holds its square's room too. */
  besideLabels?: readonly string[];
}) {
  const send = useSend();
  const command = link?.command;
  return (
    <span className={className === undefined ? "account-action" : `account-action ${className}`}>
      {labels.map((label) => (
        // Seen nowhere, never focused nor clicked: it only holds the place's width.
        <span key={label} className="account-action-floor" aria-hidden>
          <LinkButton size="sm" variant={variant} href="about:blank">
            {label}
          </LinkButton>
          {besideLabels.includes(label) ? <span className="account-again-floor" /> : null}
        </span>
      ))}
      {link === null ? (
        idle
      ) : (
        <span className="account-action-link">
          <LinkButton
            size="sm"
            variant={variant}
            href={link.href}
            title={link.label}
            {...(command === undefined ? {} : { onClick: () => send(command) })}
          >
            <span className="account-action-label">{link.label}</span>
          </LinkButton>
          {beside}
        </span>
      )}
    </span>
  );
}

/** Each account mark's icon, before the row's detail. */
const MARK_ICONS = {
  repositories: "repo",
  "not-installed": "absent",
  ask: "owners",
  waiting: "time",
  "needs-you": "alert",
  looking: "search",
  another: "add",
} as const satisfies Record<AccountMark, IconName>;

/**
 * Ask again, on a row waiting for an owner: GitHub's page again, the ask kept again, an icon button beside the fix in
 * the fix's own place, named by its words and said on hover.
 */
function AskAgain({ link }: { link: AccountLink }) {
  const send = useSend();
  const { command } = link;
  return (
    <span className="anchor account-again">
      <a
        className="btn btn-ghost btn-sm btn-square"
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={link.label}
        {...(command === undefined ? {} : { onClick: () => send(command) })}
      >
        <Icon name="again" />
      </a>
      <span className="tip" role="tooltip">
        {link.label}
      </span>
    </span>
  );
}

/**
 * Focus follows an account's row (`key`) across its going and coming: `held`, the key of the row focus was last in,
 * set as focus enters the row and cleared as it leaves it; a row mounting while it holds that key and the page's focus
 * is nowhere (the row before it went with focus in it) takes focus back, on its fix, else on itself. What it gives
 * goes on the row's element, its ref passed on to `ref` (the entry's).
 */
function useFocusFollowsRow(
  key: string,
  held: MutableRefObject<string | null>,
  ref: (el: Element | null) => (() => void) | undefined,
) {
  const node = useRef<HTMLDivElement | null>(null);
  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      return ref(el);
    },
    [ref],
  );
  useLayoutEffect(() => {
    const el = node.current;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (el === null || held.current !== key || !lost) return;
    // The fix the row shows: its place's floors come first, hidden, and a hidden link takes no focus.
    const fix = el.querySelector<HTMLElement>(".account-action-link a, .account-action-link button");
    if (fix !== null) return fix.focus();
    el.tabIndex = -1;
    el.focus();
  });
  return {
    ref: rowRef,
    onFocus: () => {
      held.current = key;
    },
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      const to = e.relatedTarget;
      if (to instanceof Node && !e.currentTarget.contains(to)) held.current = null;
    },
  };
}

/**
 * One account's row. A row that mounted after its list first showed has arrived (an account installed elsewhere, an
 * owner's approval): it drops into place once, behind the list's gate (ADR 0087). `held`, the key of the row focus
 * was last in: a row that went while it held focus leaves the page's focus nowhere, and its account's row takes it
 * back, on its fix, else on itself.
 */
function AccountLine({
  row,
  shown,
  held,
}: {
  row: AccountRow;
  shown: Shown;
  held: MutableRefObject<string | null>;
}) {
  const mark = accountMark(row);
  const arrived = useArrived();
  const { enters, props } = useEntry(arrived, shown);
  const follows = useFocusFollowsRow(row.key, held, props.ref);
  return (
    <div
      className={enters ? "account-row new" : "account-row"}
      data-state={row.state}
      {...props}
      {...follows}
    >
      <span className="account-name">
        <b>{row.name}</b>
        <span className="account-detail t-small t-help">
          <span className="account-mark" data-mark={mark}>
            <Icon name={MARK_ICONS[mark]} />
          </span>
          <span>{row.detail}</span>
        </span>
      </span>
      {/* The fix's one place, pinned to the row's top, level with the login; on a row waiting for an owner, Ask again beside the
          fix inside it, so no row is taller for being able to wait. */}
      <span className="account-actions">
        <AccountAction
          link={row.fix}
          labels={row.labels}
          besideLabels={row.againLabels}
          variant="secondary"
          idle={
            row.status === null ? null : (
              <span className="account-status">
                <Icon name="check" />
                {row.status}
              </span>
            )
          }
          beside={row.again === null ? null : <AskAgain link={row.again} />}
        />
      </span>
    </div>
  );
}

/**
 * The part of the list a row's state puts it in: an account moving to another part (an owner approving an ask, an
 * install arriving) shows there as a new row, which arrives; one changing state in its part changes in place. The
 * person's own row is no part's: looking, the listing's cause, not installed or installed, it is the one row.
 */
const PART = {
  installed: "reached",
  reading: "reached",
  "needs-you": "reached",
  looking: "reached",
  "not-installed": "unreached",
  waiting: "unreached",
  another: "another",
} as const satisfies Record<AccountRow["state"], string>;

/**
 * The accounts list (design-system.md "Accounts list", ADR 0067): one row per account, its login, its detail, as tall
 * as it says and holding no other (ADR 0086), its one fix's place, as wide as every label its own row can show, the
 * button as wide as its own label on the place's right edge (Installed there on an account installed and used; Ask
 * again beside the fix on a row waiting for an owner), so a row changing state moves nothing beside its detail and a
 * row growing or appended moves only what is under it; a row appended after the list first showed fades in. Nothing
 * before a sign-in.
 */
export function AccountsList({ list }: { list: AccountsListView }) {
  // The row focus is in, kept past the row going (a removed element says no blur everywhere); a press anywhere ends it.
  const held = useRef<string | null>(null);
  useEffect(() => {
    const press = () => {
      held.current = null;
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, []);
  if (list.rows.length === 0) return null;
  const keyOf = (row: AccountRow) =>
    row.key === list.own ? `own:${row.key}` : `${PART[row.state]}:${row.key}`;
  // The list's own gate: setup and Settings › GitHub open on their rows still; an account that comes later arrives. A
  // row that goes (signed out, an account GitHub no longer lists) goes at once: only arrivals move.
  return (
    <FirstPaint>
      <div className="accounts-list">
        <PresenceList items={list.rows} keyOf={keyOf} exits={false}>
          {(row, shown) => <AccountLine row={row} shown={shown} held={held} />}
        </PresenceList>
      </div>
    </FirstPaint>
  );
}

/**
 * Copies a code to type on GitHub as its page opens (a sign-in's): said once the clipboard has it; without one, the
 * code is to be typed. GitHub's page opens either way, by the link clicked.
 */
function useCopyCode(): (code: string) => void {
  const toast = useToast();
  return (code) => {
    const said = (copied: boolean) => () => toast({ text: codeToast(code, copied) });
    const written = navigator.clipboard?.writeText(code);
    if (written === undefined) said(false)();
    else written.then(said(true), said(false));
  };
}

/**
 * A problem's one fix, at the size the band and the status menu give it: a command sent to the service, a page
 * opened on GitHub in a new tab (its code copied as it opens, when it asks for one; the look sent as it opens, when it
 * is the install page or an installation's settings), or a place in the app. `busyLabel`: what a command fix says
 * while the problem waits (a sign-in). A link fix that starts a look says "Looking…" in its place while the look runs,
 * the place as wide as the fix whichever it shows (ADR 0088).
 */
export function FixButton({ problem, busyLabel }: { problem: Problem; busyLabel: string }) {
  const send = useSend();
  const navigate = useNavigate();
  const copyCode = useCopyCode();
  const { fix, busy } = problem;
  if (!fix) return null;
  if ("path" in fix) {
    const { path } = fix;
    return (
      <Button size="sm" onClick={() => void navigate(path)}>
        {fix.label}
      </Button>
    );
  }
  if ("href" in fix) {
    const { copy, command } = fix;
    if (command === undefined) {
      const click = copy === undefined ? {} : { onClick: () => copyCode(copy) };
      return (
        <LinkButton size="sm" href={fix.href} {...click}>
          {fix.label}
        </LinkButton>
      );
    }
    return <LookFix label={fix.label} href={fix.href} command={command} busy={busy} />;
  }
  return (
    <Button size="sm" loading={busy} disabled={busy} onClick={() => send(fix.command)}>
      {busy ? busyLabel : fix.label}
    </Button>
  );
}

/**
 * A fix that opens GitHub's install page or an installation's settings and starts the look (ADR 0088): Looking… in
 * its place while the look runs, the fix again once it ends. The focus in the place follows what it shows, so a fix
 * pressed from the keyboard hands it to Looking…, and Looking… back to the fix, never dropping it to the page.
 */
function LookFix({
  label,
  href,
  command,
  busy,
}: {
  label: string;
  href: string;
  command: Command;
  busy: boolean;
}) {
  const send = useSend();
  const status = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const place = status.current?.closest(".same-width");
    const focused = document.activeElement;
    if (!place || !(focused instanceof HTMLElement) || !place.contains(focused)) return;
    const to = busy ? status.current : place.querySelector<HTMLElement>("a");
    if (to && to !== focused) to.focus();
  }, [busy]);
  return (
    <>
      <SameWidth
        shown={busy ? "looking" : "fix"}
        labels={{
          fix: (
            <LinkButton size="sm" href={href} onClick={() => send(command)}>
              {label}
            </LinkButton>
          ),
          looking: (
            <BusyStatus tone="run" ref={status}>
              {LOOKING}
            </BusyStatus>
          ),
        }}
      />
      <StatusLine>{busy ? LOOKING : ""}</StatusLine>
    </>
  );
}

/**
 * Opens a pull request on GitHub: the real one in a new tab in live mode, the app's simulated page in demo mode.
 * For the `G` key, which opens it the way the button does.
 */
export function useOpenOnGitHub(): (change: Change) => void {
  const { connection } = useAppState();
  const navigate = useNavigate();
  return (change) => {
    const link = pullRequestLink(connection, change);
    if ("href" in link) window.open(link.href, "_blank", "noopener,noreferrer");
    else void navigate(link.path);
  };
}

/** "Open on GitHub", or another label: a link to the real pull request in live mode, the simulated page in demo. */
export function GitHubButton({
  change,
  variant = "secondary",
  size = "md",
  kbd,
  label,
  square = false,
  children,
}: {
  change: Change;
  /** A secondary, or the page's filled primary where the person settles what needs them on GitHub. */
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  kbd?: string;
  /** Its accessible name, when its words may be hidden (an icon alone on a phone). */
  label?: string;
  /** An Icon button at a small button's size: its icon alone, in a square (`btn-square`); give it a `label`. */
  square?: boolean;
  children: ReactNode;
}) {
  const { connection } = useAppState();
  const navigate = useNavigate();
  const link = pullRequestLink(connection, change);
  const key = kbd === undefined ? {} : { kbd };
  const named = label === undefined ? {} : { label };
  const className = square ? "btn-square" : "";
  if ("href" in link) {
    return (
      <LinkButton href={link.href} variant={variant} size={size} className={className} {...key} {...named}>
        {children}
      </LinkButton>
    );
  }
  return (
    <Button
      icon="external"
      variant={variant}
      size={size}
      className={className}
      {...key}
      aria-label={label}
      onClick={() => navigate(link.path)}
    >
      {children}
    </Button>
  );
}
