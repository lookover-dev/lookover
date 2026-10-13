// The first-run setup and each watched repository's switch (ADR 0047, ADR 0053): what the setup screens and the
// repositories pages ask, kept by the store (`setup`, `repos`) and each change sent as the UI's event, `setup.changed`
// with the whole setup as it now is, `repo.changed` with the switch. The furthest step reached is the store's rule
// and `apply`'s: going back never loses the way forward. Leaving the AI step sets nothing (the `reviewers` default is
// the settings writer's, row 4). The GitHub step (ADR 0053): an App created or given (`appGiven`) is waited for until
// installed (`waiting-for-install`, the installation's wait reading it every few seconds); the install found
// (`installed`) shows the connection, with the App's installation, and marks the step "nothing granted" or done, the
// repositories reached; the step itself moves only by the owner's `goto` (ADR 0058). "Create it on GitHub" only says
// the setup waits for the App (`waitForApp`): the manifest flow (`app-flow.ts`) makes it, and says here why it
// stopped short (`flowRefused`), until the owner tries again. The first review is the queue's request (trigger
// "first-review", a preview when the owner said "preview here only"); the setup keeps the change it was asked for,
// once the queue knows it.
// It must never know: the host (the installation is read by `installation.ts`, the App made by the flow), or
// what a switch turned off does to a review (`core.intake`'s, through the queue).
import type {
  ChangeId,
  Clock,
  EventBody,
  RepositoryId,
  RepositoryRef,
  SetupGitHub,
  SetupGitHubRefusal,
  Setup as SetupState,
  SetupStep,
} from "@lookover/contracts";
import { furthestReached } from "@lookover/contracts";
import type { Store } from "@lookover/store";
import type { Installation } from "./installation.ts";
import { appInstalled, appMade, connectionIdOf, repoIdOf } from "./snapshot.ts";

export interface SetupDeps {
  store: Pick<Store, "setup" | "repos">;
  clock: Clock;
  emit(body: EventBody): void;
  /** The repositories the service watches now. */
  repos(): readonly RepositoryRef[];
  /** The bot and the installation as the service holds them, and the install's wait. */
  github: Pick<Installation, "bot" | "installationId" | "waitForInstall">;
  /** The queue's first review of the change: a request, a preview when said. */
  review(changeId: ChangeId, preview: boolean): Promise<"ok" | "no_such_change">;
}

export interface SetupFlow {
  /** The owner went to `step`: the step now, and the furthest reached if it is further. */
  goto(step: SetupStep): void;
  /**
   * "Choose repositories": every repository's switch, on for those in `enabled` and off for the others; then the
   * first review's step.
   */
  chooseRepos(enabled: RepositoryId[]): void;
  /** The setup is done. */
  finish(): void;
  /** The owner turned a repository's switch on or off; refused for a repository the service doesn't watch. */
  setEnabled(repoId: RepositoryId, enabled: boolean): "ok" | "no_such_repository";
  /** "Create it on GitHub" (ADR 0053): the setup waits for the App, nothing refused shown; nothing once it is made. */
  waitForApp(): void;
  /** The manifest flow stopped short: why, shown on the GitHub step until the owner tries again. */
  flowRefused(why: SetupGitHubRefusal): void;
  /**
   * An App created or given (ADR 0053), kept by the service, the connection showing it and its bot already (the
   * installation's `adopt` sent them): unless it is installed already, the install is waited for.
   */
  appGiven(): void;
  /**
   * The App's installation found (ADR 0053), granting repositories or none: the connection shown connected (once),
   * with the installation; the GitHub step done, the repositories reached but not gone to (ADR 0058), or "nothing
   * granted". Nothing when the setup says so already.
   */
  installed(granted: boolean): void;
  /**
   * The first review of the change, asked of the queue (a preview posts nothing), and the change kept as the
   * setup's; refused for a change the service doesn't see open.
   */
  firstReview(changeId: ChangeId, preview: boolean): Promise<"ok" | "no_such_change">;
}

export function createSetup(d: SetupDeps): SetupFlow {
  const now = () => d.clock.now();
  /** The setup changed as `patch` says, kept, and the UI sent the whole of it. */
  const write = (patch: Partial<SetupState>): void => {
    d.emit({ type: "setup.changed", at: now(), setup: d.store.setup.write(patch) });
  };
  /** A watched repository's switch, kept, and sent when it moved. */
  const switched = (repo: RepositoryRef, enabled: boolean): void => {
    if (d.store.repos.enabled(repo) === enabled) return;
    d.store.repos.setEnabled(repo, enabled);
    d.emit({ type: "repo.changed", at: now(), repoId: repoIdOf(repo), patch: { enabled } });
  };
  return {
    goto: (step) => write({ step }),
    chooseRepos: (enabled) => {
      for (const repo of d.repos()) switched(repo, enabled.includes(repoIdOf(repo)));
      write({ step: "first-review" });
    },
    finish: () => write({ done: true }),
    setEnabled: (repoId, enabled) => {
      const repo = d.repos().find((r) => repoIdOf(r) === repoId);
      if (repo === undefined) return "no_such_repository";
      switched(repo, enabled);
      return "ok";
    },
    waitForApp: () => {
      if (appMade(d.store.setup.read())) return;
      write({ github: "waiting-for-app", githubRefused: null });
    },
    flowRefused: (why) => write({ githubRefused: why }),
    appGiven: () => {
      if (appInstalled(d.store.setup.read())) return;
      write({ github: "waiting-for-install", githubRefused: null });
      d.github.waitForInstall();
    },
    installed: (granted) => {
      const kept = d.store.setup.read();
      const github: SetupGitHub = granted ? "done" : "nothing-granted";
      if (kept.github === github) return;
      const at = now();
      if (!appInstalled(kept)) {
        const bot = d.github.bot();
        d.emit({
          type: "connection.changed",
          at,
          patch: {
            ...(bot === null ? {} : { id: connectionIdOf(bot) }),
            state: "connected",
            since: at,
            installationId: d.github.installationId(),
          },
        });
      }
      // The step never moves on by itself (ADR 0058): the way forward opens, and the owner's Continue moves it.
      if (!granted) write({ github });
      else write({ github, reached: furthestReached(kept.reached, "repos") });
    },
    firstReview: async (changeId, preview) => {
      const answer = await d.review(changeId, preview);
      if (answer === "ok") write({ firstReviewChange: changeId });
      return answer;
    },
  };
}
