// @lookover/testkit: the fakes and the port suites (ADR 0031, ADR 0033, ADR 0039).
// The decision it hides: how Lookover stands in for the outside world without calling it. An in-memory Git host
// (`FakeGitHost`: `HostIntake` and `HostWriter` at once, recording every post and enforcing GitHub's known rules,
// and the coding agent's side of it, `AgentHost`, through `asAgent`), an in-memory engine (`FakeEngines`, answering
// from a script, per engine or shared), the fake `claude` and `codex` programs replaying recordings of the real ones
// (`fakeClaude`, `fakeCodex`; each `review` is a real review of the planted bugs), the sandbox repository planted
// locally with git (`plantSandbox`, `pushSandboxFix`, `SANDBOX_FIX`; `plantSandboxRules`: the owner's `REVIEW.md` on
// `main`, and pull request #1's own hostile rules files holding `SANDBOX_BAIT`, ADR 0048), and one shared suite per
// port (`describeEngines`, `describeHostIntake`, `describeHostWriter`, `describeAgentHost`,
// `describeHostInstallation`, either way in: the own App's credentials or the person signed in to the shared App,
// `describeGh`, `describeSignIn`: the device flow on the fake only, a person enters its code), run against the fake in
// every check and against the real adapter in `bun run live`, so "the fake behaves like the real thing" is proven,
// not assumed. The person's own `gh` (ADR 0059: who it is signed in as, the organisations it admins, one
// organisation's membership) is `memoryGh`, on contracts' port (`Gh`).
// Two audiences, two entries. Tests: every package's tests use the fakes and the suites through this entry (a
// test file may import this package). Demo mode (ADR 0031, ADR 0046), through `@lookover/testkit/demo`
// (`src/demo.ts`), which never reaches `bun:test`: the service's demo driver (`apps/service/src/demo/`, the one
// non-test package that declares this import) plays each scenario on `FakeGitHost`, `ScriptedEngines`,
// `ScriptedRetrieval` and the `DemoClock`; `bun run record:claude` and `record:codex` plant the sandbox and run the
// fake programs. Those pieces are the product's demo mode, not test helpers that leaked: they must work outside a
// test (no test runner, a real data folder, a service that runs for hours) and stay true to the real host and the
// real `claude` and `codex`, since what `bun dev` and the proof screenshots show is what they do.
// Interface: the fakes implement the ports of @lookover/contracts and add what a test needs to script and to
// observe them: `FakeEngines` runs that take their time and leave their folder (in memory); `FakeGitHost` as a
// world that moves (ADR 0043): refusals (`refuse`, rate-limited with its `retryAt`; `refuseChecks`, the check
// writes alone), every check state recorded (created `queued` or `in_progress`, updated, completed), changes
// opened (with their own commits' messages, counted from their base), marked ready and closed after it was made
// (`open`, `markReady`, `close`), pushes with their commit count and messages, on the head or rewriting it, that
// re-anchor earlier comments (`push` with its edits), comments from the owner and others written and edited at the
// time of its injected clock (`seedComment`, `editComment`, or the agent's `asAgent(account).comment`), a check of
// the same name from another App (`foreignCheck`), the bot's reactions counted per comment, its listings
// `unchanged` when read again with nothing changed, as GitHub's `304`, the owner's several repositories
// (`repositories`), the owner's App and its installation as GitHub's `HostInstallations` (ADR 0053: made from a
// manifest, installed on all or some repositories, uninstalled, suspended, its key revoked, a repository added,
// removed or archived; refused as GitHub refuses, each refusal with its `connectionCause`: not installed, the App's
// calls are `not_found`; the agent's go on), the person signing in to the shared App as GitHub's `HostSignIn` (ADR
// 0066: a device code entered, refused or run out, polled too soon and asked to slow down, a sign-in refreshed once per
// refresh token, every one refused once the person takes the App back, `revokeSignIn`), what that person reaches as
// GitHub's `HostAccounts` (ADR 0066: the App's own installation and, in `reaches`, others on other accounts, each
// with its repositories, which the repository ports serve through it; one suspended, `suspend(login)`, or asking for
// SAML SSO, `askSso` until `signInSso`, refuses only its own repositories and says so on its account), and GitHub's web side for demo
// mode (`fakeGitHubPages`: the "new App" page that makes the App and redirects to the callback with a code, the install
// page that grants repositories then goes to the App's setup page, the installation's page, each sending the browser to
// the service only), and Lookover's review threads (ADR 0052): every inline comment with its id and node id, the bot's
// replies and replies seeded by anyone (`seedReply`, each filed as an empty review as GitHub files it), another
// account's inline comment (`seedInline`), comments minimized (`minimize`, shown by `view`), threads outdated by a
// push.
// `DemoClock` (ADR 0046) is the service's `Clock` and `Timers` in one: standing still, time moves only by
// `advance` and `step`, which fire the due timers in their due order and let the work each started settle before
// the next; flowing (`set`), it follows the real time at a speed, one timer per real tick. `ScriptedRetrieval`
// (ADR 0046) is `retrieval`'s port without git: a worktree path and a diff per scripted commit of a change
// (`script`, `worktreeOf`: `<root>/<change>/<sha>`, nothing written there), and a repository's rules files given
// with each of its prepares (`scriptRules`). `ScriptedEngines` (ADR 0046) is
// the `Engines` port, and `engines`' `SelfTests` by shape, from a script: one answer per worktree
// and pass (`scriptFind`, `scriptConfirm`, the pass read from the marker `review`'s prompts carry), written as
// data and rendered into the text `review` reads, kept rather than consumed; a duration on the timers given,
// never a real one; health set by hand (`setHealth`), a sign-in that lands after 5 s on the clock (`signIn`), a
// failure one run ahead (`nextRunAnswers`), self-tests that pass unless a version is told to fail
// (`failSelfTest`). `FakeEngines` stays for the tests that script an answer's raw text; its durations elapse on
// the `Timers` given (real by default). Both keep health and the run folder the same way (`EngineDouble`), and both
// play an answer's `activity` (`ScriptedActivity[]`, ADR 0055) to the run's `onActivity` on those timers, each at its
// `afterMs`, before the answer: none due after it, nor after a cancel or the limit; a listener that throws is
// dropped, as the port says, and the timers never see its error. The fake `claude` replays a
// recorded `Read` in its worktree as one in the folder it runs in. Each suite takes a name
// and a `setup` that gives, once per case, a fresh adapter in the state the case needs with what the suite needs
// around it; a state the real adapter can't be brought to on demand is left out of its setup and that case is
// skipped. The suite's tests are the port's contract, written once: every outcome and failure the port defines.
// Invariants: a fake never calls the network, `claude` or `codex` (AGENTS.md rule 1); a fake with nothing
// scripted fails rather than answering a default, with one exception: `ScriptedRetrieval` gives a commit nothing
// is scripted for its default diff (`diff`, empty unless set) at a path of the job's, since the service's tests
// of the queue, the checks and recovery review changes whose code is beside the point, and an empty diff is what
// a review of no change reads (every finding then goes into the summary).
// Ordering: the fakes keep what they were asked in order (`FakeEngines.runs`, `FakeGitHost.posts`) and leave
// the order to the caller, as the real host does: a check updated or completed that was never created is refused
// (`not_found`); `FakeGitHost.push` re-anchors only the comments posted before it. A suite's cases run in any
// order: each sets up its own adapter.
// Error modes: the fakes throw the same `HostError`s an adapter would, with the same `failure` codes (and
// `FakeGitHost.refuse` makes every port call fail with one), and their runs end with the same outcomes: a
// `FakeEngines` run with nothing scripted ends `crashed`, and so does a `ScriptedEngines` run in a worktree or for a
// pass nothing is scripted for, its text saying which. `plantSandbox`, `pushSandboxFix` and `plantSandboxRules`
// throw a plain `Error` when git fails (naming the command), when a planted sandbox's record can't be read, or when
// the last two's folder holds no planted sandbox: a broken machine or a programming error, never a host's refusal.
// It must never know: Lookover's rules (`core`), the service, the UI, or how the real adapters are built.

export { DemoClock, type DemoClockOptions, type Wall } from "./demo-clock.ts";
export {
  type AgentHostFixture,
  type AgentHostSetup,
  describeAgentHost,
  type RefusingAgentFixture,
} from "./describe-agent-host.ts";
export { describeEngines, type EnginesFixture, type EnginesSetup } from "./describe-engines.ts";
export { describeGh, type GhFixture, type GhSetup } from "./describe-gh.ts";
export {
  describeHostInstallation,
  type HostAccountsFixture,
  type HostAccountsSetup,
  type HostInstallationAdapter,
  type HostInstallationFixture,
  type HostInstallationSetup,
  type ManifestFixture,
  type ReachFixture,
} from "./describe-host-installation.ts";
export {
  describeHostIntake,
  type ForkIntakeFixture,
  type HostIntakeFixture,
  type HostIntakeSetup,
  noSuchRepository,
  type RefusingIntakeFixture,
} from "./describe-host-intake.ts";
export {
  describeHostWriter,
  type HostWriterFixture,
  type HostWriterSetup,
} from "./describe-host-writer.ts";
export {
  type DeviceFlowFixture,
  describeSignIn,
  type RefreshFixture,
  type SignInFixture,
  type SignInSetup,
} from "./describe-sign-in.ts";
export type { ScriptedActivity } from "./engine-double.ts";
export {
  type ClaudeReceived,
  type ClaudeRecording,
  claudeReceived,
  type FakeProgram,
  fakeClaude,
} from "./fake-claude.ts";
export { type CodexReceived, type CodexRecording, codexReceived, fakeCodex } from "./fake-codex.ts";
export { FakeEngines, type ScriptedRun } from "./fake-engines.ts";
export {
  type GhMember,
  type MemoryGh,
  memoryGh,
} from "./fake-gh.ts";
export {
  type CommentableRange,
  type FakeAppOptions,
  type FakeChange,
  FakeGitHost,
  type FakeGitHostOptions,
  type FakeGitHubReached,
  type FakeGitHubView,
  type FakeManifest,
  type FakeReach,
  type HostPost,
  type HostRefusal,
  type PushEdit,
  type PushHow,
} from "./fake-git-host.ts";
export { fakeGitHubPages } from "./fake-github-pages.ts";
export {
  ORG_SANDBOX_REPOSITORY,
  type PlantedSandbox,
  plantSandbox,
  plantSandboxRules,
  pushSandboxFix,
  SANDBOX_BAIT,
  SANDBOX_FIX,
  SANDBOX_REPOSITORY,
  type SandboxPush,
} from "./sandbox.ts";
export {
  type ScriptedConfirmAnswer,
  type ScriptedConfirmVerdict,
  type ScriptedEarlierVerdict,
  ScriptedEngines,
  type ScriptedFailure,
  type ScriptedFindAnswer,
  type ScriptedFinding,
} from "./scripted-engines.ts";
export {
  type ScriptedPrepared,
  type ScriptedPrepareRequest,
  ScriptedRetrieval,
  type ScriptedRetrievalOptions,
} from "./scripted-retrieval.ts";
