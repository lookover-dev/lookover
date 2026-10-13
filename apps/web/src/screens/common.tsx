// Pieces shared by several screens.
import type { Command, Review, RunStep, State } from "@lookover/contracts";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { reviewPath, useAppState, useSend } from "../store.tsx";
import { useTickingNow } from "../ticking.tsx";
import { Button, Chip, Eyes, Icon, Row, Said } from "../ui/basics.tsx";
import { Tip } from "../ui/layers.tsx";
import { duration, type WithCommand } from "../view-model/format.ts";
import {
  confirmerOf,
  confirmSkipped,
  postingText,
  type RunLineParts,
  runLineParts,
  runSteps,
  stepListText,
  stepSkippedText,
  stepTime,
} from "../view-model/run.ts";
import { SAVE_IDLE, SAVE_TEXT, type SaveShown, type SaveStep, saveStep } from "../view-model/save.ts";
import {
  authorLabel,
  type ChangeReview,
  changeLabel,
  chip,
  reviewAgainNote,
  reviewerOf,
  rowAction,
  rowAge,
  status,
  statusLine,
} from "../view-model/select.ts";

/**
 * A page's save stamp, and how a change is sent through it: "Saving…" once sent, "Saved" once the service took
 * every change in flight, gone once one is refused or its unlock cancelled. `stamp` is `SaveState`'s props.
 */
export function useSaving(): { stamp: { shown: SaveShown; text: string }; save: (command: Command) => void } {
  const send = useSend();
  const [saving, setSaving] = useState(SAVE_IDLE);
  const step = (s: SaveStep) => setSaving((prev) => saveStep(prev, s));
  return {
    stamp: { shown: saving.shown, text: saving.shown === "saving" ? SAVE_TEXT.saving : SAVE_TEXT.saved },
    save: (command) => {
      step("sent");
      send(
        command,
        () => step("took"),
        () => step("refused"),
      );
    },
  };
}

export function ReviewRow({ item, fresh }: { item: ChangeReview; fresh?: boolean }) {
  const state = useAppState();
  const now = useTickingNow(state);
  const send = useSend();
  const navigate = useNavigate();
  const c = chip(item);
  const action = rowAction(item);
  const note = action ? reviewAgainNote(state) : null;
  const finished = ["settled", "skipped", "cancelled"].includes(status(item).kind);
  const open = () => navigate(reviewPath(item.change));
  const button = action ? (
    <Button size="sm" onClick={() => send(action.command)}>
      {action.label}
    </Button>
  ) : null;
  return (
    <Row
      status
      fresh={fresh ?? false}
      lead={<Chip tone={c.tone}>{c.label}</Chip>}
      title={item.change.title}
      meta={
        <>
          <code>{changeLabel(item.change)}</code>
          <span>{authorLabel(item.change)}</span>
          <span>
            {status(item).kind === "running" ? (
              <RunLine parts={runLineParts(now, item.review)} />
            ) : (
              statusLine(state, item, now)
            )}
          </span>
          {finished ? <span>{rowAge(state, item)}</span> : null}
        </>
      }
      onOpen={open}
      action={note ? <Tip text={note}>{button}</Tip> : button}
    />
  );
}

/** "reading the code · 1:12", its time a running time (design system), so ticking moves nothing after it. */
export function RunLine({ parts }: { parts: RunLineParts }) {
  return (
    <>
      {parts.doing} · <span className="time-running">{parts.time}</span>
    </>
  );
}

/**
 * The steps of the running round, ticking live, or else of the last round. The confirm step names the AI that
 * double-checks; a planned one the run passed by says there was nothing new to double-check, in the same row. The
 * posting step says the round's outbox as it posts (ADR 0055), in a row always two lines tall.
 */
export function StepList({ review, state }: { review: Review; state: State }) {
  const reviewer = reviewerOf(review);
  const confirmer = confirmerOf(review);
  const name = reviewer ? state.engines[reviewer].name : "The AI";
  const checker = confirmer ? state.engines[confirmer].name : name;
  const now = useTickingNow(state);
  return (
    <ol className="steplist">
      {runSteps(review).map((step) => (
        <StepItem
          key={step}
          step={step}
          name={step === "confirming" ? checker : name}
          review={review}
          now={now}
        />
      ))}
    </ol>
  );
}

/**
 * A step's row. The running step's time cell is a running time (design system): as wide as the longest, so ticking
 * moves nothing; the others hold a time that stands, as wide as it is, and leave their words the room.
 */
function StepItem({ step, name, review, now }: { step: RunStep; name: string; review: Review; now: number }) {
  const { run } = review;
  const done = (run ? run.steps : review.rounds.at(-1)?.steps)?.some((s) => s.step === step);
  const { doing, did } = stepListText(step, name);
  if (step === "confirming" && confirmSkipped(review)) {
    return (
      <li>
        <span className="dot" />
        <span>{stepSkippedText(step)}</span>
        <code />
      </li>
    );
  }
  const active = !done && run?.step === step;
  const time = <code className={active ? "time-running" : undefined}>{stepTime(review, step, now)}</code>;
  if (done) {
    return (
      <li className="done">
        <Icon name="check" />
        <StepText step={step}>{did}</StepText>
        {time}
      </li>
    );
  }
  return (
    <li className={active ? "active" : ""}>
      {active ? <Eyes /> : <span className="dot" />}
      <StepText step={step}>
        {active && step === "publishing" ? postingText(run.posting, now) : doing}
      </StepText>
      {time}
    </li>
  );
}

/**
 * A step's words. The posting step's hold two lines, never more, whether it waits, posts or is done: its outbox and
 * GitHub's wait never move the list, nor does the run's end.
 */
function StepText({ step, children }: { step: RunStep; children: string }) {
  if (step !== "publishing") return <span>{children}</span>;
  return (
    <span className="two-lines">
      <span>{children}</span>
    </span>
  );
}

export function roundDuration(review: Review): string {
  const round = review.rounds.at(-1);
  return round ? duration(round.endedAt - round.startedAt) : "";
}

/** A screen's page; `screen` names what it shows (proof checks a shot landed on it), absent when it found nothing. */
export function Page({
  children,
  narrow,
  screen,
}: {
  children: ReactNode;
  narrow?: boolean;
  screen?: string | undefined;
}) {
  return (
    <main className={`page ${narrow ? "narrow" : ""}`} data-screen={screen}>
      {children}
    </main>
  );
}

export function Sentence({
  title,
  small,
  still,
  action,
}: {
  title: string;
  small?: ReactNode;
  still?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="sentence-row">
      {still ? <Eyes still large /> : null}
      <h1 className="sentence">
        {title}
        {small ? <small>{small}</small> : null}
      </h1>
      {action}
    </div>
  );
}

/** The state of a step or an AI, in a square: an empty ring before, the eyes while waiting, green when done. */
export function StateSquare({ state }: { state: "done" | "busy" | "idle" }) {
  return (
    <span className={`lg ${state}`}>
      {state === "done" ? <Icon name="check" /> : state === "busy" ? <Eyes /> : <span className="dot" />}
    </span>
  );
}

/**
 * A sub-step's detail, held at the height of the tallest it can show: every one in the same cell, only `shown` seen
 * (as `SameWidth` does for widths), so a sub-step done or undone moves nothing under it, at any width.
 */
export function HeldDetail({
  shown,
  details,
}: {
  shown: string | WithCommand;
  details: readonly (string | WithCommand)[];
}) {
  const seen = JSON.stringify(shown);
  return (
    <span className="held-detail">
      {details.map((detail) => {
        const key = JSON.stringify(detail);
        return (
          <span key={key} aria-hidden={key === seen ? undefined : true}>
            <Said words={detail} />
          </span>
        );
      })}
    </span>
  );
}

/**
 * A setup sub-step (design-system.md "State square"): its state, a title, its detail (`.substep-detail`), its one
 * action; and what it asks before its action, under its title and detail as wide as both and the action
 * (`below`: "Where the App lives"), so the action going moves nothing in it.
 */
export function SubStep({
  state,
  title,
  children,
  action,
  below,
}: {
  state: "done" | "busy" | "current" | "later";
  title: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className={`engine substep ${state}`}>
      <StateSquare state={state === "done" ? "done" : state === "busy" ? "busy" : "idle"} />
      <div>
        <b>{title}</b>
        <span className="substep-detail">{children}</span>
      </div>
      {action}
      {below ? <div className="substep-below">{below}</div> : null}
    </div>
  );
}
