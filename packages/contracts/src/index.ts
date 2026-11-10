// @lookover/contracts: the shared vocabulary (ADR 0033, ADR 0037, ADR 0039), in the words of ADR 0030 and the
// glossary. The decision it hides: the shape of what crosses a module boundary. The snapshot the UI shows, the
// events that change it, the commands the UI sends and `LookoverApi`, which carries all three; the ports a module
// depends on instead of the package that implements them; the public result format; `Reconciled`,
// `core.reconcile`'s answer for a round (the verdict, the next action, who must act, the counts), read as it is by
// `publish` and the service; the interfaces of the leaves. One file per concept. Every package may
// import it; it imports only Zod.
// Its only logic is `apply`, the snapshot reducer: what an event does to the snapshot is part of the wire
// contract, shared by the UI and the service. Events carry the states they result in, so `apply` records
// and decides nothing; the timeline it keeps is data, never sentences: the words belong to the UI. Besides it:
// the ID constructors, which only check an ID where it enters, and a change's name (`<owner>/<name>#<n>`,
// `changeName` and `changeIdOf`, read back by `changeNameParts`) and a repository's (`repositoryRefOf`) written once;
// `isUnsettled`, the definition of an unsettled finding, and `isCounted`, one that counts on the pull request
// (unsettled and posted, I-152); `bySeverity`, the order findings are listed in, by publish and the app alike;
// `fingerprintWord`, a category or a kind key as fingerprints compare it;
// `isWaiting`, a job not started yet (queued or deferred); `deferralEngine`, the engine a deferral waits for;
// `engineDeferral`, what an engine's state makes a review wait for;
// `sameDeferral`, when two deferrals are the same reason to wait; `sameLoginHolder`, two answers of who holds start
// at login the same (ADR 0068); `sameTurn`, two turns the same thing to wait
// behind; `stepsDone`, a run's steps with its current one closed; `repositoryName` and `sameRepository`, a
// repository as written and compared as GitHub does (ignoring case); `reviewResultV1`, the Zod schema of
// `lookover.review-result/v1`, which parses a result where it enters, and `readResult`, which finds one in
// a check's text (the agents' helper imports only this package); `enumOf`, a Zod enum tied to the type it
// parses, so that every package's parser fails the typecheck when the type and the enum differ; `tiedTo`, any Zod
// schema tied exactly to its type (a field missed, optional ones included, or added fails the typecheck), and
// `stateSchema`, the state the UI holds as this version writes it, each section tied to its type: what a start
// must read its replayed log through rather than trust it (ADR 0085), and `readState`, which reads it so over the
// start's own state: a change with its review, each repository, departed repository and rule alone, every other
// section the start's own when it doesn't read, check results always the start's, each piece dropped a `Dropped`;
// `reviewRequest`, `readRequest`, `isReviewRequest` and `requestedCommit`, a review request's text as written and
// read (ADR 0043, ADR 0052: `full`, and the reply a request asks to have answered);
// `DISCOVERY_MS` and `DISCOVERY_RETRY_MS`, the pace the installations are listed at, which the app says (ADR 0088).
// `NOT_CHECKED`, the confirmation of a finding no confirm judged, the default every producer fills (ADR 0044).
// The second look (ADR 0044): who found each finding and what the confirm pass said of it, and the finder,
// confirmer, fallback and failure a run and a round record (the shapes in `confirm.ts`); a candidate's verdict
// and what a refuted one leaves in its round (`round.ts`); the repository's `Depth`; the engine state of a
// version that failed the self-test, and of one whose self-test couldn't finish (ADR 0075), and the deferral that
// waits on each; the skip of another author's change when only Codex may review it; a candidate's `Anchoring` and
// the placement of one whose line's text is not in the diff; the commits' messages a push brought. Posting safely
// (ADR 0044, #67): `HostWriter.findReview` and the job's id on a check, `REVIEW_MARKER` in `frozen.ts`, and
// `COMMENT_MAX_BYTES` and `REVIEW_MAX_COMMENTS` beside `CHECK_OUTPUT_MAX_BYTES` in `host.ts`, with `utf8Bytes`, a
// text measured as GitHub counts them.
// The one exception to "never a sentence": `copy.ts`, the phrases the app, GitHub and the service's log file share
// (`engineName`, `deferralText`, the safety check's states `FAILED_SAFETY_CHECK` and `UNFINISHED_SAFETY_CHECK`,
// `failureWords` (a failure by its cause, ADR 0081) and `failedTitle`, `cancelText` and `cancelPhrase`, `skipText`,
// `confirmFailureText`, `findersText`, `foundAndCheckedText`, `keptText`, `ruleText`, `CODEX_REVIEWS`, `postWaitText`,
// `pushedText`; the status block's headings `NEEDS_YOUR_LOOK`, `thingsText`, `lookingOverHead`, `waitingHead` and
// `failedHead`, its lines `roundLine` (with `roundCountsText`), `failedLine` (`stoppedText`, `TRY_AGAIN`),
// `waitingText` and `startsOnceText`, its notes `notInDiffText` and `escalationText`; a thread reply's `replyKind`
// and `STILL_PRESENT`), and the ways of writing they share (`asSentence`, `shortSha`, `dayText`, `twoDigits`),
// written once here because the web may import only this package and `publish` words the pull request: everything
// else either says stays in its own module. `findingPermalink`
// (`status-block.ts`): where a finding with no line comment shows its lines, for the block and the simulated page.
// Ports (ADR 0033): `Clock` and `IdGen` (ADR 0037); `Engines`, `HostIntake` and `HostWriter` (ADR 0039, polling
// and reactions by ADR 0043), each shaped by what the service calls and nothing more, a host's listing saying
// `unchanged` when the host says so, with `HostError` as the one way a host refuses; `AgentHost`, the host as
// the coding agent sees it with its own login, shaped by what `lookover wait` calls (ADR 0021, ADR 0043);
// `HostView`, what a host shows of a change, the one shape the real adapter and the fake read back.
// `HostIntake.poster` names who posts on a repository by numeric id, the person signed in on the shared App (ADR
// 0066): what tells Lookover's replies on its threads, with the ids it kept.
// The posts on GitHub (ADR 0074): the status block Lookover owns in a pull request's description, between
// `STATUS_MARKER` and `STATUS_END_MARKER` (`frozen.ts`), written by `HostWriter.upsertStatus` within
// `DESCRIPTION_MAX_CHARACTERS` (`characterCount`) and shown by `HostView.description`, placed by the one splice the
// fake host and the real one share (`status-block.ts`: `spliceStatus`, the first closing marker with an opening one
// before it replaced from the last such opening one, all else kept byte for byte, else written at the end, after
// `---` only under a non-empty author's text; `statusOf`, the block a description holds; `showsStatus`, whether a
// read shows a block, line endings aside; `statusRoom`, the characters GitHub's limit leaves it); the wordmark every
// post opens with (`wordmark(px)`, its two files `WORDMARK_URLS`), and `withoutWordmark`, a post's opening taken off
// for the agent.
// A port changes here only, one change at a time. The frozen identifiers of ADR 0032 are in `frozen.ts`.
// `API` and `SSE` name where `LookoverApi` is over HTTP and what its event stream sends (ADR 0038); beside it, the
// `lookover` commands' two routes (`API.link`, answered as a `MintedLink`, and `API.stop`, ADR 0054). The log file's
// tail (`logs`, `API.logs`) and its new lines (`subscribeLogs`, a `LogMessage` each, `SSE.log`) sit on `LookoverApi`
// beside the state, never in it (ADR 0055). A session-checked route answers 401 with a `NoSession`, naming the command
// that opens Lookover (ADR 0058).
// The developer drawer's channel (`demo.ts`, ADR 0046) sits beside `LookoverApi`, never in it: the dev verbs
// (`DemoCommand`), the faults and their labels (`FAULTS`, the one data the service answers as words), and what
// `DEMO_API.listing` answers (`DemoListing`: the scenarios, the current one, the demo clock, the faults).
// A deferred job carries the engine it could step in to (`ReviewJob.stepIn`, ADR 0047), so the app only counts.
// The types row 5 fills so nothing from the pull request steers the reviewer (ADR 0048): a change's `fork` and the
// `fork` skip, the default branch a `FetchSpec` names, the rules files read from it (`RulesFile`), the rules both
// prompts are to give (`PromptRulesFile`), the rule a finding cites (`CitedRule`) and `rules.changed`, which
// replaces a repository's rules in the snapshot.
// The types row 6 fills so a round reads its threads (ADR 0052): a finding's newest claim (`FindingClaim`) and how
// often a round kept it against one, the earlier verdict `wrong`, the replies a round makes on its threads
// (`ThreadReply`) and a review thread as a host shows it (`HostThread`), with `findingOfMarker`, the finding an
// inline comment's marker names, and `replyMarker` and `readReplyMarker`, the marker each of Lookover's replies
// ends with, written and read back (the claim it answers), and `newestThread`, a finding's thread among a change's;
// `HostIntake.threads` reads a change's threads, `HostWriter.reply` answers on one and `HostWriter.minimize` hides a
// comment as resolved or outdated (`MinimizeReason`), which `HostView` shows.
// The types row 7 fills so onboarding is real (ADR 0053): the connection's cause (`Connection.cause`,
// `connectionCauseOf`, a `HostError`'s `connectionCause`), the setup's GitHub step (`Setup.github`), `repo.removed`,
// a problem's fix as a command or a link (`FixAction`), and the links to GitHub's pages built on `Connection.web`
// (`githubLinks`, `GITHUB_WEB`, demo mode's `DEMO_API.github`).
// Organisations (ADR 0059, `gh.ts`): the person's own `gh` as a port (`Gh`: who it is signed in as, their
// organisations).
// One way in (ADR 0073): the connection is the shared App's alone, its causes, commands and setup step with no own
// App's, and no App level of its own: no key, no manifest.
// The shared App (ADR 0065, ADR 0066): `SHARED_APP`, its id, slug, client ID and account, shipped, never configured;
// a check's `external_id` as `checkExternalId` writes it (`<job>#<number>@<person's id>`, ADR 0077) and
// `readCheckExternalId` reads it back (`CheckExternalId`: no number in one from before, null for an older check's job
// id alone), and `checkIsFor`, whether it names a person and a pull request; `AgentHost.account`, whose token the agent holds. Signing in to it
// (`sign-in.ts`): the device flow and the refresh as a port (`HostSignIn`: a device code, `DeviceGrant`, polled to a
// `DevicePoll`, the tokens issued, `SignInTokens`, then whose they are, `person`; a `SignIn` renewed, its refusal
// the connection's cause `signed-out`), where the sign-in is kept (`SignInKeeper`, and how, `KeyProtection`, as Run
// checks says it), so the adapter never knows the disk, and why the service didn't start one (`SignInStartRefusal`).
// What the person reaches through it
// (`HostAccounts`: who they are, and every account's installation with its repositories, `ReachedAccount`, or the
// account's own cause, `AccountCause`: suspended, or `sso`, an organisation asking for SAML single sign-on). The
// connection keeps every account it reaches with its installation and its own cause (`Connection.accounts`,
// `ConnectionAccount`; `accountOf` finds a repository owner's). Each (ADR 0067) reached account says whether the person owns it (`ConnectionAccount.owner`), the accounts the App
// doesn't reach are named (`Connection.unreached`, `UnreachedAccount`: their own, and the organisations their `gh`
// names, with when they asked an owner to install it), "Ask to install on <org>" records that ask
// (`connection.askToInstall`, refused with `AskToInstallRefusal`), a suspension names who suspended it
// (`suspendedBy`), and `githubLinks.owners` is an organisation's owners page. The person's `gh` reads every active
// membership with its role at once (`Gh.memberships`, `GhMemberships`). A new install is looked for (ADR 0088):
// `connection.look` starts an install look or moves its end (`Connection.look`, `InstallLook`), refused with
// `LookRefusal`.
// The types row 9 fills so the app shows what is happening now (ADR 0055, `activity.ts`): what an engine did
// (`EngineActivity`: a file read, a search, a listing, a command), reported through `EngineRunSpec.onActivity` as
// its output arrives and never after `run` resolves; a run's activities by engine and pass (`RunActivity`,
// `RunPass`), its newest kept in `Run.activities` (the cap, `RUN_ACTIVITIES_KEPT`, is 50) and appended by
// `run.activity`; a publishing run's outbox (`Run.posting`, `RunPosting`, with the host's wait as one `wait` or
// none), replaced by `run.posting`; neither event moves the review's `updatedAt`. What a queued job waits behind
// (`ReviewJob.turn`, `Turn`: busy engines and the changes whose reviews hold them, or a round of its own change).
// What each engine session of a round used (`RoundSession`: its pass, engine, ms and tokens, from the run's
// `EngineRunResult.tookMs` and `usage`), kept apart in `RoundOutcome.sessions` and `Round.sessions`, never summed.
// Leaves: the types `diff` indexes and places with, `process` starts and limits with, `settings` resolves with.
// Ordering: events are applied in their number order; `apply` ignores one numbered at or below the snapshot's
// `seq` (sent twice, or older than the snapshot it arrives on) and takes `state.replaced` whatever its number
// (ADR 0038); it never looks for a gap: a follower that lost its stream asks after its last number and gets the
// missed events or a reload. A port that has an order states it in its file: `HostWriter`'s post order (check in
// progress → review → replies → status block → check completed), `ProcessRunner.sweepOrphans` once at start before
// any `start`, an engine run's folder complete once `run` resolves.
// Error modes: `readResult`, `enumOf` and every helper above never throw: an event about a change the snapshot
// doesn't hold changes nothing, a text without a valid result reads as null. `apply` throws `UnknownEvent`, carrying
// the type, on an event of a type this version doesn't know (ADR 0085); its callers skip it.
// An ID constructor throws a plain `Error` on a value that can't be that ID, where it enters. `reviewResultV1`
// fails with Zod's own errors. A host port's refusal is a `HostError` and nothing else (its `failure` says
// which); the engines and process ports never throw: their failures are outcomes.
export type { EngineActivity, RunActivity } from "./activity.ts";
export type { AgentChange, AgentCheck, AgentHost, AgentThread } from "./agent-host.ts";
export type { LogMessage, LookoverApi, MintedLink, NoSession } from "./api.ts";
export { API, SSE } from "./api.ts";
export { apply, emptyReview, UnknownEvent } from "./apply.ts";
export type { Change } from "./change.ts";
export {
  type CheckExternalId,
  checkExternalId,
  checkIsFor,
  readCheckExternalId,
} from "./check-external-id.ts";
export type { Claim, ClaimKind, FindingClaim } from "./claim.ts";
export type { Clock } from "./clock.ts";
export type {
  AgentRefusal,
  AgentSkill,
  CodingAgent,
  CommandPathState,
  PathOffer,
  PathReach,
  SkillState,
} from "./coding-agent.ts";
export type { Command, NoiseChoice } from "./command.ts";
export type { Confirmation, ConfirmFailure, ConfirmFallback, ConfirmVerdict } from "./confirm.ts";
export { NOT_CHECKED } from "./confirm.ts";
export type {
  AskToInstallRefusal,
  Connection,
  ConnectionAccount,
  ConnectionCause,
  InstallLook,
  LookRefusal,
  UnreachedAccount,
} from "./connection.ts";
export { accountOf, DISCOVERY_MS, DISCOVERY_RETRY_MS, sameLogin } from "./connection.ts";
export {
  asSentence,
  CODEX_REVIEWS,
  cancelPhrase,
  cancelText,
  confirmFailureText,
  dayText,
  deferralText,
  engineDetailText,
  engineHealthText,
  engineName,
  escalationText,
  FAILED_SAFETY_CHECK,
  type FailureWords,
  failedHead,
  failedLine,
  failedTitle,
  failureWords,
  findersText,
  foundAndCheckedText,
  KEPT_TWICE_WONT_FIX,
  keptText,
  lookingOverHead,
  NEEDS_YOUR_LOOK,
  NOT_DOUBLE_CHECKED,
  NOT_RAISED_AGAIN,
  NOTHING_NEW_TO_CHECK,
  notInDiffText,
  postWaitText,
  pushedText,
  type ReplyWords,
  type RoundChecks,
  replyKind,
  roundCountsText,
  roundLine,
  ruleText,
  STILL_PRESENT,
  severityText,
  shortSha,
  skipText,
  startsOnceText,
  stoppedText,
  TRY_AGAIN,
  thingsText,
  twoDigits,
  UNFINISHED_SAFETY_CHECK,
  unusableFixedText,
  unusableStateText,
  upperFirst,
  waitingHead,
  waitingText,
} from "./copy.ts";
export type { DemoClock, DemoCommand, DemoFault, DemoListing, DemoScenario, FaultId } from "./demo.ts";
export { DEMO_API, FAULTS } from "./demo.ts";
export type {
  Anchoring,
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffIndex,
  DiffLine,
  DiffLineKind,
  DiffLocation,
  DiffSide,
  IndexDiff,
  Place,
  Placement,
} from "./diff.ts";
export type { Engine, EngineId, EngineState } from "./engine.ts";
export type {
  EngineHealth,
  EngineRunOutcome,
  EngineRunResult,
  EngineRunSpec,
  Engines,
  EngineUnusable,
  EngineUsage,
  LimitMet,
} from "./engines-port.ts";
export { limitMet } from "./engines-port.ts";
export { enumOf } from "./enum-of.ts";
export type { Event, EventBody } from "./event.ts";
export type { Finding, FindingStatus, Fingerprints, Severity } from "./finding.ts";
export { bySeverity, fingerprintWord, isCounted, isUnsettled } from "./finding.ts";
export { findingOfMarker } from "./finding-marker.ts";
export type { FixAction } from "./fix.ts";
export {
  CHECK_NAME,
  FINDING_MARKER,
  REPLY_MARKER,
  REQUEST_MARKER,
  RESULT_MARKER,
  REVIEW_MARKER,
  REVIEW_RESULT_SCHEMA,
  STATUS_END_MARKER,
  STATUS_MARKER,
  WORDMARK_URLS,
} from "./frozen.ts";
export type {
  Gh,
  GhMemberships,
  GhNoAnswer,
  GhOrganisation,
  GhPerson,
  GhRole,
  GhUnanswered,
  GhWhy,
} from "./gh.ts";
export type {
  AccountCause,
  HostAccount,
  HostAccounts,
  HostInstallation,
  HostLogin,
  ReachedAccount,
} from "./github-app.ts";
export { GITHUB_WEB, githubLinks } from "./github-app.ts";
export type { ChangeRef, GitHost, HostFailure, RepositoryRef, TransientHostFailure } from "./host.ts";
export {
  CHECK_OUTPUT_MAX_BYTES,
  COMMENT_MAX_BYTES,
  characterCount,
  connectionCauseOf,
  DESCRIPTION_MAX_CHARACTERS,
  HostError,
  REVIEW_MAX_COMMENTS,
  repositoryName,
  sameRepository,
  utf8Bytes,
} from "./host.ts";
export type {
  CommitCount,
  FetchCredentials,
  FetchSpec,
  HostChange,
  HostConversationComment,
  HostIntake,
  Listing,
} from "./host-intake.ts";
export type { HostThread, HostThreadReply } from "./host-thread.ts";
export { newestThread } from "./host-thread.ts";
export type {
  HostCheck,
  HostComment,
  HostInlineComment,
  HostReview,
  HostView,
  HostViewComment,
  Minimized,
} from "./host-view.ts";
export type {
  CheckConclusion,
  CheckOutput,
  HostWriter,
  InlineComment,
  MinimizeReason,
  OpenCheckStatus,
  Reaction,
  ReviewPost,
  RoundConclusion,
} from "./host-writer.ts";
export type { IdGen } from "./id-gen.ts";
export type { ChangeId, CommitSha, ConnectionId, FindingId, JobId, RepositoryId, RunId } from "./ids.ts";
export {
  changeId,
  changeIdOf,
  changeName,
  changeNameParts,
  changePrefixOf,
  commitSha,
  connectionId,
  findingId,
  jobId,
  repositoryId,
  repositoryRefOf,
  runId,
} from "./ids.ts";
export type {
  AskedBy,
  CancelReason,
  Deferral,
  FailureCause,
  JobFailure,
  JobFailureKind,
  JobState,
  PushedBy,
  ReviewJob,
  SkipReason,
  Trigger,
  Turn,
} from "./job.ts";
export {
  deferralEngine,
  engineDeferral,
  isWaiting,
  sameDeferral,
  sameTurn,
} from "./job.ts";
export type { LoopState } from "./loop.ts";
export type { Prepared } from "./prepared.ts";
export type {
  Invocation,
  ProcessEnd,
  ProcessLimits,
  ProcessResult,
  ProcessRunner,
  StartedProcess,
} from "./process.ts";
export type { Dropped, DroppedWhy } from "./read-state.ts";
export { readState } from "./read-state.ts";
export type {
  ActionBy,
  FindingCounts,
  NextAction,
  Reconciled,
  ReplyKind,
  ThreadReply,
  Verdict,
} from "./reconciled.ts";
export type { ReplyMarked } from "./reply-marker.ts";
export { readReplyMarker, replyMarker } from "./reply-marker.ts";
export type { DepartedRepository, NoiseCounts, Repository } from "./repository.ts";
export type { Review, TimelineEntry } from "./review.ts";
export type { ReviewRequestText } from "./review-request.ts";
export { isReviewRequest, readRequest, requestedCommit, reviewRequest } from "./review-request.ts";
export type { ReviewResult, ReviewResultFinding } from "./review-result.ts";
export { readResult, reviewResultV1 } from "./review-result.ts";
export type {
  CandidateFinding,
  CandidateVerdict,
  EarlierVerdict,
  Round,
  RoundOutcome,
  RoundSession,
  RuledOut,
  SecondFind,
} from "./round.ts";
export type {
  CitedRule,
  PromptContext,
  PromptRule,
  PromptRulesFile,
  Rule,
  RulesFile,
  RulesFileName,
} from "./rule.ts";
export { normalisedRuleText, RULES_FILES } from "./rule.ts";
export type { FindRunPass, Run, RunPass, RunPosting, RunStep } from "./run.ts";
export { stepsDone } from "./run.ts";
export {
  type CheckItem,
  type LoginHolder,
  type LoginItemKind,
  type PauseFor,
  type Service,
  sameLoginHolder,
} from "./service.ts";
export type {
  Depth,
  ResolvedSetting,
  ResolvedSettings,
  Reviewers,
  SettingKey,
  SettingOrigin,
  SettingsFileError,
  SettingsFileProblem,
  SettingsRefusal,
  SettingsWriteFailure,
  SettingValue,
  SettingValues,
  Strictness,
} from "./settings.ts";
export type { ResolveSettings, SettingsLayer } from "./settings-resolve.ts";
export type { Setup, SetupGitHub, SetupStep } from "./setup.ts";
export { furthestReached, reposChosen, SETUP_ORDER } from "./setup.ts";
export type { SharedApp } from "./shared-app.ts";
export { SHARED_APP } from "./shared-app.ts";
export type {
  DeviceCode,
  DeviceGrant,
  DevicePoll,
  HostSignIn,
  KeyProtection,
  SignIn,
  SignInKeeper,
  SignInStartRefusal,
  SignInTokens,
} from "./sign-in.ts";
export type { State } from "./state.ts";
export { stateSchema } from "./state-schema.ts";
export { findingPermalink, showsStatus, spliceStatus, statusOf, statusRoom } from "./status-block.ts";
export { tiedTo } from "./tied-to.ts";
export { withoutWordmark, wordmark } from "./wordmark.ts";
