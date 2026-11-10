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
import { type AccountsList, accountRows, readingRepositories, saidSignedOut, signedIn } from "./accounts.ts";
import { until, type WithCommand } from "./format.ts";
import { LONGEST_LOOK_LINES, type LookLineView, type LookWords, lookLine } from "./look-line.ts";

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
  /** As tall as it says, holding no other text (ADR 0086): what follows it moves with it, the list included. */
  text: string | WithCommand;
  /** The code to enter, while one waits: copied and opened by the row's one button. */
  code: DeviceCode | null;
}

interface AccountsRowView {
  state: RowState;
  /**
   * One line over the list: where the step is with the accounts, or, listed, once a look began (ADR 0088), the look
   * line's words.
   */
  text: string | LookWords;
  /** Every account, one row each, with its state or its one fix (ADR 0067): empty until signed in. */
  list: AccountsList;
  /** The look line once signed in: its Check again, the row's action, and its status line; null before. */
  look: LookLineView | null;
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

/**
 * What "Your accounts" says under its title, each on one line at a phone's 375 px: it sits right above the list's
 * buttons and holds no height (ADR 0086), so a line wrapping as the state changes would move them under the pointer
 * (proof's `accountsLinesFit` lays every one out there).
 */
export const ACCOUNTS_TEXT = {
  later: "Right after you sign in.",
  looking: "Looking for your accounts on GitHub.",
  /** Listed, their repositories' first read still under way: the step goes on once it ends (ADR 0083, ADR 0086). */
  reading: "Reading your accounts' repositories…",
  nothing: "Installed, with no repository chosen.",
  done: "Install it on more accounts any time.",
  /** Done, with an account still to set up: one is enough to go on (Repositories, First review and the agent come next), the rest can wait. */
  rest: "Enough to go on. The rest can wait.",
  /** Listed, once a look began: the look line's words (ADR 0088), each at its longest. */
  ...LONGEST_LOOK_LINES,
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
 * A sign-in row's text: `idle` while no code waits, else the code's with until when it works (past its expiry, the
 * wait for who signed in).
 */
function codeText(state: State, timeZone: string | undefined, idle: string): string | WithCommand {
  const { signIn } = state.connection;
  if (signIn === null) return idle;
  // Past its expiry and still shown, the code was taken: the service asks GitHub who signed in (ADR 0066).
  return state.now >= signIn.expiresAt
    ? FINISHING
    : waitingText(signIn.userCode, until(state.now, signIn.expiresAt, timeZone));
}

function signInRow(state: State, timeZone: string | undefined): SignInRowView {
  const { signIn } = state.connection;
  if (signedIn(state.connection)) return { state: "done", text: signedInText(state.connection), code: null };
  const text = codeText(state, timeZone, START);
  return signIn === null ? { state: "current", text, code: null } : { state: "busy", text, code: signIn };
}

const zoned = (timeZone: string | undefined) => (timeZone === undefined ? {} : { timeZone });

function accountsRow(state: State, timeZone: string | undefined): AccountsRowView {
  const list = accountRows(state, zoned(timeZone));
  if (!signedIn(state.connection)) return { state: "later", text: ACCOUNTS_TEXT.later, list, look: null };
  const look = lookLine(state, zoned(timeZone));
  // Listed, a look begun says where it is in place of the step's own line (ADR 0088): not before, when the step
  // still looks for the accounts or reads their repositories for the first time.
  const said = (text: string) =>
    state.connection.listed && !readingRepositories(state) && look.state !== "idle" ? look.words : text;
  const row = (rowState: RowState, text: string): AccountsRowView => ({
    state: rowState,
    text: said(text),
    list,
    look,
  });
  switch (state.setup.github) {
    case "done":
      // An account with a fix still needs the person (installing, SSO, an owner): the rest can wait, said so.
      return row(
        "done",
        list.rows.some((r) => r.account !== null && r.fix !== null) ? ACCOUNTS_TEXT.rest : ACCOUNTS_TEXT.done,
      );
    case "nothing-granted":
      return row("current", ACCOUNTS_TEXT.nothing);
    default:
      return row("busy", readingRepositories(state) ? ACCOUNTS_TEXT.reading : ACCOUNTS_TEXT.looking);
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
  /** As tall as it says, holding no other text (ADR 0086): a code's sentence may grow the row over the list. */
  text: string | WithCommand;
  /** The code to enter, while one waits: copied and opened by the row's one button, Cancel beside it. */
  code: DeviceCode | null;
}

/**
 * Settings › GitHub (ADR 0067): who is signed in (or signed out), with Sign in again and its code in place, also while
 * connected, to change person, the accounts list and, ending the card under it, the look line with Check again
 * (ADR 0088). Nothing else: there is no other way in (ADR 0073).
 */
export interface GitHubSettingsView {
  signIn: SettingsSignInView;
  list: AccountsList;
  /** The look line, in every state once signed in; null before a sign-in and once signed out, with no list. */
  look: LookLineView | null;
}

/** Settings › GitHub at the state the service says; `timeZone`, the zone times are said in (the browser's by default). */
export function githubSettings(state: State, o: { timeZone?: string } = {}): GitHubSettingsView {
  const { connection } = state;
  const inNow = signedIn(connection);
  const who = inNow ? signedInText(connection) : SIGNED_OUT_ROW;
  return {
    signIn: { text: codeText(state, o.timeZone, who), code: connection.signIn },
    list: accountRows(state, zoned(o.timeZone)),
    look: inNow ? lookLine(state, zoned(o.timeZone)) : null,
  };
}
