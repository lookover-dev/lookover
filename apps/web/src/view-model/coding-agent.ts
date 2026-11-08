// Your coding agent, in words (ADR 0058; design-system.md "Your coding agent"): the rows the setup step and Settings
// show, from `Service.agent`'s facts. `lookover` in your terminal (whether the PATH finds this Lookover, and the one
// click that makes it so, for the binary only), one row per agent Lookover found (the review loop's skill in its
// folder: Install, Replace, or done), then Try it: the sentence to give the agent, naming one of the user's pull
// requests with a finding posted on GitHub, since the agent reads the findings there, else one whose posted review
// found nothing to fix, its check on the head, so the agent's `wait` reports a pass.
import {
  type AgentSkill,
  type CodingAgent,
  type Command,
  type EngineId,
  isCounted,
  type Review,
  type State,
} from "@lookover/contracts";
import { firstReviewCandidates, reviewedOnHead } from "./first-review.ts";
import type { WithCommand } from "./format.ts";
import { AGENT_REFUSED, type Refusal, refusalLine } from "./refusal.ts";
import { codePlace } from "./said.ts";

/** What a row's click sends, with its label. */
export interface AgentAction {
  label: string;
  command: Command;
}

/** Which row a row is: the PATH's, or an agent's skill. */
type AgentRowId = "path" | EngineId;

/**
 * One row: its state (`done` once satisfied, `todo` before, `stale` when something else is there: another copy's
 * launcher or skill, a folder off the PATH), its title and one line of detail, the action that moves it forward
 * (setup and Settings), and the undo Settings offers on a done row.
 */
export interface AgentRow {
  id: AgentRowId;
  state: "done" | "todo" | "stale";
  title: string | WithCommand;
  detail: string | WithCommand;
  action: AgentAction | null;
  undo: AgentAction | null;
}

/** The agents by their program, as the user knows them: the engine's id names the agent that runs on it. */
const AGENT_NAMES: Record<EngineId, string> = { claude: "Claude Code", codex: "Codex" };

const PATH_TITLE: WithCommand = { before: "", command: "lookover", after: "in your terminal" };
const RESTART = "Terminals already open need a restart.";
/** After the folder `lookover` is in, when the PATH doesn't reach it. */
const OFF_PATH = ", but that folder isn't on your PATH. Add it there, then open a new terminal.";
/** The same, said before the folder set on its own line under it (`WithCommand.alone`), then where it is. */
const OFF_PATH_ALONE = "Add this folder to your PATH, then open a new terminal.";

/** Another `lookover` comes first on the PATH: `lookover` as code, as the row's title shows it, then where it is. */
const anotherFirst = (where: WithCommand): WithCommand => ({
  before: "A terminal runs another",
  command: PATH_TITLE.command,
  after: where,
});

/**
 * Every label a row of that kind can show: what moves it forward (setup and Settings), and its undo (Settings only).
 * The screen keeps each row's action as wide as the widest it can show there.
 */
export interface RowLabels {
  setup: readonly string[];
  undo: readonly string[];
}

export const PATH_LABELS = {
  setup: ["Add to my PATH", "Point it at this Lookover"],
  undo: ["Remove from my PATH"],
} as const satisfies RowLabels;
export const SKILL_LABELS = {
  setup: ["Install the skill", "Replace"],
  undo: ["Remove the skill"],
} as const satisfies RowLabels;

/** Where the rows show: setup's step, or Settings › Your coding agent, where a done row offers its undo. */
export type AgentPlace = "setup" | "settings";

/** The one action a row shows there: what moves it forward, else, in Settings, its undo. */
export const rowAction = (row: AgentRow, place: AgentPlace): AgentAction | null =>
  row.action ?? (place === "settings" ? row.undo : null);

/** Every label a row of that kind can show there, so its action keeps the widest one's width. */
export const rowLabels = (labels: RowLabels, place: AgentPlace): readonly string[] =>
  place === "settings" ? [...labels.setup, ...labels.undo] : labels.setup;

const [ADD, POINT] = PATH_LABELS.setup;
const ADD_PATH: AgentAction = { label: ADD, command: { type: "agent.path", on: true } };
/** "Add to my PATH" again, which writes Lookover's launcher over the one another copy left. */
const POINT_PATH: AgentAction = { label: POINT, command: { type: "agent.path", on: true } };
const REMOVE_PATH: AgentAction = { label: PATH_LABELS.undo[0], command: { type: "agent.path", on: false } };

/**
 * What "Add to my PATH" does, by the folder it uses: on Windows a folder of Lookover's own holding its launcher, put
 * on the PATH; elsewhere a link in `~/.local/bin`.
 */
function addsWhat(folder: string): WithCommand {
  return folder.includes("\\")
    ? {
        before: "Adds",
        command: folder,
        kind: "path",
        after: `to your PATH. It holds only Lookover's launcher. ${RESTART}`,
        alone: "Adds to your PATH, for new terminals, the folder that holds only Lookover's launcher:",
      }
    : {
        before: "Links lookover into",
        command: folder,
        kind: "path",
        after: "for new terminals; open ones need a restart.",
        alone: "Links Lookover's launcher into this folder, for new terminals (open ones need a restart):",
      };
}

/**
 * The `lookover` in your terminal row. `command` is Lookover's (`Service.command`): once the PATH reaches this
 * Lookover, the one a terminal runs, `--home` and all.
 */
export function pathRow(agent: CodingAgent, command: string): AgentRow {
  const { path, offer } = agent;
  const row = (
    state: AgentRow["state"],
    detail: AgentRow["detail"],
    more: Partial<AgentRow> = {},
  ): AgentRow => ({
    id: "path",
    state,
    title: PATH_TITLE,
    detail,
    action: null,
    undo: null,
    ...more,
  });
  if (offer === "clone")
    return row(
      path.reach === "yes" ? "done" : "todo",
      "Lookover runs from its clone here: the skill calls it there, so your agent needs no PATH.",
    );
  // An npm install: npm put `lookover` in its own folder, so nothing is offered but what to do when that folder isn't
  // on the PATH.
  if (offer === "npm" && path.reach === "yes")
    return row("done", {
      before: "npm put it on your PATH: a terminal's",
      command,
      after: "runs this Lookover.",
      alone: "npm put it on your PATH, so a terminal runs this Lookover as:",
    });
  // Another `lookover` first (bun's, pnpm's) may be the person's only other one: said, never to remove it.
  if (offer === "npm" && path.reach === "other")
    return row(
      "stale",
      anotherFirst({
        before: "first, at",
        command: path.other,
        kind: "path",
        after: ".",
        alone: "first, at:",
      }),
    );
  if (offer === "npm")
    return row("stale", {
      before: "npm put it in",
      command: path.folder,
      kind: "path",
      after: OFF_PATH,
      alone: `${OFF_PATH_ALONE} npm put it in:`,
    });
  if (path.reach === "yes")
    return row(
      "done",
      {
        before: "A terminal's",
        command,
        after: "runs this Lookover.",
        alone: "A terminal runs this Lookover as:",
      },
      offer === "binary" ? { undo: REMOVE_PATH } : {},
    );
  switch (path.reach) {
    case "no":
      return row("todo", addsWhat(path.folder), { action: ADD_PATH });
    case "linked":
      return row(
        "stale",
        {
          before: "Lookover's link is in",
          command: path.folder,
          kind: "path",
          after: OFF_PATH,
          alone: `${OFF_PATH_ALONE} Lookover's link is in:`,
        },
        { undo: REMOVE_PATH },
      );
    case "stale":
      return row(
        "stale",
        {
          before: "Lookover's launcher runs",
          command: path.other,
          kind: "path",
          after: `instead of this copy. ${RESTART}`,
          alone: `Lookover's launcher runs another copy instead of this one. ${RESTART} That copy is at:`,
        },
        offer === "binary" ? { action: POINT_PATH } : {},
      );
    case "other":
      return row(
        "stale",
        anotherFirst({
          before: "first:",
          command: path.other,
          kind: "path",
          after: ". Take it off your PATH to reach this one.",
          alone: "first. Take it off your PATH to reach this one. It is at:",
        }),
      );
  }
}

const [INSTALL, REPLACE] = SKILL_LABELS.setup;

/** One agent's row: the review loop's skill in its folder. */
function skillRow({ agent, state, folder }: AgentSkill): AgentRow {
  const name = AGENT_NAMES[agent];
  const install = (label: string): AgentAction => ({
    label,
    command: { type: "agent.skill", agent, on: true },
  });
  const row = (detail: WithCommand, more: Partial<AgentRow>): AgentRow => ({
    id: agent,
    state: "todo",
    title: name,
    detail,
    action: null,
    undo: null,
    ...more,
  });
  switch (state) {
    case "none":
      return row(
        {
          before: "Installs the review loop's skill in",
          command: folder,
          kind: "path",
          after: `so ${name} knows the loop.`,
          alone: `Installs the review loop's skill, so ${name} knows the loop, in:`,
        },
        { action: install(INSTALL) },
      );
    case "ours":
      return row(
        {
          before: "The review loop's skill is in",
          command: folder,
          kind: "path",
          after: "and calls this Lookover.",
          alone: "The review loop's skill, which calls this Lookover, is in:",
        },
        {
          state: "done",
          undo: { label: SKILL_LABELS.undo[0], command: { type: "agent.skill", agent, on: false } },
        },
      );
    case "another":
      return row(
        {
          before: "Another Lookover's skill is in",
          command: folder,
          kind: "path",
          after: "Replace it to call this one.",
          alone: "Replace another Lookover's skill to call this one. It is in:",
        },
        { state: "stale", action: install(REPLACE) },
      );
    case "foreign":
      return row(
        {
          before: "A skill Lookover didn't write is in",
          command: folder,
          kind: "path",
          after: "Replace it to call this Lookover.",
          alone: "Replace a skill Lookover didn't write to call this Lookover. It is in:",
        },
        { state: "stale", action: install(REPLACE) },
      );
  }
}

/** One row per agent Lookover found, in the service's order (Claude Code first). */
export const skillRows = (agent: CodingAgent): AgentRow[] => agent.skills.map(skillRow);

type Detail = AgentRow["detail"];

/** The details in that order, each once. */
const distinct = (details: Detail[]): Detail[] => {
  const seen = new Set<string>();
  return details.filter((d) => {
    const key = JSON.stringify(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Every detail that row can show after a click there (done, not done, and the one it shows now), so the screen lays
 * them in one cell and the row keeps the tallest one's height at any width (design-system.md "Your coding agent").
 */
export function rowDetails(agent: CodingAgent, command: string, id: AgentRowId): Detail[] {
  if (id === "path") {
    const { folder } = agent.path;
    const shown = pathRow(agent, command).detail;
    if (agent.offer === "clone") return [shown];
    const at = (reach: "yes" | "no") => pathRow({ ...agent, path: { reach, folder } }, command).detail;
    return distinct([at("yes"), at("no"), shown]);
  }
  const skill = agent.skills.find((s) => s.agent === id);
  if (skill === undefined) return [];
  const at = (state: AgentSkill["state"]) => skillRow({ ...skill, state }).detail;
  return distinct([at("ours"), at("none"), skillRow(skill).detail]);
}

/** What Your coding agent opens with, in setup and in Settings. */
export const AGENT_INTRO =
  "After each push, your agent can ask Lookover for a review, fix what it found and push again.";

/**
 * Try it: the sentence to give the agent, naming one of the user's own pull requests with a finding posted on GitHub,
 * else one whose posted review found nothing to fix, its check on the head (in each, the setup's first review when it
 * is one, else the latest), or none, with why; then what happens next.
 */
export interface TryIt {
  sentence: string | null;
  /** Without a sentence, why and what to do; with one, what happens once the agent has it. */
  line: string | WithCommand;
}

/** What happens once the agent has the sentence, naming `wait` by Lookover's command (`Service.command`). */
const next = (command: string): WithCommand => ({
  before: "Your agent fixes and pushes, then",
  command: `${command} wait`,
  after: "asks Lookover for round 2. Each finding it fixed has its thread resolved.",
  alone:
    "Your agent fixes and pushes, then asks Lookover for round 2, which resolves each fixed finding's thread, with:",
});
/** What happens once the agent has a pull request whose posted review found nothing to fix. */
const clean = (command: string): WithCommand => ({
  before: "Lookover found nothing to fix there, so",
  command: `${command} wait`,
  after: "reports a pass. After your agent's next push, it asks for round 2.",
  alone:
    "Lookover found nothing to fix there, so this reports a pass, and after your agent's next push asks for round 2:",
});
const PREVIEW_ONLY =
  "Your first review was a preview, so nothing is on GitHub for your agent to read. Post a review on one of your pull requests first.";
const NONE = "None of your pull requests has a finding on GitHub yet. Post a review on one first.";
const NOTHING_LEFT = "None of your pull requests has a finding to fix on GitHub yet.";

/** A review that put something on GitHub: a round whose run wasn't a preview, or a finding posted. */
const wasPosted = (review: Review): boolean =>
  (review.rounds.length > 0 && !review.preview) || review.findings.some((f) => f.posted);

export function tryIt(state: State): TryIt {
  const yours = firstReviewCandidates(state);
  const first = state.setup.firstReviewChange;
  const pickOf = (tier: typeof yours) => tier.find((it) => it.change.id === first) ?? tier[0] ?? null;
  const toFix = pickOf(yours.filter((it) => it.review.findings.some(isCounted)));
  if (toFix !== null) {
    const { change } = toFix;
    return {
      sentence: `Get pull request #${change.number} of ${change.repoId} through Lookover's review: fix what it found and push.`,
      line: next(state.service.command),
    };
  }
  // A posted review found nothing to fix, its check on the head: `wait` there reports a pass.
  const passed = pickOf(yours.filter(reviewedOnHead));
  if (passed !== null) {
    const { change } = passed;
    return {
      sentence: `Get pull request #${change.number} of ${change.repoId} through Lookover's review.`,
      line: clean(state.service.command),
    };
  }
  // Nothing posted and the setup's first review was a preview; else a posted review left nothing to fix; else none.
  const posted = yours.some((it) => wasPosted(it.review));
  if (!posted && first !== null && state.reviews[first]?.preview)
    return { sentence: null, line: PREVIEW_ONLY };
  return { sentence: null, line: posted ? NOTHING_LEFT : NONE };
}

/** A command off the PATH, too long to sit in a sentence: this Lookover's own stand-in while the PATH reaches it. */
const OFF_PATH_STAND_IN = "& 'C:\\Users\\Your Name\\AppData\\Local\\Programs\\Lookover\\lookover.exe'";

/** Where Lookover's command names its data folder (`--home=`, quoted or not), so both its forms keep it. */
const HOME = /\s(?=['"]?--home=)/;

/**
 * Every line Try it can switch to on this page, each once: its own, and, where "Add to my PATH" and "Remove from my
 * PATH" switch Lookover's command, the line with `lookover` and the line with a command off the PATH (this one's
 * when it is off, a stand-in as long when it is on), each with this command's `--home`. The card holds the tallest
 * (`HeldDetail`): a long command goes on a line of its own, a short one sits in the sentence, and the card under it
 * never moves (rule 5).
 */
export function tryItLines(state: State): TryIt["line"][] {
  const { command, agent } = state.service;
  const lineWith = (c: string) => tryIt({ ...state, service: { ...state.service, command: c } }).line;
  if (agent.offer !== "binary") return [lineWith(command)];
  const at = command.search(HOME);
  const home = at === -1 ? "" : command.slice(at);
  const onPath = `lookover${home}`;
  const lines = [command, onPath, command === onPath ? `${OFF_PATH_STAND_IN}${home}` : command].map(lineWith);
  return lines.filter((line, i) => lines.findIndex((l) => JSON.stringify(l) === JSON.stringify(line)) === i);
}

/** A write the machine refused (500): what didn't change. */
const MACHINE: Record<"agent.path" | "agent.skill", string> = {
  "agent.path": "This computer refused to change your PATH. Try again.",
  "agent.skill": "This computer refused to change the skill's folder. Try again.",
};

/**
 * Why a refused `agent.*` command did nothing, said on the row it was for (one per place). Null for any other
 * refusal, which the toast says.
 */
export function agentRefusal(refusal: Refusal | null): string | null {
  const command = refusal?.command;
  if (!refusal || !command || (command.type !== "agent.path" && command.type !== "agent.skill")) return null;
  if (refusal.agent !== undefined) return AGENT_REFUSED[refusal.agent];
  return refusal.status === 500 ? MACHINE[command.type] : refusalLine(refusal);
}

/** The row a refused `agent.*` command was for: the PATH's, or the agent's whose skill it wrote. */
function refusedRow(refusal: Refusal | null): AgentRowId | null {
  const command = refusal?.command;
  if (command?.type === "agent.path") return "path";
  if (command?.type === "agent.skill") return command.agent;
  return null;
}

/**
 * Every refusal a click on a row of that kind can bring, by the service's reason or the machine's (500). Never
 * `not_offered`: it answers a PATH click where the row offers none, so no click there brings it.
 */
const REFUSALS: Record<"path" | "skill", Detail[]> = {
  path: [MACHINE["agent.path"]],
  skill: [MACHINE["agent.skill"], AGENT_REFUSED.no_such_agent, AGENT_REFUSED.not_ours],
};

/**
 * A row's mark, its state square (design-system.md "State square"): its state, `install` while still to do (a PATH
 * entry or a skill, each a thing put in place), or `refused` once a write was.
 */
type RowMark = Exclude<AgentRow["state"], "todo"> | "install" | "refused";

/** What a row shows: its mark, its detail (the refusal, while its write is refused), and every one it can show. */
export interface RowView {
  mark: RowMark;
  detail: Detail;
  /** Every detail a click there can bring and every refusal it can be told, so the row holds the tallest's height. */
  details: Detail[];
}

/**
 * A row as `refusal` leaves it: a refused write marks its own row and is said there, in place of its detail, so no
 * line under the rows waits for one (design-system.md "Your coding agent").
 */
export function rowView(
  agent: CodingAgent,
  command: string,
  row: AgentRow,
  refusal: Refusal | null,
): RowView {
  const told = refusedRow(refusal) === row.id ? agentRefusal(refusal) : null;
  const details = distinct([
    ...rowDetails(agent, command, row.id),
    ...REFUSALS[row.id === "path" ? "path" : "skill"],
    ...(told === null ? [] : [told]),
  ]);
  return told === null
    ? { mark: row.state === "todo" ? "install" : row.state, detail: row.detail, details }
    : { mark: "refused", detail: told, details };
}

/** A value on a line of its own under a row's sentence: a folder, or a command. */
interface RowValueLine {
  value: string;
  kind: "path" | "command";
}

/** One detail as a row lays it: its sentence, then the value it sets on a line of its own under it, if any. */
interface DetailLine {
  sentence: Detail;
  line: RowValueLine | null;
}

/** A row's details as it lays them (`rowLine`): its mark, the one it shows, every other one it holds the room of. */
export interface RowLineView {
  mark: RowMark;
  shown: DetailLine;
  held: DetailLine[];
}

/**
 * A detail whose one value is too long for its sentence: the sentence said alone, the value on its line; any other (a
 * refusal, a short value, a sentence naming two values) as it is, no line.
 */
function detailLine(detail: Detail): DetailLine {
  if (typeof detail === "string" || detail.alone === undefined || detail.kind === "device-code")
    return { sentence: detail, line: null };
  if (typeof detail.after !== "string" || codePlace(detail.command) !== "line")
    return { sentence: detail, line: null };
  return { sentence: detail.alone, line: { value: detail.command, kind: detail.kind ?? "command" } };
}

/**
 * Every row lays its details one way (design-system.md "Your coding agent", round 5): the sentence, then its value on
 * a line of its own right under it, across the row's text and action columns, so a long folder or command keeps to
 * one line whatever the action column takes, the same gap above it in every row, the PATH's too. The row holds every
 * other detail it can show, each with its line, so it is as tall as the tallest and nothing under it moves; the room
 * held goes under the line shown, never between the sentence and its line.
 */
export function rowLine(view: RowView): RowLineView {
  const shown = detailLine(view.detail);
  const key = (d: DetailLine) => JSON.stringify(d);
  const held = view.details.map(detailLine).filter((d) => key(d) !== key(shown));
  return {
    mark: view.mark,
    shown,
    held: held.filter((d, i) => held.findIndex((e) => key(e) === key(d)) === i),
  };
}
