// The reactions on review requests (ADR 0043): 👀 once a request is recorded, 🚀 once the round its job led to is
// posted, and no other. What is owed is the store's (`requests.unreacted`), so a reaction refused, or owed when the
// service stopped, is sent at the next `send`, and one sent is never sent again, after a restart too.
// Ordering: one send at a time; a send asked for while one goes makes it go round once more. A request's 👀 goes
// before its 🚀: a 👀 refused holds back that request's 🚀 until the next send.
// Errors: a reaction the host refuses goes to the log and is sent again at the next send (the poll's, a run's end);
// one on a comment the host no longer has (deleted) is given up, logged. Never throws.
// It must never know: which comments are requests, or when a job is done (the poller's, the queue's, the store's).

import { HostError, type HostWriter } from "@lookover/contracts";
import type { Store, Unreacted } from "@lookover/store";
import { said } from "./said.ts";

export interface ReactionsDeps {
  store: Store;
  writer: Pick<HostWriter, "react">;
  log(line: string): void;
}

export interface Reactions {
  /** Sends every reaction owed and not yet sent. Never throws. */
  send(): void;
  /** Sends nothing more, and waits for the send under way. */
  stop(): Promise<void>;
}

export function createReactions(d: ReactionsDeps): Reactions {
  let sending: Promise<void> | null = null;
  let again = false;
  let stopping = false;

  /** Puts the reaction on; true when it is settled (sent, or its comment gone), false when it is still owed. */
  async function react(owed: Unreacted): Promise<boolean> {
    try {
      await d.writer.react(owed.repo, owed.commentId, owed.reaction);
      return true;
    } catch (error) {
      const detail = said(error);
      const gone = error instanceof HostError && error.failure === "not_found";
      const what = `the ${owed.reaction} reaction on comment ${owed.commentId}`;
      d.log(`${what} was not sent${gone ? ", given up" : ""}: ${detail}`);
      return gone;
    }
  }

  /** Every reaction owed now, once. */
  async function sendOwed(): Promise<void> {
    /** The requests whose 👀 was refused in this send: their 🚀 waits. */
    const held = new Set<string>();
    for (const owed of d.store.requests.unreacted()) {
      if (held.has(owed.commentId)) continue;
      const settled = await react(owed);
      // Stopping: the store may be closed.
      if (stopping) return;
      if (settled) d.store.requests.reacted(owed.repo, owed.commentId, owed.reaction);
      else held.add(owed.commentId);
    }
  }

  async function goRound(): Promise<void> {
    do {
      again = false;
      await sendOwed();
    } while (again && !stopping);
  }

  return {
    send() {
      if (stopping) return;
      if (sending !== null) {
        again = true;
        return;
      }
      sending = goRound()
        .catch((error: unknown) => d.log(`the reactions owed could not be read: ${error}`))
        .finally(() => {
          sending = null;
        });
    },
    async stop() {
      stopping = true;
      await sending;
    },
  };
}
