// The settings' files on disk (ADR 0049): the owner's defaults are `settings.yaml` at the data folder's root, a
// repository's own values `settings.yaml` in its folder, `<owner>/<name>/`, lowercased. A name is a path only when
// it is in GitHub's characters, never `.` or `..`, no Windows device name, no trailing dot, and its owner none of the
// service's own folders at the root (`runs`, `repos`, ...); and the port refuses any
// path that resolves outside the root. A write is whole or absent: a temporary file beside the target, readable by
// the user only, then a rename; the temporary file is removed when anything fails. The port does one file at a
// time; running the changes one after the other is the room's (`settings-writer.ts`).

import { randomUUID } from "node:crypto";
import { rename as fsRename, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RepositoryRef, SettingsWriteFailure } from "@lookover/contracts";
import type { SettingsFiles } from "@lookover/settings";
import { said } from "./said.ts";

/** The owner's defaults, at the data folder's root. */
export const OWNER_SETTINGS = "settings.yaml";

/** GitHub's characters, lowercased: an owner of letters, digits and `-`; a name of those, `_` and `.`. */
const OWNER = /^[a-z0-9-]+$/;
const NAME = /^[a-z0-9._-]+$/;
/** The names Windows keeps for its devices, alone or before an extension. */
const DEVICE = /^(con|nul|aux|prn|com[1-9]|lpt[1-9])(\..*)?$/;

/**
 * The service's own folders and files at the data folder's root, beside the store (ADR 0053): an owner of one of
 * these names would mix its repositories' settings into them, so it is never a path. The rest of the root is dotted
 * (`lookover.sqlite`, `processes.json`), which no GitHub owner is.
 */
const ROOT_FOLDERS = new Set(["session", "rooms", "repos", "runs", "self-tests", "worktrees", "github"]);

/** A piece of a path: in `chars`, never `.` or `..` (nor any trailing dot), never a device name. */
const safe = (piece: string, chars: RegExp) =>
  chars.test(piece) && !piece.endsWith(".") && !DEVICE.test(piece);

/**
 * A repository's own values, `<owner>/<name>/settings.yaml` in the data folder, the one file of that folder (the
 * store is at the root, ADR 0053); null for a name that must never become a path (its writes are refused).
 */
export function repositorySettingsFile(repo: RepositoryRef): string | null {
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase();
  if (!safe(owner, OWNER) || !safe(name, NAME) || ROOT_FOLDERS.has(owner)) return null;
  return `${owner}/${name}/${OWNER_SETTINGS}`;
}

/**
 * A settings file that couldn't be written (contracts' `SettingsWriteFailure`): `held-open` when Windows refused the
 * rename (an editor or a virus scanner holds the file), `other` for any other failure, whose words the message keeps
 * for the console. The room refuses the change with it.
 */
export class SettingsUnwritten extends Error {
  readonly file: string;
  readonly why: SettingsWriteFailure["why"];

  constructor(file: string, why: SettingsWriteFailure["why"], detail = "") {
    super(`${file} was not written: ${why === "held-open" ? "another program holds it open" : detail}`);
    this.name = "SettingsUnwritten";
    this.file = file;
    this.why = why;
  }
}

/** What the port is given besides the root: the real rename and platform, unless a test stands in for them. */
interface DiskOptions {
  rename?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
/** What Windows answers a rename onto a file another program has open. */
const HELD = new Set(["EPERM", "EACCES", "EBUSY"]);

/** The settings files under `root`, the data folder's root: the port the room is given in live and demo mode. */
export function diskSettingsFiles(root: string, o: DiskOptions = {}): SettingsFiles {
  const rename = o.rename ?? fsRename;
  const platform = o.platform ?? process.platform;
  const top = resolve(root);
  /** The file's path, refused unless it is inside the root. */
  const inside = (file: string): string => {
    const path = resolve(top, file);
    const rel = relative(top, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`${file} is outside the data folder`);
    return path;
  };
  return {
    read: async (file) => {
      const path = inside(file);
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (codeOf(error) === "ENOENT") return null;
        throw error;
      }
    },
    write: async (file, text) => {
      const path = inside(file);
      // A name no other write has, made by this write only (`wx`): never another's file, never one left over.
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } catch (error) {
        const code = codeOf(error);
        if (code !== "EEXIST") await rm(temporary, { force: true }).catch(() => {});
        const held = platform === "win32" && code !== null && HELD.has(code);
        throw new SettingsUnwritten(file, held ? "held-open" : "other", said(error));
      }
    },
    remove: async (file) => {
      const path = inside(file);
      try {
        await rm(path, { force: true });
      } catch (error) {
        throw new SettingsUnwritten(file, "other", said(error));
      }
    },
  };
}
