// The setup's GitHub step, Sign in with GitHub, the one way in (ADR 0065, ADR 0066, ADR 0073): the sign-in row (the
// code GitHub gave, with until when it works; the wait; who you are), the accounts row (one line, then the accounts
// list, ADR 0067), the step's one primary, and the refusal line (a start refused, a code that ran out, a sign-in GitHub
// didn't finish). The connection says only that a code waits; how one went without a sign-in is the screen's to
// remember (`signInEnd`). Who you are is the connection's person, said as soon as the sign-in is kept: signed in is a
// person kept and not signed out since (`signedIn`), whatever else the connection holds. Signed out before the setup
// is done (the sign-in lost with the keychain, or revoked on GitHub), the step is at its start again, and says why.
// Settings › GitHub (`githubSettings`) says who is signed in, with Sign in again and its code in place, also while
// connected, and the same accounts list. Every link is built on `Connection.web`, so demo mode stays on GitHub's fake.
import type { Connection, DeviceCode, SignInStartRefusal, State } from "@lookover/contracts";
import { type AccountsList, accountRows, saidSignedOut, signedIn } from "./accounts.ts";
import { until, type WithCommand } from "./format.ts";

/** How a code went without a sign-in: it ran out, or GitHub didn't sign the person in (refused, or failed). */
export type SignInEnd = "expired" | "ended";

/**
 * Why the code shown last (`last`) went with no sign-in, as the screen saw it go: ran out once the service's clock
 * reached its expiry, else GitHub didn't sign in. Null while it waits, once signed in, with no code seen, or when the
 * person cancelled it here (`cancelled`).
 */
export function signInEnd(
  last: DeviceCode | null,
  connection: Connection,
  now: number,
  cancelled: boolean,
): SignInEnd | null {
  if (last === null || cancelled || connection.signIn !== null || signedIn(connection)) return null;
  return now >= last.expiresAt ? "expired" : "ended";
}

/**
 * Why "Sign in with GitHub" didn't start: as the service answered (409's `signIn`), or `github` when GitHub gave no
 * code (502).
 */
export type SignInNotStarted = SignInStartRefusal | "github";

/** A sub-step's state square. */
type RowState = "done" | "busy" | "current" | "later";

interface SignInRowView {
  state: RowState;
  text: string | WithCommand;
  /** Every text the row can show, `text` among them: as tall as the tallest, so nothing moves. */
  held: (string | WithCommand)[];
  /** The code to enter, while one waits: copied and opened by the row's one button. */
  code: DeviceCode | null;
}

interface AccountsRowView {
  state: RowState;
  /** One line over the list: where the step is with the accounts. */
  text: string;
  held: string[];
  /** Every account, one row each, with its state or its one fix (ADR 0067): empty until signed in. */
  list: AccountsList;
}

export interface SignInStepView {
  signIn: SignInRowView;
  accounts: AccountsRowView;
  /** The step's one primary: Sign in with GitHub to start one, else Continue, enabled once the step is done. */
  primary: { label: string; enabled: boolean; starts: boolean };
  refused: string | null;
  done: boolean;
}

/** The step's words (glossary: the shared App, signed in). */
export const SIGN_IN_TEXT = {
  title: "Connect GitHub.",
  lead: "Sign in with GitHub, and Lookover posts its reviews as you. Your teammates see your review written by you, each comment opening with Lookover's wordmark, its status in the pull request's description, and a Lookover check.",
  signIn: "Sign in with GitHub",
  accounts: "Your accounts",
  copy: "Copy code and open GitHub",
  cancel: "Cancel",
  continue: "Continue",
  /** Beside Continue once the step is done: setup waits for the owner (ADR 0058). */
  done: "GitHub is connected.",
} as const;

const START = "You enter a code on GitHub, then authorise Lookover there.";
export const FINISHING = "Finishing the sign-in with GitHub…";
/** As long as any code GitHub gives (`XXXX-XXXX`), for the row's held height before one is given. */
const ANY_CODE = "XXXX-XXXX";
/** How long GitHub's device codes work: 15 minutes. */
const CODE_LIFETIME_MS = 15 * 60_000;

/**
 * "Enter `D054-61DC` on GitHub. It works until 10:26.": the setup's sign-in row, Settings', and Sign in again's
 * problem; the code a device code (design-system.md "Device code").
 */
export const waitingText = (userCode: string, works: string): WithCommand => ({
  before: "Enter",
  command: userCode,
  kind: "device-code",
  after: `on GitHub. It works ${works}.`,
});

/** The toast once a code to type on GitHub is copied as its page opens (`copied`), or, without a clipboard, typed. */
export const codeToast = (userCode: string, copied: boolean): string =>
  copied ? `${userCode} copied.` : `Type ${userCode} on GitHub.`;

const ACCOUNTS_TEXT = {
  later: "Right after you sign in.",
  looking: "Looking for your accounts with Lookover's App.",
  nothing: "Installed, with no repository. On GitHub, pick the ones it may see.",
  done: "Install it on more accounts any time.",
} as const;

const ENDED: Record<SignInEnd, string> = {
  expired: "The code ran out before it was entered. Sign in with GitHub for a new one.",
  ended: "GitHub didn't sign you in. Sign in with GitHub to try again.",
};

/** Signed out before the setup is done: why the step is at its start again. */
const SIGNED_OUT = "You're signed out of GitHub. Sign in again.";
/** Settings › GitHub's sign-in row, signed out: Sign in again is beside it. */
const SIGNED_OUT_ROW = "You're signed out of GitHub.";

/** Why a start was refused. */
const START_REFUSED: Record<SignInNotStarted, string> = {
  pending: "A sign-in already waits for its code.",
  github: "GitHub didn't give a code. Try again.",
};

/** Why a sign-in didn't start, in the step's words. */
export const signInRefusalText = (refusal: SignInNotStarted): string => START_REFUSED[refusal];

/** "Signed in as sasensi.": who the sign-in kept is. */
const signedInText = ({ person }: Connection) =>
  person === null ? "Signed in." : `Signed in as ${person.login}.`;

/**
 * A sign-in row's texts: `idle` while no code waits, else the code's (past its expiry, the wait for who signed in),
 * all held with `others`, the row's other texts, and a code as long as any, until when the code shown (or one given
 * now) works.
 */
function codeTexts(state: State, timeZone: string | undefined, idle: string, others: string[]) {
  const { signIn } = state.connection;
  const works = (expiresAt: number) => until(state.now, expiresAt, timeZone);
  const anyCode = waitingText(ANY_CODE, works(signIn?.expiresAt ?? state.now + CODE_LIFETIME_MS));
  // Past its expiry and still shown, the code was taken: the service asks GitHub who signed in (ADR 0066).
  const text =
    signIn === null
      ? idle
      : state.now >= signIn.expiresAt
        ? FINISHING
        : waitingText(signIn.userCode, works(signIn.expiresAt));
  const held = [
    ...new Map([...others, anyCode, FINISHING, text].map((t) => [JSON.stringify(t), t])).values(),
  ];
  return { text, held };
}

function signInRow(state: State, timeZone: string | undefined): SignInRowView {
  const { signIn } = state.connection;
  if (signedIn(state.connection)) {
    const text = signedInText(state.connection);
    return { state: "done", text, held: codeTexts(state, timeZone, text, [START, text]).held, code: null };
  }
  const { text, held } = codeTexts(state, timeZone, START, [START]);
  return signIn === null
    ? { state: "current", text, held, code: null }
    : { state: "busy", text, held, code: signIn };
}

const zoned = (timeZone: string | undefined) => (timeZone === undefined ? {} : { timeZone });

function accountsRow(state: State, timeZone: string | undefined): AccountsRowView {
  const list = accountRows(state, zoned(timeZone));
  const row = (rowState: RowState, text: string): AccountsRowView => ({
    state: rowState,
    text,
    held: Object.values(ACCOUNTS_TEXT),
    list,
  });
  if (!signedIn(state.connection)) return row("later", ACCOUNTS_TEXT.later);
  switch (state.setup.github) {
    case "done":
      return row("done", ACCOUNTS_TEXT.done);
    case "nothing-granted":
      return row("current", ACCOUNTS_TEXT.nothing);
    default:
      return row("busy", ACCOUNTS_TEXT.looking);
  }
}

/**
 * The step at the state the service says: `end`, how the code shown last went without a sign-in; `refusal`, why a
 * start was refused; `timeZone`, the zone times are said in (the browser's by default).
 */
export function signInStep(
  state: State,
  o: { end?: SignInEnd | null; refusal?: SignInNotStarted | null; timeZone?: string } = {},
): SignInStepView {
  const { connection } = state;
  const done = signedIn(connection) && state.setup.github === "done";
  const starts = !signedIn(connection) && connection.signIn === null;
  const refused =
    o.refusal !== undefined && o.refusal !== null
      ? START_REFUSED[o.refusal]
      : starts && o.end !== undefined && o.end !== null
        ? ENDED[o.end]
        : starts && saidSignedOut(connection.cause)
          ? SIGNED_OUT
          : null;
  return {
    signIn: signInRow(state, o.timeZone),
    accounts: accountsRow(state, o.timeZone),
    primary: starts
      ? { label: SIGN_IN_TEXT.signIn, enabled: true, starts: true }
      : { label: SIGN_IN_TEXT.continue, enabled: done, starts: false },
    refused,
    done,
  };
}

/** Settings › GitHub's words (ADR 0067). */
export const GITHUB_SETTINGS_TEXT = {
  title: "Signed in with GitHub",
  again: "Sign in again",
} as const;

/** Settings › GitHub's sign-in row: who is signed in, or the code Sign in again gave, as setup's row says it. */
interface SettingsSignInView {
  text: string | WithCommand;
  /** Every text the row can show, `text` among them: as tall as the tallest, so nothing moves. */
  held: (string | WithCommand)[];
  /** The code to enter, while one waits: copied and opened by the row's one button, Cancel beside it. */
  code: DeviceCode | null;
}

/**
 * Settings › GitHub (ADR 0067): who is signed in (or signed out), with Sign in again and its code in place, also while
 * connected, to change person, and the accounts list. Nothing else: there is no other way in (ADR 0073).
 */
export interface GitHubSettingsView {
  signIn: SettingsSignInView;
  list: AccountsList;
}

/** Settings › GitHub at the state the service says; `timeZone`, the zone times are said in (the browser's by default). */
export function githubSettings(state: State, o: { timeZone?: string } = {}): GitHubSettingsView {
  const { connection } = state;
  const who = signedIn(connection) ? signedInText(connection) : SIGNED_OUT_ROW;
  const { text, held } = codeTexts(state, o.timeZone, who, [signedInText(connection), SIGNED_OUT_ROW]);
  return {
    signIn: { text, held, code: connection.signIn },
    list: accountRows(state, zoned(o.timeZone)),
  };
}
