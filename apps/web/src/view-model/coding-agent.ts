// Your coding agent, in words (ADR 0058; design-system.md "Your coding agent"): the rows the setup step and Settings
// show, from `Service.agent`'s facts. `lookover` in your terminal (whether the PATH finds this Lookover, and the one
// click that makes it so, for the binary only), one row per agent Lookover found (the review loop's skill in its
// folder: Install, Replace, or done), then Try it: the sentence to give the agent, naming one of the user's pull
// requests with a finding posted on GitHub, since the agent reads the findings there.
import {
  type AgentSkill,
  type CodingAgent,
  type Command,
  type EngineId,
  isCounted,
  type Review,
  type State,
} from "@lookover/contracts";
import type { WithCommand } from "./format.ts";
import { AGENT_REFUSED, type Refusal, refusalLine } from "./refusal.ts";
import { firstReviewCandidates } from "./select.ts";

/** What a row's click sends, with its label. */
export interface AgentAction {
  label: string;
  command: Command;
}

/** Which row a row is: the PATH's, or an agent's skill. */
type AgentRowId = "path" | EngineId;

/**
 * One row: its state square (`done` once satisfied), its title and one line of detail, the action that moves it
 * forward (setup and Settings), and the undo Settings offers on a done row.
 */
export interface AgentRow {
  id: AgentRowId;
  state: "done" | "idle";
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
        after: `to your PATH. It holds only Lookover's launcher. ${RESTART}`,
      }
    : {
        before: "Links lookover into",
        command: folder,
        after: "for new terminals; open ones need a restart.",
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
      path.reach === "yes" ? "done" : "idle",
      "Lookover runs from its clone here: the skill calls it there, so your agent needs no PATH.",
    );
  // An npm install: npm put `lookover` in its own folder, so nothing is offered but what to do when that folder isn't
  // on the PATH.
  if (offer === "npm" && path.reach === "yes")
    return row("done", {
      before: "npm put it on your PATH: a terminal's",
      command,
      after: "runs this Lookover.",
    });
  // Another `lookover` first (bun's, pnpm's) may be the person's only other one: said, never to remove it.
  if (offer === "npm" && path.reach === "other")
    return row("idle", anotherFirst({ before: "first, at", command: path.other, after: "." }));
  if (offer === "npm") return row("idle", { before: "npm put it in", command: path.folder, after: OFF_PATH });
  if (path.reach === "yes")
    return row(
      "done",
      { before: "A terminal's", command, after: "runs this Lookover." },
      offer === "binary" ? { undo: REMOVE_PATH } : {},
    );
  switch (path.reach) {
    case "no":
      return row("idle", addsWhat(path.folder), { action: ADD_PATH });
    case "linked":
      return row(
        "idle",
        { before: "Lookover's link is in", command: path.folder, after: OFF_PATH },
        { undo: REMOVE_PATH },
      );
    case "stale":
      return row(
        "idle",
        {
          before: "Lookover's launcher runs",
          command: path.other,
          after: `instead of this copy. ${RESTART}`,
        },
        offer === "binary" ? { action: POINT_PATH } : {},
      );
    case "other":
      return row(
        "idle",
        anotherFirst({
          before: "first:",
          command: path.other,
          after: ". Take it off your PATH to reach this one.",
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
    state: "idle",
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
          after: `so ${name} knows the loop.`,
        },
        { action: install(INSTALL) },
      );
    case "ours":
      return row(
        { before: "The review loop's skill is in", command: folder, after: "and calls this Lookover." },
        {
          state: "done",
          undo: { label: SKILL_LABELS.undo[0], command: { type: "agent.skill", agent, on: false } },
        },
      );
    case "another":
      return row(
        { before: "Another Lookover's skill is in", command: folder, after: "Replace it to call this one." },
        { action: install(REPLACE) },
      );
    case "foreign":
      return row(
        {
          before: "A skill Lookover didn't write is in",
          command: folder,
          after: "Replace it to call this Lookover.",
        },
        { action: install(REPLACE) },
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
 * Try it: the sentence to give the agent, naming one of the user's own pull requests with a finding posted on GitHub
 * (the setup's first review when it is one, else the latest), or none, with why; then what happens next.
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
  const toFix = yours.filter((it) => it.review.findings.some(isCounted));
  const pick = toFix.find((it) => it.change.id === first) ?? toFix[0] ?? null;
  if (pick !== null) {
    const { change } = pick;
    return {
      sentence: `Get pull request #${change.number} of ${change.repoId} through Lookover's review: fix what it found and push.`,
      line: next(state.service.command),
    };
  }
  // The setup's first review was a preview; else a posted review left nothing to fix; else nothing was posted.
  if (first !== null && state.reviews[first]?.preview) return { sentence: null, line: PREVIEW_ONLY };
  const posted = yours.some((it) => wasPosted(it.review));
  return { sentence: null, line: posted ? NOTHING_LEFT : NONE };
}

/** A write the machine refused (500): what didn't change. */
const MACHINE: Record<"agent.path" | "agent.skill", string> = {
  "agent.path": "This computer refused to change your PATH. Try again.",
  "agent.skill": "This computer refused to change the skill's folder. Try again.",
};

/**
 * Why a refused `agent.*` command did nothing, said on the one refusal line under the rows (one per place). Null for
 * any other refusal, which the toast says.
 */
export function agentRefusal(refusal: Refusal | null): string | null {
  const command = refusal?.command;
  if (!refusal || !command || (command.type !== "agent.path" && command.type !== "agent.skill")) return null;
  if (refusal.agent !== undefined) return AGENT_REFUSED[refusal.agent];
  return refusal.status === 500 ? MACHINE[command.type] : refusalLine(refusal);
}
