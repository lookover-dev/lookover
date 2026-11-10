// The look line (ADR 0088, design-system.md "Look line"): where Lookover stands with GitHub's installations, its time
// to the second in tabular figures, a small ghost Check again that sends the look in every state, and a hidden status
// line that says a state as it comes. Settings › GitHub shows it whole at its accounts card's end; setup's
// "Your accounts" says its words on the sub-step's own line and has Check again as the sub-step's action.
import { useEffect, useRef } from "react";
import { useAppState, useSend } from "../store.tsx";
import { Button, Eyes, StatusLine } from "../ui/basics.tsx";
import { useToast } from "../ui/layers.tsx";
import { arrivalToast, CHECK_AGAIN, type LookLineView, type LookWords } from "../view-model/look-line.ts";

/** The line's words, its time to the second in tabular figures (`.clock-s`), so a new second moves nothing. */
export function LookSaid({ words }: { words: string | LookWords }) {
  if (typeof words === "string") return words;
  // One time at most in a line: its key.
  return words.map((w) =>
    typeof w === "string" ? (
      w
    ) : (
      <span key="time" className="clock-s">
        {w.time}
      </span>
    ),
  );
}

/** Check again: the look sent, whatever the connection's state; a running look moves its end on. */
export function CheckAgain() {
  const send = useSend();
  return (
    <Button variant="ghost" size="sm" className="look-again" onClick={() => send(CHECK_AGAIN.command)}>
      {CHECK_AGAIN.label}
    </Button>
  );
}

/**
 * The state's words for a screen reader, said as the state comes: never each new time it looked, nor what arrived,
 * which its toast says.
 */
export function LookStatus({ look }: { look: LookLineView }) {
  return <StatusLine>{look.status}</StatusLine>;
}

/**
 * The toast of an arrival (ADR 0088): what a look found, said once per look wherever the person is, as well as the
 * line, which may be out of view. The look the app opened on is where it starts from: an arrival already there when
 * the app loaded is not new to say.
 */
export function ArrivalToast() {
  const { look } = useAppState().connection;
  const toast = useToast();
  const before = useRef(look);
  useEffect(() => {
    const text = arrivalToast(before.current, look);
    before.current = look;
    if (text !== null) toast({ text });
  }, [look, toast]);
  return null;
}

/**
 * The line whole, a row of its own: the eyes, reading while a look runs and still otherwise (their place held in
 * every state), the fuller words (wrapping here moves nothing: the row ends the card), and Check again on the right,
 * level with the words' first line.
 */
export function LookLine({ look }: { look: LookLineView }) {
  return (
    <div className="look-line" data-state={look.state}>
      <span className="look-line-said">
        <Eyes still={look.state !== "looking"} />
        <span>
          <LookSaid words={look.full} />
        </span>
      </span>
      <CheckAgain />
      <LookStatus look={look} />
    </div>
  );
}
