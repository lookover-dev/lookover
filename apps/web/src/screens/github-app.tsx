// Pieces of onboarding for real (ADR 0053) that several screens show: a problem's one fix (a command, or a page on
// GitHub), "Open on GitHub", "Use an existing App" and the App's slug for the agents.
import type { Change, Connection } from "@lookover/contracts";
import { type ReactNode, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp, useAppState, useSend, useStoreStatus } from "../store.tsx";
import { Button, CopyLine, Field, Input, KeyFile, LinkButton, Said } from "../ui/basics.tsx";
import { useToast } from "../ui/layers.tsx";
import { agentApp, pullRequestLink, USE_APP_TEXT, useAppRefusalText } from "../view-model/onboarding.ts";
import type { Problem } from "../view-model/select.ts";

/**
 * A problem's one fix, at the size the band and the status menu give it: a command sent to the service, a page
 * opened on GitHub in a new tab, or a place in the app. `busyLabel`: what a command fix says while the problem waits
 * (a sign-in).
 */
export function FixButton({ problem, busyLabel }: { problem: Problem; busyLabel: string }) {
  const send = useSend();
  const navigate = useNavigate();
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
    return (
      <LinkButton size="sm" href={fix.href}>
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
