// An in-memory Git host: `HostIntake` and `HostWriter` for the owner's repositories (`repo`, then `repositories`; a
// change, a comment, a listing's version are each a repository's), and `HostInstallations` for the owner's App, a world
// a test moves. Changes open, close, are marked ready and pushed after construction (a push with its commit count, or
// rewriting the head); the owner and others write and edit comments, stamped by the injected clock; the bot reacts. It
// records every post in order (a check created, updated and completed, ADR 0043) and knows GitHub's rules as spike 03
// recorded them (ADR 0022): one comment outside the diff fails the whole review and posts nothing; a check output over
// the byte limit is refused; the bot's own comments are told by its numeric user id; a repeated reaction stays one; a
// listing read again with nothing changed says `unchanged` (GitHub's `304`), and a comment or a review changes the open
// changes' listing too, as it moves a pull request's last update on GitHub. A test that passes here would pass on
// GitHub.
// It is brought to refuse as GitHub does on a bad day: every call (`refuse`), the check writes (`refuseChecks`), the
// compare (`refuseCounts`), or the next post once (`refuseNext`), kept on the host or not: GitHub answered a review
// it had saved "422 An internal error occurred".
// The App and its installation (ADR 0053) move as the owner moves them on GitHub: made from a manifest (`createApp`,
// which gives the code `convertManifest` converts once within the hour; the fake GitHub pages call it), installed on
// every repository or some (`install`, a new installation id after `uninstall`), suspended (`suspend`, `unsuspend`), a
// repository added to or removed from the installation (`addRepository`, `removeRepository`), one archived (`archive`:
// left out of the installation's listing), its key revoked (`revokeKey`) and a new one generated (`generateKey`) and
// used by the ports (`useKey`); `credentials` gives the App's id and the key the ports sign with. Apps an
// organisation's admin made and handed over (`handed`, ADR 0059) are described to the key handed with each and
// installed nowhere. The repository ports refuse as GitHub does: the key refused, `unauthorized` (cause `key-refused`:
// `revoked` for a key the App doesn't take, `app-deleted` for an id it isn't, none for a text that isn't a key, as
// `@lookover/github` reads GitHub's words); no installation, `not_found` (cause `uninstalled`, ADR 0047's demo setup
// installs it on the fake); suspended, `unauthorized` (cause `uninstalled`, suspended); a repository the installation
// leaves out, `not_found` with no cause. The agent's calls through `asAgent` go on whatever the App's state, as the
// agent has a token of its own.
// Made with `person`, the repository ports post as that person signed in to the App (ADR 0066), as spike 20 saw
// GitHub do it: the review, its line comments, the replies and the reactions are theirs, with no bot flag; the
// summary, an issue comment, also names the App that posted it, so one they wrote by hand is never the summary; the
// checks are still the App's. Lookover's threads are then the person's roots holding a finding marker. `postAs`
// moves who posts between the person and the bot, as demo mode's service moves between its two ways.
// That person signs in to the shared App by the device flow (`HostSignIn`, ADR 0066, `fake-sign-in.ts`): a code they
// enter on GitHub's page (`enterCode`) or refuse (`denyCode`), a sign-in refreshed with its refresh token, spent
// once used, and every refresh token refused once they take the App's authorisation back (`revokeSignIn`); signed out
// (`signOut`), every repository and every account is refused as signed out until a new code is polled. What they
// reach is `HostAccounts`: who they are (`person`) and every installation (`accounts`), the App's own on its account
// and, given `reaches`, the shared App's on other accounts, each with its repositories, which the repository ports serve
// through that installation. One suspended (`suspend(login, by)`, `by` named as who suspended it) or whose
// organisation asks for SAML SSO (`askSso`, until `signInSso`) is that account's cause in `accounts`, and refuses its
// own repositories alone, as GitHub's 403s do; one uninstalled (`uninstall(login)`) is no longer listed, its
// repositories refused as not found. The person's organisations without the App (`unreached`, ADR 0067) are not
// listed until an owner installs it there (`installOn(login)`), last.
// `asAgent` is the same host seen by a coding agent with its own token (`AgentHost`, ADR 0021): it reads the checks of
// a commit from one App only (each check keeps the slug of the App that made it; the bot's App is its login without
// `[bot]`), answers the agent's own account, and writes comments as it; it reads Lookover's threads (the bot's roots,
// or the person's when asked by their id) with their thread ids (`PRRT_<root id>`) and whether they are resolved,
// replies in them as the agent and resolves them, as GitHub's GraphQL lets a person do and the App can't. Made with
// `mayResolve: false`, the agent's token may not resolve a thread, and `resolve` is refused as GitHub refuses it.
import type {
  AgentCheck,
  AgentHost,
  AgentThread,
  AppCredentials,
  ChangeRef,
  CheckConclusion,
  CheckOutput,
  Clock,
  CommitCount,
  CommitSha,
  DeviceGrant,
  DevicePoll,
  DiffLocation,
  DiffSide,
  FetchSpec,
  HostAccount,
  HostAccounts,
  HostApp,
  HostChange,
  HostCheck,
  HostComment,
  HostConversationComment,
  HostFailure,
  HostInlineComment,
  HostInstallation,
  HostInstallations,
  HostIntake,
  HostLogin,
  HostReview,
  HostSignIn,
  HostThread,
  HostView,
  HostViewComment,
  HostWriter,
  InlineComment,
  KeyRefusal,
  Listing,
  ManifestConversion,
  Minimized,
  MinimizeReason,
  OpenCheckStatus,
  ReachedAccount,
  Reaction,
  RepositoryRef,
  ReviewPost,
  SignIn,
} from "@lookover/contracts";
import {
  APP_PERMISSIONS,
  CHECK_NAME,
  CHECK_OUTPUT_MAX_BYTES,
  COMMENT_MAX_BYTES,
  changeName,
  findingOfMarker,
  HostError,
  PRIVATE_KEY_ARMOUR,
  repositoryName,
  SUMMARY_MARKER,
  sameRepository,
  utf8Bytes,
} from "@lookover/contracts";
import { FakeSignIn } from "./fake-sign-in.ts";

/** Lines a comment can go on: `from` to `to` inclusive, on one side of one file. */
export interface CommentableRange {
  path: string;
  side: DiffSide;
  from: number;
  to: number;
}

/** A change as the fake holds it: what the host shows (on GitHub, always), plus which lines its diff has. */
export interface FakeChange extends Omit<HostChange, "host" | "fork"> {
  /** The repository it is in: one the host holds. The first (`FakeGitHostOptions.repo`) when not given. */
  repo?: RepositoryRef;
  /**
   * Its head is in another repository than its base, or in one deleted since (ADR 0048). None: it isn't. The fake
   * still holds a fork's head on a branch of its own repository (the planted sandbox's), so that the fetch spec's
   * branches bring it, as GitHub's `refs/pull/<n>/head` does.
   */
  fork?: boolean;
  diff: CommentableRange[];
  /**
   * Its own commits' messages, oldest first: its head then sits on its base with that many commits, which the
   * compare from its base counts and gives. None: the head is a commit of its own, related to nothing.
   */
  messages?: string[];
}

export interface FakeGitHostOptions {
  /** The owner's first repository: where a change, a seeded issue comment or another App's check is when not said. */
  repo: RepositoryRef;
  /** The owner's other repositories on the host, after `repo`, in the order GitHub lists them. */
  repositories?: RepositoryRef[];
  /** The reviewer bot, as the host knows it: the numeric id is its identity (ADR 0006). */
  bot: { id: number; login: string };
  /**
   * The person signed in to the App, whom the repository ports post as (ADR 0066's `shared` way), as spike 20 saw
   * GitHub do it: every review, line comment, reply and reaction is theirs, no bot's; the summary, an issue comment,
   * also names the App that posted it (`performed_via_github_app`), so one they wrote by hand is not it; the checks
   * are still the App's. The bot posts when not given.
   */
  person?: { id: number; login: string };
  /**
   * The page each device code names to be entered on (`DeviceCode.verificationUri`): GitHub's when not given; demo
   * mode gives its fake's (`fakeGitHubPages`' `<web>/login/device`), so nothing it shows opens github.com.
   */
  devicePage?: string;
  /** The changes open at the start. */
  changes: FakeChange[];
  /** Where the fetch spec points: a local bare repository, so `retrieval` runs real git on it. GitHub's URL by default. */
  cloneUrl?: string;
  /** The repository's default branch, as the fetch spec names it. `main` when not given. */
  defaultBranch?: string;
  /** The host's clock, which stamps comments and listings. The real time when not given. */
  clock?: Clock;
  /** The owner's App, whose bot `bot` is: its slug is the bot's login without `[bot]`. */
  app?: FakeAppOptions;
  /**
   * Whether the App is installed at the start, on every repository of the owner's: not installed, it has no
   * token, and every call of the repository ports is refused as GitHub refuses an App with no installation
   * (`not_found`) until `install()`. Installed when not given, unless no App is made.
   */
  installed?: boolean;
  /**
   * Apps made by an organisation's admin, whose id and key were handed to the owner for "Use an existing App" (ADR
   * 0059): GitHub describes each, with Lookover's permissions, to its own key alone, and none is installed here. The
   * owner's App and its installation are unchanged.
   */
  handed?: FakeHandedApp[];
  /**
   * The shared App's other installations the person reaches (ADR 0066), each on its account with the repositories it
   * grants them (all that account's), listed by `accounts` after the App's own in this order; needs `person`. Their
   * repositories answer the repository ports through their own installation: suspended (`suspend(login)`) or asking
   * for SAML SSO (`askSso`), only theirs are refused.
   */
  reaches?: FakeReach[];
  /**
   * The person's organisations where the shared App isn't installed (ADR 0067), each with its repositories: not in
   * `accounts`, their repositories refused as not found, until `installOn` installs it there (an owner did, on
   * GitHub's page); needs `person`.
   */
  unreached?: FakeReach[];
}

/**
 * Another account the person reaches through the shared App: the account, and the repositories granted there.
 * `owners`: the logins GitHub lists as the organisation's owners beside the person (its people page), none when not
 * given.
 */
export interface FakeReach {
  account: HostAccount;
  repositories: RepositoryRef[];
  owners?: string[];
}

/** Another account's installation as the fake keeps it: suspended, or its organisation asking for SAML SSO. */
interface FakeOther {
  id: number;
  account: HostAccount;
  repositories: RepositoryRef[];
  owners?: string[];
  suspended: boolean;
  /** Who suspended it, as `accounts` names them; null when nobody is named. */
  suspendedBy: string | null;
  /** SAML SSO asked, with GitHub's page for it (null: none given); null while the person's sign-in has a session. */
  sso: { url: string | null } | null;
}

/**
 * Throws unless every repository is the account's: an installation on another account the person reaches grants only
 * that account's repositories.
 */
function onlyItsOwn({ account, repositories }: FakeReach): void {
  const outside = repositories.find((repo) => repo.owner.toLowerCase() !== account.login.toLowerCase());
  if (outside)
    throw new Error(
      `${repositoryName(outside)} is not ${account.login}'s: an installation grants only its account's repositories`,
    );
}

/**
 * An App an organisation's admin made and handed over: its id, its slug, the organisation that owns it, and the text of
 * the key file the owner was given (PEM-shaped).
 */
interface FakeHandedApp {
  id: number;
  slug: string;
  owner: HostAccount;
  key: string;
}

/** The owner's App on the fake host at the start. */
export interface FakeAppOptions {
  /** GitHub's id of the App. 1 when not given. */
  id?: number;
  /**
   * The account that owns it: a personal account named after `repo`'s owner (id 1) when not given, or an
   * organisation's (ADR 0059), whose repositories `repo` and `repositories` must then be (the constructor throws
   * otherwise); installed there.
   */
  owner?: HostAccount;
  /** What it holds: exactly Lookover's (`APP_PERMISSIONS`) when not given. */
  permissions?: HostApp["permissions"];
  /** Whether the App exists yet: not made, there is none until a manifest makes one (`createApp`). Made when not given. */
  made?: boolean;
  /**
   * The text of the key file downloaded when it was made, which the repository ports sign with (PEM-shaped): what a
   * scenario gives "Use an existing App". A generated one when not given.
   */
  key?: string;
}

/** What `createApp` takes of a manifest (GitHub's field names): the App's name, and the permissions it asks. */
export interface FakeManifest {
  name: string;
  /** Just `metadata: read` when not given, as GitHub gives an App that asks for nothing. */
  permissions?: HostApp["permissions"];
}

/** What GitHub's own pages show the owner (`onGitHub`). */
export interface FakeGitHubView {
  /** The account whose pages these are, where the App is or will be made: a person's, or an organisation's. */
  account: HostAccount;
  app: HostApp | null;
  installation: { id: number; suspended: boolean; granted: RepositoryRef[] } | null;
  repositories: { repo: RepositoryRef; archived: boolean }[];
  /**
   * The other accounts the shared App is installed on (ADR 0066), in `accounts`' order: each installation, its
   * repositories, whether it is suspended or its organisation asks for SAML SSO, and the owners GitHub lists.
   */
  reached: FakeGitHubReached[];
  /** The person's organisations where the shared App isn't installed (ADR 0067), until `installOn`, with their owners. */
  unreached: { account: HostAccount; owners: string[] }[];
}

/** Another account's installation of the shared App, as GitHub's pages show it. */
export interface FakeGitHubReached {
  id: number;
  account: HostAccount;
  repositories: RepositoryRef[];
  suspended: boolean;
  sso: boolean;
  owners: string[];
}

/** One post, as the host received it. */
export type HostPost =
  | { kind: "check.created"; sha: CommitSha; checkId: string; status: OpenCheckStatus; output: CheckOutput }
  | { kind: "check.updated"; checkId: string; status: OpenCheckStatus; output: CheckOutput }
  | { kind: "check.completed"; checkId: string; conclusion: CheckConclusion; output: CheckOutput }
  | { kind: "review"; number: number; reviewId: string; review: ReviewPost }
  | { kind: "summary.created" | "summary.edited"; number: number; commentId: string; body: string }
  | { kind: "reaction"; commentId: string; reaction: Reaction }
  | { kind: "reply"; number: number; commentId: number; replyId: string; body: string }
  | { kind: "minimized"; nodeId: string; reason: MinimizeReason };

/** The refusals a host can be brought to: every call refused, whatever it asks (`refuse`). */
export type HostRefusal = Extract<HostFailure, "unauthorized" | "rate_limited" | "unavailable">;

const REFUSED = {
  unauthorized: "The host refused the credentials (401)",
  rate_limited: "The host asked to wait (403, x-ratelimit-remaining: 0)",
  unavailable: "The host could not be reached",
} satisfies Record<HostRefusal, string>;

/** How long GitHub converts a manifest's code: an hour. */
const CODE_LIFETIME_MS = 60 * 60 * 1000;

/** The first installation id the fake gives: far from 1, as GitHub's are, so a suite's "no such installation" is none. */
const FIRST_INSTALLATION = 60_000_001;

/** A private key's text, as GitHub gives one to download: PEM-shaped, so a scan for keys finds it. */
const keyText = (appId: number, n: number) =>
  `-----BEGIN RSA PRIVATE KEY-----\nfake-key-${n}-of-app-${appId}\n-----END RSA PRIVATE KEY-----\n`;

/** A slug as GitHub makes one of an App's name: lower case, words joined by `-`. */
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The owner's App as the fake keeps it: what GitHub says of it, and the keys it takes. */
interface FakeApp extends HostApp {
  keys: string[];
}

/**
 * The account the host's App is on, made or to be made: `app.owner`, else a person named after `repo`'s owner, with
 * `person`'s id when that is them (a user account's id is its person's, as on GitHub), else 1.
 */
const accountOf = ({ app = {}, repo, person }: FakeGitHostOptions): HostAccount =>
  app.owner ?? {
    id: person !== undefined && person.login.toLowerCase() === repo.owner.toLowerCase() ? person.id : 1,
    login: repo.owner,
    type: "User",
  };

/** The App the options make, its slug the bot's login without `[bot]`: null when they say none is made yet. */
function appOf(options: FakeGitHostOptions): FakeApp | null {
  const { app = {}, bot } = options;
  if (app.made === false) return null;
  return {
    id: app.id ?? 1,
    slug: bot.login.replace(/\[bot\]$/, ""),
    owner: accountOf(options),
    permissions: { ...(app.permissions ?? APP_PERMISSIONS) },
    keys: app.key === undefined ? [] : [app.key],
  };
}

/**
 * Throws unless every repository is `owner`'s when it is an organisation: its App is installed only there, and GitHub
 * never lists another account's repository on it.
 */
function onlyTheOrganisations(owner: HostAccount, repositories: RepositoryRef[]): void {
  if (owner.type !== "Organization") return;
  const outside = repositories.find((repo) => repo.owner.toLowerCase() !== owner.login.toLowerCase());
  if (outside)
    throw new Error(
      `${repositoryName(outside)} is not ${owner.login}'s: an organisation's App holds only its repositories`,
    );
}

/** The App's installation as the fake keeps it: on every repository of the owner's (`all`), or on `selected`. */
interface FakeInstallation {
  id: number;
  suspended: boolean;
  /** Who suspended it, as `accounts` names them; null when nobody is named. */
  suspendedBy: string | null;
  all: boolean;
  selected: RepositoryRef[];
}

/**
 * A post the host can be brought to refuse once (`refuseNext`): a check write, a review, a summary, a reaction, a
 * reply in a thread, a comment minimized.
 */
type PostWrite = "check" | "review" | "summary" | "reaction" | "reply" | "minimize";

/** The next post refused once (`refuseNext`): why, which kind (any when not given), and whether it was kept. */
interface NextRefusal {
  failure: HostRefusal;
  post?: PostWrite;
  saved: boolean;
}

/** What a push changed in one file, on the head side: from `line` on, `removed` lines became `added` ones. */
export interface PushEdit {
  path: string;
  line: number;
  removed: number;
  added: number;
}

/**
 * How a push lands: how many commits it brings (one by default), on top of which commit (the head by default),
 * and their messages, oldest first (`Commit 1 of 2`… by default).
 */
export interface PushHow {
  commits?: number;
  messages?: string[];
  /** The commit the pushed ones sit on: one other than the head rewrites the history, as a force-push does. */
  onto?: CommitSha;
}

/** A change as the fake keeps it: in its repository, open or closed. */
interface Held extends Omit<FakeChange, "repo"> {
  repo: RepositoryRef;
  closed: boolean;
}

/**
 * A conversation comment as the fake keeps it: who put each reaction on it, by numeric id, why it is hidden, and the
 * slug of the App a person's token posted it through (GitHub's `performed_via_github_app`), null when written by hand.
 */
interface Kept extends HostConversationComment {
  repo: RepositoryRef;
  reactedBy: Record<Reaction, Set<number>>;
  minimized: Minimized;
  via: string | null;
}

/** An account as a thread's reply names it: a bot or a person. */
type Author = { id: number; login: string; bot: boolean };

/**
 * An inline comment as the fake keeps it: who wrote it, when (to the second), its host's global id, and the root
 * comment of its thread when it is a reply.
 */
interface Inline extends HostInlineComment {
  nodeId: string;
  author: Author;
  at: number;
  inReplyTo: string | null;
}

/** A review as the fake keeps it: who filed it (the bot, or someone replying in a thread), and its comments. */
interface Filed extends Omit<HostReview, "comments"> {
  author: { id: number; login: string };
  comments: Inline[];
}

/** An inline comment as the host shows it. */
const shownInline = ({
  nodeId: _,
  author: __,
  at: ___,
  inReplyTo: ____,
  ...c
}: Inline): HostInlineComment => ({
  ...c,
});

/** A check as the fake keeps it: with the slug of the App that created it, and the job id it was created for. */
interface Made extends HostCheck {
  repo: RepositoryRef;
  app: string;
  externalId: string;
}

/** A check as the host shows it, without the App that made it or its external id. */
const shownCheck = ({ app: _, externalId: __, repo: ___, ...check }: Made): HostCheck => ({ ...check });

/** A commit as the fake knows it: the one it sits on, how many commits it is past that one, and their messages. */
interface Commit {
  parent: CommitSha | null;
  commits: number;
  messages: string[];
}

/** The listings a client reads again with the ETag of its last answer, one of each per repository. */
type ListingName = "changes" | "comments";

/** A repository as the fake keys it: GitHub compares names without case. */
const keyOf = (repo: RepositoryRef) => repositoryName(repo).toLowerCase();

/** A change's key: its repository's and its number. */
const changeKey = (change: ChangeRef) => changeName(change).toLowerCase();

/** Where a head line that no edit replaced is after the edits (all against the head before the push). */
function shifted(line: number, edits: PushEdit[]): number {
  let shift = 0;
  for (const edit of edits) if (line >= edit.line + edit.removed) shift += edit.added - edit.removed;
  return line + shift;
}

/**
 * Where a head comment's lines are after the edits to its file: a range moves whole, and is gone, like a line,
 * once an edit replaced any of its lines. Null when gone.
 */
function moved(
  { line, endLine }: { line: number; endLine: number | null },
  edits: PushEdit[],
): { line: number; endLine: number | null } | null {
  const last = endLine ?? line;
  if (edits.some((e) => e.line <= last && e.line + e.removed > line && e.removed > 0)) return null;
  return { line: shifted(line, edits), endLine: endLine === null ? null : shifted(endLine, edits) };
}

/** A line, or a range of lines (`line` to `endLine`), that one commentable range holds whole, as GitHub wants. */
const inDiff = (
  change: FakeChange,
  { path, side, line, endLine }: DiffLocation & Pick<InlineComment, "endLine">,
) =>
  change.diff.some(
    (r) =>
      r.path === path &&
      r.side === side &&
      line >= r.from &&
      (endLine ?? line) <= r.to &&
      (endLine ?? line) >= line,
  );

/** GitHub keeps a comment's times to the second. */
const toSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

export class FakeGitHost implements HostIntake, HostWriter, HostInstallations, HostAccounts, HostSignIn {
  /** Every post, in the order it was asked. */
  readonly posts: HostPost[] = [];
  private readonly repo: RepositoryRef;
  /** The owner's repositories, in the order GitHub lists them. */
  private readonly held: RepositoryRef[] = [];
  /** The App's bot: its login follows the App's slug, its id stays. */
  private bot: { id: number; login: string };
  /** The person signed in to the App, whom the ports post as unless told the bot (`postAs`); null when none is. */
  private readonly signedIn: { id: number; login: string } | null;
  /** Who the ports post as: the person signed in (when there is one), or the bot. */
  private postsAs: "bot" | "person";
  /** Signed out on GitHub (`signOut`): every repository refused as signed out until a new sign-in is issued. */
  private signedOut = false;
  private readonly changes: Held[] = [];
  private readonly cloneUrl: string | undefined;
  private readonly defaultBranch: string;
  private readonly clock: Clock;
  /** Every check named `Lookover`, with the slug of the App that created it. */
  private readonly checks: Made[] = [];
  /** Each change's reviews, by `changeKey`. */
  private readonly reviews = new Map<string, Filed[]>();
  private readonly comments: Kept[] = [];
  private readonly history = new Map<CommitSha, Commit>();
  /** Each repository's listings' versions, moved by every change they would show, and those their last read gave. */
  private readonly versions = new Map<string, Record<ListingName, number>>();
  private readonly read = new Map<string, Record<ListingName, number | null>>();
  private nextId = 1;
  private nextInlineId = 100_001;
  /** The root comments, by id, of the threads a person resolved. */
  private readonly resolved = new Set<string>();
  /** The account the App is on, made or to be made: a person's, or an organisation's (ADR 0059). */
  private readonly account: HostAccount;
  /** The owner's App: null until one is made. */
  private made: FakeApp | null;
  /** The key the repository ports sign with, as the service holds it. */
  private signing: string | null;
  /** The App's installation on the owner's account: null when it has none. */
  private current: FakeInstallation | null = null;
  /** The archived repositories, by `keyOf`. */
  private readonly archived = new Set<string>();
  /** The manifests' codes not converted yet, with what each converts to and until when. */
  private readonly codes = new Map<string, { conversion: ManifestConversion; until: number }>();
  /** The Apps an organisation's admin handed over, by id. */
  private readonly handed = new Map<number, FakeApp>();
  /** The shared App's installations on the other accounts the person reaches, in `accounts`' order. */
  private readonly others: FakeOther[] = [];
  /** The person's organisations where the shared App isn't installed, until `installOn`. */
  private readonly unreached: FakeReach[] = [];
  private nextInstallation = FIRST_INSTALLATION;
  private nextKey = 1;
  private nextCode = 1;
  private refusal: { failure: HostRefusal; retryAt?: number } | null = null;
  private checkRefusal: HostRefusal | null = null;
  private countRefusal: HostRefusal | null = null;
  private nextRefusal: NextRefusal | null = null;
  private readonly signIns: FakeSignIn;

  constructor(options: FakeGitHostOptions) {
    this.repo = options.repo;
    for (const repo of [options.repo, ...(options.repositories ?? [])])
      if (!this.held.some((r) => sameRepository(r, repo))) this.held.push(repo);
    this.bot = options.bot;
    this.signedIn = options.person === undefined ? null : { ...options.person };
    this.postsAs = "person";
    this.cloneUrl = options.cloneUrl;
    this.defaultBranch = options.defaultBranch ?? "main";
    this.clock = options.clock ?? { now: () => Date.now() };
    this.signIns = new FakeSignIn(
      this.clock,
      () => {
        if (this.signedIn === null) throw new Error("The fake has no person to sign in: give it `person`");
        return this.signedIn;
      },
      options.devicePage,
    );
    this.account = accountOf(options);
    onlyTheOrganisations(this.account, this.held);
    this.made = appOf(options);
    for (const { id, slug, owner, key } of options.handed ?? [])
      this.handed.set(id, {
        id,
        slug,
        owner: { ...owner },
        permissions: { ...APP_PERMISSIONS },
        keys: [key],
      });
    this.signing = this.made === null ? null : (this.made.keys[0] ?? this.generateKey());
    if (this.made !== null && (options.installed ?? true)) this.install();
    this.reach(options.reaches, options.unreached);
    for (const change of options.changes) this.open(change);
  }

  // The App and its installation, as the owner moves them on GitHub (ADR 0053).

  /**
   * The App's id and the key the repository ports sign with, as the owner downloaded it: what "Use an existing
   * App" is given. Throws when no App is made.
   */
  credentials(): AppCredentials {
    const app = this.theApp();
    if (this.signing === null) throw new Error("The fake's App has no key");
    return { id: app.id, key: this.signing };
  }

  /**
   * The owner installs the App (GitHub's install page), on `repositories` or on every repository of theirs (also
   * those added to the account later) when none are given; already installed, the installation keeps its id and
   * grants these instead. Returns the installation's id: a new one after an uninstall, as GitHub gives.
   */
  install(repositories?: RepositoryRef[]): number {
    this.theApp();
    for (const repo of repositories ?? []) this.ownRepo(repo);
    const grant = { all: repositories === undefined, selected: [...(repositories ?? [])] };
    this.current =
      this.current === null
        ? { id: this.nextInstallation++, suspended: false, suspendedBy: null, ...grant }
        : { ...this.current, ...grant };
    return this.current.id;
  }

  /**
   * The owner uninstalls the App: no installation, so the repository ports are refused as not found. Given another
   * account's login, the shared App is uninstalled there (ADR 0066): `accounts` no longer lists it, and its
   * repositories are refused as not found, no cause; the account is the person's without the App again, which
   * `installOn` installs anew.
   */
  uninstall(login?: string): void {
    if (login === undefined) {
      this.current = null;
      return;
    }
    const other = this.other(login);
    this.others.splice(this.others.indexOf(other), 1);
    this.unreached.push({
      account: other.account,
      repositories: other.repositories,
      owners: [...(other.owners ?? [])],
    });
  }

  /**
   * The shared App installed on `login`, one of the person's organisations without it (`unreached`), as an owner does
   * on GitHub's page (ADR 0067): `accounts` lists it last, with all its repositories, which answer from now on.
   * Returns the new installation's id. Throws for an account that isn't the person's without the App.
   */
  installOn(login: string): number {
    const at = this.unreached.findIndex((u) => u.account.login.toLowerCase() === login.toLowerCase());
    const [found] = at === -1 ? [] : this.unreached.splice(at, 1);
    if (found === undefined) throw new Error(`${login} is no account of the person's without the App`);
    const id = this.nextInstallation++;
    this.others.push({ id, ...found, suspended: false, suspendedBy: null, sso: null });
    return id;
  }

  /**
   * The organisation `login`, one the person reaches or one of theirs without the App, renamed `to` on GitHub: same id,
   * its repositories under the new login. Throws for an account that is neither.
   */
  rename(login: string, to: string): void {
    const found = [...this.others, ...this.unreached].find(
      (a) => a.account.login.toLowerCase() === login.toLowerCase(),
    );
    if (found === undefined) throw new Error(`${login} is no organisation of the person's`);
    found.account = { ...found.account, login: to };
    found.repositories = found.repositories.map((r) => ({ ...r, owner: to }));
  }

  /**
   * The owner suspends the installation, the App's own or, given its account's login, another the person reaches: it
   * stays, and everything through it is refused until `unsuspend`. `by` is who suspended it, the login `accounts`
   * names (GitHub's `suspended_by`); not given, `accounts` names nobody.
   */
  suspend(login?: string, by?: string): void {
    const installation = this.installedOn(login);
    installation.suspended = true;
    installation.suspendedBy = by ?? null;
  }

  /** The owner lifts the suspension, of the App's own installation or, given its login, another account's. */
  unsuspend(login?: string): void {
    const installation = this.installedOn(login);
    installation.suspended = false;
    installation.suspendedBy = null;
  }

  /**
   * The organisation `login` (one the person reaches) asks for SAML SSO the person's sign-in hasn't (ADR 0066): its
   * repositories are refused as GitHub refuses them, `unauthorized` with the cause `sso` and GitHub's page (`url`,
   * none when not given), and `accounts` says so on it, until `signInSso`.
   */
  askSso(login: string, url: string | null = null): void {
    this.other(login).sso = { url };
  }

  /** The person starts an SSO session on the organisation `login`: its repositories answer again. */
  signInSso(login: string): void {
    this.other(login).sso = null;
  }

  /**
   * The owner revokes the key the repository ports sign with (deletes it on the App's page): from now on it is
   * refused, its cause saying it was revoked.
   */
  revokeKey(): void {
    const app = this.theApp();
    const key = this.signing;
    app.keys = app.keys.filter((k) => k !== key);
  }

  /** The owner generates a new private key on the App's page: the App takes it from now on. Returns its text. */
  generateKey(): string {
    const app = this.theApp();
    const key = keyText(app.id, this.nextKey++);
    app.keys.push(key);
    return key;
  }

  /** The repository ports sign with `key` from now on, as the service does once it is given one. */
  useKey(key: string): void {
    this.signing = key;
  }

  /**
   * A repository added to the installation on GitHub, made on the owner's account first when it is new there. An
   * installation on every repository takes it as it is.
   */
  addRepository(repo: RepositoryRef): void {
    if (!this.held.some((r) => sameRepository(r, repo))) this.held.push(repo);
    const current = this.current;
    if (current && !current.all && !current.selected.some((r) => sameRepository(r, repo)))
      current.selected.push(repo);
  }

  /** A repository removed from the installation on GitHub: one on every repository then holds all the others. */
  removeRepository(repo: RepositoryRef): void {
    const current = this.installed();
    if (current.all) {
      current.all = false;
      current.selected = [...this.held];
    }
    current.selected = current.selected.filter((r) => !sameRepository(r, repo));
  }

  /** The owner archives a repository: the installation's listing leaves it out from now on. */
  archive(repo: RepositoryRef): void {
    this.ownRepo(repo);
    this.archived.add(keyOf(repo));
  }

  /**
   * The owner makes an App from a manifest on GitHub's "new App" page of the host's account (`onGitHub().account`, a
   * person's or an organisation's): a new App there (the old one gone with its keys), not installed, named and
   * holding what the manifest says, its bot named after its slug, the repository ports signing with its key. Returns
   * the code GitHub's redirect carries, which `convertManifest` converts once within the hour.
   */
  createApp(manifest: FakeManifest): string {
    const id = (this.made?.id ?? 0) + 1;
    const slug = slugOf(manifest.name);
    const owner = { ...this.account };
    this.made = {
      id,
      slug,
      owner,
      permissions: { ...(manifest.permissions ?? { metadata: "read" }) },
      keys: [],
    };
    this.bot = { ...this.bot, login: `${slug}[bot]` };
    this.current = null;
    const key = this.generateKey();
    this.signing = key;
    const code = `fake-manifest-code-${this.nextCode++}`;
    this.codes.set(code, {
      conversion: { app: this.described(this.made), key },
      until: this.clock.now() + CODE_LIFETIME_MS,
    });
    return code;
  }

  /**
   * What GitHub's own pages show the owner, whatever `refuse` says (it refuses the API): the App, null before one
   * is made; its installation with the repositories it grants, archived ones included; every repository of the
   * owner's, archived ones marked.
   */
  onGitHub(): FakeGitHubView {
    const app = this.made;
    const current = this.current;
    return {
      account: { ...this.account },
      app: app && this.described(app),
      installation: current && {
        id: current.id,
        suspended: current.suspended,
        granted: this.held.filter((r) => this.grants(current, r)).map((r) => ({ ...r })),
      },
      repositories: this.held.map((r) => ({ repo: { ...r }, archived: this.archived.has(keyOf(r)) })),
      reached: this.others.map((o) => ({
        id: o.id,
        account: { ...o.account },
        repositories: o.repositories.map((r) => ({ ...r })),
        suspended: o.suspended,
        sso: o.sso !== null,
        owners: [...(o.owners ?? [])],
      })),
      unreached: this.unreached.map((u) => ({ account: { ...u.account }, owners: [...(u.owners ?? [])] })),
    };
  }

  // HostInstallations

  convertManifest(code: string): Promise<ManifestConversion> {
    return this.answerAgent(() => {
      const made = this.codes.get(code);
      if (!made || this.clock.now() > made.until)
        throw new HostError("not_found", "The manifest's code is unknown, used or expired (404)");
      this.codes.delete(code);
      return { app: { ...made.conversion.app }, key: made.conversion.key };
    });
  }

  app(credentials: AppCredentials): Promise<HostApp> {
    return this.answerAgent(() => this.described(this.opened(credentials)));
  }

  installation(credentials: AppCredentials): Promise<HostInstallation | null> {
    return this.answerAgent(() => {
      const app = this.opened(credentials);
      const current = this.current;
      // On the App's own account, a person's or an organisation's (ADR 0059), as `@lookover/github` finds it. An App
      // handed over is installed nowhere here.
      if (current === null || app !== this.made) return null;
      return { id: current.id, account: { ...app.owner }, suspended: current.suspended };
    });
  }

  repositories(credentials: AppCredentials, installationId: number): Promise<RepositoryRef[]> {
    return this.answerAgent(() => {
      const app = this.opened(credentials);
      const current = this.current;
      if (current === null || app !== this.made || current.id !== installationId)
        throw new HostError("not_found", `The App has no installation ${installationId} (404)`, {
          connectionCause: { kind: "uninstalled", suspended: false },
        });
      this.usable(current);
      return this.held
        .filter((r) => this.grants(current, r) && !this.archived.has(keyOf(r)))
        .map((r) => ({ ...r }));
    });
  }

  // HostAccounts: what the person signed in to the shared App reaches (ADR 0066).

  /**
   * Who is signed in (`HostAccounts`); given a token, whose that token is (`HostSignIn`: `GET /user`, refused once as
   * `refuseSignInPerson` set).
   */
  person(token?: string): Promise<HostLogin> {
    return this.answerAgent(() => {
      if (token !== undefined) return this.signIns.personOf(token);
      if (this.signedIn === null || this.signedOut)
        throw new HostError("unauthorized", "Nobody is signed in to the shared App", {
          connectionCause: { kind: "signed-out" },
        });
      return { ...this.signedIn };
    });
  }

  /**
   * The App's own installation, on its account, when there is one, then every other account's in `reaches`' order,
   * each with what it grants (archived ones left out), or its cause: suspended, else SAML SSO asked.
   */
  accounts(): Promise<ReachedAccount[]> {
    return this.answerAgent(() => {
      this.stillSignedIn();
      const reached: ReachedAccount[] = [];
      const current = this.current;
      if (current !== null && this.made !== null) {
        const installation = { id: current.id, account: { ...this.account }, suspended: current.suspended };
        const granted = this.held.filter((r) => this.grants(current, r));
        reached.push(this.reachedOf(installation, current.suspendedBy, null, granted));
      }
      for (const other of this.others) {
        const installation = { id: other.id, account: { ...other.account }, suspended: other.suspended };
        reached.push(this.reachedOf(installation, other.suspendedBy, other.sso, other.repositories));
      }
      return reached;
    });
  }

  // HostSignIn: the person signing in to the shared App (ADR 0066).

  startSignIn(): Promise<DeviceGrant> {
    return this.answerAgent(() => this.signIns.start());
  }

  pollSignIn(grant: DeviceGrant): Promise<DevicePoll> {
    return this.answerAgent(() => {
      const polled = this.signIns.poll(grant);
      if (polled.kind === "issued") this.signedOut = false;
      return polled;
    });
  }

  refreshSignIn(signIn: SignIn): Promise<SignIn> {
    return this.answerAgent(() => this.signIns.refresh(signIn));
  }

  /** The person enters the device code on GitHub's page and authorises the App: the next poll signs them in. */
  enterCode(userCode: string): void {
    this.signIns.enter(userCode);
  }

  /** The person refuses the device code on GitHub's page: the next poll is denied. */
  denyCode(userCode: string): void {
    this.signIns.deny(userCode);
  }

  /**
   * Who the repository ports post as from now on: the person signed in (the shared App's way, the default when
   * `person` is given), or the bot (an own App's, ADR 0066). Demo mode moves it as the service moves between the two.
   */
  postAs(who: "bot" | "person"): void {
    this.postsAs = who;
  }

  /** The person takes the App's authorisation back on GitHub: no refresh token given so far renews. */
  revokeSignIn(): void {
    this.signIns.revoke();
  }

  /**
   * The person is signed out on GitHub, as the adapter finds it once its renewal is refused (ADR 0066): the refresh
   * tokens given so far are refused (`revokeSignIn`), and every repository, `accounts` and `person` refuse
   * `unauthorized` with the cause `signed-out`, until a new code is polled to a sign-in.
   */
  signOut(): void {
    this.signIns.revoke();
    this.signedOut = true;
  }

  /** The next `GET /user` of a sign-in refused once as `failure`, the tokens already issued. */
  refuseSignInPerson(failure: HostFailure): void {
    this.signIns.refusePerson(failure);
  }

  /** GitHub asks to slow down at the device code's next poll. */
  slowDownCode(userCode: string): void {
    this.signIns.slowDown(userCode);
  }

  /** When the device code was polled, each time. */
  codePolls(userCode: string): number[] {
    return this.signIns.polls(userCode);
  }

  // What a test does to the host, and reads from it.

  /** The host as it shows the change now: the checks of `commit`, or of the head commit when none is named. */
  view(change: ChangeRef, commit?: CommitSha): HostView {
    const held = this.find(change);
    const sha = commit ?? held.head.sha;
    return {
      checks: this.checks.filter((c) => c.sha === sha && sameRepository(c.repo, held.repo)).map(shownCheck),
      reviews: this.reviewsOf(held).map(
        ({ author: _, ...r }): HostReview => ({ ...r, comments: r.comments.map(shownInline) }),
      ),
      comments: this.comments
        .filter((c) => c.change === held.number && sameRepository(c.repo, held.repo))
        .map(
          (c): HostViewComment => ({
            id: c.id,
            author: { ...c.author },
            body: c.body,
            reactions: { eyes: c.reactedBy.eyes.size, rocket: c.reactedBy.rocket.size },
            minimized: c.minimized,
          }),
        ),
    };
  }

  /**
   * Who filed each review of the change, by login, in order: the App's bot, or the person a sign-in posts as (ADR
   * 0066). A change the host hasn't is refused (`not_found`).
   */
  reviewers(change: ChangeRef): string[] {
    return this.reviewsOf(this.find(change)).map((r) => r.author.login);
  }

  /** A change opened on the host. Its head and base are commits the host knows from now on. */
  open(change: FakeChange): void {
    const repo = change.repo ?? this.repo;
    this.ownRepo(repo);
    if (this.changes.some((c) => c.number === change.number && sameRepository(c.repo, repo)))
      throw new Error(`The fake already holds pull request ${change.number}`);
    const { messages, ...held } = change;
    this.changes.push({ ...held, repo, diff: [...change.diff], closed: false });
    if (messages && !this.history.has(change.head.sha))
      this.history.set(change.head.sha, { parent: change.base.sha, commits: messages.length, messages });
    for (const sha of [change.base.sha, change.head.sha])
      if (!this.history.has(sha)) this.history.set(sha, { parent: null, commits: 0, messages: [] });
    this.moved(repo, "changes");
  }

  /** The change closed: no longer listed open, still read by its number, its comments still listed. */
  close(change: ChangeRef): void {
    this.find(change).closed = true;
    this.moved(change.repo, "changes");
  }

  /** The change closed earlier, reopened: listed open again, as it was. */
  reopen(change: ChangeRef): void {
    this.find(change).closed = false;
    this.moved(change.repo, "changes");
  }

  /** The draft marked ready for review. */
  markReady(change: ChangeRef): void {
    this.find(change).draft = false;
    this.moved(change.repo, "changes");
  }

  /**
   * Commits pushed on the change: a new head, a new diff, and the earlier inline comments re-anchored as GitHub
   * does, by `edits` (what the push changed on the head side): a comment moves with its text (a range moves
   * whole), and one on a line the push replaced (any line of a range), or whose lines the new diff doesn't
   * show, reads `line: null` and `endLine: null`, its `originalLine` kept.
   * Without `edits`, the push touched no commented line. `how` says how many commits it brought, and on which
   * commit they sit (one commit on the head when not given).
   */
  push(
    change: ChangeRef,
    sha: CommitSha,
    diff: CommentableRange[],
    edits: PushEdit[] = [],
    how: PushHow = {},
  ): void {
    const held = this.find(change);
    const commits = how.commits ?? 1;
    const messages =
      how.messages ?? Array.from({ length: commits }, (_, i) => `Commit ${i + 1} of ${commits}`);
    this.history.set(sha, { parent: how.onto ?? held.head.sha, commits, messages });
    held.head = { ...held.head, sha };
    held.diff = [...diff];
    this.moved(held.repo, "changes");
    this.reanchor(held, edits);
  }

  /** The change's inline comments on the head side, moved by a push's `edits` as GitHub moves them. */
  private reanchor(held: Held, edits: PushEdit[]): void {
    for (const review of this.reviewsOf(held))
      for (const comment of review.comments) {
        if (comment.side !== "head" || comment.line === null) continue;
        const now = moved(
          { line: comment.line, endLine: comment.endLine },
          edits.filter((e) => e.path === comment.path),
        );
        // GitHub sets a line only where the pull request's diff shows one.
        const shown = now !== null && inDiff(held, { ...comment, ...now });
        comment.line = shown ? now.line : null;
        comment.endLine = shown ? now.endLine : null;
      }
  }

  /**
   * From now on the host refuses every port call for this reason, as GitHub does with a bad key, when it asks
   * to wait, or when it is down: nothing is read or posted, and a fetch spec's credentials are refused too. `null`
   * lifts it. `retryAt` is when a `rate_limited` host says it may be asked again (GitHub's reset time), carried
   * by every refusal's `HostError`.
   */
  refuse(failure: HostRefusal | null, options: { retryAt?: number } = {}): void {
    this.refusal = failure === null ? null : { failure, ...options };
  }

  /**
   * From now on the host refuses only the check writes (create, update, complete) for this reason, as GitHub
   * does on a bad moment while the rest answers; nothing of a check is posted. `null` lifts it.
   */
  refuseChecks(failure: HostRefusal | null): void {
    this.checkRefusal = failure;
  }

  /**
   * The next post (of the kind `post` names, else of any kind) is refused once for this reason, then the host answers
   * again; reads are not posts. `saved`: the host keeps the post all the same and refuses only its answer, as GitHub
   * once answered a review it had saved "422 An internal error occurred, please try again".
   */
  refuseNext(failure: HostRefusal, options: { post?: PostWrite; saved?: boolean } = {}): void {
    this.nextRefusal = {
      failure,
      saved: options.saved ?? false,
      ...(options.post ? { post: options.post } : {}),
    };
  }

  /**
   * From now on the host refuses only to count commits (GitHub's compare) for this reason, as GitHub does while it
   * hasn't computed a fresh push yet, or on a bad moment; the rest answers. `null` lifts it.
   */
  refuseCounts(failure: HostRefusal | null): void {
    this.countRefusal = failure;
  }

  /**
   * A comment someone wrote on the change's conversation, now by the host's clock, or at `at`: one GitHub lists
   * late, after newer ones were already listed (its listing is eventually consistent). Returns its id.
   */
  seedComment(
    change: ChangeRef,
    comment: { author: { id: number; login: string }; body: string },
    at?: number,
  ): string {
    this.find(change);
    return this.write(change, comment.author, comment.body, at).id;
  }

  /**
   * A comment someone wrote on an issue of the repository (number `issue`, no pull request's; the first repository
   * when `repo` isn't given), now by the host's clock: GitHub lists it with the pull requests' conversation
   * comments. Returns its id.
   */
  seedIssueComment(
    issue: number,
    comment: { author: { id: number; login: string }; body: string },
    repo: RepositoryRef = this.repo,
  ): string {
    if (this.changes.some((c) => c.number === issue && sameRepository(c.repo, repo)))
      throw new Error(`#${issue} is a pull request`);
    return this.write({ repo, number: issue }, comment.author, comment.body).id;
  }

  /**
   * A reply someone wrote in the review thread whose root comment is `commentId` (the owner, the change's author,
   * anyone), now by the host's clock or at `at`: filed, as GitHub files it, as a review of its own with an empty
   * body. `bot` says whether the account is a bot (one whose login ends in `[bot]` when not given). Returns its id.
   */
  seedReply(
    change: ChangeRef,
    commentId: number,
    reply: { author: { id: number; login: string; bot?: boolean }; body: string },
    at?: number,
  ): number {
    const held = this.find(change);
    const { author, body } = reply;
    const by = { id: author.id, login: author.login, bot: author.bot ?? author.login.endsWith("[bot]") };
    return Number(this.replyTo(held, this.root(held, commentId), by, body, at).id);
  }

  /**
   * An inline comment someone other than the bot wrote on the change, now by the host's clock: a review of theirs
   * with an empty body, holding it. Not on a line of the diff, it is refused as GitHub refuses it. Returns its id.
   */
  seedInline(change: ChangeRef, author: { id: number; login: string }, comment: InlineComment): number {
    const held = this.find(change);
    if (!inDiff(held, comment))
      throw new HostError("unplaceable_comment", `${comment.path}:${comment.line} is outside the diff`);
    const id = this.inlineId();
    const inline: Inline = {
      ...comment,
      id,
      nodeId: `PRRC_${id}`,
      originalLine: comment.line,
      minimized: null,
      author: { ...author, bot: author.login.endsWith("[bot]") },
      at: toSecond(this.clock.now()),
      inReplyTo: null,
    };
    this.reviewsOf(held).push({
      id: this.id(),
      sha: held.head.sha,
      body: "",
      author: { ...author },
      comments: [inline],
    });
    this.moved(held.repo, "changes");
    return Number(id);
  }

  /** The comment edited by its author, now by the host's clock. */
  editComment(commentId: string, body: string): void {
    const kept = this.comment(commentId);
    kept.body = body;
    kept.updatedAt = toSecond(this.clock.now());
    this.moved(kept.repo, "comments");
    this.moved(kept.repo, "changes");
  }

  /**
   * A check named `Lookover` created on the commit by another App (`app`, its slug), as any App may create one:
   * queued, then left as it is. Shown by `view`, which reads every check of the name; never by the agent's
   * `checks` for Lookover's App. In the first repository when `repo` isn't given. Returns its id.
   */
  foreignCheck(sha: CommitSha, app: string, repo: RepositoryRef = this.repo): string {
    const output = { title: "Not Lookover", summary: "Another App's check.", text: "" };
    const check: Made = {
      id: this.id(),
      name: CHECK_NAME,
      sha,
      status: "queued",
      conclusion: null,
      output,
      app,
      externalId: "",
      repo,
    };
    this.checks.push(check);
    return check.id;
  }

  /**
   * The host as a coding agent sees it, signed in as `account` with its own token (ADR 0021): the same memory as
   * the App's ports, its comments written by that account, every refusal set with `refuse` applying to it too.
   */
  asAgent(account: { id: number; login: string }, options: { mayResolve?: boolean } = {}): AgentHost {
    const mayResolve = options.mayResolve ?? true;
    return {
      account: () => this.answerAgent(() => ({ id: account.id, login: account.login })),
      changeOf: (repo, branch) =>
        this.answerAgent(() => {
          this.ownRepo(repo);
          const open = this.changes.find(
            (c) => !c.closed && !c.fork && c.head.ref === branch && sameRepository(c.repo, repo),
          );
          return open ? { number: open.number, head: open.head.sha, fork: false } : null;
        }),
      getChange: (change) =>
        this.answerAgent(() => {
          const held = this.find(change);
          return { number: held.number, head: held.head.sha, fork: held.fork ?? false };
        }),
      checks: (repo, sha, app) =>
        this.answerAgent(() => {
          this.ownRepo(repo);
          if (!this.history.has(sha)) throw new HostError("not_found", `No commit ${sha}`);
          return this.checks
            .filter((c) => c.sha === sha && c.app === app && sameRepository(c.repo, repo))
            .map((c): AgentCheck => ({ ...shownCheck(c), externalId: c.externalId }));
        }),
      comments: (change) =>
        this.answerAgent(() => this.view(change).comments.map(({ minimized: _, ...c }): HostComment => c)),
      comment: (change, body) =>
        this.answerAgent(() => {
          this.find(change);
          return this.write(change, account, body).id;
        }),
      threads: (change, app, person) =>
        this.answerAgent(() =>
          this.threadsOf(
            this.find(change),
            (a) => (a.bot && a.login === `${app}[bot]`) || (!a.bot && a.id === person),
          ).map(
            (thread): AgentThread => ({
              ...thread,
              threadId: `PRRT_${thread.commentId}`,
              resolved: this.resolved.has(String(thread.commentId)),
            }),
          ),
        ),
      reply: (change, commentId, body) =>
        this.answerAgent(() => {
          // Its size first, as the adapter knows it before asking.
          this.fitsBody("reply", body);
          const held = this.find(change);
          const root = this.root(held, commentId);
          return Number(this.replyTo(held, root, { ...account, bot: false }, body).id);
        }),
      resolve: (threadId) =>
        this.answerAgent(() => {
          const rootId = threadId.replace(/^PRRT_/, "");
          const root = this.inlineOfAll().find((c) => c.id === rootId && c.inReplyTo === null);
          if (!threadId.startsWith("PRRT_") || !root)
            throw new HostError(
              "not_found",
              `Could not resolve to a node with the global id of '${threadId}'`,
            );
          if (!mayResolve)
            throw new HostError(
              "unauthorized",
              `GitHub refused to resolve thread ${threadId}: ${account.login} does not have the correct permissions to execute \`ResolveReviewThread\``,
            );
          this.resolved.add(rootId);
        }),
    };
  }

  // HostIntake

  listOpenChanges(repo: RepositoryRef): Promise<Listing<HostChange>> {
    return this.answer(repo, () => {
      this.ownRepo(repo);
      return this.listing(
        repo,
        "changes",
        this.changes.filter((c) => !c.closed && sameRepository(c.repo, repo)).map((c) => this.shown(c)),
      );
    });
  }

  listComments(repo: RepositoryRef, since: number): Promise<Listing<HostConversationComment>> {
    return this.answer(repo, () => {
      this.ownRepo(repo);
      const items = this.comments
        .filter((c) => c.updatedAt >= since && sameRepository(c.repo, repo))
        // Newest edited first; of two edited in the same second, the one written later.
        .sort((a, b) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id))
        .map(({ reactedBy: _, minimized: __, repo: ___, via: ____, ...c }) => ({
          ...c,
          author: { ...c.author },
        }));
      return this.listing(repo, "comments", items);
    });
  }

  getChange(repo: RepositoryRef, number: number): Promise<HostChange> {
    return this.answer(repo, () => this.shown(this.find({ repo, number })));
  }

  threads(change: ChangeRef): Promise<HostThread[]> {
    return this.answer(change.repo, () =>
      this.threadsOf(this.find(change), (a) => a.id === this.whoPosts().id),
    );
  }

  poster(repo: RepositoryRef): Promise<{ id: number; login: string }> {
    return this.answer(repo, () => {
      this.ownRepo(repo);
      const { id, login } = this.whoPosts();
      return { id, login };
    });
  }

  countCommits(repo: RepositoryRef, from: CommitSha, to: CommitSha): Promise<CommitCount> {
    const failure = this.countRefusal;
    if (failure !== null) return Promise.reject(new HostError(failure, REFUSED[failure]));
    return this.answer(repo, () => {
      this.ownRepo(repo);
      const ancestors = new Set(this.lineage(from).map(([sha]) => sha));
      let commits = 0;
      // Nearest push first, each push's messages oldest first: the pushes are put back in order at the end.
      const pushes: string[][] = [];
      const counted = (diverged: boolean): CommitCount => ({
        commits,
        diverged,
        messages: pushes.reverse().flat(),
      });
      for (const [sha, commit] of this.lineage(to)) {
        if (ancestors.has(sha)) return counted(sha !== from);
        commits += commit.commits;
        pushes.push(commit.messages);
      }
      return counted(true);
    });
  }

  /** Read from the host, as GitHub's reads the default branch: refused as every call is. */
  fetchSpec(repo: RepositoryRef): Promise<FetchSpec> {
    return this.answer(repo, () => ({
      cloneUrl: this.cloneUrl ?? `https://github.com/${repo.owner}/${repo.name}.git`,
      // The planted sandbox keeps every change on a branch of its own: the branches are all there is to fetch.
      refspecs: ["+refs/heads/*:refs/heads/*"],
      defaultBranch: this.defaultBranch,
      credentials: () =>
        this.answer(repo, () => ({ username: "x-access-token", password: "ghs_fake_installation_token" })),
    }));
  }

  // HostWriter

  createCheck(
    repo: RepositoryRef,
    sha: CommitSha,
    status: OpenCheckStatus,
    output: CheckOutput,
    externalId: string,
  ): Promise<string> {
    return this.answerCheck(
      repo,
      this.posting("check", () => {
        this.ownRepo(repo);
        this.fits(output);
        const check: Made = {
          externalId,
          id: this.id(),
          name: CHECK_NAME,
          sha,
          status,
          conclusion: null,
          output,
          app: this.slug(),
          repo,
        };
        this.checks.push(check);
        this.posts.push({ kind: "check.created", sha, checkId: check.id, status, output });
        return check.id;
      }),
    );
  }

  updateCheck(
    repo: RepositoryRef,
    checkId: string,
    status: OpenCheckStatus,
    output: CheckOutput,
  ): Promise<void> {
    return this.answerCheck(
      repo,
      this.posting("check", () => {
        this.ownRepo(repo);
        const check = this.checks.find((c) => c.id === checkId);
        if (!check) throw new HostError("not_found", `No check ${checkId}`);
        this.fits(output);
        Object.assign(check, { status, output });
        this.posts.push({ kind: "check.updated", checkId, status, output });
      }),
    );
  }

  completeCheck(
    repo: RepositoryRef,
    checkId: string,
    conclusion: CheckConclusion,
    output: CheckOutput,
  ): Promise<void> {
    return this.answerCheck(
      repo,
      this.posting("check", () => {
        this.ownRepo(repo);
        const check = this.checks.find((c) => c.id === checkId);
        if (!check) throw new HostError("not_found", `No check ${checkId}`);
        this.fits(output);
        Object.assign(check, { status: "completed", conclusion, output });
        this.posts.push({ kind: "check.completed", checkId, conclusion, output });
      }),
    );
  }

  publishReview(change: ChangeRef, review: ReviewPost): Promise<string> {
    return this.answer(
      change.repo,
      this.posting("review", () => {
        const held = this.find(change);
        this.fitsBody("review's body", review.body);
        for (const c of review.comments) this.fitsBody(`comment on ${c.path}:${c.line}`, c.body);
        const unplaceable = review.comments.find((c) => !inDiff(held, c));
        if (unplaceable) {
          throw new HostError(
            "unplaceable_comment",
            `${unplaceable.path}:${unplaceable.line} (${unplaceable.side}) is outside the diff; the review was not posted`,
          );
        }
        const at = toSecond(this.clock.now());
        const author = this.whoPosts();
        const posted: Filed = {
          id: this.id(),
          sha: review.sha,
          body: review.body,
          author: { id: author.id, login: author.login },
          comments: review.comments.map((c) => {
            const id = this.inlineId();
            return {
              ...c,
              id,
              nodeId: `PRRC_${id}`,
              originalLine: c.line,
              minimized: null,
              author,
              at,
              inReplyTo: null,
            };
          }),
        };
        this.reviewsOf(held).push(posted);
        this.moved(held.repo, "changes");
        this.posts.push({ kind: "review", number: change.number, reviewId: posted.id, review });
        return posted.id;
      }),
    );
  }

  findCheck(repo: RepositoryRef, sha: CommitSha, externalId: string): Promise<string | null> {
    return this.answerCheck(repo, () => {
      this.ownRepo(repo);
      const own = this.checks.filter(
        (c) =>
          c.sha === sha &&
          c.app === this.slug() &&
          c.externalId === externalId &&
          sameRepository(c.repo, repo),
      );
      return own.at(-1)?.id ?? null;
    });
  }

  findReview(change: ChangeRef, marker: string): Promise<string | null> {
    return this.answer(change.repo, () => {
      const held = this.find(change);
      // The poster's own: someone replying in a thread files a review too.
      const own = this.reviewsOf(held).filter((r) => r.author.id === this.whoPosts().id);
      return own.find((r) => r.body.includes(marker))?.id ?? null;
    });
  }

  upsertSummary(change: ChangeRef, body: string): Promise<string> {
    return this.answer(
      change.repo,
      this.posting("summary", () => {
        this.find(change);
        if (!body.includes(SUMMARY_MARKER)) {
          throw new HostError(
            "missing_marker",
            `The summary must hold the marker ${SUMMARY_MARKER}, or the next round can't find it`,
          );
        }
        this.fitsBody("summary", body);
        const own = this.comments.find(
          (c) =>
            c.change === change.number &&
            sameRepository(c.repo, change.repo) &&
            this.posted(c) &&
            c.body.includes(SUMMARY_MARKER),
        );
        if (own) {
          this.editComment(own.id, body);
          this.posts.push({ kind: "summary.edited", number: change.number, commentId: own.id, body });
          return own.id;
        }
        // A person's token names the App on the issue comments it posts (spike 20); the bot's needs no naming.
        const poster = this.whoPosts();
        const via = poster.bot ? null : this.slug();
        const by = { id: poster.id, login: poster.login };
        const created = this.write(change, by, body, this.clock.now(), via);
        this.posts.push({ kind: "summary.created", number: change.number, commentId: created.id, body });
        return created.id;
      }),
    );
  }

  react(repo: RepositoryRef, commentId: string, reaction: Reaction): Promise<void> {
    return this.answer(
      repo,
      this.posting("reaction", () => {
        this.ownRepo(repo);
        const kept = this.comment(commentId);
        kept.reactedBy[reaction].add(this.whoPosts().id);
        // GitHub lists each comment with its reactions' counts: a reaction changes the comments' listing.
        this.moved(kept.repo, "comments");
        this.posts.push({ kind: "reaction", commentId, reaction });
      }),
    );
  }

  reply(change: ChangeRef, commentId: number, body: string): Promise<string> {
    return this.answer(
      change.repo,
      this.posting("reply", () => {
        const held = this.find(change);
        this.fitsBody("reply", body);
        const root = this.root(held, commentId);
        const reply = this.replyTo(held, root, this.whoPosts(), body);
        this.posts.push({ kind: "reply", number: held.number, commentId, replyId: reply.id, body });
        return reply.id;
      }),
    );
  }

  minimize(repo: RepositoryRef, nodeId: string, reason: MinimizeReason): Promise<void> {
    return this.answer(
      repo,
      this.posting("minimize", () => {
        this.ownRepo(repo);
        const inline = [...this.reviews.values()]
          .flat()
          .flatMap((r) => r.comments)
          .find((c) => c.nodeId === nodeId);
        const comment = inline ?? this.comments.find((c) => c.nodeId === nodeId);
        if (!comment) throw new HostError("not_found", `No comment ${nodeId}`);
        comment.minimized = reason;
        this.posts.push({ kind: "minimized", nodeId, reason });
      }),
    );
  }

  /**
   * What `act` gives, or the refusal before anything is read or posted, as a promise, through the App's token for
   * `repo`, refused as GitHub refuses it: GitHub down (`refuse`) first; then the key the ports sign with refused
   * (`unauthorized`); no installation (`not_found`, the App uninstalled); the installation suspended
   * (`unauthorized`); the repository not granted to it (`not_found`, no cause: the owner's choice on GitHub).
   */
  private answer<T>(repo: RepositoryRef, act: () => T): Promise<T> {
    return this.answerAgent(() => {
      this.stillSignedIn();
      const other = this.otherOf(repo);
      if (other !== undefined) {
        this.reachable(other);
        return act();
      }
      const app = this.made;
      this.opened(app === null || this.signing === null ? null : { id: app.id, key: this.signing });
      const current = this.current;
      if (current === null)
        throw new HostError("not_found", `The App is not installed on ${repositoryName(repo)} (404)`, {
          connectionCause: { kind: "uninstalled", suspended: false },
        });
      this.usable(current);
      this.ownRepo(repo);
      if (!this.grants(current, repo))
        throw new HostError("not_found", `The App's installation leaves out ${repositoryName(repo)} (404)`);
      return act();
    });
  }

  /** Refused as signed out, as the adapter refuses every call once the person's renewal was refused (`signOut`). */
  private stillSignedIn(): void {
    if (this.signedOut)
      throw new HostError("unauthorized", "GitHub refused to renew the sign-in: bad_refresh_token", {
        connectionCause: { kind: "signed-out" },
      });
  }

  /** The App, or the `Error` of a test that moves an App the fake hasn't made. */
  private theApp(): FakeApp {
    if (this.made === null) throw new Error("The fake holds no App yet: make one with createApp");
    return this.made;
  }

  /** The installation, or the `Error` of a test that moves one the App hasn't. */
  private installed(): FakeInstallation {
    if (this.current === null) throw new Error("The fake's App is not installed");
    return this.current;
  }

  /**
   * The other accounts' installations the person reaches, each with a new id, and the person's accounts without the
   * App (`unreached`); none without a person.
   */
  private reach(reaches: FakeReach[] = [], unreached: FakeReach[] = []): void {
    if (reaches.length + unreached.length > 0 && this.signedIn === null)
      throw new Error("Other accounts are reached by a person signed in: give the fake `person`");
    for (const other of unreached) {
      onlyItsOwn(other);
      this.unreached.push({
        account: { ...other.account },
        repositories: other.repositories.map((r) => ({ ...r })),
        owners: [...(other.owners ?? [])],
      });
    }
    for (const reach of reaches) {
      onlyItsOwn(reach);
      this.others.push({
        id: this.nextInstallation++,
        account: { ...reach.account },
        repositories: reach.repositories.map((r) => ({ ...r })),
        owners: [...(reach.owners ?? [])],
        suspended: false,
        suspendedBy: null,
        sso: null,
      });
    }
  }

  /** The App's own installation (no login, or its account's), or another account's the person reaches. */
  private installedOn(login?: string): { suspended: boolean; suspendedBy: string | null } {
    if (login === undefined || login.toLowerCase() === this.account.login.toLowerCase())
      return this.installed();
    return this.other(login);
  }

  /** Another account's installation the person reaches, by its login, or the `Error` of a test naming none. */
  private other(login: string): FakeOther {
    const found = this.others.find((o) => o.account.login.toLowerCase() === login.toLowerCase());
    if (found === undefined) throw new Error(`The person reaches no installation on ${login}`);
    return found;
  }

  /** An installation as `accounts` gives it: suspended, or SAML SSO asked, its cause; else what it grants, unarchived. */
  private reachedOf(
    installation: HostInstallation,
    suspendedBy: string | null,
    sso: { url: string | null } | null,
    granted: RepositoryRef[],
  ): ReachedAccount {
    if (installation.suspended) {
      const by = suspendedBy === null ? {} : { suspendedBy };
      return { installation, repositories: [], cause: { kind: "uninstalled", suspended: true, ...by } };
    }
    if (sso !== null) {
      const cause = { kind: "sso", organisation: installation.account.login, url: sso.url } as const;
      return { installation, repositories: [], cause };
    }
    const repositories = granted.filter((r) => !this.archived.has(keyOf(r))).map((r) => ({ ...r }));
    return { installation, repositories, cause: null };
  }

  /** The other account's installation that grants `repo`, if any. */
  private otherOf(repo: RepositoryRef): FakeOther | undefined {
    return this.others.find((o) => o.repositories.some((r) => sameRepository(r, repo)));
  }

  /**
   * Another account's installation refused as `@lookover/github`'s `UserSession` tells it: suspended, a 403 GitHub
   * names no cause for, so the person's own refusal on that repository (`invalid`, no cause: `accounts` reads the
   * suspension, from `suspended_at`); then SAML SSO asked (403), that account's `sso`.
   */
  private reachable(other: FakeOther): void {
    if (other.suspended) throw new HostError("invalid", "Resource not accessible by integration (403)");
    if (other.sso !== null)
      throw new HostError("unauthorized", "Resource protected by organization SAML enforcement (403)", {
        connectionCause: { kind: "sso", organisation: other.account.login, url: other.sso.url },
      });
  }

  /** The App as GitHub describes it. */
  private described({ keys: _, ...app }: FakeApp): HostApp {
    return { ...app, owner: { ...app.owner }, permissions: { ...app.permissions } };
  }

  /**
   * The App the credentials open, or the refusal of its token as `@lookover/github` tells it (`jwtCause`), all
   * `unauthorized` and the key refused: a text that isn't a key can't sign (no reason); an App id GitHub doesn't
   * hold, a former App's or one never made, is "Integration not found" (`app-deleted`); a key the App doesn't
   * take, revoked or never its own, "could not be decoded" (`revoked`). Null credentials: the service holds none.
   */
  private opened(credentials: AppCredentials | null): FakeApp {
    const refused = (why: KeyRefusal | null, words: string) =>
      new HostError("unauthorized", words, { connectionCause: { kind: "key-refused", why } });
    if (credentials === null || !PRIVATE_KEY_ARMOUR.test(credentials.key))
      throw refused(null, "The GitHub App's private key can't sign: not a private key");
    const app = this.made?.id === credentials.id ? this.made : this.handed.get(credentials.id);
    if (app === undefined) throw refused("app-deleted", "Integration not found (401)");
    if (!app.keys.includes(credentials.key))
      throw refused("revoked", "A JSON web token could not be decoded (401)");
    return app;
  }

  /** A suspended installation refused as GitHub refuses its token (403). */
  private usable(current: FakeInstallation): void {
    if (current.suspended)
      throw new HostError("unauthorized", "This installation has been suspended (403)", {
        connectionCause: { kind: "uninstalled", suspended: true },
      });
  }

  /** Whether the installation grants the repository. */
  private grants(current: FakeInstallation, repo: RepositoryRef): boolean {
    return (current.all ? this.held : current.selected).some((r) => sameRepository(r, repo));
  }

  /**
   * What `act` gives, or the refusal set with `refuse`, as a promise, through the agent's own token (ADR 0021):
   * whether the App is installed doesn't touch it.
   */
  private answerAgent<T>(act: () => T): Promise<T> {
    try {
      if (this.refusal !== null) {
        const { failure, retryAt } = this.refusal;
        throw new HostError(failure, REFUSED[failure], retryAt === undefined ? {} : { retryAt });
      }
      return Promise.resolve(act());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * A post of `kind`: refused once as `refuseNext` set, its write done first when that refusal says it was saved;
   * else written as `act` writes it.
   */
  private posting<T>(kind: PostWrite, act: () => T): () => T {
    return () => {
      const next = this.nextRefusal;
      if (next === null || (next.post !== undefined && next.post !== kind)) return act();
      this.nextRefusal = null;
      if (next.saved) act();
      throw new HostError(next.failure, REFUSED[next.failure]);
    };
  }

  /** A check write: refused as `refuseChecks` set, else answered as every call is. */
  private answerCheck<T>(repo: RepositoryRef, act: () => T): Promise<T> {
    const failure = this.checkRefusal;
    if (failure !== null) return Promise.reject(new HostError(failure, REFUSED[failure]));
    return this.answer(repo, act);
  }

  private id(): string {
    return String(this.nextId++);
  }

  /**
   * An inline comment's id, from a counter of its own, as GitHub's review comments have ids apart from its reviews
   * and conversation comments: posting inline comments moves no other id.
   */
  private inlineId(): string {
    return String(this.nextInlineId++);
  }

  /** Who the repository ports post as: the person signed in to the App, else its bot (ADR 0066). */
  private whoPosts(): Author {
    return this.signedIn === null || this.postsAs === "bot"
      ? { ...this.bot, bot: true }
      : { ...this.signedIn, bot: false };
  }

  /** Whether a conversation comment is one the ports posted: theirs, and, for a person, through the App. */
  private posted(c: Kept): boolean {
    const poster = this.whoPosts();
    return c.author.id === poster.id && (poster.bot || c.via === this.slug());
  }

  /** The bot's App, by its slug: GitHub names an App's bot `<slug>[bot]`. */
  private slug(): string {
    return this.bot.login.replace(/\[bot\]$/, "");
  }

  /**
   * The repository's listing, `unchanged` when nothing it shows changed since its last read, answered at the
   * host's time.
   */
  private listing<T>(repo: RepositoryRef, name: ListingName, items: T[]): Listing<T> {
    const versions = this.versionsOf(repo);
    const read = this.read.get(keyOf(repo)) ?? { changes: null, comments: null };
    const unchanged = read[name] === versions[name];
    this.read.set(keyOf(repo), { ...read, [name]: versions[name] });
    return { unchanged, items, at: this.clock.now() };
  }

  private versionsOf(repo: RepositoryRef): Record<ListingName, number> {
    const versions = this.versions.get(keyOf(repo)) ?? { changes: 0, comments: 0 };
    this.versions.set(keyOf(repo), versions);
    return versions;
  }

  private moved(repo: RepositoryRef, name: ListingName): void {
    this.versionsOf(repo)[name] += 1;
  }

  private write(
    change: ChangeRef,
    author: { id: number; login: string },
    body: string,
    written = this.clock.now(),
    via: string | null = null,
  ): Kept {
    const at = toSecond(written);
    const id = this.id();
    const kept: Kept = {
      id,
      nodeId: `IC_${id}`,
      change: change.number,
      repo: change.repo,
      author: { ...author },
      body,
      createdAt: at,
      updatedAt: at,
      reactedBy: { eyes: new Set(), rocket: new Set() },
      minimized: null,
      via,
    };
    this.comments.push(kept);
    this.moved(change.repo, "comments");
    this.moved(change.repo, "changes");
    return kept;
  }

  private comment(commentId: string): Kept {
    const kept = this.comments.find((c) => c.id === commentId);
    if (!kept) throw new HostError("not_found", `No comment ${commentId}`);
    return kept;
  }

  /** The commit and the ones it sits on, nearest first. Throws `not_found` for a commit the host doesn't know. */
  private lineage(sha: CommitSha): [CommitSha, Commit][] {
    const line: [CommitSha, Commit][] = [];
    let at: CommitSha | null = sha;
    while (at !== null) {
      const commit = this.history.get(at);
      if (!commit) throw new HostError("not_found", `No commit ${at}`);
      line.push([at, commit]);
      at = commit.parent;
    }
    return line;
  }

  private ownRepo(repo: RepositoryRef): void {
    if (!this.held.some((r) => sameRepository(r, repo)) && this.otherOf(repo) === undefined)
      throw new HostError("not_found", `No repository ${repo.owner}/${repo.name}`);
  }

  private find(change: ChangeRef): Held {
    this.ownRepo(change.repo);
    const held = this.changes.find((c) => c.number === change.number && sameRepository(c.repo, change.repo));
    if (!held) {
      throw new HostError(
        "not_found",
        `${change.repo.owner}/${change.repo.name} has no pull request ${change.number}`,
      );
    }
    return held;
  }

  /** The change as the host shows it: without the fake's own knowledge of the diff and whether it is open. */
  private shown({ diff: _, closed: __, repo: ___, ...change }: Held): HostChange {
    return {
      ...change,
      // The fake is GitHub as spike 03 recorded it.
      host: "github",
      fork: change.fork ?? false,
      head: { ...change.head },
      base: { ...change.base },
      author: { ...change.author },
    };
  }

  /** A body over `publish`'s budget, in bytes, refused as GitHub refuses one too long ("Body is too long"). */
  private fitsBody(what: string, body: string): void {
    const size = utf8Bytes(body);
    if (size > COMMENT_MAX_BYTES) {
      throw new HostError(
        "too_large",
        `The ${what} is ${size} bytes; Lookover posts ${COMMENT_MAX_BYTES} at most`,
      );
    }
  }

  private fits(output: CheckOutput): void {
    for (const field of ["summary", "text"] as const) {
      const size = utf8Bytes(output[field]);
      if (size > CHECK_OUTPUT_MAX_BYTES) {
        throw new HostError(
          "too_large",
          `The check's ${field} is ${size} bytes; GitHub takes ${CHECK_OUTPUT_MAX_BYTES} at most`,
        );
      }
    }
  }

  private reviewsOf(change: ChangeRef): Filed[] {
    const list = this.reviews.get(changeKey(change)) ?? [];
    this.reviews.set(changeKey(change), list);
    return list;
  }

  /** The change's inline comments, oldest first. */
  private inlineOf(change: ChangeRef): Inline[] {
    return this.reviewsOf(change)
      .flatMap((r) => r.comments)
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** Every inline comment of every change, oldest first. */
  private inlineOfAll(): Inline[] {
    return this.changes.flatMap((c) => this.inlineOf(c));
  }

  /**
   * Lookover's threads on the change, oldest first: those whose root comment holds a finding marker and was written
   * by an author `isOurs` takes (the App's side by the bot's id, the agent's by its login), outdated ones included,
   * each with every reply after its root, oldest first.
   */
  private threadsOf(held: Held, isOurs: (author: Author) => boolean): HostThread[] {
    const inline = this.inlineOf(held);
    const threads: HostThread[] = [];
    for (const root of inline) {
      const finding = findingOfMarker(root.body);
      const ours = isOurs(root.author);
      if (root.inReplyTo !== null || !ours || finding === null) continue;
      threads.push({
        commentId: Number(root.id),
        nodeId: root.nodeId,
        url: `${held.url}#discussion_r${root.id}`,
        findingId: finding,
        outdated: root.line === null,
        replies: inline
          .filter((c) => c.inReplyTo === root.id)
          .map((c) => ({
            commentId: Number(c.id),
            nodeId: c.nodeId,
            author: { ...c.author },
            body: c.body,
            at: new Date(c.at).toISOString(),
          })),
      });
    }
    return threads;
  }

  /**
   * The root comment of the thread holding the change's comment `commentId`: `not_found` for a comment the change
   * hasn't. A reply's id gives its thread's root, as GitHub files a reply to a reply under the root (#174's live run).
   */
  private root(held: Held, commentId: number): Inline {
    const inline = this.inlineOf(held);
    const comment = inline.find((c) => c.id === String(commentId));
    const root = comment?.inReplyTo ? inline.find((c) => c.id === comment.inReplyTo) : comment;
    if (!root)
      throw new HostError("not_found", `No review comment ${commentId} on pull request ${held.number}`);
    return root;
  }

  /**
   * A reply in `root`'s thread by `author`, now by the host's clock or at `written`, filed as GitHub files it: a
   * review of its own with an empty body, on the change's head, the reply on the root's lines as they are now.
   */
  private replyTo(
    held: Held,
    root: Inline,
    author: Author,
    body: string,
    written = this.clock.now(),
  ): Inline {
    const id = this.inlineId();
    const reply: Inline = {
      path: root.path,
      side: root.side,
      line: root.line,
      endLine: root.endLine,
      originalLine: root.originalLine,
      body,
      id,
      nodeId: `PRRC_${id}`,
      minimized: null,
      author,
      at: toSecond(written),
      inReplyTo: root.id,
    };
    const filed: Filed = {
      id: this.id(),
      sha: held.head.sha,
      body: "",
      author: { id: author.id, login: author.login },
      comments: [reply],
    };
    this.reviewsOf(held).push(filed);
    this.moved(held.repo, "changes");
    return reply;
  }
}
