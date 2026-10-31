// The setup's GitHub step on its first way, Sign in with GitHub (ADR 0065, ADR 0066): which way the step shows, the
// sign-in row (the code GitHub gave, with until when it works; the wait; who you are), the accounts row (one line,
// then the accounts list, ADR 0067), the step's one primary, and the refusal line (a start refused, a code that ran
// out, a sign-in GitHub didn't finish). Use your own App is today's flow (`onboarding.ts`). The connection says only
// that a code waits; how one went without a sign-in is the screen's to remember (`signInEnd`). Who you are is the
// connection's person, said as soon as the sign-in is kept. Signed out before the setup is done (the sign-in lost with
// the keychain, or revoked on GitHub), the step is at its start again, both ways offered, and says why. Settings ›
// GitHub on the shared App (`githubSettings`) says who is signed in, with Sign in again and its code in place, also
// while connected, and the same accounts list. Every link is built on `Connection.web`, so demo mode stays on
// GitHub's fake.
import type { Connection, DeviceCode, SignInStartRefusal, State } from "@lookover/contracts";
import { type AccountsList, accountRows } from "./accounts.ts";
import { until, type WithCommand } from "./format.ts";
import { appText } from "./onboarding.ts";

/** Which of the GitHub step's two ways is on screen. */
export type WayShown = "shared" | "own";

/** On the shared App with the person signed out (the sign-in lost, or revoked): a new sign-in or an own App mends it. */
const signedOut = ({ way, cause }: Connection) => way === "shared" && cause?.kind === "signed-out";

/** Signed in to the shared App, and not signed out since: a code seen before it is done with. */
export const signedInNow = (connection: Connection): boolean =>
  connection.way === "shared" && !signedOut(connection);

/** No way taken yet, or the sign-in taken lost: the step offers both, as at its start. */
const open = (connection: Connection) => connection.way === null || signedOut(connection);

/**
 * The way the step shows: Sign in with GitHub unless Use your own App was chosen here (`chosen`), its App is being
 * made, or Lookover runs as one; signed in, always the sign-in.
 */
export function wayShown(state: State, chosen: "own" | null): WayShown {
  const { way } = state.connection;
  if (way !== null && !signedOut(state.connection)) return way;
  return chosen === "own" || state.setup.github === "waiting-for-app" ? "own" : "shared";
}

/** Whether Use your own App's Back returns to the two ways: nothing asked of GitHub on it yet, and no way held. */
export function bothWays(state: State): boolean {
  const { connection, setup } = state;
  if (signedOut(connection)) return setup.github !== "waiting-for-app";
  return connection.way === null && setup.github === "start";
}

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
  if (last === null || cancelled || connection.signIn !== null || !open(connection)) return null;
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
  /** Use your own App, offered until signed in. */
  ownApp: boolean;
  refused: string | null;
  done: boolean;
}

/** The words of the step's first way (glossary: the shared App, signed in). */
export const SIGN_IN_TEXT = {
  title: "Connect GitHub.",
  lead: "Sign in with GitHub, and Lookover posts its reviews as you. Your teammates see your review written by you, opening with “Lookover”, a summary with Lookover's badge, and a Lookover check. Or use an App of your own.",
  signIn: "Sign in with GitHub",
  accounts: "Your accounts",
  copy: "Copy code and open GitHub",
  cancel: "Cancel",
  own: "Use your own App",
  continue: "Continue",
  /** Beside Continue once the step is done: setup waits for the owner (ADR 0058). */
  done: "GitHub is connected.",
} as const;

const START = "You enter a code on GitHub. No App to create, no key to keep.";
export const FINISHING = "Finishing the sign-in with GitHub…";
/** As long as any code GitHub gives (`XXXX-XXXX`), for the row's held height before one is given. */
const ANY_CODE = "XXXX-XXXX";
/** How long GitHub's device codes work: 15 minutes. */
const CODE_LIFETIME_MS = 15 * 60_000;

/** "Enter `ABCD-1234` on GitHub. It works until 10:26.": the setup's sign-in row, and Sign in again's problem. */
export const waitingText = (userCode: string, works: string): WithCommand => ({
  before: "Enter",
  command: userCode,
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
const SIGNED_OUT = "You're signed out of GitHub. Sign in again, or use your own App.";
/** Settings › GitHub's sign-in row, signed out: Sign in again is beside it. */
const SIGNED_OUT_ROW = "You're signed out of GitHub.";

const START_REFUSED: Record<SignInNotStarted, string> = {
  pending: "A sign-in already waits for its code.",
  "own-app": "Lookover already uses your own App here.",
  unavailable: "Signing in with GitHub isn't offered here.",
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
  const { signIn, way } = state.connection;
  if (way === "shared" && !signedOut(state.connection)) {
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
  if (state.connection.way !== "shared" || signedOut(state.connection))
    return row("later", ACCOUNTS_TEXT.later);
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
 * The step's first way at the state the service says: `end`, how the code shown last went without a sign-in;
 * `refusal`, why a start was refused; `timeZone`, the zone times are said in (the browser's by default).
 */
export function signInStep(
  state: State,
  o: { end?: SignInEnd | null; refusal?: SignInNotStarted | null; timeZone?: string } = {},
): SignInStepView {
  const { connection } = state;
  const done = connection.way === "shared" && !signedOut(connection) && state.setup.github === "done";
  const starts = open(connection) && connection.signIn === null;
  const refused =
    o.refusal !== undefined && o.refusal !== null
      ? START_REFUSED[o.refusal]
      : starts && o.end !== undefined && o.end !== null
        ? ENDED[o.end]
        : starts && signedOut(connection)
          ? SIGNED_OUT
          : null;
  return {
    signIn: signInRow(state, o.timeZone),
    accounts: accountsRow(state, o.timeZone),
    primary: starts
      ? { label: SIGN_IN_TEXT.signIn, enabled: true, starts: true }
      : { label: SIGN_IN_TEXT.continue, enabled: done, starts: false },
    ownApp: open(connection),
    refused,
    done,
  };
}

/** Settings › GitHub's words on the shared App (ADR 0067). */
export const GITHUB_SETTINGS_TEXT = {
  title: "Signed in with GitHub",
  again: "Sign in again",
  own: "Use your own App",
  ownBody:
    "Your own App replaces the sign-in: Lookover then posts as the App, not as you. Give its id and its private key.",
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
 * Settings › GitHub (ADR 0067): on the shared App, who is signed in (or signed out), with Sign in again and its code in
 * place, also while connected, to change person, and the accounts list; else the App's line, as before.
 */
export type GitHubSettingsView =
  | { way: "shared"; signIn: SettingsSignInView; list: AccountsList }
  | { way: "own"; text: string };

/** Settings › GitHub at the state the service says; `timeZone`, the zone times are said in (the browser's by default). */
export function githubSettings(state: State, o: { timeZone?: string } = {}): GitHubSettingsView {
  const { connection } = state;
  if (connection.way !== "shared") return { way: "own", text: appText(connection) };
  const who = signedOut(connection) ? SIGNED_OUT_ROW : signedInText(connection);
  const { text, held } = codeTexts(state, o.timeZone, who, [signedInText(connection), SIGNED_OUT_ROW]);
  return {
    way: "shared",
    signIn: { text, held, code: connection.signIn },
    list: accountRows(state, zoned(o.timeZone)),
  };
}
