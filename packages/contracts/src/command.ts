// What the UI asks the service to do. No `service.start`: a stopped service can't be reached from its own UI (ADR
// 0046). The developer drawer's verbs are `demo.ts`'s, beside this and never in it.
import type { EngineId } from "./engine.ts";
import type { ChangeId, FindingId, RepositoryId } from "./ids.ts";
import type { PauseFor } from "./service.ts";
import type { SettingKey, SettingValue } from "./settings.ts";
import type { SetupStep } from "./setup.ts";

/**
 * What "Too noisy?" can do in v1 (ADR 0049, ADR 0052): dismiss a posted finding still unsettled as wrong (said on its
 * thread, the summary and the check rewritten, never raised again on the change), post only blocking findings in the
 * change's repository, or turn off the rule the finding cites.
 */
export type NoiseChoice =
  | { kind: "wrong"; changeId: ChangeId; findingId: FindingId }
  | { kind: "blocking-only"; changeId: ChangeId }
  | { kind: "rule-off"; changeId: ChangeId; findingId: FindingId };

export type Command =
  | { type: "engine.signIn"; id: EngineId }
  | { type: "engine.check" }
  /** Send the jobs deferred on this engine to the other one. Only ever the owner's choice (ADR 0029). */
  | { type: "engine.reroute"; from: EngineId }
  /**
   * "Create it on GitHub" (ADR 0053, ADR 0059): the setup waits for the App, made on your own account (`organisation`
   * null) or on the organisation of that login, which must be one the person's `gh` lists as theirs to admin when
   * asked. The page it opens makes the App where this said, whatever its own address says.
   */
  | { type: "connection.createApp"; organisation: string | null }
  /** The person's own `gh` read again (ADR 0059): when the setup's GitHub step shows, and its Check again. */
  | { type: "gh.check" }
  /**
   * "Use an existing App" (ADR 0053): the App's id and its private key, the PEM text of the file GitHub gave. The key
   * is checked, kept and never echoed, logged or put in an event or a refusal (`UseAppRefusal`).
   */
  | { type: "connection.useApp"; appId: number; key: string }
  /**
   * "Sign in with GitHub", and Sign in again once signed out (ADR 0066): a device code asked of GitHub and shown on
   * the connection (`signIn`) until the person enters it, it expires, or the sign-in is cancelled. Refused while one
   * waits, and while Lookover runs as its own App.
   */
  | { type: "connection.signIn" }
  /** The sign-in waiting for its code given up: the code no longer shown, nothing kept. Nothing when none waits. */
  | { type: "connection.cancelSignIn" }
  /**
   * "Ask to install on <org>" (ADR 0067): the person, not an owner of `account` (an organisation's login, one of
   * `Connection.unreached`), opened GitHub's install page to request the shared App there; Lookover keeps the time
   * asked (`UnreachedAccount.askedAt`) until the account is reached. The link opens the page; this only records the
   * ask. Refused as `AskToInstallRefusal` says.
   */
  | { type: "connection.askToInstall"; account: string }
  | { type: "connection.reconnect" }
  | { type: "setup.goto"; step: SetupStep }
  | { type: "setup.chooseRepos"; enabled: RepositoryId[] }
  | { type: "setup.firstReview"; changeId: ChangeId; preview: boolean }
  | { type: "setup.finish" }
  | { type: "review.request"; changeId: ChangeId }
  | { type: "noise.apply"; choice: NoiseChoice }
  | { type: "service.pause"; for: PauseFor }
  | { type: "service.resume" }
  | { type: "service.runChecks" }
  | { type: "service.unlock" }
  | { type: "service.startAtLogin"; on: boolean }
  /**
   * Your coding agent (ADR 0058): `lookover` put on the PATH through Lookover's own folder, or taken off it. Offered
   * for the binary only. A write the machine refuses refuses the command with why, the state shown as it is.
   */
  | { type: "agent.path"; on: boolean }
  /**
   * The `lookover-review-loop` skill written in an agent's folder, over whatever is there (Replace), or removed (only
   * one a Lookover stamped). Only for an agent Lookover found. Refused as `agent.path` is.
   */
  | { type: "agent.skill"; agent: EngineId; on: boolean }
  /** Your coding agent's state read again (a skill removed by hand shows as removed): when the step or Settings shows. */
  | { type: "agent.check" }
  | { type: "settings.set"; key: SettingKey; value: SettingValue }
  | { type: "repo.setEnabled"; repoId: RepositoryId; enabled: boolean }
  | { type: "repo.setSetting"; repoId: RepositoryId; key: SettingKey; value: SettingValue }
  | { type: "repo.resetSetting"; repoId: RepositoryId; key: SettingKey }
  /** A repository said departed (ADR 0059) no longer said: Repositories' × on its notice. Refused when none is said. */
  | { type: "repo.dismiss"; repoId: RepositoryId }
  | { type: "rule.setEnabled"; ruleId: string; enabled: boolean };
