// @lookover/core: Lookover's rules (ADR 0028, ADR 0033, ADR 0037).
// The decision it hides: the rules that make a review loop settle, and who reviews. Whether a change gets a review
// job or is skipped (`intake`: a push with "review after every push" off asks nothing, whoever's change it is,
// ADR 0043; a fork change is skipped `fork` unless asked by hand, whoever wrote it, ADR 0048), and what a skip leads
// to (`skipOutcome`: an automatic trigger's recorded with its check only for another author's change or a fork
// change, ADR 0043, ADR 0048; a request's always answered, recorded, or joining the change's pending job, ADR 0047);
// how often a watched repository is polled (`pollEvery`: 10 s while a review is asked, waits or runs, or was posted
// in the last 30 minutes, else 60 s, ADR 0043); who wrote a change (`writerOf`: its commits' `Co-authored-by`
// trailers and its branch prefix, the newest signal winning, ADR 0044); who reviews it (`roundPlan`: the finder, the
// allowed engine that didn't write it, Claude when unknown, never Codex on another author's change nor on a fork
// change, which is skipped `codex-not-yours` where only Codex may review, ADR 0044, ADR 0048, or the engine the owner
// sent the job to, `finder`, when it may review the change, ADR 0047; and the confirmer: the other engine when it may
// review the change and is ready, else the finder in a new session with why, `ConfirmFallback`; at the repository's
// depth: none at Quick, and at Deep a second finder, the confirmer), and which may step in for a deferred one when
// the owner asks (`stepIn`: the other engine, when the reviewers allow it and it may review the change, never Codex
// on another author's or a fork's, ADR 0047); whether a job may start now or waits, and why (`mayStart`: paused
// before the chosen engine's state, ADR 0029, ADR 0040; `engineHold`, what an engine's state makes a job wait for,
// also when a run finds it signed out or at its limit); the pause (`pauseOf`: what the app's choices pause for, an
// hour, 18 hours for "until tomorrow", or until resumed; `pausedAt`: a timed pause is over at its end, ADR 0040);
// what the take does with a waiting job (`takeDecision`: cancelled once its change is gone, skipped when the round
// plan says so, else `mayStart` with the plan's finder, and queued while its finder or its confirmer reviews another,
// one run per engine, ADR 0015, a run holding both, ADR 0044, or while its change's last round is still running or
// posting; started, with the whole plan); what a restart does with a job it found running (`afterRestart`: its
// round's posts resume once its run reached publishing, ADR 0044; otherwise it runs again once, ADR 0043); when two
// findings are the same (`sameFinding`, ADR 0044: the meanings and the locations match, the location hashing the
// line's text, or either has no line text and the meanings match; and the same category on the same line, either text
// missing: the one rule for a round's duplicates, a finding reported again and merging find passes); a Deep round's
// two find passes as one outcome (`mergeFinds`: each bug once, as the first pass that found it reported it; an
// earlier finding present when any pass says so, else gone, else wrong; each pass's sessions apart, the notes and problems
// joined); which of a round's candidates the confirm pass checks (`toConfirm`, ADR 0044: those `reconcile` would
// raise, met as it meets them, but a round-2 `consider`; the same objects back) and what each verdict makes of a
// candidate (`confirmPolicy`: the confirmer's severity first; a `blocking` one not confirmed, unsure or not checked,
// failed pass and depth Quick included, becomes `should_fix`, demoted; any other kept unless refuted; a refuted one
// is no finding but the round's `RuledOut`; one not given to the pass kept as found, `NOT_CHECKED`; verdicts found by
// candidate object; `unconfirmed`, the same for a round with no confirm pass, depth Quick: what the pass would have
// checked is not checked); what one round does to the change's findings (`reconcile`: a round's candidates each once,
// two lines holding the same text kept apart by their numbers; each meets at most one ledger finding, the nearest
// stored line first, so two bugs of one kind stay two, #63; a finding reported again with its line's text takes its
// current line, range and text, else keeps the location `review` anchored; no re-raising; a candidate a switched-off
// rule drops counts for nothing; strictness, no new Consider posted from round 2 (ADR 0042) unless the owner asked
// `full` (ADR 0052), the statuses, the claims read on the threads answered (ADR 0052: claimed fixed decided by the
// check; a dispute the finder calls `wrong` withdrawn, escalated on a blocking finding, even when it reports the
// finding again (the verdict answers the dispute); won't fix, deferred or a
// rejected dispute acknowledged, kept on a blocking finding; a question answered, never counted; the second keep
// escalated; the newest claim and the keep count stored on the finding; what to reply, never for verified fixed nor
// acknowledged; a claim the finder said nothing about left unread), the loop, the verdict, the agent's next action,
// who must act on each finding, the check's conclusion, what to post (a finding an earlier round withheld, its
// review never landed, posted now while it is open), the counts over posted findings only and how many findings are
// kept in the app (unsettled, not posted); `obsolete` waits), answered as contracts' `Reconciled`, which `publish`
// posts as it is; the claims on Lookover's threads (`readThreads`, ADR 0052, ADR 0048: per unsettled finding, by the
// root comment's marker, never its line, the newest reply newer than the claim last answered, the one the finding
// holds or the one a bot's reply marker names (`readReplyMarker`), never cut at that reply: a claim written while a
// round ran is read by the next; from the owner, or the change's author unless a fork's, by account id; its first
// line read case-insensitive, `Fixed`, `Won't fix`/`Wontfix`, `Disputed`/`False positive`/`Not a bug`,
// `Deferred`/`Out of scope` as whole words, anything else a question); the `Round` a finished
// run makes of it (`roundOf`, the service's one builder); what the owner's dismissal does (`findingsAfterDismissal`:
// the finding settled `dismissed`, no reason kept) and the latest round restated over the ledger it leaves
// (`standing`, ADR 0052: where the change stands now, what the round raised and answered kept); a repository's
// rules files as rules (`parseRules`, ADR 0048: one per Markdown list item, its first line's number, else one per
// paragraph, headings as context; its id a hash of the repository, the file and its
// whitespace-collapsed text without the list marker, so it stays when lines move and is new when the text changes)
// and what both prompts may give of them (`promptRules`: 32 KB in total, 16 KB per file, counted as the file's bytes
// up to a line, filled in the order REVIEW.md, AGENTS.md, CLAUDE.md, cut at the last line that fits, with the file's
// length; a file with no room left is listed with nothing given; labelled `R1`… across the files; a rule switched
// off, by its id, is given to neither pass and takes no label, and the rules nested in it go with it, their lines
// still counted against the budget; each parsed rule carries the ids of the items it sits in, `parentIds`).
// Interface: pure functions over domain values from @lookover/contracts, never the UI snapshot as a whole (`intake`
// reads only a change's `author`, `draft` and `fork`, from contracts' `Change`, which the snapshot holds too;
// `reconcile` gives a new finding the facts the app shows with it when the candidate has none: as its `why`, the text
// of the rule it cites when the rules given hold it (ADR 0048), else none, `NOT_CHECKED` as its confirmation; who
// found it and its line's text are the candidate's). Same input, same output: no clock, no IDs, no randomness; a
// finding's id is its rank on the change, `F<n>`. Invariants: a settled finding never changes again; a finding is never raised twice on one change; a finding reported again is still present;
// escalated wins the loop state.
// Ordering: `reconcile` takes a change's rounds in order, each against the ledger the one before returned (round 1
// against none); new findings are numbered in the order the engine gave them, after the ledger's last. An unsettled
// finding's status, in precedence: verified fixed (the engine says gone and did not report it again), then what its
// thread's claim makes of it; otherwise it stays as it was. A Deep round's verdicts: present, then gone, then wrong,
// then unknown. `readThreads`' claims come in the ledger's order, one per finding. The loop: escalated wins, then any
// finding that counts (open), else settled. `mayStart`: paused first, then the chosen engine's state.
// `takeDecision`: a gone change first, then the plan's skip, then the pause, then the finder's state (a busy engine counts as ready, for the plan's
// confirmer too), then the host's connection (deferred `connection` unless it is connected, ADR 0047), then the
// finder, the confirmer (none at Quick) or the change busy. The confirmer falls back on the finder when the other
// engine is barred by the settings, then by a change not the owner's own from the repository (`not-own`), then not
// ready.
// Error modes: none for valid domain values; inputs are taken as typed (the edges check them).
// It must never know: the snapshot, events or `apply`; the service or any adapter (GitHub, the engines, storage); the
// order jobs are taken in (`store`'s take), and it is told the busy engines, never counts or tracks them; settings
// over their layers (the `settings` leaf's: the rules read resolved values); any word the screens say.
// It imports only @lookover/contracts, and no node: or bun: module.
export { type ConfirmApplied, confirmPolicy, type Judged, toConfirm, unconfirmed } from "./confirm.ts";
export { type Identity, sameFinding } from "./identity.ts";
export { type Intake, intake, type SkipOutcome, skipOutcome } from "./intake.ts";
export { findingsAfterDismissal, loopState, standing } from "./loop.ts";
export { mergeFinds } from "./merge.ts";
export { pausedAt, pauseOf } from "./pause.ts";
export { type ReviewPlan, type RoundPlan, type RoundPlanFacts, roundPlan } from "./plan.ts";
export { type PollFacts, pollEvery } from "./poll.ts";
export {
  type ReconcileCandidate,
  type ReconcileInput,
  type RoundOutcomeInput,
  reconcile,
} from "./reconcile.ts";
export { type AfterRestart, afterRestart, type Interrupted } from "./restart.ts";
export { stepIn } from "./reviewer.ts";
export { roundOf } from "./round.ts";
export { type ParsedRule, parseRules, promptRules } from "./rules.ts";
export { engineHold, type MayStart, mayStart, type StartFacts } from "./start.ts";
export { type EngineHold, type TakeDecision, type TakeFacts, takeDecision } from "./take.ts";
export { type Claimants, readThreads, type ThreadReading } from "./threads.ts";
export { type WriterFacts, writerOf } from "./writer.ts";
