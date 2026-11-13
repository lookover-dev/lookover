// The first-run setup and each watched repository's switch (ADR 0047, ADR 0053): what the setup screens and the
// repositories pages ask, kept by the store (`setup`, `repos`) and each change sent as the UI's event, `setup.changed`
// with the whole setup as it now is, `repo.changed` with the switch. The furthest step reached is the store's rule
// and `apply`'s: going back never loses the way forward. Leaving the AI step sets nothing (the `reviewers` default is
// the settings writer's, row 4). The GitHub step (ADR 0053, ADR 0073): once the person signed in to the shared App
// (`signedIn`), its install is waited for (`waiting-for-install`, the installation's wait reading it every few
// seconds); the install found (`installed`) shows the connection, with the accounts reached, and marks the step
// "nothing granted" or done, the repositories reached; the step itself moves only by the owner's `goto` (ADR 0058).
// While the GitHub step is at its start (before a sign-in, or the choice made again for another person), no sign-in
// is held for the setup, so an install's answer is nobody's and changes nothing (ADR 0095): an earlier person's check
// answering in the room's switch never skips the new person's install wait.
// The first review is the queue's request (trigger
// "first-review", a preview when the owner said "preview here only"); the setup keeps the change it was asked for,
// once the queue knows it. Moving the furthest step reached past Repositories (`chooseRepos`, or a `goto` beyond it)
// is the choice of the repositories: until then nothing asks a review by itself (ADR 0079, `reposChosen`), and the
// queue answers the coding agent's requests kept until then (`chosen`, ADR 0090). Making the
// choice again (`again`, ADR 0090) sends the setup back to the GitHub step, the furthest reached too; the room cancels
// the unfinished reviews first (`choice-again.ts`).
// It must never know: the host (the installations are read by `installation.ts`), or
// what a switch turned off does to a review (`core.intake`'s, through the queue).
import type {
  ChangeId,
  Clock,
  EventBody,
  RepositoryId,
  RepositoryRef,
  SetupGitHub,
  Setup as SetupState,
  SetupStep,
} from "@lookover/contracts";
import { furthestReached, reposChosen } from "@lookover/contracts";
import type { Store } from "@lookover/store";
import type { Installation } from "./installation.ts";
import type { OwnerAnswer } from "./queue.ts";
import { appInstalled, repoIdOf } from "./snapshot.ts";

export interface SetupDeps {
  store: Pick<Store, "setup" | "repos">;
  clock: Clock;
  emit(body: EventBody): void;
  /** The repositories the service watches now. */
  repos(): readonly RepositoryRef[];
  /** The connection's id and the installation as the service holds them, and the install's wait. */
  github: Pick<Installation, "connectionId" | "accounts" | "waitForInstall">;
  /**
   * The queue's first review of the change: a request, a preview when said; `signed-in-since` when another person's
   * sign-in began meanwhile (ADR 0090), nothing asked.
   */
  review(changeId: ChangeId, preview: boolean): Promise<OwnerAnswer>;
  /** The repositories were just chosen: the queue answers the coding agent's requests kept until then (ADR 0090). */
  chosen(): void;
}

export interface SetupFlow {
  /** The owner went to `step`: the step now, and the furthest reached if it is further. */
  goto(step: SetupStep): void;
  /**
   * "Choose repositories": every repository's switch, on for those in `enabled` and off for the others; then the
   * first review's step. From then on, the repositories kept on are reviewed by themselves (ADR 0079).
   */
  chooseRepos(enabled: RepositoryId[]): void;
  /** The setup is done. */
  finish(): void;
  /**
   * The owner turned repositories' switches on or off, one or many at once (ADR 0082): each named repository the
   * service watches, in the order it watches them, sent when its switch moved; one it doesn't watch is passed over.
   * Refused when it watches none of them.
   */
  setEnabled(repoIds: readonly RepositoryId[], enabled: boolean): "ok" | "no_such_repository";
  /**
   * A sign-in to the shared App made (ADR 0066), kept by the service, the connection naming the person already (the
   * installation's `signedIn` sent it): unless it is installed already, the install is waited for.
   */
  signedIn(): void;
  /**
   * The sign-in held at start, the choice of repositories made again (ADR 0090): unless it is installed already, the
   * GitHub step waits for its install, a wait the installation's own loop begins (`Installation.begin` reads the
   * setup), so none is begun here and none twice.
   */
  heldAtStart(): void;
  /**
   * The choice of repositories made again (ADR 0090): the setup back at the GitHub step's start, the furthest reached
   * too, not done, the first review forgotten, so the repositories are no longer chosen. The install of whoever signs
   * in is waited for by `signedIn`, once the service holds that sign-in. The repositories' switches stay, as the
   * Repositories step's starting ticks.
   */
  again(): void;
  /**
   * The shared App's installation found (ADR 0053), granting repositories or none: the connection shown connected (once),
   * with the installation; the GitHub step done, the repositories reached but not gone to (ADR 0058), or "nothing
   * granted". Nothing when the setup says so already, or while the GitHub step is at its start: no sign-in is held
   * for the setup there, so the answer is nobody's (ADR 0095).
   */
  installed(granted: boolean): void;
  /**
   * The first review of the change, asked of the queue (a preview posts nothing), and the change kept as the
   * setup's; refused for a change the service doesn't see open. Asked before another person's sign-in made the
   * choice again (ADR 0090): nothing asked, nothing kept.
   */
  firstReview(changeId: ChangeId, preview: boolean): Promise<"ok" | "no_such_change">;
}

export function createSetup(d: SetupDeps): SetupFlow {
  const now = () => d.clock.now();
  /** The setup changed as `patch` says, kept, and the UI sent the whole of it. */
  const write = (patch: Partial<SetupState>): void => {
    const before = reposChosen(d.store.setup.read());
    const setup = d.store.setup.write(patch);
    d.emit({ type: "setup.changed", at: now(), setup });
    if (!before && reposChosen(setup)) d.chosen();
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
    setEnabled: (repoIds, enabled) => {
      const named = d.repos().filter((r) => repoIds.includes(repoIdOf(r)));
      if (named.length === 0) return "no_such_repository";
      for (const repo of named) switched(repo, enabled);
      return "ok";
    },
    signedIn: () => {
      if (appInstalled(d.store.setup.read())) return;
      write({ github: "waiting-for-install" });
      d.github.waitForInstall();
    },
    heldAtStart: () => {
      if (!appInstalled(d.store.setup.read())) write({ github: "waiting-for-install" });
    },
    again: () =>
      write({ done: false, step: "github", reached: "github", github: "start", firstReviewChange: null }),
    installed: (granted) => {
      const kept = d.store.setup.read();
      const github: SetupGitHub = granted ? "done" : "nothing-granted";
      if (kept.github === github || kept.github === "start") return;
      const at = now();
      if (!appInstalled(kept)) {
        // The person's (ADR 0066).
        const id = d.github.connectionId();
        d.emit({
          type: "connection.changed",
          at,
          patch: {
            ...(id === null ? {} : { id }),
            state: "connected",
            since: at,
            accounts: d.github.accounts(),
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
      // Asked by the last person, before another's sign-in made the choice again (ADR 0090): this setup is theirs now,
      // and keeps no first review; the ask was answered, by the cancel.
      return answer === "signed-in-since" ? "ok" : answer;
    },
  };
}
