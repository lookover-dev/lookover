// The contract of the person's `gh` (ADR 0059), written once: what the port that runs `gh` must answer, and how it
// says it can't. Run against `memoryGh` in every check, against the service's real adapter on a scripted `gh` in the
// service's tests, and against the owner's real `gh` in `bun run live` (reads only). Each case asks `setup` for a port
// in the state it needs: signed in (always), then, each optional, signed out, not installed, GitHub out of reach, a
// token without `read:org`, an organisation behind SAML single sign-on. A state the real `gh` can't be brought to on
// demand is left out of its setup, and that case is skipped. Every read answers: none rejects.
import { describe, expect, test } from "bun:test";
import type { Gh, GhMembership, GhMemberships, GhPerson, HostLogin } from "@lookover/contracts";

export interface GhFixture {
  gh: Gh;
  /** The account `gh` is signed in as, its id and login exactly. */
  person: HostLogin;
  /**
   * Organisations where the person is an active owner (GitHub's API: admin): each must be listed as an owner (live,
   * `gh` may list more).
   */
  admin: HostLogin[];
  /** Organisations where the person is an active member, not an owner: each must be listed as a member. */
  member?: HostLogin[];
  /** An organisation the person was invited to and hasn't joined: pending. None: not checked. */
  pending?: HostLogin;
  /** An organisation's login the person isn't a member of. */
  absent: string;
}

export interface GhSetup {
  signedIn(): Promise<GhFixture>;
  /** `gh` installed, signed in to no account. None: skipped. */
  signedOut?: () => Promise<Gh>;
  /** No `gh` to run. None: skipped. */
  missing?: () => Promise<Gh>;
  /** `gh` signed in, GitHub out of reach. None: skipped. */
  offline?: () => Promise<Gh>;
  /** `gh` signed in with a token that lacks `read:org`. None: skipped. */
  noReadOrg?: () => Promise<Gh>;
  /** `organisation` enforces SAML single sign-on, and `gh`'s token isn't authorised for it. None: skipped. */
  sso?: () => Promise<{ gh: Gh; organisation: string }>;
}

type Answer = GhPerson | GhMemberships | GhMembership;

/** An answer's kind, and why for one that can't answer, with whether it gave `gh`'s words. */
const kindOf = (answer: Answer): string =>
  answer.kind === "unanswered"
    ? `unanswered: ${answer.why}${answer.detail.trim() === "" ? ", no words" : ""}`
    : answer.kind;

/** Every read of `gh`, an organisation's with `organisation`, by kind. */
const everyRead = async (gh: Gh, organisation: string): Promise<string[]> =>
  (await Promise.all([gh.person(), gh.memberships(), gh.membership(organisation)])).map(kindOf);

/** The memberships `gh` lists, or the case fails saying why it listed none. */
async function listed(gh: Gh): Promise<Extract<GhMemberships, { kind: "listed" }>> {
  const answer = await gh.memberships();
  if (answer.kind !== "listed") throw new Error(`gh listed nothing: ${kindOf(answer)}`);
  return answer;
}

/** A case for a state the setup may not bring the port to: skipped when it can't. */
function when<T>(
  make: (() => Promise<T>) | undefined,
  title: string,
  body: (made: T) => Promise<void>,
): void {
  (make === undefined ? test.skip : test)(title, async () => {
    if (make !== undefined) await body(await make());
  });
}

export function describeGh(name: string, setup: GhSetup): void {
  describe(`the person's gh (${name})`, () => {
    test("who: the account gh is signed in as, by its numeric id and its login", async () => {
      const { gh, person } = await setup.signedIn();
      expect(await gh.person()).toEqual({ kind: "signed-in", account: person });
    });

    test("memberships: who gh is, each owner's organisation as an owner and each member's as a member", async () => {
      const { gh, person, admin, member } = await setup.signedIn();
      const answer = await listed(gh);
      expect(answer.person).toEqual(person);
      for (const organisation of admin)
        expect(answer.organisations).toContainEqual({ organisation, role: "owner" });
      for (const organisation of member ?? [])
        expect(answer.organisations).toContainEqual({ organisation, role: "member" });
    });

    test("memberships: each active organisation once, by id and login, never one only invited to", async () => {
      const { gh, pending } = await setup.signedIn();
      const { organisations } = await listed(gh);
      const ids = organisations.map((o) => o.organisation.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const { organisation, role } of organisations) {
        expect(Number.isInteger(organisation.id)).toBe(true);
        expect(organisation.login).toMatch(/^[A-Za-z0-9-]+$/);
        expect(["owner", "member"]).toContain(role);
      }
      if (pending !== undefined) expect(ids).not.toContain(pending.id);
    });

    test("membership: each organisation memberships lists, read alone, says the same role, as the person", async () => {
      const { gh, person } = await setup.signedIn();
      const answer = await listed(gh);
      for (const { organisation, role } of answer.organisations)
        expect(await gh.membership(organisation.login)).toEqual({
          kind: "active",
          person,
          admin: role === "owner",
        });
    });

    test("membership: an organisation's login matched without case, as GitHub does", async () => {
      const { gh, person, admin } = await setup.signedIn();
      for (const organisation of admin.slice(0, 1))
        expect(await gh.membership(organisation.login.toUpperCase())).toEqual({
          kind: "active",
          person,
          admin: true,
        });
    });

    test("membership: an active member who isn't an admin reads active, not as an admin", async () => {
      const { gh, person, member } = await setup.signedIn();
      for (const organisation of member ?? [])
        expect(await gh.membership(organisation.login)).toEqual({ kind: "active", person, admin: false });
    });

    test("membership: an invitation not yet accepted reads pending", async () => {
      const { gh, person, pending } = await setup.signedIn();
      if (pending !== undefined)
        expect(await gh.membership(pending.login)).toMatchObject({ kind: "pending", person });
    });

    test("membership: an organisation the person isn't in reads absent, and so does a login no organisation can have", async () => {
      const { gh, absent } = await setup.signedIn();
      expect(await gh.membership(absent)).toEqual({ kind: "absent" });
      expect(await gh.membership("not/an organisation")).toEqual({ kind: "absent" });
      expect(await gh.membership("")).toEqual({ kind: "absent" });
    });

    when(setup.signedOut, "signed out: every read says so", async (gh) => {
      expect(await everyRead(gh, "lookover-dev")).toEqual(["signed-out", "signed-out", "signed-out"]);
    });

    when(setup.missing, "not installed: every read says so", async (gh) => {
      expect(await everyRead(gh, "lookover-dev")).toEqual(["missing", "missing", "missing"]);
    });

    when(
      setup.offline,
      "GitHub out of reach: every read can't answer, offline, with gh's words",
      async (gh) => {
        const offline = "unanswered: offline";
        expect(await everyRead(gh, "lookover-dev")).toEqual([offline, offline, offline]);
      },
    );

    when(
      setup.noReadOrg,
      "a token without read:org: who it is answers, the organisations' reads can't, for the scope",
      async (gh) => {
        const scope = "unanswered: scope";
        expect(await everyRead(gh, "lookover-dev")).toEqual(["signed-in", scope, scope]);
      },
    );

    when(
      setup.sso,
      "an organisation behind SAML single sign-on: its membership and the list of memberships can't answer, for SSO",
      async ({ gh, organisation }) => {
        expect(kindOf(await gh.membership(organisation))).toBe("unanswered: sso");
        expect(kindOf(await gh.memberships())).toBe("unanswered: sso");
        expect((await gh.person()).kind).toBe("signed-in");
      },
    );
  });
}
