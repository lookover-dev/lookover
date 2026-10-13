// What happened: the service sends events, and `apply` turns each into the next snapshot.
// An event carries the state it results in (the job, the run, the findings, the loop): the rules that decide
// it live in `core` and in the service, and `apply` only records it.
// Every event is numbered, one more than the one before (ADR 0038): a UI that lost its live connection can
// say which number it saw last and catch up from there.
import type { RunActivity } from "./activity.ts";
import type { Change } from "./change.ts";
import type { Connection } from "./connection.ts";
import type { Engine, EngineId } from "./engine.ts";
import type { Finding } from "./finding.ts";
import type { ChangeId, CommitSha, FindingId, RepositoryId } from "./ids.ts";
import type { ReviewJob } from "./job.ts";
import type { LoopState } from "./loop.ts";
import type { NoiseCounts, Repository } from "./repository.ts";
import type { Round } from "./round.ts";
import type { Rule } from "./rule.ts";
import type { Run, RunPosting, RunStep } from "./run.ts";
import type { Service } from "./service.ts";
import type { ResolvedSettings } from "./settings.ts";
import type { Setup } from "./setup.ts";
import type { State } from "./state.ts";

/** What happened, before it is numbered. Whoever emits events numbers them. */
export type EventBody =
  /**
   * The service's `now` moved (ADR 0046). The demo clock's advance, step and a scenario's load send one: stored
   * and numbered like any event. A stream's keepalive carries one too, at the last number the tab holds, applied
   * and never stored: it moves `now` forward and nothing else.
   */
  | { type: "clock"; at: number }
  | { type: "state.replaced"; at: number; state: State }
  | { type: "setup.changed"; at: number; setup: Partial<Setup> }
  | { type: "engine.changed"; at: number; id: EngineId; patch: Partial<Engine> }
  | { type: "connection.changed"; at: number; patch: Partial<Connection> }
  | { type: "service.changed"; at: number; patch: Partial<Service> }
  /** The owner's defaults changed: what now applies, for the owner and in each repository it names. */
  | {
      type: "settings.changed";
      at: number;
      settings: ResolvedSettings;
      repos: Record<RepositoryId, ResolvedSettings>;
    }
  | { type: "repo.changed"; at: number; repoId: RepositoryId; patch: Partial<Repository> }
  | { type: "repo.added"; at: number; repo: Repository }
  /**
   * The repository is gone from the App's installation (ADR 0053): it leaves the copy with its open changes and its
   * rules. Their reviews are kept, as a closed change's are; the store keeps its history. The copy says it departed
   * (ADR 0059) until a `repo.added` brings it back or a `repo.dismissed`.
   */
  | { type: "repo.removed"; at: number; repoId: RepositoryId }
  /** A repository said departed (ADR 0059), dismissed by the person: no longer said, back or not. */
  | { type: "repo.dismissed"; at: number; repoId: RepositoryId }
  | { type: "rule.changed"; at: number; ruleId: string; enabled: boolean }
  /**
   * A repository's rules as they now are (ADR 0048): read again from its default branch, or their counts moved
   * after a round. `rules` replaces every rule of that repository the snapshot holds, with their counts; an empty
   * list leaves it none. The owner's own rules are not a repository's and stay.
   */
  | { type: "rules.changed"; at: number; repoId: RepositoryId; rules: Rule[] }
  /**
   * A change the host lists open that Lookover did not show, or a draft marked ready for review (ADR 0043). A
   * change already shown keeps its review, when it was first seen and the commits no round has looked at.
   */
  | { type: "change.opened"; at: number; change: Change }
  /** The change is no longer open on the host (closed or merged): it leaves the list; its review is kept. */
  | { type: "change.closed"; at: number; changeId: ChangeId }
  | {
      type: "change.pushed";
      at: number;
      changeId: ChangeId;
      sha: CommitSha;
      commits: number;
      by: "you" | "agent";
    }
  /** A job was asked for, or its state changed. A job that is not running has no run. */
  | { type: "job.changed"; at: number; changeId: ChangeId; job: ReviewJob }
  /** A run of the current job started. `job` is the job as it now is: running. */
  | { type: "run.started"; at: number; changeId: ChangeId; job: ReviewJob; run: Run }
  | { type: "run.step"; at: number; changeId: ChangeId; step: RunStep }
  /**
   * What the running run's engines did since the last one (ADR 0055), oldest first, already filtered and cut: the
   * run keeps its last `RUN_ACTIVITIES_KEPT`. Nothing happens when no run goes.
   */
  | { type: "run.activity"; at: number; changeId: ChangeId; activities: RunActivity[] }
  /** The running run's outbox as it now is (ADR 0055). Nothing happens when no run goes. */
  | { type: "run.posting"; at: number; changeId: ChangeId; posting: RunPosting }
  /**
   * The run's round is through posting (ADR 0044): saved before its first post, while the run showed
   * `publishing`, it is now the change's round. `job` is the job as it now is: done, every post sent; or failed
   * `publish_failed` (or `unexpected`), the posts given up, the round kept with `findings` as they landed (not posted
   * when its review didn't), its open count and `loop` as `core` decided them. `newCommits` is the change's count
   * of commits no round has looked at yet, as it now is. Sent once per round, after a restart too: a run left
   * publishing resumes its posts and ends the same way. `preview`: the run's (ADR 0047), the round kept with nothing
   * posted, its outbox empty.
   */
  | {
      type: "round.finished";
      at: number;
      changeId: ChangeId;
      round: Round;
      job: ReviewJob;
      newCommits: number;
      findings: Finding[];
      loop: LoopState;
      preview: boolean;
      /**
       * The change's repository and its "Too noisy?" counts with this round in them (ADR 0049); absent: not counted.
       * The repository is named here, so the counts land even when the change was closed before its round finished.
       */
      noise?: { repoId: RepositoryId; counts: NoiseCounts };
    }
  | {
      type: "finding.dismissed";
      at: number;
      changeId: ChangeId;
      findingIds: FindingId[];
      findings: Finding[];
      loop: LoopState;
    };

/** An event as it is sent: what happened, and its number. */
export type Event = EventBody & {
  /** One more than the event before it. The snapshot says which number it is current up to. */
  seq: number;
};
