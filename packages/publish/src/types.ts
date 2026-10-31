// What `publish` is given and what it answers: one round as `core.reconcile` left it, as it is, with the facts
// of the change and the run that the result and the texts name.
import type {
  CancelReason,
  ChangeRef,
  CommitSha,
  ConfirmFailure,
  Deferral,
  EngineId,
  FindingId,
  HostChange,
  HostIntake,
  HostThreadReply,
  HostWriter,
  JobFailureKind,
  JobId,
  LoopState,
  Reconciled,
  ReviewResult,
  Round,
  RunId,
  RunPosting,
  SecondFind,
  SkipReason,
  Trigger,
} from "@lookover/contracts";

/** One round to post: what `core.reconcile` answered, plus the change, the commit, the diff and the run. */
export interface RoundToPost {
  /** The change as the host names it, the host it is on and its page, all named in the result. */
  change: ChangeRef & Pick<HostChange, "host" | "url">;
  /** The commit the round reviewed: the change's head when it ran. */
  sha: CommitSha;
  /** The merge base the diff was taken from. */
  base: CommitSha | null;
  /** The unified diff the round reviewed, as git prints it: where an inline comment can go. */
  diff: string;
  /** This round's number on the change, from 1. */
  round: number;
  /** The earlier rounds on the change: the commit each one reviewed. */
  rounds: Pick<Round, "n" | "sha">[];
  run: {
    id: RunId;
    /** The review job the run is of: a check the round creates carries its id (ADR 0044). */
    job: JobId;
    trigger: Trigger;
    /** The finder. */
    engine: EngineId;
    /**
     * Depth Deep's second find pass (ADR 0044): its engine, and why it gave no round when it failed, which the
     * summary says. Null with one find pass.
     */
    secondFind: SecondFind | null;
    /** The engine that confirmed the round, null when it wasn't confirmed (ADR 0044): the result names it. */
    confirmer: EngineId | null;
    /**
     * Why the round's confirm session gave no verdicts, when it failed (ADR 0044): its findings are posted as found,
     * and the summary says they were not double-checked. Null when it read, or didn't run.
     */
    confirmFailure: ConfirmFailure | null;
    /** How many candidates the confirm pass ruled out (ADR 0044): no findings, the result counts them. */
    ruledOut: number;
    /** Epoch milliseconds. */
    startedAt: number;
    completedAt: number;
  };
  /** The round as `core` decided it: posted as it is, never recomputed here. */
  reconciled: Reconciled;
  /** The job's check on `sha`, in progress since the run started: the round completes it. Null creates one. */
  checkId: string | null;
  /**
   * The thread of each finding whose claim the run read (ADR 0052), as it read them: what a reply goes under and the
   * root comment minimized once its finding is withdrawn. Kept with the round, so a resume needs no new read. None
   * when absent: a reply on a finding with no thread here is not sent.
   */
  roots?: ThreadRoot[];
  /** The review requests the round answers, by the host's global ids: minimized once its check completes. */
  requests?: string[];
}

/**
 * The owner's dismissal of a finding ("This finding is wrong", ADR 0052), posted outside any round: said on the
 * finding's thread, then the change's summary and the latest round's check say where the change stands now.
 */
export interface DismissalToPost {
  /** The dismissal's own key, apart from any run: what its reply's hidden marker names. */
  id: string;
  findingId: FindingId;
  /**
   * The change's latest round that posted, as its posts were rendered, with `reconciled` restated over the ledger as
   * it is when the posts are sent (`core.standing`): what the summary and the check say.
   */
  round: PlacedRound;
  /** That round's review went with every finding in the summary: GitHub refused one of its comments. */
  degraded: boolean;
  /** That round's check, rewritten; null leaves it: the change's head moved since the round. */
  checkId: string | null;
}

/** One of a dismissal's posts: the reply on its thread, the summary, the round's check, its root comment minimized. */
export type DismissalPostKind = "reply" | "summary" | "completed" | "minimize";

/** One post of a dismissal as its outbox keeps it: sent, with the host's id, or owed; and how often a send began. */
export interface SavedDismissalPost {
  kind: DismissalPostKind;
  hostId: string | null;
  tries: number;
}

/**
 * A dismissal's posts as the caller saved them before the first was sent, under the dismissal's own key (ADR 0044,
 * ADR 0052): `dismiss` sends the owed ones in order and marks each one as it goes.
 */
export interface DismissalOutbox {
  /** The posts as saved; one missing is owed, never begun. */
  readonly posts: readonly SavedDismissalPost[];
  /** A send of `kind` begins: kept before the host is asked. */
  sending(kind: DismissalPostKind): void;
  /** The host took `kind`, or already held it: its id for it, kept before the next post is begun. */
  sent(kind: DismissalPostKind, hostId: string): void;
}

/** A finding's thread as the run read it: its root comment's id and global id (ADR 0052). */
export interface ThreadRoot {
  findingId: FindingId;
  commentId: number;
  nodeId: string;
}

/**
 * Why a job's check on a commit ends without a round, for a reason that is no failure (ADR 0043), in contracts'
 * spelling: a newer commit took its place (the job moved on, its old commit's check ends), the job was cancelled
 * (its change closed, a newer review took its place), a skip rule of `core` skipped it, or its round was a preview
 * (ADR 0047: a check made before the preview joined the job ends so).
 */
export type SkipWhy = "newer-commit" | "preview" | CancelReason | SkipReason;

/** Why a job ended without a round on the check's commit (ADR 0043): skipped, and why, or failed, and how. */
export type Ended = { kind: "skipped"; why: SkipWhy } | { kind: "failed"; failure: JobFailureKind };

/**
 * Where the job stands on the check's commit: waiting (its turn, or why it is deferred, and until when an engine's
 * limit holds when its reset is known: ADR 0055), running, or ended.
 */
export type Standing =
  | { kind: "waiting"; deferral: Deferral | null; until: number | null }
  | { kind: "running"; round: number }
  | { kind: "ended"; ended: Ended };

/** A review job as its check shows it on one commit, with what the result of a job that ended names. */
export interface JobCheck {
  change: ChangeRef & Pick<HostChange, "host">;
  /** The commit the check is on: the job's, or the one it was on before it moved to a newer one. */
  sha: CommitSha;
  job: { id: JobId; trigger: Trigger };
  /** The job's run, once one started: the result names it, else the job. */
  run: { id: RunId; engine: EngineId; startedAt: number } | null;
  /** The rounds the change has had, and where its loop stands: the result's `loop`. */
  rounds: number;
  loop: LoopState;
  standing: Standing;
  /** Only Codex may review in the repository: a fork's skip says to let Claude review, in Settings (ADR 0048). */
  onlyCodex: boolean;
  /** When the job came to stand so (epoch milliseconds): an ended job's `completed_at`. */
  at: number;
  /** The job's check on `sha`, updated or completed; null when it has none yet, which creates one. */
  checkId: string | null;
}

/** A round as its findings are placed: everything `publish` takes but the job's check. */
export type PlacedRound = Omit<RoundToPost, "checkId">;

/** A round's review found on the host: its id, and the findings its inline comments hold. */
interface FoundReview {
  reviewId: string;
  commented: FindingId[];
}

/** What the host gave back for the round's posts, and the result as posted. */
export interface Published {
  checkId: string;
  reviewId: string;
  summaryId: string;
  result: ReviewResult;
}

/** Told the id of a check `publish` just created, before anything else is sent for it, so the caller keeps it. */
export type Created = (checkId: string) => void;

/**
 * One of a round's posts (ADR 0039, ADR 0044, ADR 0052): the check in progress, the review, a reply on a finding's
 * thread (`reply:<finding>`), the summary comment, the check completed, a comment minimized (`minimize:<global id>`).
 */
export type PostKind =
  | "check"
  | "review"
  | `reply:${string}`
  | "summary"
  | "completed"
  | `minimize:${string}`;

/** One post of a round as the outbox keeps it: sent, with the host's id for it, or owed; and how often a send began. */
export interface SavedPost {
  kind: PostKind;
  /** The host's id for what it took; null while the post is owed. */
  hostId: string | null;
  /** How many sends of it began: past 0, the host may hold it already, though no answer was kept. */
  tries: number;
}

/**
 * The round's posts as the caller saved them before the first was sent (ADR 0044): `publish` sends the owed
 * ones, in order, and marks each one as it goes. The store keeps them, so a restart resumes where a stopped
 * service left off.
 */
export interface Outbox {
  /** The posts as saved; one missing is owed, never begun. */
  readonly posts: readonly SavedPost[];
  /**
   * The round's review goes with every finding in the summary: GitHub refused one of its comments as off the diff
   * (ADR 0044). Read once, when `publish` begins.
   */
  readonly degraded: boolean;
  /** GitHub refused a comment of the review: kept before the review is sent again, its findings in the summary. */
  degrade(): void;
  /** A send of `kind` begins: kept before the host is asked, so the next send knows to look for it first. */
  sending(kind: PostKind): void;
  /**
   * The host took `kind`, or already held it: its id for it, kept before the next post is begun. For the review,
   * `commented`: the findings its inline comments hold, which the ledger marks `commented` as it lands (#67).
   */
  sent(kind: PostKind, hostId: string, commented?: readonly FindingId[]): void;
  /**
   * The host refused a post for a moment and `publish` waits before it is tried again (ADR 0055): until when, and
   * the refusal; null once the post after a wait lands or is given up. Said as each wait starts, a refusal after a
   * wait starting a new one; never for a refusal that stands at once.
   */
  waiting(wait: PostWait | null): void;
}

/** A refused post's wait: until when (ms since the epoch), and the host's refusal. */
export type PostWait = NonNullable<RunPosting["wait"]>;

export interface Publisher {
  /**
   * Sends the round's owed posts in the fixed order (ADR 0039, ADR 0044): the check in progress (the job's, given
   * as `checkId`, or created), the review with its inline comments, the summary comment, the check completed.
   * Each is marked sent in `outbox` with the host's id before the next is begun; one sent before is not sent
   * again, and the review once begun is looked for by its marker (`findReview`) before it is posted again. With
   * no outbox, every post is owed. A transient refusal (`unavailable`, `rate_limited`) is tried again on the
   * publisher's `time`, backing off, for about an hour of refusals in a row; a review refused for a comment the host
   * can't place is sent once more with every finding of the round in the summary (`degrade`). A refusal it doesn't
   * try again, or the last of the hour, propagates as its `HostError`, and what was sent before it is marked; what
   * the outbox throws propagates too, nothing more sent. `signal` aborted ends a wait at once, rejecting with its
   * reason, nothing more sent.
   */
  publish(round: RoundToPost, outbox?: Outbox, signal?: AbortSignal): Promise<Published>;
  /**
   * The round's review on the host, found by its marker (ADR 0044), with the findings its comments hold as the
   * round placed them (`degraded`: the outbox's, its findings in the summary), or null when the host holds none:
   * what a caller asks before it takes a review whose send began, and was never marked sent, for one that never
   * landed. A host refusal propagates as its `HostError`.
   */
  findReview(round: PlacedRound, degraded: boolean): Promise<FoundReview | null>;
  /**
   * Posts the owner's dismissal (ADR 0052), its owed posts in order (`dismissalPostsOf`): a reply on the finding's
   * thread ("Dismissed by the owner."), the summary comment and the round's check (when `checkId` is given) rendered
   * from the round as restated, then the thread's root comment minimized as `resolved`. The thread is found in one
   * read of the change's threads, made as the posts begin; a finding with none (in the summary only), or a read
   * refused for good, sends no reply and minimizes nothing. A reply begun before is looked for by its marker first; a
   * reply refused for good (`not_found`, `invalid`) and a refused minimize go to `log`. Retries, refusals, the
   * outbox and `signal` as for `publish`.
   */
  dismiss(dismissal: DismissalToPost, outbox?: DismissalOutbox, signal?: AbortSignal): Promise<void>;
  /**
   * The job's check shows where the job stands (ADR 0043): created when it has none (`queued`, or `in_progress`
   * for a running job), else updated; an ended job's completed `skipped` or `neutral` with the result block (a
   * check never created is created first, then completed). A check created is given to `created` at once, before
   * it is completed. Gives the check's id. A host refusal propagates as its `HostError`: the caller sends the job's
   * standing again at its next change, to the check `created` gave.
   */
  check(job: JobCheck, created?: Created): Promise<string>;
}

/** Time as `publish` waits on it between two tries of a refused post: the caller's clock and timers. */
export interface PostTime {
  /** Milliseconds since the Unix epoch: what a host's `retryAt` is counted against. */
  now(): number;
  /** Calls `fire` once `ms` have passed; the function returned cancels it. */
  after(ms: number, fire: () => void): () => void;
}

export interface PublisherOptions {
  writer: HostWriter;
  /**
   * The numeric id on the host of the person Lookover posts for (the App's person on the own App, the signed-in
   * person on the shared one), read at each check created or looked for: their id is in its external id with the
   * job's (`checkExternalId`, ADR 0066), so two people's checks on one commit never mix.
   */
  person: () => number;
  /**
   * Reads the change's Lookover threads (ADR 0052), once, as a round's check is completed: the result names each
   * finding's thread. Without it, or when the host refuses the read, the result names none.
   */
  threads?: HostIntake["threads"];
  /**
   * What tells Lookover's replies on the change's threads from everyone else's, asked at each look (`core`'s
   * `lookoversReply`, ADR 0066): a reply already sent is the one it names holding the reply's marker. Without it, or
   * without `threads`, a reply begun is never looked for: it is sent again.
   */
  lookovers?: (change: ChangeRef) => Promise<(reply: HostThreadReply) => boolean>;
  /** What a refused post waits on before it is tried again; without it, every refusal propagates at once. */
  time?: PostTime;
  /** Where a refusal that never fails the round is said (a comment GitHub wouldn't minimize); without it, nowhere. */
  log?: (line: string) => void;
  /**
   * The service's offset from UTC at an instant, in minutes east: a waiting check gives an engine's reset in the
   * service's time with it (ADR 0055). The machine's own by default.
   */
  offset?: (at: number) => number;
  /**
   * Removes the secrets the service knows from a text (ADR 0056: the log sink's filter): every text an engine or a
   * person wrote passes it before it is posted, with the output filter's other steps. Without it, none is removed.
   */
  secretsRemoved?: (text: string) => string;
}
