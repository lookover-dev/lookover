// The person's membership of the organisation whose App it is (ADR 0059), as their own `gh` answers it: what "Use an
// existing App" asks before taking an organisation's App, and what the service asks at start and every hour once it
// runs on one. Only `gh` signed in as the person can answer for them: an answer for another account, or none (`gh`
// not installed, signed out, offline, SAML SSO, no `read:org`), is no answer, and the last one stands.
// It must never know: the App's key, GitHub's App-level calls, or what stops when the person is no longer a member.
import type { Gh, GhMembership, HostLogin } from "@lookover/contracts";
import type { Membership } from "./app-store.ts";
import { membershipLines } from "./log-lines.ts";

/**
 * The account `gh` is signed in as and its membership of one organisation: `GhMembership`, with that account named
 * when it isn't a member too.
 */
export type GhMember = Exclude<GhMembership, { kind: "absent" }> | { kind: "absent"; person: HostLogin };

/**
 * The account `gh` is signed in as and its membership of `organisation`: `absent` asks who that account is too, so a
 * refusal can name it. No `gh`: not installed.
 */
export async function memberOf(gh: Gh | undefined, organisation: string): Promise<GhMember> {
  if (gh === undefined) return { kind: "missing" };
  const membership = await gh.membership(organisation);
  if (membership.kind !== "absent") return membership;
  const person = await gh.person();
  return person.kind === "signed-in" ? { kind: "absent", person: person.account } : person;
}

/**
 * What `gh`'s answer says of `person`'s membership of `organisation`: a member (active), or not one (absent, or only
 * invited); or no answer, with the log's line saying why the last answer stands.
 */
export function membershipOf(
  person: HostLogin,
  organisation: string,
  answer: GhMember,
): { membership: Membership } | { unanswered: string } {
  switch (answer.kind) {
    case "missing":
      return { unanswered: membershipLines.ghMissing(organisation) };
    case "signed-out":
      return { unanswered: membershipLines.ghSignedOut(organisation) };
    case "unanswered":
      return { unanswered: membershipLines.ghUnanswered(organisation, answer.why, answer.detail) };
    case "active":
    case "pending":
    case "absent":
      if (answer.person.id !== person.id)
        return {
          unanswered: membershipLines.anotherAccount(organisation, answer.person.login, person.login),
        };
      return { membership: answer.kind === "active" ? "member" : "not-a-member" };
  }
}
