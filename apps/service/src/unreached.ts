// The person's accounts on the shared App (ADR 0067): whether they own each account the App reaches, and the accounts
// of theirs it doesn't reach, with the asks to install kept. Its user is the room, which hands it every
// `connection.changed` before it is sent (`completed`) and once it is kept (`held`), and asks it to read the person's
// own `gh` again (`read`).
// - Owners: the person's own account (GitHub's id for it is theirs) is theirs; an organisation is theirs as their
//   `gh` gave their role there; null when it said nothing of it. Always null on `own`, and before a sign-in.
// - Not reached, on `shared` only: the person's own account first while the App isn't installed there (owner true),
//   then the organisations their `gh` names, in its order, without the App, then those asked that it doesn't name,
//   oldest ask first (an ask shows until its organisation is reached). `gh` counts only signed in as the person signed
//   in, compared by GitHub's id, never the login, and only when it lists their organisations: one signed in as
//   another, missing, signed out or unable to answer says nothing, and the organisations it named last stand (a start
//   takes those the replayed log shows). Only a listing replaces them.
// - `gh` is read once per sign-in: at start, once a sign-in is kept, and after each ask; never awaited by discovery,
//   and a read that throws is an unknown answer, logged. Only the latest read is applied, only for the person it was
//   read for, and none once the room stopped (`stop`): its store is closed then.
// - The asks (`ask`, "Ask to install on <org>"): an organisation named as not reached that the person doesn't own,
//   kept in the store with when, the last ask winning; forgotten once the account is reached, and when another person
//   signs in (their asks stay theirs). Refused off `shared` (`not-shared`), for an account not named (`not-named`),
//   or one the person owns (`owner`).
// - Accounts reached, listed by `gh` and asked are matched by GitHub's id, never the login: an organisation renamed
//   between an ask and its install is one account, reached under its new login, its ask forgotten.
// Every change goes out as a `connection.changed`: completed in the patch that moved what it follows from, or sent
// on its own (`settle`) when only `gh` or an ask moved it.
// It must never know: how GitHub lists the accounts (the installation's), or how `gh` is reached (the `Gh` port).
import { isDeepStrictEqual } from "node:util";
import {
  type AskToInstallRefusal,
  type Connection,
  type ConnectionAccount,
  type EventBody,
  type Gh,
  type GhOrganisation,
  type HostLogin,
  sameLogin,
  type UnreachedAccount,
} from "@lookover/contracts";
import type { InstallAsks } from "@lookover/store";
import { said } from "./said.ts";

export interface UnreachedDeps {
  /** The person's own `gh`; none: not installed, an unknown answer. */
  gh: Gh | undefined;
  asks: InstallAsks;
  now(): number;
  /** The connection as the UI holds it now. */
  shown(): Connection;
  emit(body: EventBody): void;
  log(line: string): void;
}

export interface Unreached {
  /**
   * A `connection.changed` patch, sent while the UI holds `was`, with the owners and the accounts not reached as they
   * follow from it, when it moves the way, the person or the accounts. Any other patch as it is. Keeps nothing.
   */
  completed(patch: Partial<Connection>, was: Connection): Partial<Connection>;
  /**
   * A `connection.changed` patch kept, the UI having held `was` before it: the asks it makes stale forgotten in the
   * store, another person's when a new one signed in, and those of the accounts it reaches.
   */
  held(patch: Partial<Connection>, was: Connection): void;
  /** Sends the owners and the accounts not reached when the UI holds others. */
  settle(): void;
  /** The person's own `gh` read again, applied (and sent) when it answers, unless `stop` came first. */
  read(): Promise<void>;
  /** The room stops: a read that answers later is dropped before it reaches the store. */
  stop(): void;
  /** "Ask to install on <org>": kept, sent, and `gh` read again; or refused, nothing kept. */
  ask(account: string): Promise<"ok" | { refused: AskToInstallRefusal }>;
}

/**
 * The organisations the connection `shown` says the person was named in (its accounts' and its accounts not reached
 * owners), in its order: what stands at start until `gh` lists them again.
 */
function namedIn(shown: Connection): GhOrganisation[] {
  const person = shown.person;
  if (shown.way !== "shared" || person === null) return [];
  const reached = shown.accounts.flatMap((a): GhOrganisation[] =>
    a.owner === null || a.account.id === person.id
      ? []
      : [{ organisation: { id: a.account.id, login: a.account.login }, role: a.owner ? "owner" : "member" }],
  );
  const unreached = shown.unreached.flatMap((u): GhOrganisation[] =>
    u.kind !== "organisation" || u.owner === null
      ? []
      : [{ organisation: { ...u.account }, role: u.owner ? "owner" : "member" }],
  );
  return [...reached, ...unreached];
}

export function createUnreached(d: UnreachedDeps): Unreached {
  const atStart = d.shown();
  /** What `gh` last listed, for whom (their id); null with nobody. */
  let named: { person: number; organisations: GhOrganisation[] } | null =
    atStart.person === null ? null : { person: atStart.person.id, organisations: namedIn(atStart) };
  /** The reads asked so far: only the latest one's answer is applied. */
  let reads = 0;
  /** Whether the room stopped: nothing reaches the store, closed then. */
  let stopped = false;

  const organisationsOf = (person: HostLogin): GhOrganisation[] =>
    named?.person === person.id ? named.organisations : [];

  /** The owners and the accounts not reached for the connection `c`. */
  const derived = (c: Connection): Pick<Connection, "accounts" | "unreached"> => {
    const person = c.person;
    if (c.way !== "shared" || person === null)
      return { accounts: c.accounts.map((a) => ({ ...a, owner: null })), unreached: [] };
    const organisations = organisationsOf(person);
    const own = (account: HostLogin) => account.id === person.id;
    const ownerOf = (account: HostLogin): boolean | null => {
      if (own(account)) return true;
      const found = organisations.find((o) => o.organisation.id === account.id);
      return found === undefined ? null : found.role === "owner";
    };
    const accounts: ConnectionAccount[] = c.accounts.map((a) => ({ ...a, owner: ownerOf(a.account) }));
    // By GitHub's id: an organisation renamed since it was asked, listed or named is still the same one.
    const notReached = (account: HostLogin) => !c.accounts.some((a) => a.account.id === account.id);
    const asks = d.asks.of(person.id).filter((a) => notReached(a.account));
    const askedAt = (account: HostLogin) => asks.find((a) => a.account.id === account.id)?.askedAt ?? null;
    const listed = organisations.filter((o) => notReached(o.organisation));
    const unreached: UnreachedAccount[] = [
      ...(c.accounts.some((a) => own(a.account))
        ? []
        : [{ account: { ...person }, kind: "user" as const, owner: true, askedAt: null }]),
      ...listed.map((o) => ({
        account: { ...o.organisation },
        kind: "organisation" as const,
        owner: o.role === "owner",
        askedAt: askedAt(o.organisation),
      })),
      // Asked, and not named by `gh` now: it shows until the organisation is reached.
      ...asks
        .filter((a) => !listed.some((o) => o.organisation.id === a.account.id))
        .map((a) => ({
          account: { ...a.account },
          kind: "organisation" as const,
          owner: false,
          askedAt: a.askedAt,
        })),
    ];
    return { accounts, unreached };
  };

  /** The part of `next` that differs from what the UI holds (`was`). */
  const moved = (next: Pick<Connection, "accounts" | "unreached">, was: Connection): Partial<Connection> => ({
    ...(isDeepStrictEqual(next.accounts, was.accounts) ? {} : { accounts: next.accounts }),
    ...(isDeepStrictEqual(next.unreached, was.unreached) ? {} : { unreached: next.unreached }),
  });

  const settle = (): void => {
    const shown = d.shown();
    const patch = moved(derived(shown), shown);
    if (Object.keys(patch).length > 0) d.emit({ type: "connection.changed", at: d.now(), patch });
  };

  /** The organisations the person's `gh` lists now; null when it says nothing of them (not signed in as them). */
  const organisationsNow = async (person: HostLogin): Promise<GhOrganisation[] | null> => {
    try {
      const answer = d.gh === undefined ? null : await d.gh.memberships();
      return answer?.kind === "listed" && answer.person.id === person.id ? answer.organisations : null;
    } catch (error) {
      d.log(`your gh could not be read for your organisations: ${said(error)}`);
      return null;
    }
  };

  const read = async (): Promise<void> => {
    const shown = d.shown();
    const person = shown.person;
    if (stopped || shown.way !== "shared" || person === null) return;
    const at = ++reads;
    const organisations = await organisationsNow(person);
    if (stopped || organisations === null || at !== reads || d.shown().person?.id !== person.id) return;
    named = { person: person.id, organisations };
    settle();
  };

  return {
    completed: (patch, was) => {
      if (!("accounts" in patch || "person" in patch || "way" in patch)) return patch;
      const { accounts, unreached } = derived({ ...was, ...patch });
      return {
        ...patch,
        ...("accounts" in patch || !isDeepStrictEqual(accounts, was.accounts) ? { accounts } : {}),
        ...(isDeepStrictEqual(unreached, was.unreached) ? {} : { unreached }),
      };
    },
    held: (patch, was) => {
      const next: Connection = { ...was, ...patch };
      const person = next.person;
      // Another person signed in: nobody else's asks are theirs.
      if (person !== null && person.id !== was.person?.id) d.asks.signedIn(person.id);
      if (next.way === "shared" && "accounts" in patch)
        for (const a of next.accounts) d.asks.reached(a.account.id);
    },
    settle,
    read,
    stop: () => {
      stopped = true;
    },
    ask: async (account) => {
      const shown = d.shown();
      const person = shown.person;
      if (shown.way !== "shared" || person === null) return { refused: "not-shared" };
      const found = shown.unreached.find(
        (u) => u.kind === "organisation" && sameLogin(u.account.login, account),
      );
      if (found === undefined) return { refused: "not-named" };
      if (found.owner === true) return { refused: "owner" };
      d.asks.asked(person.id, found.account, d.now());
      settle();
      void read().catch((error) => d.log(`your organisations could not be shown again: ${said(error)}`));
      return "ok";
    },
  };
}
