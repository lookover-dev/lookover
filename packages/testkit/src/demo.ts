// @lookover/testkit/demo: testkit's second entry, for its second audience, demo mode (ADR 0031, ADR 0039,
// ADR 0046). What it gives: the scripted fakes the service's demo driver (`apps/service/src/demo/`) plays each
// scenario on, and the pieces `bun run record:claude`, `record:codex` and `bun run live` plant or name:
// `FakeGitHost` (with the owner's repositories, the App and its installation, and its clock), GitHub's pages for
// the App's manifest, install and installation, faked on it (`fakeGitHubPages`, served under `DEMO_API.github`
// so nothing opens github.com), the demo clock (`DemoClock`: the service's
// `Clock` and `Timers`, standing still or flowing at a speed), the scripted retrieval (`ScriptedRetrieval`: a
// diff and a worktree path per commit, a repository's rules files, no git), the scripted engines (`ScriptedEngines`: `Engines` and
// `SelfTests`, with a sign-in, answering per worktree and pass from data, their durations on the demo clock), the fake `claude`
// and `codex` (`fakeClaude`, `fakeCodex`), the sandbox planted locally (`plantSandbox`, `pushSandboxFix`,
// `SANDBOX_FIX`, the owner's `REVIEW.md` for its default branch `SANDBOX_RULES`) and the sandbox's name on
// GitHub (`SANDBOX_REPOSITORY`), and the person's `gh` in memory (`memoryGh`, ADR 0059). They are the same as `@lookover/testkit`'s, which tests import; the port suites and `FakeEngines` are there only.
// Invariant: nothing this entry reaches imports `bun:test` (`bun run imports` holds it), so a service in demo
// mode never loads the test runner.
export { DemoClock, type DemoClockOptions, type Wall } from "./demo-clock.ts";
export {
  type ClaudeRecording,
  type FakeProgram,
  fakeClaude,
} from "./fake-claude.ts";
export { type CodexRecording, fakeCodex } from "./fake-codex.ts";
export { type MemoryGh, memoryGh } from "./fake-gh.ts";
export {
  type CommentableRange,
  type FakeChange,
  FakeGitHost,
  type FakeGitHostOptions,
  type PushEdit,
} from "./fake-git-host.ts";
export { fakeGitHubPages } from "./fake-github-pages.ts";
export {
  ORG_SANDBOX_REPOSITORY,
  type PlantedSandbox,
  plantSandbox,
  pushSandboxFix,
  SANDBOX_FIX,
  SANDBOX_REPOSITORY,
  SANDBOX_RULES,
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
