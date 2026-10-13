// The skill in each coding agent's folder (ADR 0058): a port, `SkillFolders`, that reads, writes and removes the
// `lookover-review-loop` skill's `SKILL.md` for one agent, Claude Code in `~/.claude/skills`, Codex in
// `~/.agents/skills`. It knows files only: whose skill it is is `skill.ts`'s to say, from the text. The fake keeps the
// folders in memory, for demo mode and the tests. The real adapter writes the files under a home folder: the user's
// (`userSkillFolders`) for the program, under the `lookover-dev-review-loop` name for a run a live config guards, never
// the user's own skill; it refuses to run on the user's home under `bun test`, as start at login's does (ADR 0045), and
// a test gives it a scratch home (`homeSkillFolders`). `bun run live`'s suite alone writes there, the dev skill only
// (`scripts/live-skill-folders.ts`).
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type EngineId, enumOf } from "@lookover/contracts";
import { type System, underTest } from "./config.ts";

/** The skill's name, its folder's: the one the user's agents learn the loop from. */
export const SKILL_NAME = "lookover-review-loop";

/** The name a run guarded by a live config installs under (ADR 0058): beside the user's own skill, never over it. */
export const DEV_SKILL_NAME = "lookover-dev-review-loop";

/** Where each agent reads its skills, under the user's home: Codex reads the agents' shared folder (ADR 0058). */
const SKILL_ROOTS = {
  claude: [".claude", "skills"],
  codex: [".agents", "skills"],
} as const satisfies Record<EngineId, readonly string[]>;

/**
 * The coding agents, Claude Code first: each engine's program is one. The typecheck refuses a list that leaves an
 * engine out, so a new engine's agent is offered the skill, or the build says why.
 */
export const CODING_AGENTS: readonly EngineId[] = enumOf<EngineId>()(["claude", "codex"]).options;

/** The skill's file in its folder. */
const SKILL_FILE = "SKILL.md";

/** The skill in each agent's own folder, for the user who runs Lookover. */
export interface SkillFolders {
  /** The skill's folder for `agent`, in full: known without reading the machine. */
  folderOf(agent: EngineId): string;
  /** What `agent`'s `SKILL.md` says, null when there is none. Rejects when it can't be read. */
  read(agent: EngineId): Promise<string | null>;
  /** Writes `text` as the skill's `SKILL.md`, over whatever is there. Rejects with why the machine refused. */
  install(agent: EngineId, text: string): Promise<void>;
  /**
   * Removes the skill's `SKILL.md`, and its folder when nothing else is left in it; nothing when there is none.
   * Rejects with why the machine refused.
   */
  remove(agent: EngineId): Promise<void>;
}

/**
 * The fake: the folders in memory, under `home` (`~` by default, as the screens would show the user's). `refuse(reason)`
 * makes `install` and `remove` reject, until `null`, and `unreadable(reason)` `read`; `put(agent, text)` is a change made outside Lookover: a skill
 * written by hand or by another Lookover, or (`null`) removed.
 */
export interface MemorySkillFolders extends SkillFolders {
  refuse(reason: string | null): void;
  unreadable(reason: string | null): void;
  put(agent: EngineId, text: string | null): void;
}

export function memorySkillFolders(o: { home?: string; name?: string } = {}): MemorySkillFolders {
  const home = o.home ?? "~";
  const name = o.name ?? SKILL_NAME;
  const held = new Map<EngineId, string>();
  let refused: string | null = null;
  let unread: string | null = null;
  const put = (agent: EngineId, text: string | null) => {
    if (text === null) held.delete(agent);
    else held.set(agent, text);
  };
  const change = (agent: EngineId, text: string | null) => {
    if (refused !== null) return Promise.reject(new Error(refused));
    put(agent, text);
    return Promise.resolve();
  };
  return {
    // A Windows home (`C:\Users\<name>`) joins with its own separator.
    folderOf: (agent) => [home, ...SKILL_ROOTS[agent], name].join(home.includes("\\") ? "\\" : "/"),
    read: (agent) =>
      unread === null ? Promise.resolve(held.get(agent) ?? null) : Promise.reject(new Error(unread)),
    install: (agent, text) => change(agent, text),
    remove: (agent) => change(agent, null),
    refuse: (reason) => {
      refused = reason;
    },
    unreadable: (reason) => {
      unread = reason;
    },
    put,
  };
}

/** Thrown by the real adapter built on the user's home under `bun test`. */
const UNDER_TEST =
  "The real skill folders never run on your home under bun test: a test writes no skill on this machine (ADR 0045). Use memorySkillFolders, or homeSkillFolders on a scratch home.";

/** Whether the error is the machine's "no such file". */
const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

/**
 * The skill's files under `home`, named `name` (`lookover-review-loop` by default). Refuses the user's home under
 * `bun test`, but for `bun run live`'s suite (`liveSuite`), which proves the real folders on the dev skill only.
 */
export function homeSkillFolders(o: { home: string; name?: string; liveSuite?: true }): SkillFolders {
  const name = o.name ?? SKILL_NAME;
  const proven = o.liveSuite === true && name === DEV_SKILL_NAME;
  if (underTest() && !proven && resolve(o.home).toLowerCase() === resolve(homedir()).toLowerCase())
    throw new Error(UNDER_TEST);
  const folderOf = (agent: EngineId) => join(o.home, ...SKILL_ROOTS[agent], name);
  const fileOf = (agent: EngineId) => join(folderOf(agent), SKILL_FILE);
  return {
    folderOf,
    read: async (agent) => {
      try {
        return await readFile(fileOf(agent), "utf8");
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    install: async (agent, text) => {
      await mkdir(folderOf(agent), { recursive: true });
      await writeFile(fileOf(agent), text, "utf8");
    },
    remove: async (agent) => {
      await rm(fileOf(agent), { force: true });
      try {
        // Only an empty folder goes: whatever else the user keeps there stays.
        await rmdir(folderOf(agent));
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))
          )
        )
          throw error;
      }
    },
  };
}

/** The skill's files in the user's own home, named `name`. Throws under `bun test`. */
export function userSkillFolders(system: System, name: string): SkillFolders {
  if (underTest()) throw new Error(UNDER_TEST);
  return homeSkillFolders({ home: system.homedir, name });
}
