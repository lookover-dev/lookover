// "This finding is wrong" (ADR 0052): the owner dismisses a finding posted and still unsettled, from "Too noisy?".
// Refused while a round of its change runs (the store's transaction says so), else saved in one write: the ledger with
// the finding dismissed (`core.findingsAfterDismissal`, the change's last round as the round it closes), and the posts
// it owes under its own key (`publish`'s `dismissalPostsOf`): the latest round's check is among them only while that
// round is on the change's head and completed its check (one it gave up on keeps its failure). The UI hears `finding.dismissed` at once; the posts follow, one dismissal of a change
// at a time, in the order they were saved (a later one's summary is the last word), each change's apart from the
// others' (a dismissal GitHub keeps waiting on one pull request holds no other's). Each is rendered as it is sent,
// from the round restated over the ledger as it then is (`core.standing`), so a late resend never says less than the
// ledger. While its posts are owed the change is busy for the take; once they end (sent, or given up at a host
// refusal, which goes to the log) the queue takes again. A dismissal a stopped service left owing is resumed at the
// next start (`resume`). It must never know: the loop's rules (`core`), the words on GitHub (`publish`), or which job
// is next (the queue).
import {
  type ChangeId,
  type Clock,
  type CommitSha,
  type EventBody,
  type FindingId,
  type IdGen,
  isCounted,
} from "@lookover/contracts";
import { findingsAfterDismissal, loopState, standing } from "@lookover/core";
import {
  type DismissalOutbox,
  type DismissalPostKind,
  type DismissalToPost,
  dismissalPostsOf,
  type Publisher,
} from "@lookover/publish";
import type { Store } from "@lookover/store";

export interface DismissDeps {
  store: Store;
  clock: Clock;
  ids: IdGen;
  publisher: Pick<Publisher, "dismiss">;
  emit(body: EventBody): void;
  /** The change's head as the inbox last listed it; null once it is closed. */
  head(changeId: ChangeId): CommitSha | null;
  /** A dismissal's posts ended: a job held behind them may start. */
  take(): void;
  log(line: string): void;
}

/** Why a dismissal is refused: no such finding, one settled or kept off the pull request, a round running. */
export type DismissRefusal = "no_such_finding" | "settled" | "reviewing";

export interface Dismissing {
  /** The owner dismissed `findingId` of `changeId` as wrong: saved and sent to the UI, its posts begun. */
  dismiss(changeId: ChangeId, findingId: FindingId): "ok" | DismissRefusal;
  /** The dismissals a stopped service left owing posts: sent again, in the order they were saved. */
  resume(): void;
  /** Stops: a post under way is cut (the next start resumes it); waits for the sends to settle. */
  stop(): Promise<void>;
}

/** What a dismissal reads of the round it restates: the plan its run saved, as `publish` took it. */
interface SavedPlan {
  post: DismissalToPost["round"];
}

export function createDismissals(d: DismissDeps): Dismissing {
  const controller = new AbortController();
  /**
   * The sends of each change, one dismissal at a time, in the order they were saved: a later one's summary is the
   * last word. Changes apart: their summaries and checks are their own.
   */
  const chains = new Map<ChangeId, Promise<void>>();

  const outboxOf = (id: string, posts: DismissalOutbox["posts"]): DismissalOutbox => ({
    posts,
    sending(kind: DismissalPostKind) {
      if (controller.signal.aborted) throw new Error("the service is stopping");
      d.store.dismissals.sending(id, kind);
    },
    sent(kind: DismissalPostKind, hostId: string) {
      // Answered after the cut: not marked, so the next start looks for it again.
      if (controller.signal.aborted) return;
      d.store.dismissals.sent(id, kind, hostId);
    },
  });

  /** Sends one dismissal's owed posts; ended once they are sent or given up, unless the service is stopping. */
  async function send(id: string): Promise<void> {
    const dismissal = d.store.dismissals.of<SavedPlan>(id);
    if (dismissal === null) return;
    const { signal } = controller;
    try {
      // The ledger as it is now: the summary and the check say where the change stands at the send.
      const findings = d.store.rounds.ledger(dismissal.changeId);
      const round = {
        ...dismissal.plan.post,
        reconciled: standing(dismissal.plan.post.reconciled, findings),
      };
      await d.publisher.dismiss(
        {
          id,
          findingId: dismissal.findingId,
          round,
          degraded: dismissal.degraded,
          checkId: dismissal.checkId,
        },
        outboxOf(id, dismissal.posts),
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      d.log(`the dismissal of ${dismissal.findingId} on ${dismissal.changeId} was not posted: ${error}`);
    }
    if (signal.aborted) return;
    d.store.dismissals.ended(id, d.clock.now());
    d.take();
  }

  const queued = (id: string, changeId: ChangeId): void => {
    const chain = (chains.get(changeId) ?? Promise.resolve())
      .then(() => send(id))
      .catch((error: unknown) => d.log(`dismissal ${id}: ${error}`));
    chains.set(changeId, chain);
    // The last send of the change gone, its chain goes too.
    void chain.then(() => {
      if (chains.get(changeId) === chain) chains.delete(changeId);
    });
  };

  return {
    dismiss(changeId, findingId) {
      const ledger = d.store.rounds.ledger(changeId);
      const finding = ledger.find((f) => f.id === findingId);
      if (finding === undefined) return "no_such_finding";
      const latest = d.store.posts.latest<SavedPlan>(changeId);
      // Only a finding on the pull request, still unsettled, has anything on GitHub to dismiss.
      if (!isCounted(finding) || latest === null) return "settled";
      // The round's check says the head's verdict only while the round is on it: a check on an older commit is left.
      const onHead = latest.plan.post.sha === d.head(changeId);
      const checkId = onHead ? latest.checkId : null;
      const closedIn = d.store.rounds.of(changeId).at(-1)?.n ?? latest.plan.post.round;
      const at = d.clock.now();
      const id = d.ids.next();
      const saved = d.store.dismissals.saved({
        id,
        changeId,
        findingId,
        runId: latest.runId,
        checkId,
        dismiss: (findings) => findingsAfterDismissal(findings, [findingId], closedIn),
        posts: dismissalPostsOf(checkId),
        at,
      });
      if (saved === "reviewing") return "reviewing";
      d.emit({
        type: "finding.dismissed",
        at,
        changeId,
        findingIds: [findingId],
        findings: saved,
        loop: loopState(saved),
      });
      queued(id, changeId);
      return "ok";
    },
    resume() {
      for (const id of d.store.dismissals.owing()) {
        const changeId = d.store.dismissals.of<SavedPlan>(id)?.changeId;
        if (changeId !== undefined) queued(id, changeId);
      }
    },
    async stop() {
      controller.abort();
      await Promise.all(chains.values());
    },
  };
}
