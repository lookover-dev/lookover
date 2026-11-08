// Pieces shared by several screens.
import type { Command, Review, RunStep, State } from "@lookover/contracts";
import { Fragment, type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { reviewPath, useAppState, useListScope, useSend } from "../store.tsx";
import { useTickingNow } from "../ticking.tsx";
import { Button, Chip, Eyes, Icon, Row, Said, Tabs } from "../ui/basics.tsx";
import { Tip } from "../ui/layers.tsx";
import { duration, LONGEST_RUNNING_TIMES, SEPARATOR, type WithCommand } from "../view-model/format.ts";
import {
  confirmerOf,
  confirmSkipped,
  postingText,
  type RunLineParts,
  runSteps,
  stepListText,
  stepSkippedText,
  stepTime,
} from "../view-model/run.ts";
import { SAVE_IDLE, SAVE_TEXT, type SaveShown, type SaveStep, saveStep } from "../view-model/save.ts";
import { scopeTabs } from "../view-model/scope.ts";
import {
  type ChangeReview,
  chip,
  reviewAgainNote,
  reviewerOf,
  rowAction,
  rowMeta,
} from "../view-model/select.ts";
import {
  type SquareState,
  type SubStepState,
  subStepMark,
  type TodoMark,
} from "../view-model/state-square.ts";

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

/**
 * Mine and Everyone above a list of pull requests (ADR 0078): nothing until another author's is listed, then kept
 * while the page is open. `items`: every open one.
 */
export function ScopeTabs({ items }: { items: ChangeReview[] }) {
  const { scope, shown, choose } = useListScope();
  const tabs = scopeTabs(items, shown);
  return tabs ? <Tabs split label="Whose pull requests" value={scope} tabs={tabs} onChange={choose} /> : null;
}

export function ReviewRow({ item, fresh }: { item: ChangeReview; fresh?: boolean }) {
  const state = useAppState();
  const now = useTickingNow(state);
  const send = useSend();
  const navigate = useNavigate();
  const c = chip(item);
  const action = rowAction(item);
  const note = action ? reviewAgainNote(state) : null;
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
        // One line of text, one separator between its parts all along (`rowMeta`).
        <span>
          {rowMeta(state, item, now).map((part, i) => (
            <Fragment key={part.kind === "change" ? "change" : i}>
              {i > 0 ? SEPARATOR : null}
              {part.kind === "change" ? (
                <code>{part.text}</code>
              ) : part.kind === "running" ? (
                <RunLine parts={part} />
              ) : (
                part.text
              )}
            </Fragment>
          ))}
        </span>
      }
      onOpen={open}
      action={note ? <Tip text={note}>{button}</Tip> : button}
    />
  );
}

/** "reading the code · 1 min 12 s", its time a running time (design system), so ticking moves nothing after it. */
export function RunLine({ parts }: { parts: RunLineParts }) {
  return (
    <>
      {parts.doing}
      {/* The time's box is one inline grid: the no-break space alone may not hold the dot to it. */}
      <span className="nowrap">
        {SEPARATOR}
        <RunningTime time={parts.time} />
      </span>
    </>
  );
}

/**
 * A running time (design system): the time, laid in one cell over a hidden "59 min 59 s" and "99 h 59 min", the
 * longest it writes, so the box is as wide as the wider of them in whatever face it is set and ticking moves nothing
 * beside it, past ten hours too.
 */
function RunningTime({ time }: { time: string }) {
  return (
    <span className="time-running">
      <span>{time}</span>
      {LONGEST_RUNNING_TIMES.map((sizer) => (
        <span key={sizer} aria-hidden="true">
          {sizer}
        </span>
      ))}
    </span>
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
  const stepAt = stepTime(review, step, now);
  const time = <code>{active ? <RunningTime time={stepAt} /> : stepAt}</code>;
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

/**
 * Each state's mark: before, the icon of what is not done yet; the eyes while waiting, a check when done, again when
 * stale, a cross when refused.
 */
const MARKS: Record<SquareState, ReactNode> = {
  install: <Icon name="install" />,
  "sign-in": <Icon name="sign-in" />,
  wait: <Icon name="time" />,
  fix: <Icon name="alert" />,
  busy: <Eyes />,
  done: <Icon name="check" />,
  stale: <Icon name="again" />,
  refused: <Icon name="close" />,
};

/** Its class: every mark before anything is done is `todo`, one look whatever is not done yet. */
const CLASSES: Record<SquareState, string> = {
  install: "todo",
  "sign-in": "todo",
  wait: "todo",
  fix: "todo",
  busy: "busy",
  done: "done",
  stale: "stale",
  refused: "refused",
};

/** The state of a step or an AI, in a square holding its mark, in its state's colour. */
export function StateSquare({ state }: { state: SquareState }) {
  return <span className={`lg ${CLASSES[state]}`}>{MARKS[state]}</span>;
}

/** A detail given as its sentences, not as words with a command in them. */
const isSentences = (detail: string | WithCommand | readonly string[]): detail is readonly string[] =>
  Array.isArray(detail);

/**
 * A sub-step's detail, held at the height of the tallest it can show: every one in the same cell, only `shown` seen
 * (as `SameWidth` does for widths), so a sub-step done or undone moves nothing under it, at any width. A detail given
 * as sentences (first review's line) draws each as a block of its own (`.held-sentence`), in every copy held.
 */
export function HeldDetail({
  shown,
  details,
}: {
  shown: string | WithCommand | readonly string[];
  details: readonly (string | WithCommand | readonly string[])[];
}) {
  const seen = JSON.stringify(shown);
  return (
    <span className="held-detail">
      {details.map((detail) => {
        const key = JSON.stringify(detail);
        return (
          <span key={key} aria-hidden={key === seen ? undefined : true}>
            {isSentences(detail) ? (
              detail.map((sentence) => (
                <span key={sentence} className="held-sentence">
                  {sentence}
                </span>
              ))
            ) : (
              <Said words={detail} />
            )}
          </span>
        );
      })}
    </span>
  );
}

/**
 * A setup sub-step (design-system.md "State square"): its state, a title and its one action on one line, its detail
 * (`.substep-detail`) under the title; and what it holds below (`below`: setup's accounts list) on the title's text
 * column (`.substep-below`), so the action going moves nothing in it. `todo`, what its square shows before it
 * is done (a sign-in, an install). Your coding agent's rows have a layout of their own (`coding-agent.tsx`).
 */
export function SubStep({
  state,
  todo,
  title,
  children,
  action,
  below,
}: {
  state: SubStepState;
  todo: TodoMark;
  title: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  below?: ReactNode;
}) {
  const square = subStepMark(state, todo);
  return (
    <div className={`engine substep ${state} mark-${square}`}>
      <StateSquare state={square} />
      <b>{title}</b>
      <span className="substep-detail">{children}</span>
      {action === undefined ? null : <div className="substep-act">{action}</div>}
      {below ? <div className="substep-below">{below}</div> : null}
    </div>
  );
}
