// Pieces of onboarding for real (ADR 0053) that several screens show: a problem's one fix (a command, or a page on
// GitHub), "Open on GitHub", and (ADR 0067) the code's actions and the accounts list, the same in setup and
// Settings › GitHub.
import type { Change, DeviceCode } from "@lookover/contracts";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAppState, useSend } from "../store.tsx";
import { Button, Icon, type IconName, LinkButton, SameWidth } from "../ui/basics.tsx";
import { useToast } from "../ui/layers.tsx";
import {
  type AccountLink,
  type AccountMark,
  type AccountRow,
  type AccountsList as AccountsListView,
  accountMark,
} from "../view-model/accounts.ts";
import { pullRequestLink } from "../view-model/onboarding.ts";
import type { Problem } from "../view-model/select.ts";
import { codeToast, SIGN_IN_TEXT } from "../view-model/sign-in.ts";
import { HeldDetail } from "./common.tsx";

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
        className="btn btn-ghost btn-sm"
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

function AccountLine({ row }: { row: AccountRow }) {
  const mark = accountMark(row);
  return (
    <div className="account-row" data-state={row.state}>
      <span className="account-name">
        <b>{row.name}</b>
        <span className="account-detail t-small t-help">
          <span className="account-mark" data-mark={mark}>
            <Icon name={MARK_ICONS[mark]} />
          </span>
          <HeldDetail shown={row.detail} details={row.details} />
        </span>
      </span>
      {/* The fix's one place, centred on the login and its detail; on a row waiting for an owner, Ask again beside the
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
 * The accounts list (design-system.md "Accounts list", ADR 0067): one row per account, its login, its detail held at
 * the tallest it can show, two lines at least, its one fix's place, as wide as every label its own row can show, the
 * button as wide as its own label on the place's right edge (Installed there on an account installed and used; Ask
 * again beside the fix on a row waiting for an owner), so every row is as tall, a row changing state moves nothing and
 * a row appended moves only what is under it. Nothing before a sign-in.
 */
export function AccountsList({ list }: { list: AccountsListView }) {
  if (list.rows.length === 0) return null;
  return (
    <div className="accounts-list">
      {list.rows.map((row) => (
        <AccountLine key={row.key} row={row} />
      ))}
    </div>
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
 * opened on GitHub in a new tab (its code copied as it opens, when it asks for one), or a place in the app.
 * `busyLabel`: what a command fix says while the problem waits (a sign-in).
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
    const { copy } = fix;
    const click = copy === undefined ? {} : { onClick: () => copyCode(copy) };
    return (
      <LinkButton size="sm" href={fix.href} {...click}>
        {fix.label}
      </LinkButton>
    );
  }
  return (
    <Button size="sm" loading={busy} disabled={busy} onClick={() => send(fix.command)}>
      {busy ? busyLabel : fix.label}
    </Button>
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
  children,
}: {
  change: Change;
  /** A secondary, or the page's filled primary where the person settles what needs them on GitHub. */
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  kbd?: string;
  children: ReactNode;
}) {
  const { connection } = useAppState();
  const navigate = useNavigate();
  const link = pullRequestLink(connection, change);
  const key = kbd === undefined ? {} : { kbd };
  if ("href" in link) {
    return (
      <LinkButton href={link.href} variant={variant} size={size} {...key}>
        {children}
      </LinkButton>
    );
  }
  return (
    <Button icon="external" variant={variant} size={size} {...key} onClick={() => navigate(link.path)}>
      {children}
    </Button>
  );
}
