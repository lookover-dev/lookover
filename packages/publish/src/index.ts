// @lookover/publish: what a round puts on the pull request, and in which order (ADR 0022, ADR 0023, ADR 0032,
// ADR 0033, ADR 0039).
// The decision it hides: how a reconciled round becomes GitHub's three things and the words on them. One review
// holding every inline comment of the round. `publish` places: `review` anchored each finding (where the problem is:
// its side, its line and its range's end), and `diff` answers whether a comment can go there on the host now: a
// range as a range (one side, one hunk), else on the range's first line, else its last; a finding no comment can go
// on goes into the status block instead, so one bad line never fails the review; so does one `review` could not
// anchor by its line's text (`unmatched`, ADR 0044). Every finding of the ledger is placed again each round against
// this round's diff, with its side and range. The result's `location` is the finding as `review` anchored it (its
// side and whole range), and an inline finding's `placed` is where its comment went this round (the lines it
// covers). One status block per change, in its description (ADR 0074), rewritten as where it stands changes; the
// `Lookover` check, in progress before anything else of the round and completed last, with the
// `lookover.review-result/v1` result as the last line of its text, so a coding agent that waits on the check finds
// everything posted. The check follows the review job from the moment it is recorded (ADR 0043): `queued`, saying
// why it waits (its turn, or the app's words for a deferral: "Waiting: Claude is signed out"; an engine's limit with
// its reset known gives it in the service's time with its offset, from `offset`, ADR 0055), `in_progress` while
// it runs, completed by the round; or, for a job that ended without a round, completed `skipped` (a newer commit or
// a newer review took its place, the pull request closed, a skip rule such as "it comes from a fork") or `neutral`
// (the review failed: its title says the cause's phrase, its summary how to try again where another try can help,
// else what would change it, ADR 0081; never the failure's `detail`), never `failure` (ADR 0006), with a result block
// holding the run's state and its reason (snake_case; a failure's kind, whatever its cause), no verdict, no findings
// and every count at zero. The result's bytes are counted before posting: when every finding doesn't fit, the result
// keeps the first findings that do, whole, in urgency order (open on the pull request first), and says `truncated`;
// nothing is ever cut mid-way. Every sentence that lands on GitHub is product copy and lives here, not in the UI.
// Findings kept in the app (ADR 0042) are counted, never listed: the check's summary says how many, and "The rest can
// go." closes a sentence only when nothing else is open, on the pull request or in the app. The confirm pass (ADR
// 0044): the result names the round's confirmer and each finding's confirmation; a `blocking` finding lowered for want
// of a confirmation reads "Should fix, unconfirmed" in its comment, the status block and the check; a round whose
// confirm session gave no answer (`run.confirmFailure`) says in the check its findings are "Not double-checked", and
// why; a Deep round whose second find pass gave no answer (`run.secondFind`) says "One find pass, not two", and why.
// Nothing on the pull request names the engines (ADR 0074): the check's result does. A finding that follows one of the
// repository's rules (ADR 0048) cites it in its comment's body, as the finder wrote it, and the result's `rule` gives
// its id, its file as `source` and its line.
// The words (ADR 0074), the owner's prototype's: every post opens with the wordmark (contracts' `wordmark`, 18 px),
// " · " and its kind, added after the output filter. A review's body is its hidden marker alone. A line comment is
// "<wordmark> · Blocking" (its severity), its title in bold, its body, then the finding's suggestion as a `suggestion`
// block (fenced longer than any run of backticks in it) only on a comment covering exactly its lines on the head side,
// and only when the filter leaves it as written and it fits whole; then its marker. A reply is "<wordmark> · " and
// Withdrawn, Kept (closing "If it is kept again, the owner decides."), "Kept. The owner decides", "The owner decides
// this one" (a won't fix kept twice says the prototype's fixed words in place of the finder's), Answer, or "Dismissed by
// the owner" (closing "It won't be raised again on this pull request."), then why, then its marker. The status block
// in the pull request's description (`statusBlock(change, status, room)`, pure, given to `HostWriter.upsertStatus`'s
// render): a heading (the wordmark at 26 px and the state: "Looking over <commit>" and "again" on the same commit, "N
// things to fix", "One thing to fix", "Nothing to fix", "Needs your look", "Waiting to look over <commit>", "Couldn't look
// over <commit>", "Didn't look over <commit>"), one line (the round, the commit as a link, "n fixed, m withdrawn"
// counted over every round, dismissed as withdrawn; or why it waits, its reset in the machine's time, with the day when
// not today; or why it failed, then how to try again only where another try can help, else what would change it, ADR
// 0081; or, for a fork's request a newer push ended with no round posted, that push and how to ask for the newest
// commit, ADR 0092), then the last posted round's open findings (none while a round runs, nor for that request):
// escalated first, then by severity, then by id, none kept in the app; each with a link to its thread, an
// escalated one's why the owner decides, one with no line comment "Not in the diff: …" and its permalink on the
// commit its lines are on. Cut to the room left: items from the end, then the permalinks; null when the heading and
// its line don't fit. It is rendered as it is written, from where the change stands then (`status`, the caller's
// reader: its newest job and the ledger of its last posted round, with the threads just read; without it, the round
// or the dismissal being posted), never from a text kept: a block sent again, or late, never puts back an older one.
// A reader's null writes no block (a pull request Lookover skips).
// Claims (ADR 0052): a finding the round kept against its author's claim is answered on its thread (the replies
// below); the status block says why an escalated one is the owner's. The result gives each finding its claim (its
// kind, text, author, time, and `count`: how many times a round kept it against one), and its `resolution` `kept`
// (or `escalated`, or `still_present` after a push, ADR 0081) with the reason when this round replied; and, from one
// read of the change's threads (`threads`, `HostIntake`'s) made before the status block, its `thread` (the root
// comment's id and URL, and whether it was resolved when the read can tell), null for a finding with none: the block
// links the same. A transient refusal of that read is tried again like a post; one that stands leaves `thread` out,
// and the check still completes.
// Replies and minimizing (ADR 0052): each of `core`'s replies (`reconciled.replies`) on a finding whose thread the run
// read (`roots`, kept with the round so a resume reads nothing new) is one post, sent after the review and before the
// status block, under the thread's root, ending with a hidden reply marker (contracts' `replyMarker`: the run, the
// finding and the claim it answers, so a claim written while the round ran is read next) within `COMMENT_MAX_BYTES`:
// only its reason is cut, at a line, so its opening and its closing line ("If it is kept again, the owner decides.")
// are always said. A reply whose send began before is looked for by its marker among the bot's replies in the
// threads (`threads`) before it is sent again, so it is sent once. A reply on a finding with no thread read is not sent, nor an answer with
// no words. A reply refused for good (`not_found`: its thread's root deleted; `invalid`) never fails the round: it goes
// to `log`, and the rest go on. Once the check completed, the request comments the round answers (`requests`) and the
// root comment of each finding it withdrew are minimized as `resolved`, one post each; a refusal that stands, after the
// transient ones were tried again, never fails the round either: it goes to `log`, and the rest go on.
// The owner's dismissal (ADR 0052, "This finding is wrong") posts outside any round, through an outbox of its own
// keyed by the dismissal (`dismissalPostsOf`): "Dismissed by the owner." on the finding's thread, ending with a
// hidden marker naming the dismissal and the finding (looked for before it is sent again), then the status block
// (rewritten from where the change stands then) and, when the caller gives its id, the latest round's check, rendered
// from that round restated over the ledger as it is when it is sent (the caller's `core.standing`: verdict,
// conclusion and result block included), then the thread's root minimized as `resolved`. The thread is found in one
// read made as the posts begin; a finding with none (in the status block only) gets no reply and nothing minimized.
// The output filter (ADR 0056, SR-08): every text an engine or a person wrote that a round posts again (each
// finding's category, title, body and reason for closing, the confirm pass's reason and evidence, its claim's text,
// each reply's reason) is filtered once, as `publish`, `dismiss` and `findReview` receive the round, so the review,
// the replies, the status block, the check and the result show the same text; the caller keeps the raw. What is put on
// one line (a list item, a title) is filtered again as that line, and every body, once cut to fit, again, last.
// `postableText(text, secretsRemoved)`, exported for its own unit tests: hidden and bidirectional control characters
// removed, then the secrets the caller's filter knows, then, outside fenced code, an invisible break (U+200B) after
// each `@`, between the `!` and the `[` of each `![`, after the `<` of each tag, after the `&` of each entity and
// before each run of three backticks or tildes; fenced code is left as written but for those two, so a suggestion
// still applies. Lookover's own words hold nothing the filter changes.
// Interface: `createPublisher({ writer, person, threads, lookovers, time, log, secretsRemoved, status })` takes the
// `HostWriter` port, the numeric id of the person Lookover posts for (read at each check created; one that is no id
// throws), the threads' reader and what tells Lookover's replies on them (`core.lookoversReply`, both optional:
// without them a reply begun is sent again), the time a refused post waits on, where a refusal that never fails a
// round is said, the secrets filter (the service's log sink's; none removed without it) and the reader of where a
// change stands for its status block (above), and gives `dismiss(dismissal, outbox, signal)` (above), and
// `publish(round, outbox, signal)`: a `RoundToPost` (contracts' `Reconciled` as `core.reconcile` answered it, with the
// change and its host, the commit, the diff, the run and the job's check, if it has one) to the host's ids and the
// result as posted; and `check(job)`: a `JobCheck` (the job, the commit its check is on, its check's id or none, and
// where it stands: waiting, running or ended) to its check's id, created when it had none; and `status(change)`: the
// status block written outside a round (the check follower's, as a job waits, runs or fails) from the reader, the
// threads read once only when it lists a posted round, a refusal that stands said in the log, any other thrown and
// never tried again (the caller writes it at the job's next change). The caller (the
// scheduler) never writes to the host's checks itself, and keeps the id: `check` gives a check it creates to the
// caller's `created`, and `publish` marks the round's check sent in the outbox, at once, before anything else is sent
// for it, so a refusal after the create never leaves a second check behind it. The result's line opens with
// contracts' `RESULT_MARKER`, and contracts' `readResult` reads it back (the agents' helper imports only `contracts`).
// The outbox (ADR 0044): the caller saves the round and its posts as owed (`postsOf(round)`, in order; the review only
// when the round has a line comment, ADR 0074) before the first is sent, and hands them to `publish` as an `Outbox`, a
// structural port its store keeps: `publish` sends only the owed ones and marks each sent with the host's id before
// the next is begun, so a restart resumes where a stopped service left off, and nothing is sent twice. A post whose
// send began but was never marked sent may be on the host already: the review is looked for by the hidden
// `REVIEW_MARKER` its body is (the round's run and number) through `findReview` before it is posted again (a round
// that owes none is never looked for); the status block is written whole between its markers either way; the check
// created on an answer that was lost is looked for by its external id (the job's id, the pull request's number and
// the person's, `checkExternalId`, ADR 0066, 0077: the `person` the options give) through `findCheck`; the check
// completed is a write by id. `findReview(round)` answers whether the host holds a round's review, for a caller
// that gave a round up with its review begun and never marked sent. A round that owes no review lands its ledger as its status block's send begins
// (the caller's store), so a block refused, or not written at all, never sends its findings again.
// Refusals (ADR 0044): given the caller's `time`, a transient refusal (`unavailable`: a 5xx, GitHub's 422 "An internal
// error occurred", a network failure; `rate_limited`, waiting at least a minute, else until the host's `retryAt`) is
// tried again, backing off from 5 s to 5 min, while the refusals in a row last less than an hour (about 55 min of
// waits); a re-send of the review looks for its marker first, every time. The outbox hears each wait as it starts
// (`waiting`: until when, the refusal), and its end once the post lands or is given up (ADR 0055). A review refused
// for a comment the host can't place (`unplaceable_comment`: GitHub's diff is not git's, and it never says which
// comment) is not sent again: every finding the round posts goes in the status block; the outbox keeps that
// (`degrade`) first, so the block, the result and a restart say the same. A status block refused for good (`invalid`:
// the person may not edit the description; `too_large`) never fails the round: it goes to `log`, and the rest go on.
// Size (ADR 0044, #67): every inline comment and reply fits `COMMENT_MAX_BYTES`, and the check's summary
// `CHECK_OUTPUT_MAX_BYTES`, counted in UTF-8 bytes; a body over it is cut at a line (a line only when no whole line
// fits), never in a character or the hidden marker, its open code block closed with its own fence, and ends "Cut to
// fit GitHub's limit" with where the rest is: Lookover, and the check's result when it fits there. The status block
// fits the room the description leaves (`DESCRIPTION_MAX_CHARACTERS`, in characters), cut as said above. One review
// holds `REVIEW_MAX_COMMENTS` comments: the round's most urgent findings go inline, the rest into the status block,
// and the result says so; a review the host refused moves them all there first. The outbox's
// `sent("review", id, commented)` names the findings the review holds a comment on, which the ledger keeps
// (`Finding.commented`): a later round lists one with none in the block as not in the diff. The result's headline is
// cut short between characters. A round is never refused for its size, so its check completes.
// Ordering: check in progress (created only when the job has none) → review → replies → status block → check
// completed → minimized comments, always, each post awaited and marked before the next, and a refusal stops the
// rest (one of a reply or of the status block that stands, or of a minimize, goes on). One `publish` per round,
// rounds in order: the result reads the rounds before it, as given in `rounds`. A job's `check` calls come in the
// order its standing changed, each awaited before the next: the caller holds the order.
// Invariants: one review per round, and only with a line comment; the verdict, the next action, who must act on
// each finding, the conclusion and the counts are `core`'s, posted as given and never recomputed here; the
// result's host is the change's; every check output has a non-empty title, summary and text; the result validates
// against `reviewResultV1` and fits `CHECK_OUTPUT_MAX_BYTES`; only posted findings appear on the pull request;
// every finding is in the result unless `truncated` says some were left out, and then the counts still cover them.
// Error modes: a host refusal (`HostError`) that is not tried again, or the last of the hour, propagates, and what
// was sent before it is marked in the outbox; the caller decides whether to send the rest again (`publish` with the
// same outbox) or give up. The caller's `signal`, aborted, ends a wait at once with its reason. The caller sends a
// refused `check` again with the job's next standing, or, for an end, at its next try. What the outbox throws (the
// store, a stopping service) propagates, and nothing more is sent. A finding with no entry in
// `reconciled.actionBy` is a programming error (`core` gives every finding one): a plain `Error`, thrown before
// anything is posted.
// It must never know: the rules of the loop (`core`), the engines, the store, GitHub's API (the ports), or the
// UI. It is pure: no `node:` or `bun:` module; the writer and the threads' reader come in as parameters.
export { postableText } from "./filter.ts";
export { createPublisher, dismissalPostsOf, postsOf } from "./publish.ts";
export { shownFailure } from "./result.ts";
export type {
  DismissalOutbox,
  DismissalPostKind,
  DismissalToPost,
  Ended,
  JobCheck,
  Outbox,
  PostKind,
  PostTime,
  Published,
  Publisher,
  PublisherOptions,
  RoundToPost,
  SavedDismissalPost,
  SavedPost,
  ShownFailure,
  SkipWhy,
  Standing,
  Status,
  StatusRound,
  ThreadRoot,
} from "./types.ts";
