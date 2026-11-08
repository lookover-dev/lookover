// Departed repositories said by how they went (design-system.md "Departed summary and No access", ADR 0082). An
// account gone, only while the connection is up (none of its repositories still watched, and it is no account the
// sign-in reaches), is one No access notice with the accounts list's fix for it; a suspended account, or one with a
// cause, is still reached, so never gone: the band and its head say it. The rest are quiet: one alone as before, from
// two up the summary, held a summary down to one while the app is open (`LeftSummary`, on the store). With the
// connection down every departed repository is quiet and the band speaks.
import {
  accountOf,
  type DepartedRepository,
  type RepositoryId,
  type State,
  sameLogin,
} from "@lookover/contracts";
import { type AccountLink, unreachedFix } from "./accounts.ts";
import { plural, repositoryLabel } from "./format.ts";
import { HeldValue } from "./held.ts";

/** An account the App no longer reaches, said once for all its departed repositories. */
export interface AccountGone {
  /** The account's login, as its repositories name it. */
  key: string;
  label: string;
  text: string;
  /** Every repository the notice names, its × dismisses them all. */
  repoIds: [RepositoryId, ...RepositoryId[]];
  fix: AccountLink;
}

/** The departed repositories, partitioned: the accounts gone, then the quiet ones in the service's order. */
interface DepartedSaid {
  gone: AccountGone[];
  quiet: DepartedRepository[];
}

/** The quiet ones as Repositories shows them: none, one alone, or the summary with the ids it shows. */
type QuietShown =
  | { kind: "none" }
  | { kind: "one"; repo: DepartedRepository }
  | {
      kind: "summary";
      summary: string;
      /** Show's and Hide's words, and their accessible names: what they open, so the toggle is never a bare "Show". */
      toggle: { show: string; hide: string; showName: string; hideName: string };
      lines: SummaryLine[];
      repoIds: [RepositoryId, ...RepositoryId[]];
    };

/** One repository in the summary's list: its name, and its Dismiss's accessible name. */
interface SummaryLine {
  id: RepositoryId;
  name: string;
  dismiss: string;
}

export const DEPARTED = {
  noAccess: "No access",
  left: "Left",
  dismissAll: "Dismiss all",
  addBack: "Add it back",
  dismiss: "Dismiss",
  show: "Show",
  hide: "Hide",
} as const;

const goneText = (login: string, n: number) =>
  `Lookover no longer has access to ${login}. ${
    n === 1 ? "Its repository is" : `Its ${n} repositories are`
  } no longer reviewed.`;

/** The summary's sentence, whole and plain, flush under its label; its Show is at the notice's action edge. */
const summaryText = (n: number) => `${plural(n, "repository", "repositories")} left the App's installation.`;

/** What the summary's Show (Hide once open) opens, for its accessible name: "the 10 repositories", "the repository". */
const listed = (n: number) => (n === 1 ? "the repository" : `the ${n} repositories`);

/**
 * The departed repositories of the accounts gone, by login in the order their first one departed; empty with the
 * connection down. Gone: no repository of it still watched, and no account reached by that login.
 */
function goneAccounts(
  state: Pick<State, "connection" | "departed" | "repos">,
): Map<string, DepartedRepository[]> {
  const gone = new Map<string, DepartedRepository[]>();
  if (state.connection.state !== "connected") return gone;
  for (const d of state.departed) {
    const key = [...gone.keys()].find((k) => sameLogin(k, d.owner));
    if (key !== undefined) {
      gone.get(key)?.push(d);
      continue;
    }
    if (accountOf(state.connection.accounts, d.owner) !== undefined) continue;
    if (state.repos.some((r) => sameLogin(r.owner, d.owner))) continue;
    gone.set(d.owner, [d]);
  }
  return gone;
}

/** The departed repositories said quietly: every one not of an account gone. */
function quietOf(state: Pick<State, "connection" | "departed" | "repos">): DepartedRepository[] {
  const gone = [...goneAccounts(state).values()].flat();
  return state.departed.filter((d) => !gone.includes(d));
}

/** The departed repositories by how they went, in the service's order. */
export function departedSaid(state: State): DepartedSaid {
  const gone: AccountGone[] = [];
  for (const [login, [first, ...rest]] of goneAccounts(state)) {
    if (first === undefined) continue;
    gone.push({
      key: login,
      label: DEPARTED.noAccess,
      text: goneText(login, rest.length + 1),
      repoIds: [first.id, ...rest.map((r) => r.id)],
      fix: unreachedFix(state, login),
    });
  }
  return { gone, quiet: quietOf(state) };
}

/**
 * What Repositories shows of the departed: the accounts gone, then the quiet ones, a summary from two up or while
 * `held` (the summary was shown since the app opened, `LeftSummary`), down to one.
 */
export function departedShown(state: State, held: boolean): { gone: AccountGone[]; quiet: QuietShown } {
  const { gone, quiet } = departedSaid(state);
  const [first, ...rest] = quiet;
  if (first === undefined) return { gone, quiet: { kind: "none" } };
  if (rest.length === 0 && !held) return { gone, quiet: { kind: "one", repo: first } };
  return {
    gone,
    quiet: {
      kind: "summary",
      summary: summaryText(quiet.length),
      toggle: {
        show: DEPARTED.show,
        hide: DEPARTED.hide,
        showName: `${DEPARTED.show} ${listed(quiet.length)}`,
        hideName: `${DEPARTED.hide} ${listed(quiet.length)}`,
      },
      lines: quiet.map((r) => {
        const name = repositoryLabel(r);
        return { id: r.id, name, dismiss: `${DEPARTED.dismiss} ${name}` };
      }),
      repoIds: [first.id, ...rest.map((r) => r.id)],
    },
  };
}

/**
 * Whether the quiet ones are said as the summary, held for the app while it is open: the store's `see` on every
 * state it takes holds it once two or more are quiet, down to one; none left lets it go, so a later one alone is said
 * alone. The value changes only when it moves.
 */
export class LeftSummary extends HeldValue<boolean> {
  constructor() {
    super(false);
  }

  see(state: Pick<State, "connection" | "departed" | "repos">): void {
    const shown = this.get();
    if (!shown && state.departed.length < 2) return;
    const n = quietOf(state).length;
    const next = n === 0 ? false : shown || n >= 2;
    if (next !== shown) this.set(next);
  }
}
