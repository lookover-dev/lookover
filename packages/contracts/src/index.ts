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
// `sameDeferral`, when two deferrals are the same reason to wait; `sameTurn`, two turns the same thing to wait
// behind; `stepsDone`, a run's steps with its current one closed; `repositoryName` and `sameRepository`, a
// repository as written and compared as GitHub does (ignoring case); `reviewResultV1`, the Zod schema of
// `lookover.review-result/v1`, which parses a result where it enters, and `readResult`, which finds one in
// a check's text (the agents' helper imports only this package); `enumOf`, a Zod enum tied to the type it
// parses, so that every package's parser fails the typecheck when the type and the enum differ;
// `reviewRequest`, `readRequest`, `isReviewRequest` and `requestedCommit`, a review request's text as written and
// read (ADR 0043, ADR 0052: `full`, and the reply a request asks to have answered);
// `NOT_CHECKED`, the confirmation of a finding no confirm judged, the default every producer fills (ADR 0044).
// The second look (ADR 0044): who found each finding and what the confirm pass said of it, and the finder,
// confirmer, fallback and failure a run and a round record (the shapes in `confirm.ts`); a candidate's verdict
// and what a refuted one leaves in its round (`round.ts`); the repository's `Depth`; the engine state of a
// version that failed the self-test, and the deferral that waits on it; the skip of another author's change when
// only Codex may review it; a candidate's `Anchoring` and the placement of one whose line's text is not in the
// diff; the commits' messages a push brought. Posting safely (ADR 0044, #67): `HostWriter.findReview` and the
// job's id on a check, `REVIEW_MARKER` in `frozen.ts`, and `COMMENT_MAX_BYTES` and `REVIEW_MAX_COMMENTS` beside
// `CHECK_OUTPUT_MAX_BYTES` in `host.ts`, with `utf8Bytes`, a text measured as GitHub counts them.
// The one exception to "never a sentence": `copy.ts`, the phrases the app, GitHub and the service's log file share
// (`engineName`, `deferralText`, `failureText`, `cancelText` and `cancelPhrase`, `skipText`, `confirmFailureText`,
// `findersText`, `foundAndCheckedText`, `keptText`, `ruleText`, `CODEX_REVIEWS`, `postWaitText`, and
// `LOOKOVERS_OPENING`, what Lookover's words open with on the pull request), the service's
// sentences the web says too (`createAppRefusalText`), and the ways of writing they share (`asSentence`, `shortSha`,
// `dayText`, `twoDigits`), written once here because the web may import only this package and `publish` words the
// pull request: everything else either says stays in its own module.
// Ports (ADR 0033): `Clock` and `IdGen` (ADR 0037); `Engines`, `HostIntake` and `HostWriter` (ADR 0039, polling
// and reactions by ADR 0043), each shaped by what the service calls and nothing more, a host's listing saying
// `unchanged` when the host says so, with `HostError` as the one way a host refuses; `AgentHost`, the host as
// the coding agent sees it with its own login, shaped by what `lookover wait` calls (ADR 0021, ADR 0043);
// `HostView`, what a host shows of a change, the one shape the real adapter and the fake read back.
// `HostIntake.poster` names who posts on a repository by numeric id, the App's bot or the person signed in on the
// shared App (ADR 0066): what tells Lookover's replies on its threads, with the ids it kept.
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
// The types row 7 fills so onboarding is real (ADR 0053, `github-app.ts`): the owner's App, its installation and the
// installation port (`HostInstallations`: convert a manifest, read the App, its installation on the owner's
// account, that installation's repositories), the permissions the App asks for (`APP_PERMISSIONS`), the refusals of
// "Create it on GitHub" and "Use an existing App" (`connection.useApp`, whose key is never in an event or a refusal),
// how the key is kept as Run checks says it; the connection's cause, App and installation (`Connection.cause`,
// `connectionCauseOf`, a `HostError`'s `connectionCause`), the setup's GitHub step (`Setup.github`), `repo.removed`,
// a problem's fix as a command or a link (`FixAction`), the manifest flow's pages (`APP_FLOW`) and the links to
// GitHub's pages built on `Connection.web` (`githubLinks`, `GITHUB_WEB`, demo mode's `DEMO_API.github`).
// Organisations (ADR 0059, `gh.ts`): the person's own `gh` as a port (`Gh`: who it is signed in as, their admin
// organisations, a membership), what the setup's GitHub step shows of it (`Connection.gh`, read again by `gh.check`),
// and where "Create it on GitHub" makes the App (`connection.createApp`'s `organisation`, refused with
// `CreateAppRefusal`'s `gh-*` and `not-an-admin`).
// The shared App (ADR 0065, ADR 0066): `SHARED_APP`, its id, slug, client ID and account, shipped, never configured;
// a check's `external_id` as `checkExternalId` writes it (`<job>@<person's id>`) and `readCheckExternalId` reads it
// back (null for an older check's job id alone); `AgentHost.account`, whose token the agent holds. Signing in to it
// (`sign-in.ts`): the device flow and the refresh as a port (`HostSignIn`: a device code, `DeviceGrant`, polled to a
// `DevicePoll`, the tokens issued, `SignInTokens`, then whose they are, `person`; a `SignIn` renewed, its refusal
// the connection's cause `signed-out`), where the sign-in is kept (`SignInKeeper`), so the adapter never knows the
// disk, and why the service didn't start one (`SignInStartRefusal`). What the person reaches through it
// (`HostAccounts`: who they are, and every account's installation with its repositories, `ReachedAccount`, or the
// account's own cause, `AccountCause`: suspended, or `sso`, an organisation asking for SAML single sign-on). The
// connection keeps every account it reaches with its installation and its own cause (`Connection.accounts`,
// `ConnectionAccount`; `accountOf` finds a repository owner's), one on an own App (`ownInstallation`). On `shared`
// (ADR 0067) each reached account says whether the person owns it (`ConnectionAccount.owner`), the accounts the App
// doesn't reach are named (`Connection.unreached`, `UnreachedAccount`: their own, and the organisations their `gh`
// names, with when they asked an owner to install it), "Ask to install on <org>" records that ask
// (`connection.askToInstall`, refused with `AskToInstallRefusal`), a suspension names who suspended it
// (`suspendedBy`), and `githubLinks.owners` is an organisation's owners page. The person's `gh` reads every active
// membership with its role at once (`Gh.memberships`, `GhMemberships`).
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
// missed events or a reload. A port that has an order
// states it in its file: `HostWriter`'s post order (check in progress → review → summary → check completed),
// `ProcessRunner.sweepOrphans` once at start before any `start`, an engine run's folder complete once `run`
// resolves.
// Error modes: `apply`, `readResult`, `enumOf` and every helper above never throw: an
// event about a change the snapshot doesn't hold changes nothing, a text without a valid result reads as null.
// An ID constructor throws a plain `Error` on a value that can't be that ID, where it enters. `reviewResultV1`
// fails with Zod's own errors. A host port's refusal is a `HostError` and nothing else (its `failure` says
// which); the engines and process ports never throw: their failures are outcomes.
export type { EngineActivity, RunActivity } from "./activity.ts";
export type { AgentChange, AgentCheck, AgentHost, AgentThread } from "./agent-host.ts";
export type { LogMessage, LookoverApi, MintedLink, NoSession } from "./api.ts";
export { API, APP_FLOW, SSE } from "./api.ts";
export { apply, emptyReview } from "./apply.ts";
export type { Change } from "./change.ts";
export { checkExternalId, readCheckExternalId } from "./check-external-id.ts";
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
  ConnectionApp,
  ConnectionCause,
  ConnectionWay,
  KeyRefusal,
  UnreachedAccount,
} from "./connection.ts";
export { accountOf, ownInstallation, sameLogin } from "./connection.ts";
export {
  asSentence,
  CODEX_REVIEWS,
  cancelPhrase,
  cancelText,
  confirmFailureText,
  createAppRefusalText,
  dayText,
  deferralText,
  engineHealthText,
  engineName,
  FAILED_SAFETY_CHECK,
  failureText,
  findersText,
  foundAndCheckedText,
  GH_FIX_BEFORE,
  GH_SIGN_IN,
  ghFixText,
  keptText,
  LOOKOVERS_OPENING,
  NOT_DOUBLE_CHECKED,
  NOT_RAISED_AGAIN,
  NOTHING_NEW_TO_CHECK,
  postWaitText,
  type RoundChecks,
  ruleText,
  severityText,
  shortSha,
  skipText,
  twoDigits,
  USE_EXISTING_APP,
  unusableFixedText,
  unusableStateText,
  upperFirst,
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
  SUMMARY_MARKER,
} from "./frozen.ts";
export type {
  Gh,
  GhAdminOrganisations,
  GhChoices,
  GhMembership,
  GhMemberships,
  GhNoAnswer,
  GhOrganisation,
  GhPerson,
  GhRefusal,
  GhRole,
  GhUnanswered,
  GhWhy,
} from "./gh.ts";
export { ghRefusalOf } from "./gh.ts";
export type {
  AccountCause,
  AppCredentials,
  AppPermission,
  CreateAppRefusal,
  HostAccount,
  HostAccounts,
  HostApp,
  HostInstallation,
  HostInstallations,
  HostLogin,
  KeyProtection,
  ManifestConversion,
  NoNewApp,
  PermissionLevel,
  ReachedAccount,
  SetupGitHubRefusal,
  UseAppRefusal,
} from "./github-app.ts";
export { APP_PERMISSIONS, GITHUB_WEB, githubLinks, PRIVATE_KEY_ARMOUR } from "./github-app.ts";
export type { ChangeRef, GitHost, HostFailure, RepositoryRef, TransientHostFailure } from "./host.ts";
export {
  CHECK_OUTPUT_MAX_BYTES,
  COMMENT_MAX_BYTES,
  connectionCauseOf,
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
  CancelReason,
  Deferral,
  JobFailure,
  JobFailureKind,
  JobState,
  ReviewJob,
  SkipReason,
  Trigger,
  Turn,
} from "./job.ts";
export { deferralEngine, engineDeferral, isWaiting, sameDeferral, sameTurn } from "./job.ts";
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
export type { CheckItem, LoginItemKind, PauseFor, Service } from "./service.ts";
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
export { furthestReached, SETUP_ORDER } from "./setup.ts";
export type { SharedApp } from "./shared-app.ts";
export { SHARED_APP } from "./shared-app.ts";
export type {
  DeviceCode,
  DeviceGrant,
  DevicePoll,
  HostSignIn,
  SignIn,
  SignInKeeper,
  SignInStartRefusal,
  SignInTokens,
} from "./sign-in.ts";
export type { State } from "./state.ts";
