// The save stamp's state (ADR 0049): "Saving…" from the moment a change is sent, "Saved" only once the service
// took every change in flight, and nothing once one is refused, since the band and the toast say why. A refusal
// keeps the stamp down until the next change is sent: what was in flight with it may be taken, but not all of it is.

/** What the stamp shows. Hidden takes no less room than the others: its place is reserved. */
export type SaveShown = "hidden" | "saving" | "saved";

/** One step of a change: sent to the service, taken by it, or refused (the unlock cancelled included). */
export type SaveStep = "sent" | "took" | "refused";

export interface Saving {
  shown: SaveShown;
  /** Changes sent and not answered yet. */
  pending: number;
  /** A change was refused since the last one sent. */
  refused: boolean;
}

export const SAVE_IDLE: Saving = { shown: "hidden", pending: 0, refused: false };

export const SAVE_TEXT: Record<Exclude<SaveShown, "hidden">, string> = {
  saving: "Saving…",
  saved: "Saved",
};

export function saveStep(s: Saving, step: SaveStep): Saving {
  switch (step) {
    case "sent":
      return { shown: "saving", pending: s.pending + 1, refused: false };
    case "took": {
      const pending = Math.max(0, s.pending - 1);
      return { pending, refused: s.refused, shown: s.refused ? "hidden" : pending > 0 ? "saving" : "saved" };
    }
    case "refused":
      return { shown: "hidden", pending: Math.max(0, s.pending - 1), refused: true };
    default:
      return step satisfies never;
  }
}
