// The person's own `gh` (ADR 0059): the port that says who the GitHub CLI is signed in as and that account's active
// organisation memberships with its role in each (ADR 0067): the organisations the shared App doesn't reach yet. The
// service runs the real one (`apps/service/src/gh.ts`), testkit keeps the fake (`memoryGh`) and the suite
// (`describeGh`) that holds both to these shapes.

import type { HostLogin } from "./github-app.ts";

/**
 * Why `gh` gave no answer it can trust: GitHub out of reach (`offline`), an organisation's SAML single sign-on the
 * token isn't authorised for (`sso`), a token without the scope the call needs (`scope`, `read:org`), no answer in
 * time (`timeout`), anything else (`failed`).
 */
export type GhWhy = "offline" | "sso" | "scope" | "timeout" | "failed";

/** No answer, as the setup shows it: `gh` isn't installed, isn't signed in, or couldn't answer, with why. */
export type GhNoAnswer = { kind: "missing" } | { kind: "signed-out" } | { kind: "unanswered"; why: GhWhy };

/**
 * No answer, as the port gives it: `GhNoAnswer`, with `gh`'s own words when it couldn't answer. Those go to the log
 * only, never in what the service sends.
 */
export type GhUnanswered =
  | Exclude<GhNoAnswer, { kind: "unanswered" }>
  | { kind: "unanswered"; why: GhWhy; detail: string };

/** Who `gh` is signed in as. */
export type GhPerson = { kind: "signed-in"; account: HostLogin } | GhUnanswered;

/** The account's role in an organisation, in GitHub's people page's words: an owner (the API's `admin`) or a member. */
export type GhRole = "owner" | "member";

/** One organisation the signed-in account is an active member of, with its role there. */
export interface GhOrganisation {
  organisation: HostLogin;
  role: GhRole;
}

/**
 * Every organisation the signed-in account is an active member of, in `gh`'s order, each with its role, and who that
 * account is (`person`, its id and login: the shared App's person is compared by id, ADR 0067). Pending invitations
 * are left out. No answer is unknown, never an empty list: `gh` missing, signed out, or unable to answer (offline, a
 * token without `read:org`, an organisation's SSO hiding it from the list, anything else).
 */
export type GhMemberships =
  | { kind: "listed"; person: HostLogin; organisations: GhOrganisation[] }
  | GhUnanswered;

/**
 * The person's own `gh`, read only (`gh api` with `GET`, never a write). Every read answers, never rejects: `missing`
 * (no `gh`), `signed-out`, or `unanswered` with why.
 */
export interface Gh {
  person(): Promise<GhPerson>;
  /** One read of every active membership (ADR 0067): the organisations `Connection.unreached` names. */
  memberships(): Promise<GhMemberships>;
}
