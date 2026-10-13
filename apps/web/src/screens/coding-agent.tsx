// Your coding agent's rows (ADR 0058; design-system.md "Your coding agent"), shared by the setup step and Settings:
// `lookover` in your terminal, one row per agent Lookover found, the refusal line, then Try it. In setup a row offers
// only what moves it forward; in Settings (its `place`) a done row offers its undo too. Each row's action keeps the
// width of its widest label, so a click that changes or ends it moves nothing. The state is read again when the rows
// show.
import type { Command } from "@lookover/contracts";
import { type ReactNode, useEffect } from "react";
import { isLocked, useApp, useAppState, useSend, useStoreStatus } from "../store.tsx";
import { Button, CopyLine, Said, SameWidth } from "../ui/basics.tsx";
import { useToast } from "../ui/layers.tsx";
import {
  type AgentAction,
  type AgentPlace,
  type AgentRow,
  agentRefusal,
  PATH_LABELS,
  pathRow,
  type RowLabels,
  rowAction,
  rowDetails,
  rowLabels,
  SKILL_LABELS,
  skillRows,
  tryIt,
} from "../view-model/coding-agent.ts";
import { HeldDetail, SubStep } from "./common.tsx";

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
  details,
  labels,
  place,
  onAct,
}: {
  row: AgentRow;
  /** Every detail this row can show after a click, the one it shows included. */
  details: readonly AgentRow["detail"][];
  /** Every label this row's kind can show, so its action keeps one width; null for a row with none. */
  labels: RowLabels | null;
  place: AgentPlace;
  onAct: (command: Command) => void;
}) {
  const title = typeof row.title === "string" ? row.title : <Said words={row.title} />;
  return (
    <SubStep
      state={row.state === "done" ? "done" : "current"}
      title={title}
      action={
        labels === null ? null : (
          <RowAction shown={rowAction(row, place)} labels={rowLabels(labels, place)} onAct={onAct} />
        )
      }
    >
      <HeldDetail shown={row.detail} details={details} />
    </SubStep>
  );
}

/** Try it: the sentence to give the agent, to copy, then what happens next; or why there is none yet. */
function TryIt() {
  const state = useAppState();
  const toast = useToast();
  const { sentence, line } = tryIt(state);
  return (
    <div className="engine try-it">
      <div>
        <b>Try it</b>
        {sentence === null ? null : (
          <span>
            Give your agent this sentence:{" "}
            <CopyLine
              value={sentence}
              onCopy={() => {
                void navigator.clipboard?.writeText(sentence);
                toast({ text: "The sentence is copied." });
              }}
            />
          </span>
        )}
        <span className="try-next">
          <Said words={line} />
        </span>
      </div>
    </div>
  );
}

/** The rows, from the service's state, as `place` shows them: Settings offers each done row's undo. */
export function AgentRows({ place }: { place: AgentPlace }) {
  const state = useAppState();
  const send = useSend();
  const { store } = useApp();
  const { refusal } = useStoreStatus(store);
  const { agent, command } = state.service;
  const refused = agentRefusal(refusal);

  // Read again when the rows show: a skill removed by hand shows as removed (ADR 0058). Never asks to unlock.
  useEffect(() => {
    if (!isLocked(store.get())) void store.send({ type: "agent.check" });
  }, [store]);

  const act = (command: Command) => {
    // A new try clears the last refusal said here: one per place.
    if (refused !== null) store.dismiss();
    send(command);
  };
  const path = pathRow(agent, command);
  return (
    <>
      <div className="agent-rows">
        <Row
          row={path}
          details={rowDetails(agent, command, path.id)}
          labels={agent.offer === "binary" ? PATH_LABELS : null}
          place={place}
          onAct={act}
        />
        {skillRows(agent).map((row) => (
          <Row
            key={row.id}
            row={row}
            details={rowDetails(agent, command, row.id)}
            labels={SKILL_LABELS}
            place={place}
            onAct={act}
          />
        ))}
        {/* Always there, empty until a write is refused: nothing under it moves when one is said or cleared. */}
        <p className="refused-line" role="status">
          {refused ?? ""}
        </p>
      </div>
      <TryIt />
    </>
  );
}
