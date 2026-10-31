// Pieces of onboarding for real (ADR 0053) that several screens show: a problem's one fix (a command, or a page on
// GitHub), "Open on GitHub", "Use an existing App", the App's slug for the agents, and on the shared App (ADR 0067)
// the code's actions and the accounts list, the same in setup and Settings › GitHub.
import type { Change, Connection, DeviceCode } from "@lookover/contracts";
import { type ReactNode, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp, useAppState, useSend, useStoreStatus } from "../store.tsx";
import { Button, CopyLine, Field, Input, KeyFile, LinkButton, Said, SameWidth } from "../ui/basics.tsx";
import { useToast } from "../ui/layers.tsx";
import {
  ACCOUNT_FIX_LABELS,
  type AccountLink,
  type AccountRow,
  type AccountsList as AccountsListView,
  ASK_AGAIN,
} from "../view-model/accounts.ts";
import { agentApp, pullRequestLink, USE_APP_TEXT, useAppRefusalText } from "../view-model/onboarding.ts";
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
            <LinkButton href={code?.verificationUri ?? "about:blank"} onClick={copy}>
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
 * One of an account row's action places, as wide as the widest of `labels` and no wider, whatever the rows: its link,
 * when it has one, opened in a new tab, its command sent as it opens (Ask to install's, which keeps the ask); a label
 * wider than the place is cut with an ellipsis, said whole on hover. Repositories' group heads hold their fix in one.
 */
export function AccountAction({
  link,
  labels,
  variant,
}: {
  link: AccountLink | null;
  labels: readonly string[];
  variant: "secondary" | "ghost";
}) {
  const send = useSend();
  const command = link?.command;
  return (
    <span className="account-action">
      {labels.map((label) => (
        // Seen nowhere, never focused nor clicked: it only holds the place's width.
        <span key={label} className="account-action-floor" aria-hidden>
          <LinkButton size="sm" variant={variant} href="about:blank">
            {label}
          </LinkButton>
        </span>
      ))}
      {link === null ? null : (
        <span className="account-action-link" title={link.label}>
          <LinkButton
            size="sm"
            variant={variant}
            href={link.href}
            {...(command === undefined ? {} : { onClick: () => send(command) })}
          >
            <span className="account-action-label">{link.label}</span>
          </LinkButton>
        </span>
      )}
    </span>
  );
}

function AccountLine({ row }: { row: AccountRow }) {
  return (
    <div className="account-row" data-state={row.state}>
      <span className="account-name">
        <b>{row.name}</b>
        <span className="t-small">
          <HeldDetail shown={row.detail} details={row.details} />
        </span>
      </span>
      <span className="account-actions">
        <AccountAction link={row.fix} labels={ACCOUNT_FIX_LABELS} variant="secondary" />
        {row.asks ? <AccountAction link={row.again} labels={[ASK_AGAIN]} variant="ghost" /> : null}
      </span>
    </div>
  );
}

/**
 * The accounts list (design-system.md "Accounts list", ADR 0067): one row per account, its login, its detail held at
 * the tallest it can show, its one fix's place, as wide as every label it can show, and under it Ask again's on the
 * rows that can wait for an owner, so a row changing state moves nothing and a row appended moves only what is under
 * it. Nothing before a sign-in.
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
  variant?: "secondary" | "ghost";
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

/** A positive whole number, as GitHub's App ids are; null for anything else. */
function appIdOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * "Use an existing App": its id and its private key file, sent once in `connection.useApp` and kept nowhere here
 * but for the moment it is sent. Its refusal is said under the form. `appId`: the stored App's, to give it a new key.
 */
export function UseAppForm({ appId }: { appId: number | null }) {
  const { store } = useApp();
  const send = useSend();
  const { refusal } = useStoreStatus(store);
  const [id, setId] = useState(appId === null ? "" : String(appId));
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const idField = useId();
  const keyField = useId();
  const parsed = appIdOf(id);
  // The service sends `answer.useApp` (UseAppRefusal) beside `error`; refusal.ts reads exactly that.
  const refused = refusal?.useApp ? useAppRefusalText(refusal.useApp) : null;

  const submit = async () => {
    if (parsed === null || file === null) return;
    const key = await file.text();
    store.dismiss();
    setSending(true);
    const done = () => setSending(false);
    send({ type: "connection.useApp", appId: parsed, key }, done, done);
  };

  return (
    <div className="use-app">
      <Field label={USE_APP_TEXT.idLabel} htmlFor={idField} help={USE_APP_TEXT.idHelp}>
        <Input
          id={idField}
          inputMode="numeric"
          autoComplete="off"
          value={id}
          aria-invalid={id !== "" && parsed === null ? true : undefined}
          onChange={(e) => setId(e.target.value)}
        />
      </Field>
      <Field
        label={USE_APP_TEXT.keyLabel}
        htmlFor={keyField}
        help={USE_APP_TEXT.keyHelp}
        {...(refused ? { error: refused } : {})}
      >
        <KeyFile
          id={keyField}
          name={file?.name ?? null}
          placeholder={USE_APP_TEXT.keyPlaceholder}
          accept=".pem"
          invalid={refused !== null}
          onChoose={setFile}
        />
      </Field>
      <div>
        <Button
          loading={sending}
          disabled={sending || parsed === null || file === null}
          onClick={() => void submit()}
        >
          {USE_APP_TEXT.submit}
        </Button>
      </div>
    </div>
  );
}

/**
 * The App's slug, as `lookover wait` takes it on another computer: one plain sentence, then the line to copy under it.
 * Nothing before there is an App.
 */
export function AgentAppLine({ connection }: { connection: Connection }) {
  const toast = useToast();
  const app = agentApp(connection);
  if (!app) return null;
  const { sentence, line } = app;
  return (
    <div className="t-small agent-app">
      <p>
        <Said words={sentence} />
      </p>
      <CopyLine
        value={line}
        onCopy={() => {
          void navigator.clipboard?.writeText(line);
          toast({ text: `${line} copied.` });
        }}
      />
    </div>
  );
}
