// The person's own `gh` (ADR 0059): the port that says who the GitHub CLI is signed in as, the organisations where
// that account is an active admin, and that account's membership of one organisation; and what the setup's GitHub
// step shows of it (`GhChoices`). Before an App exists the service has no GitHub credential of its own, and an App's
// credentials can't say which person runs Lookover: the person's `gh` login can, since GitHub vouches for it. The
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

/** The organisations where the signed-in account is an active admin. */
export type GhAdminOrganisations = { kind: "listed"; organisations: HostLogin[] } | GhUnanswered;

/**
 * The signed-in account's membership of one organisation: active or pending (invited, not yet accepted), as whom and
 * whether as an admin; absent (not a member, or no such organisation); or no answer.
 */
export type GhMembership =
  | { kind: "active" | "pending"; person: HostLogin; admin: boolean }
  | { kind: "absent" }
  | GhUnanswered;

/**
 * The person's own `gh`, read only (`gh api` with `GET`, never a write). Every read answers, never rejects: `missing`
 * (no `gh`), `signed-out`, or `unanswered` with why.
 */
export interface Gh {
  person(): Promise<GhPerson>;
  adminOrganisations(): Promise<GhAdminOrganisations>;
  /** `organisation` is a login, matched without case as GitHub does; one no organisation can have is `absent`. */
  membership(organisation: string): Promise<GhMembership>;
}

/**
 * Where "Create your App" may make the App (ADR 0059), as the person's `gh` last said it: who it is signed in as, and
 * the organisations where that account is an active admin. Your own account needs neither. `organisations` is
 * `gh`'s refusal itself when `person` is one (nothing more is asked of it then). Never `gh`'s own words.
 */
export interface GhChoices {
  person: { kind: "signed-in"; account: HostLogin } | GhNoAnswer;
  organisations: { kind: "listed"; organisations: HostLogin[] } | GhNoAnswer;
}

/**
 * A command refused because the person's own `gh` gave no answer (ADR 0059), as "Create it on GitHub" and "Use an
 * existing App" both refuse: `gh-missing`, no `gh` on this computer; `gh-signed-out`, `gh` signed in to no account;
 * `gh-unanswered`, `gh` couldn't answer, with why (never `gh`'s own words).
 */
export type GhRefusal =
  | { kind: "gh-missing" }
  | { kind: "gh-signed-out" }
  | { kind: "gh-unanswered"; why: GhWhy };

/** The refusal `gh`'s no answer gives: `gh`'s own words, when it has some, left out. */
export function ghRefusalOf(no: GhNoAnswer): GhRefusal {
  switch (no.kind) {
    case "missing":
      return { kind: "gh-missing" };
    case "signed-out":
      return { kind: "gh-signed-out" };
    case "unanswered":
      return { kind: "gh-unanswered", why: no.why };
  }
}
