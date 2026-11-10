// The look line (ADR 0088, design-system.md "Look line"): one line where the person's accounts are listed saying where
// Lookover stands with GitHub's installations, with Check again, which sends the look whatever the connection's state.
// Idle, Lookover checks every 2 minutes (the service's `DISCOVERY_MS`; no pace named while a listing is refused, as it
// is tried again sooner); while a look runs, it looks every few seconds and says when it last did, to the second; once
// a look ends, what arrived or what is back (an account's cause mended), or, with nothing new, that it keeps checking;
// stopped by GitHub's rate
// limit, until when GitHub asks to wait (past that wait, idle again). The line has two forms: setup's short one, which
// keeps to one line at a phone's 375 px since "Your accounts" says it right above the list's buttons (ADR 0086), and
// Settings › GitHub's fuller one, a row of its own at the card's end where wrapping moves nothing, which also says what
// nothing new can mean and the step. The hidden status line says the fuller words as a state comes, never each new
// time the look listed; an arrival it leaves to its toast, the one announcement of it.
import { type Connection, DISCOVERY_MS, type InstallLook, type State } from "@lookover/contracts";
import { heldLogin, LOOK } from "./accounts.ts";
import { clockToSecond, plural, until } from "./format.ts";

type LookLineState = "idle" | "looking" | "arrived" | "nothing" | "stopped";

/** The line's words: text, and the time to the second it last looked, which the screen sets in tabular figures. */
export type LookWords = (string | { time: string })[];

/** What sends the look from the line: a small ghost button, there in every state. */
export const CHECK_AGAIN = { label: "Check again", command: LOOK } as const;

export interface LookLineView {
  state: LookLineState;
  /** Setup's short form: one line at 375 px. */
  words: LookWords;
  /** Settings › GitHub's fuller form: what nothing new can mean and the step; the short form's words otherwise. */
  full: LookWords;
  /**
   * What the hidden status line says: the fuller words, the same while the state holds; empty when idle, and when
   * something arrived, which the toast says.
   */
  status: string;
  again: typeof CHECK_AGAIN;
}

/**
 * How often Lookover lists the installations, as the line says it: "every 2 minutes", from the service's own pace
 * (`DISCOVERY_MS`); null while a listing is refused, when it tries again sooner and the line names no pace.
 */
type Pace = string | null;
const MINUTE_MS = 60_000;
const paceOf = (ms: number): string => {
  const minutes = Math.round(ms / MINUTE_MS);
  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
};
const PACE = paceOf(DISCOVERY_MS);

/** The words of each state; the looking line's time, the pace and the counts are filled in by `lookLine`. */
const LOOK_TEXT = {
  idle: (pace: Pace) =>
    pace === null ? "Lookover keeps checking GitHub." : `Lookover checks GitHub ${pace}.`,
  looking: "Looking on GitHub every few seconds.",
  lookedAt: (time: string): LookWords => ["Looking every few seconds, last at ", { time }, "."],
  /** Setup's nothing new, whatever it can mean: the rows under it say what each account waits for. */
  nothing: (pace: Pace) =>
    pace === null ? "Nothing new yet. Lookover keeps checking." : `Nothing new yet. Checking ${pace}.`,
  /** Settings' nothing new, with no ask waiting: the commonest case is GitHub's page closed without installing. */
  nothingFull: (pace: Pace) =>
    `Nothing new yet. ${checks(pace)}; on GitHub, install it and choose a repository.`,
  /** Settings' nothing new while an ask waits for an owner: GitHub doesn't tell whether one approved yet. */
  approveFull: (pace: Pace) =>
    `Nothing new yet. ${checks(pace)}; an owner may still have to approve the request.`,
  stopped: (wait: string) => `GitHub asked to wait ${wait}.`,
  stoppedFull: (wait: string) => `GitHub asks Lookover to wait ${wait}.`,
} as const;

/** "Lookover checks every 2 minutes", or that it keeps checking when no pace is named. */
function checks(pace: Pace): string {
  return pace === null ? "Lookover keeps checking" : `Lookover checks ${pace}`;
}

/**
 * What arrived, in a line: the accounts new, or back (their cause mended: unsuspended, installed again), by name when
 * one, and how many repositories came with them.
 */
function arrivedText({ accounts, back, repositories }: NonNullable<InstallLook["arrived"]>): string {
  const all = [...accounts, ...back];
  if (all.length === 0) return `${plural(repositories, "repository", "repositories")} arrived.`;
  const [only] = all;
  const who =
    all.length === 1 && only !== undefined
      ? heldLogin(only, { ellipsis: true })
      : plural(all.length, "account");
  // Only accounts back: they were there before, so they're back, not arrived.
  const came = accounts.length > 0 ? "arrived" : all.length === 1 ? "is back" : "are back";
  return repositories === 0
    ? `${who} ${came}: no repository.`
    : `${who} ${came}: ${plural(repositories, "repository", "repositories")}.`;
}

/** Whether `look` ended on something new: an account or a repository it didn't list when it began. */
const arrivedOf = (look: InstallLook | null) =>
  look !== null &&
  look.ended !== null &&
  look.arrived !== null &&
  (look.arrived.accounts.length > 0 || look.arrived.back.length > 0 || look.arrived.repositories > 0)
    ? look.arrived
    : null;

/**
 * The toast of an arrival (ADR 0088), as well as the line, never instead: the line may be out of view (Repositories'
 * foot). Said once per look, as the state `before` gives way to `after`: what arrived, in the line's words, when
 * `after` is a look that arrived and `before` wasn't that one already arrived; null otherwise.
 */
export function arrivalToast(before: InstallLook | null, after: InstallLook | null): string | null {
  const arrived = arrivedOf(after);
  if (arrived === null || after === null) return null;
  if (before !== null && before.since === after.since && arrivedOf(before) !== null) return null;
  return arrivedText(arrived);
}

/** The words as plain text, the time in them included. */
const lookText = (words: LookWords): string =>
  words.map((w) => (typeof w === "string" ? w : w.time)).join("");

/**
 * Every line setup's short form can say, each at its longest (a login cut at 16 characters, 999 repositories, a wait
 * on another day): setup's "Your accounts" lays each out at 375 px (`ACCOUNTS_TEXT`, proof's `accountsLinesFit`).
 */
export const LONGEST_LOOK_LINES = {
  lookIdle: LOOK_TEXT.idle(PACE),
  lookIdleRefused: LOOK_TEXT.idle(null),
  lookLooking: LOOK_TEXT.looking,
  lookLookedAt: lookText(LOOK_TEXT.lookedAt("00:00:00")),
  lookArrivedNamed: arrivedText({ accounts: ["lookover-sandboxes"], back: [], repositories: 999 }),
  lookArrivedNamedNone: arrivedText({ accounts: ["lookover-sandboxes"], back: [], repositories: 0 }),
  lookArrivedAccounts: arrivedText({ accounts: ["a", "b"], back: [], repositories: 999 }),
  lookArrivedRepositories: arrivedText({ accounts: [], back: [], repositories: 999 }),
  lookBackNamed: arrivedText({ accounts: [], back: ["lookover-sandboxes"], repositories: 999 }),
  lookBackAccounts: arrivedText({ accounts: [], back: ["a", "b"], repositories: 999 }),
  lookNothing: LOOK_TEXT.nothing(PACE),
  lookNothingRefused: LOOK_TEXT.nothing(null),
  lookStopped: LOOK_TEXT.stopped("until Wed 14 Oct, 00:00"),
} as const;

type Seen = Pick<State, "now"> & {
  connection: Pick<Connection, "look" | "unreached" | "limitUntil" | "cause" | "listingCause">;
};

/** The look line at the state the service says; `timeZone`, the zone times are said in (the browser's by default). */
export function lookLine({ now, connection }: Seen, o: { timeZone?: string } = {}): LookLineView {
  const view = (state: LookLineState, words: LookWords, full: LookWords, status: string): LookLineView => ({
    state,
    words,
    full,
    status,
    again: CHECK_AGAIN,
  });
  const said = (state: LookLineState, text: string, full = text) => view(state, [text], [full], full);
  const { look, limitUntil } = connection;
  // A listing refused is tried again within the minute, not at the 2 minutes' pace: no pace is named then.
  const pace = connection.cause === null && connection.listingCause === null ? PACE : null;
  const idle = view("idle", [LOOK_TEXT.idle(pace)], [LOOK_TEXT.idle(pace)], "");
  if (look === null) return idle;
  if (look.ended === null) {
    const words =
      look.lookedAt === null
        ? [LOOK_TEXT.looking]
        : LOOK_TEXT.lookedAt(clockToSecond(look.lookedAt, o.timeZone));
    return view("looking", words, words, LOOK_TEXT.looking);
  }
  const arrived = arrivedOf(look);
  // The toast says an arrival, wherever the person is: the status line, said too, would say it twice.
  if (arrived !== null) return view("arrived", [arrivedText(arrived)], [arrivedText(arrived)], "");
  if (look.stopped !== null) {
    if (limitUntil === null || limitUntil <= now) return idle;
    const wait = until(now, limitUntil, o.timeZone);
    return said("stopped", LOOK_TEXT.stopped(wait), LOOK_TEXT.stoppedFull(wait));
  }
  const asked = connection.unreached.some((u) => u.askedAt !== null);
  return said(
    "nothing",
    LOOK_TEXT.nothing(pace),
    (asked ? LOOK_TEXT.approveFull : LOOK_TEXT.nothingFull)(pace),
  );
}
