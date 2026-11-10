// Your coding agent's rows (ADR 0058; design-system.md "Your coding agent"), shared by the setup step and Settings:
// one card of rows (ADR 0083, round 6), `lookover` in your terminal, one row per agent Lookover found, each with its
// mark and, once a write is refused, why on its own row; then Try it, a card under them, one form in both. In setup a
// row offers only what moves it forward; in Settings (its `place`) a done row offers its undo too. Each row's action
// keeps the width of its widest label, so a click that changes or ends it moves nothing; a long folder goes on a line
// of its own across the row's text and action columns. The state is read again when the rows show.
import type { Command } from "@lookover/contracts";
import { type ReactNode, useEffect } from "react";
import { isLocked, useApp, useAppState, useSend, useStoreStatus } from "../store.tsx";
import { Button, Card, CopyLine, Said, SameWidth, StatusLine } from "../ui/basics.tsx";
import { useToast } from "../ui/layers.tsx";
import { CodePath } from "../ui/path.tsx";
import {
  type AgentAction,
  type AgentPlace,
  type AgentRow,
  agentRefusal,
  PATH_LABELS,
  pathRow,
  type RowLabels,
  type RowView,
  rowAction,
  rowLabels,
  rowLine,
  rowView,
  SKILL_LABELS,
  skillRows,
  tryIt,
} from "../view-model/coding-agent.ts";
import { StateSquare } from "./common.tsx";

const NONE = "";

function RowAction({
  shown,
  labels,
  onAct,
}: {
  shown: AgentAction | null;
  labels: readonly string[];
  onAct: (command: Command) => void;
}) {
  const slots: Record<string, ReactNode> = { [NONE]: null };
  for (const label of labels)
    slots[label] = (
      <Button size="sm" onClick={() => shown && onAct(shown.command)}>
        {label}
      </Button>
    );
  return <SameWidth shown={shown?.label ?? NONE} labels={slots} />;
}

function Row({
  row,
  view,
  labels,
  place,
  onAct,
}: {
  row: AgentRow;
  /** Its mark and the detail it shows (`rowView`). */
  view: RowView;
  /** Every label this row's kind can show, so its action keeps one width; null for a row with none. */
  labels: RowLabels | null;
  place: AgentPlace;
  onAct: (command: Command) => void;
}) {
  const title = typeof row.title === "string" ? row.title : <Said words={row.title} />;
  const { mark, shown } = rowLine(view);
  return (
    <div className={`engine substep agent-row ${row.state === "done" ? "done" : "current"} mark-${mark}`}>
      <StateSquare state={mark} />
      <b>{title}</b>
      <span className="substep-detail">
        <Said words={shown.sentence} />
      </span>
      <div className="agent-act">
        {labels === null ? null : (
          <RowAction shown={rowAction(row, place)} labels={rowLabels(labels, place)} onAct={onAct} />
        )}
      </div>
      {shown.line === null ? null : (
        <span className="agent-line">
          <CodePath text={shown.line.value} kind={shown.line.kind} line />
        </span>
      )}
    </div>
  );
}

/**
 * Try it, one form wherever it shows (design-system.md "Your coding agent"): a card titled as its siblings
 * (`card-title`), the sentence to give the agent, to copy, then what happens next; or why there is none yet.
 */
function TryIt() {
  const state = useAppState();
  const toast = useToast();
  const { sentence, line } = tryIt(state);
  return (
    <Card className="try-it">
      <h4 className="card-title">Try it</h4>
      {sentence === null ? null : (
        <>
          <p className="t-small t-help">Give your agent this sentence:</p>
          <CopyLine
            value={sentence}
            onCopy={() => {
              void navigator.clipboard?.writeText(sentence);
              toast({ text: "The sentence is copied." });
            }}
          />
        </>
      )}
      {/* What happens next, then Lookover's `wait` on a line of its own, long or short: Add to my PATH changes its
          words, never the card's lines, and the card is as tall as what it says (ADR 0086). */}
      <p className="t-small t-help try-next">
        <Said words={line} />
      </p>
    </Card>
  );
}

/**
 * Your coding agent, the same in setup and Settings (`place` only picks the actions a row offers): the rows, then Try
 * it under them, a gap of the page's apart.
 */
export function CodingAgent({ place }: { place: AgentPlace }) {
  return (
    <div className="coding-agent">
      <AgentRows place={place} />
      <TryIt />
    </div>
  );
}

/** The rows, from the service's state, as `place` shows them: Settings offers each done row's undo. */
function AgentRows({ place }: { place: AgentPlace }) {
  const state = useAppState();
  const send = useSend();
  const { store } = useApp();
  const { refusal } = useStoreStatus(store);
  const { agent, command } = state.service;

  // Read again when the rows show: a skill removed by hand shows as removed (ADR 0058). Never asks to unlock.
  useEffect(() => {
    if (!isLocked(store.get())) void store.send({ type: "agent.check" });
  }, [store]);

  const act = (command: Command) => {
    // A new try clears the last refusal said here: one per place.
    if (agentRefusal(refusal) !== null) store.dismiss();
    send(command);
  };
  const path = pathRow(agent, command);
  return (
    <Card className="agent-rows">
      {/* A refusal is said on its row, in place of its detail, and announced here: only it, so a row done or
          undone is never read out. Always there, so a screen reader hears it as it comes. */}
      <StatusLine>{agentRefusal(refusal) ?? ""}</StatusLine>
      <Row
        row={path}
        view={rowView(path, refusal)}
        labels={agent.offer === "binary" ? PATH_LABELS : null}
        place={place}
        onAct={act}
      />
      {skillRows(agent).map((row) => (
        <Row
          key={row.id}
          row={row}
          view={rowView(row, refusal)}
          labels={SKILL_LABELS}
          place={place}
          onAct={act}
        />
      ))}
    </Card>
  );
}
