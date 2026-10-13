// Your coding agent, as the service keeps it (ADR 0058): whether `lookover` on the PATH reaches this Lookover
// (`CommandPath`) and the skill in each found agent's folder (`SkillFolders`), read from the machine at start, on each
// `agent.*` command, when an agent is found or gone (the room's `engine.changed`), and when the step or Settings asks
// (`agent.check`), so a change made outside Lookover shows. The machine is the truth: nothing is kept in the store.
// What it says is sent as `service.changed { agent }` whenever it differs from what the UI shows, with Lookover's
// command when the PATH moved it (`lookover` once the PATH reaches this executable). A write the machine refuses
// refuses its command with why, and what it left is shown as it is. One change at a time: each waits for the one
// before. At start, Lookover's own skill written by another version is written again (`refreshSkills`); nothing is
// created.
// It must never know: which machine, or whether its ports are the real ones or the fakes.
import { isDeepStrictEqual } from "node:util";
import type {
  AgentRefusal,
  AgentSkill,
  Clock,
  CodingAgent,
  CommandPathState,
  EngineId,
  EngineState,
  EventBody,
  PathOffer,
  Service,
} from "@lookover/contracts";
import type { CommandPath } from "./command-path.ts";
import { said } from "./said.ts";
import { renderSkill, type SkillFor, skillStateOf, staleSkill } from "./skill.ts";
import { CODING_AGENTS, type SkillFolders } from "./skill-folders.ts";

/** Lookover's command both ways: `lookover` once a terminal's PATH reaches this executable, its absolute path before. */
export interface LookoverCommands {
  onPath: string;
  offPath: string;
}

/** What the room gives: the two ports, how Lookover runs, its command, and what the skill is written for. */
export interface AgentPorts {
  path: CommandPath;
  skills: SkillFolders;
  /** Whether "Add to my PATH" applies: the binary's alone. */
  offer: PathOffer;
  /** Lookover's command (`lookoverCommand`), whether the PATH reaches this executable or not. */
  command: LookoverCommands;
  /** What the installed skill is written for: its name, the absolute command it calls, Lookover's version. */
  skill: SkillFor;
}

interface CodingAgentDeps extends AgentPorts {
  /** The agents Lookover found now, in order (`foundOf` on the engines the UI shows). */
  found(): EngineId[];
  clock: Clock;
  emit(body: EventBody): void;
  /** What the UI shows now. */
  shown(): Pick<Service, "agent" | "command">;
  log(line: string): void;
}

/** What an `agent.*` write did: done, refused by its code, or refused by the machine with why. */
export type AgentOutcome = "ok" | AgentRefusal | { refused: string };

/** `agent.path`, `agent.skill` and `agent.check`, kept in turn. */
export interface CodingAgentFlow {
  /** `agent.check`: read again, what differs sent. */
  check(): Promise<void>;
  /** `agent.path`: Lookover's folder put on the PATH or taken off, then what the machine says sent. */
  path(on: boolean): Promise<AgentOutcome>;
  /** `agent.skill`: the skill written over whatever is there, or removed (one Lookover stamped), then sent. */
  skill(agent: EngineId, on: boolean): Promise<AgentOutcome>;
  /** Settles once the change under way, if any, has. */
  idle(): Promise<void>;
}

/** The agents Lookover found: each engine installed, in `EngineId` order (Claude Code first). */
export const foundOf = (states: Record<EngineId, EngineState>): EngineId[] =>
  CODING_AGENTS.filter((id) => states[id] !== "missing");

/** Whether `lookover` reaches Lookover; not, logged, when the machine can't say. */
async function pathNow(path: CommandPath, log: (line: string) => void): Promise<CommandPathState> {
  try {
    return await path.reachable();
  } catch (error) {
    log(`Can't tell whether lookover is on the PATH: ${said(error)}`);
    return { reach: "no", folder: path.folder };
  }
}

/** The skill in `agent`'s folder; none, logged, when it can't be read. */
async function skillNow(
  ports: AgentPorts,
  agent: EngineId,
  log: (line: string) => void,
): Promise<AgentSkill> {
  const folder = ports.skills.folderOf(agent);
  try {
    return { agent, state: skillStateOf(await ports.skills.read(agent), ports.skill.command), folder };
  } catch (error) {
    log(`Can't read the skill for ${agent}: ${said(error)}`);
    return { agent, state: "none", folder };
  }
}

/**
 * At start (ADR 0058): each agent's skill that is Lookover's own, the same command, written by another version, is
 * written again for this one, so an update never leaves the agent on an old text. Nothing else is touched: no skill
 * is created, another Lookover's and a hand-made one are left as they are. Every agent's folder, found or not: a
 * skill there is the user's choice. A folder that can't be read or written is logged and left.
 */
export async function refreshSkills(ports: AgentPorts, log: (line: string) => void): Promise<void> {
  for (const agent of CODING_AGENTS) {
    try {
      if (staleSkill(await ports.skills.read(agent), ports.skill))
        await ports.skills.install(agent, renderSkill(ports.skill));
    } catch (error) {
      log(`Can't refresh the skill for ${agent}: ${said(error)}`);
    }
  }
}

/** Your coding agent as the machine says it now, for the agents `found`. */
export async function readAgent(
  ports: AgentPorts,
  found: EngineId[],
  log: (line: string) => void,
): Promise<CodingAgent> {
  const path = await pathNow(ports.path, log);
  const skills = await Promise.all(found.map((agent) => skillNow(ports, agent, log)));
  return { path, offer: ports.offer, skills };
}

/** Lookover's command for what the machine says of the PATH: `lookover` only when a terminal finds it. */
export const commandFor = (ports: Pick<AgentPorts, "command">, path: CommandPathState): string =>
  path.reach === "yes" ? ports.command.onPath : ports.command.offPath;

/** Lookover's command as the PATH says now: off the PATH, its absolute form, when the machine can't say (logged). */
export const commandNow = async (
  ports: Pick<AgentPorts, "command" | "path">,
  log: (line: string) => void,
): Promise<string> => commandFor(ports, await pathNow(ports.path, log));

export function createCodingAgent(d: CodingAgentDeps): CodingAgentFlow {
  let last: Promise<unknown> = Promise.resolve();
  /** `op` once the change before it has settled. */
  const inTurn = <T>(op: () => Promise<T>): Promise<T> => {
    const done = last.then(op);
    last = done.catch(() => {});
    return done;
  };
  /** What the machine says now, sent where the UI shows otherwise; Lookover's command with it when it moved. */
  const send = async (): Promise<void> => {
    const agent = await readAgent(d, d.found(), d.log);
    const command = commandFor(d, agent.path);
    const shown = d.shown();
    const patch: Partial<Service> = {
      ...(isDeepStrictEqual(agent, shown.agent) ? {} : { agent }),
      ...(command === shown.command ? {} : { command }),
    };
    if (Object.keys(patch).length > 0) d.emit({ type: "service.changed", at: d.clock.now(), patch });
  };
  /** `write`, then what it left sent; refused with the machine's reason. */
  const written = async (write: () => Promise<void>): Promise<"ok" | { refused: string }> => {
    try {
      await write();
    } catch (error) {
      // Whatever it left behind is shown as it is.
      await send();
      return { refused: said(error) };
    }
    await send();
    return "ok";
  };
  return {
    check: () => inTurn(send),
    path: (on) => {
      if (d.offer !== "binary") return Promise.resolve("not_offered");
      return inTurn(() => written(() => (on ? d.path.add() : d.path.remove())));
    },
    skill: (agent, on) => {
      if (!d.found().includes(agent)) return Promise.resolve("no_such_agent");
      return inTurn(async () => {
        if (on) return await written(() => d.skills.install(agent, renderSkill(d.skill)));
        let state: AgentSkill["state"];
        try {
          state = skillStateOf(await d.skills.read(agent), d.skill.command);
        } catch (error) {
          // A skill that can't be read may still be there: never said removed.
          await send();
          return { refused: said(error) };
        }
        if (state === "foreign" || state === "none") {
          // Nothing to remove, or not Lookover's: what the folder holds now is still sent, changed outside it.
          await send();
          return state === "foreign" ? "not_ours" : "ok";
        }
        return await written(() => d.skills.remove(agent));
      });
    },
    idle: () => last.then(() => {}),
  };
}
