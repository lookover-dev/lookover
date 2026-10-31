// The person's own `gh` (ADR 0059), in memory: who it is signed in as, that account's active memberships with its role
// in each (ADR 0067), and its membership of one organisation. The port and its shapes are contracts' (`Gh`); the real
// one is the service's (`ghCli`), and `describeGh` holds both to one contract.
import type { Gh, GhUnanswered, GhWhy, HostLogin } from "@lookover/contracts";

/** One account's membership of one organisation, as the fake keeps it. */
export interface GhMember {
  state: "active" | "pending";
  admin: boolean;
}

/**
 * The fake: `gh` signed in as `as` (`null`: signed out; `"missing"`: not installed), organisations and their members
 * kept per account, so another sign-in reads another person's memberships; each account answered with its id and login
 * only, as `gh` answers, whatever else it was given. `fail(why)` makes every read "can't answer"
 * with `why` until `null` (`scope` spares `person`, which needs none); `fail(why, organisation)` that organisation's
 * membership alone, and the list of memberships too when `why` is `sso` (GitHub's `partial-results`).
 */
export interface MemoryGh extends Gh {
  signIn(as: HostLogin | null | "missing"): void;
  join(organisation: HostLogin, person: HostLogin, member: GhMember): void;
  leave(organisation: string, person: HostLogin): void;
  fail(why: GhWhy | null, organisation?: string): void;
  /** Signed out, with no organisation, membership or failure kept: as a new one. */
  empty(): void;
}

/** The detail the fake gives for each `why`: words of the kind `gh` says. */
const DETAIL: Record<GhWhy, string> = {
  offline: "error connecting to api.github.com",
  sso: "Resource protected by organization SAML enforcement (HTTP 403)",
  scope: 'This API operation needs the "read:org" scope',
  timeout: "gh didn't answer in time",
  failed: "gh failed",
};

const unanswered = (why: GhWhy): GhUnanswered => ({ kind: "unanswered", why, detail: DETAIL[why] });

export function memoryGh(o: { as?: HostLogin | null | "missing" } = {}): MemoryGh {
  let as: HostLogin | null | "missing" = o.as ?? null;
  let failing: GhWhy | null = null;
  const failingOrganisation = new Map<string, GhWhy>();
  const organisations = new Map<string, HostLogin>();
  /** Per organisation's login (lower case), per person's id. */
  const members = new Map<string, Map<number, GhMember>>();
  const key = (login: string) => login.toLowerCase();

  /** Who answers, or why nobody does; `org` when the read needs an organisation's scope. */
  const signedIn = (org: boolean): HostLogin | GhUnanswered => {
    if (as === "missing") return { kind: "missing" };
    if (as === null) return { kind: "signed-out" };
    if (failing !== null && (org || failing !== "scope")) return unanswered(failing);
    return as;
  };
  const isAccount = (x: HostLogin | GhUnanswered): x is HostLogin => "id" in x;

  return {
    person: async () => {
      const who = signedIn(false);
      return isAccount(who) ? { kind: "signed-in", account: { ...who } } : who;
    },
    memberships: async () => {
      const who = signedIn(true);
      if (!isAccount(who)) return who;
      // GitHub leaves an SSO organisation out of the list and says so (`partial-results`): the list can't answer.
      if ([...failingOrganisation.values()].includes("sso")) return unanswered("sso");
      const listed = [...organisations.entries()].flatMap(([login, organisation]) => {
        const member = members.get(login)?.get(who.id);
        if (member?.state !== "active") return [];
        return [{ organisation: { ...organisation }, role: member.admin ? "owner" : "member" } as const];
      });
      return { kind: "listed", person: { ...who }, organisations: listed };
    },
    membership: async (organisation) => {
      const who = signedIn(true);
      if (!isAccount(who)) return who;
      const failed = failingOrganisation.get(key(organisation));
      if (failed !== undefined) return unanswered(failed);
      const member = members.get(key(organisation))?.get(who.id);
      if (member === undefined) return { kind: "absent" };
      return { kind: member.state, person: { ...who }, admin: member.admin };
    },
    signIn: (account) => {
      as = account === null || account === "missing" ? account : { id: account.id, login: account.login };
    },
    join: (organisation, person, member) => {
      organisations.set(key(organisation.login), { id: organisation.id, login: organisation.login });
      const held = members.get(key(organisation.login)) ?? new Map<number, GhMember>();
      held.set(person.id, { ...member });
      members.set(key(organisation.login), held);
    },
    leave: (organisation, person) => {
      members.get(key(organisation))?.delete(person.id);
    },
    fail: (why, organisation) => {
      if (organisation === undefined) failing = why;
      else if (why === null) failingOrganisation.delete(key(organisation));
      else failingOrganisation.set(key(organisation), why);
    },
    empty: () => {
      as = null;
      failing = null;
      failingOrganisation.clear();
      organisations.clear();
      members.clear();
    },
  };
}
