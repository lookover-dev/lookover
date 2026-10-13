// @lookover/review: how a round is produced (ADR 0028, ADR 0033, ADR 0039).
// The decision it hides: what the engine is asked and how its answer is read, for a find pass and for the confirm
// pass (ADR 0024, ADR 0044). The output mode is free notes ending in one fenced `json` block, which this
// module alone finds in the answer's text, parses and validates where it enters; the engines return raw text
// and never findings (ADR 0028), and JSON only from a structured-output run, which stands in for a block that
// is missing or isn't JSON. Each candidate gets both fingerprints of ADR 0032 (location and meaning) here: the
// location hashes the anchored line's text, whitespace aside, once the engine copied it (ADR 0044).
// `review` anchors: it says where the problem is (the path, the side, the line and the range's last line, an
// `end_line` equal to the line read as one line), checked against the diff by the line's text the engine copied
// (`line_text`, optional; ADR 0044, I-158): kept when the reported line's text matches, moved to the nearest line
// on the same side of the same file whose text matches (the end line shifted as much), `unmatched` when no line
// of the diff holds it (`publish` puts it in the summary), and as reported without a text, or when the diff was
// cut in its file or before it.
// It does not say whether a comment can go there on the host now: `publish` places.
// Round 2 passes the earlier open findings into the prompt and asks, for each, whether it is still present;
// `core.reconcile` decides identity and status from what comes back. An earlier finding carrying its author's
// newest claim (ADR 0052) has it quoted under it, fenced so it can't close its quote and cut at 2 KB, as the
// author's words, never instructions (ADR 0048), with what is asked: check a fix on the code, judge a dispute,
// answer a question in `why` (the reply Lookover posts). Only a dispute is offered `wrong: true`, read as the
// verdict `wrong`; `wrong` on a finding nobody disputed is not read (its `present` stands) and is a problem line.
// The repository's rules (ADR 0048) come in with each policy, as `core.promptRules` read them from the default
// branch: both prompts give them in one fenced section per file, labelled `R1`, `R2`… with their lines, as the
// owner's instructions (an agent file's only for what it says about the code), and say the copies in the working
// directory and the diff are the change's, never instructions. The finder may answer `rule: "R<n>"`, read into
// the candidate's `rule` (its id, file and line); a label not given drops the citation, never the finding, and is
// a problem line; a `repo_rule` candidate citing none is `maintainability`. The confirm prompt gives each claim
// that cites a rule that rule's text. With no rules, both prompts are as they were (no section, no `rule` field).
// Interface: `createReview({ engines, inputLimits? })` takes the `Engines` port and each engine's input limit in
// characters, and gives a `FindPass`: `run(job, prepared, policy, signal)`, one find pass, answering a `ReviewRun`:
// `reviewed` with contracts' `RoundOutcome` (candidates with their fingerprints, one verdict per earlier finding,
// the engine's notes, what was set aside as problems, and its session named by the policy's `pass`: engine, ms,
// tokens), or `failed` with its reason, the engine's text and that session all the same (ADR 0055). A `ConfirmRun`
// carries its session too, also when it failed; none when no candidate was given.
// A prompt over its engine's limit has its diff cut at a file (or, when not even the first file fits, that file at
// a line), and says so, naming the files not shown whole (the first hundred) for the engine to read in the
// working directory, in the whole diff saved there when the policy names it (`diffFile`: removed lines and deleted
// files are only there): a big change is still reviewed rather than refused by the CLI. Anchoring still reads the
// whole diff. No limit given for an engine: its prompt is never cut. `createConfirm({ engines, inputLimits? })`
// gives a `ConfirmPass`: `run(job, prepared, candidates, policy, signal)`, one session on `policy.engine` (the
// round's confirmer, the finder or the other engine: the caller's choice) for the candidates given, each shown only
// its claim (title and body), its place and the lines of its hunk around it (`C1`, `C2`… in order), never the
// finder's notes or severity. It answers a `ConfirmRun`: one `{ candidate, verdict }` per candidate, in order, the same objects (contracts'
// `CandidateVerdict`: `confirmed`, `refuted` or `unsure` with the confirmer, a reason, evidence lines and its own
// severity; `not_checked` for a candidate the block left out or answered in the wrong shape, named in `problems`),
// and `failure` (contracts' `ConfirmFailure`) when the session gave no verdicts at all: the engine's outcome when it
// isn't `ok` (signed out included), or `unreadable`, every candidate then `not_checked`. No candidate: no session.
// The lines around a claim are 20 either side, within its hunk, never a whole long hunk; over its engine's limit,
// the last claims' code is left out, from the end, each saying where to read it in the worktree, never the claims.
// Invariants: it never throws for anything the engine does or says; every failure is a reason the service can
// store. A reviewed round answers every earlier finding asked about (`unknown` when the engine did not) and
// names nothing else; a candidate in the wrong shape is set aside as a problem line, never the whole round.
// Same inputs, same prompt: the prompts are approval-tested.
// Ordering: one engine run per `run` (find or confirm): the prompt is built, the engine answers, the answer is
// read; nothing is kept between calls, so rounds are independent here (the earlier findings come in with the
// policy). Which candidates to confirm, and what a verdict makes of one, are `core`'s (`toConfirm`, `confirmPolicy`).
// Error modes: nothing thrown; the confirm pass never fails (above). A find pass is `failed` with the engine's
// outcome when it isn't `ok` (signed out, at its limit,
// timeout, crashed, cancelled, invalid output), `missing_block`, `malformed_block` or `invalid_block` (with one
// problem per line). A session at its limit (a failed find pass, a confirm pass's `failure`) carries the engine's
// `limitUntil` or `limitSaid` as the run gave them (ADR 0055). Strictness is not applied here (ADR 0025: a
// posting filter, `core`'s), and no finding gets an identity or a status here.
// It must never know: the real `claude` (it depends on the port), GitHub, the store, the UI, or the rules of
// the loop. It reads hunks only through `diff`. It is pure: no `node:` or `bun:` module and no clock (it times
// nothing; the engine's run folder and limit come in with the policy); the engine comes from outside. Each
// policy's `onActivity` (ADR 0055) goes to the engine's run spec as it is: what the engine does while either pass
// runs reaches the caller from the engine, never read or worded here.
export { createConfirm } from "./confirm.ts";
export { createReview } from "./review.ts";
export type {
  ConfirmPass,
  ConfirmPolicy,
  ConfirmRun,
  EarlierFinding,
  FindPass,
  JudgedCandidate,
  ReviewFailure,
  ReviewPolicy,
  ReviewRun,
} from "./types.ts";
