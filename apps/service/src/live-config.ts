// The live config file (ADR 0039, ADR 0041, ADR 0053, ADR 0054, ADR 0060): `live.json` in the data folder guards
// live mode, and the program when it has one (development and agents only: the owner runs the program without one).
// Its parts: `app` and `repositories`, the test App and the repositories it may use (`bun run live`'s personal path,
// on the sandbox); `fork`, the owner's fork of the sandbox (`bun run live`'s pull request from a fork); `organisation`,
// an organisation's App and its sandbox (`bun run live`'s organisation path), and its `repositories`, the
// organisation's others, Lookover's own among them. A live service (`serve --live`, a guarded program) runs on the
// config `servedLiveConfig` answers: the organisation's App on its sandbox and those repositories when `organisation`
// lists some, else `app` on `repositories`; `bun run live` reads the file as written. Read here and in no package:
// the packages take the values as parameters (`github` is built with the list and refuses any other repository).
// The key's text is read by the one script that needs it, never printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type RepositoryRef, repositoryName, sameRepository } from "@lookover/contracts";

/** A GitHub App, by its id and the path of its private key (PEM). */
export interface LiveApp {
  id: number;
  keyPath: string;
}

/** An organisation's App and the sandbox it is installed on: `bun run live`'s organisation path. */
export interface LiveOrganisation {
  app: LiveApp;
  sandbox: RepositoryRef;
  /**
   * The organisation's repositories live mode watches besides its sandbox (ADR 0060): given, a live service runs as
   * this App on the sandbox and these (`servedLiveConfig`). Each is the organisation's that owns `sandbox`, not the
   * sandbox, and not in the top-level `repositories`: the two Apps never watch one repository.
   */
  repositories?: RepositoryRef[];
}

export interface LiveConfig {
  /** The App live mode runs as; absent, the data folder's own or the setup screens give it (ADR 0053). */
  app?: LiveApp;
  /** The repositories live mode may use; any other is refused before a request. */
  repositories: RepositoryRef[];
  /**
   * The owner's fork of the sandbox, where `bun run live` opens a pull request from a fork (ADR 0056); never listed
   * in `repositories` (the App is never installed on it). Absent, `bun run live` skips that step.
   */
  fork?: RepositoryRef;
  /**
   * An organisation's App and its sandbox, where `bun run live` proves the organisation's path after the personal
   * one (ADR 0059): never `app`, its sandbox never in `repositories` (the personal App never watches it). Its key file
   * may be missing (that path is skipped then, saying so). Absent, that path is skipped. A live service runs on it
   * when it lists `repositories` (ADR 0060), and ignores it otherwise.
   */
  organisation?: LiveOrganisation;
  /**
   * The lines the file still has that live mode no longer reads: `watch` (every repository listed is watched, ADR
   * 0053). The owner's own file keeps it, and each autopilot cycle copies that file, so it is ignored, not refused;
   * its value is never read. Absent when there are none.
   */
  ignored?: "watch"[];
}

/** The one line a start prints for an ignored `watch` (the service's and `bun run live`'s). */
export const WATCH_IGNORED = "`watch` is ignored: every repository in `repositories` is watched.";

/** A live config that names its App: what `bun run live` runs on, never through the setup screens. */
export type LiveConfigWithApp = LiveConfig & { app: LiveApp };

export const liveConfigPath = (home: string) => join(home, "live.json");

/** What to write when the file is missing or wrong, with the key named by its folder, never its content. */
export const LIVE_CONFIG_HELP = `Write it as:
  {
    "app": { "id": <the test App's id>, "keyPath": "<absolute path of its private key, PEM>" },
    "repositories": ["sasensi/lookover-sandbox"],
    "fork": "lookover-forks/lookover-sandbox",
    "organisation": {
      "app": { "id": <the organisation's App's id>, "keyPath": "<absolute path of its private key, PEM>" },
      "sandbox": "lookover-dev/lookover-sandbox",
      "repositories": ["lookover-dev/lookover-private"]
    }
  }
The test App is lookover-spike-sasensi; its id and key are in spikes/03-github/.secret/ of the main checkout.
Without "app", the data folder's App is used; a fresh one shows the setup, where "Use an existing App" gives it.
bun dev --live watches every repository listed that the App's installation lists: those of "repositories" as
"app", or, when "organisation" lists "repositories", its sandbox and those as the organisation's App. bun run live
uses sasensi/lookover-sandbox only, and needs "app". "fork", optional, is the owner's fork of the sandbox, never
listed in "repositories": bun run live opens a pull request from it, and skips that step without it.
"organisation", optional, is an organisation's App (never "app") and its sandbox (never listed in "repositories"):
bun run live proves the organisation's path on it after the personal one, and skips that path, saying why, without
it, without its key file, or when the App is not installed on its sandbox. Its "repositories", optional, are the
organisation's others, Lookover's own among them: each the sandbox's organisation's, never the sandbox, never in
the top-level "repositories"; with them, a live service needs its key file. bun run export-app-key writes the key of
an App made in a data folder to a key file.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** GitHub's characters: an owner of letters, digits and `-`; a name of letters, digits, `-`, `_` and `.`. */
const OWNER = /^[A-Za-z0-9-]+$/;
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * `owner/name` as a repository, in GitHub's characters; `undefined` for anything else. The pieces become folder
 * names (a repository's settings and mirror), so nothing that could lead out of the data folder (`..`, `C:`, a
 * slash) gets through.
 */
function repository(value: unknown): RepositoryRef | undefined {
  const [owner, name, ...rest] = typeof value === "string" ? value.split("/") : [];
  if (!owner || !name || rest.length > 0) return undefined;
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return undefined;
  return { owner, name };
}

/**
 * Refuses two of `repositories` sharing a name (GitHub's names ignore case), saying which `line` lists them: a change
 * is known by its repository's name (`<name>#<n>`, ADR 0053), so two of one name given one service would share their
 * changes.
 */
function noTwins(repositories: RepositoryRef[], line: string, wrong: (what: string) => Error): void {
  const seen = new Map<string, RepositoryRef>();
  for (const repo of repositories) {
    const first = seen.get(repo.name.toLowerCase());
    if (first)
      throw wrong(
        `"${line}" lists two repositories named ${first.name.toLowerCase()}, ${repositoryName(first)} and ${repositoryName(repo)}: a change is known by its repository's name, so keep one of them`,
      );
    seen.set(repo.name.toLowerCase(), repo);
  }
}

/** The `fork` line as a repository, `undefined` when absent; refused when not one, or when `repositories` lists it. */
function forkIn(
  value: unknown,
  repositories: RepositoryRef[],
  wrong: (what: string) => Error,
): RepositoryRef | undefined {
  if (value === undefined) return undefined;
  const fork = repository(value);
  if (!fork) throw wrong(`"fork", when given, must be one repository, "owner/name"`);
  if (repositories.some((r) => sameRepository(r, fork)))
    throw wrong(
      `"fork" names ${repositoryName(fork)}, which "repositories" lists too: the App is never installed on the fork, so take it out of "repositories"`,
    );
  return fork;
}

const ORGANISATION_SHAPE = `"organisation", when given, must be { "app": { "id": <its id>, "keyPath": "<its key>" }, "sandbox": "owner/name", "repositories": ["owner/name"] }, its "repositories" optional`;

/**
 * The `organisation` line, `undefined` when absent; refused when not of its shape, when its sandbox is listed in
 * `repositories`, or when its App is `app`. Its key file is not looked for: missing, `bun run live` skips that path.
 */
function organisationIn(
  value: unknown,
  repositories: RepositoryRef[],
  app: LiveApp | undefined,
  wrong: (what: string) => Error,
): LiveOrganisation | undefined {
  if (value === undefined) return undefined;
  const line: Record<string, unknown> = isRecord(value) ? value : {};
  const sandbox = repository(line.sandbox);
  const given = isRecord(line.app) ? line.app : undefined;
  const { id, keyPath } = given ?? {};
  if (
    !sandbox ||
    typeof id !== "number" ||
    !Number.isInteger(id) ||
    typeof keyPath !== "string" ||
    keyPath === ""
  )
    throw wrong(ORGANISATION_SHAPE);
  if (repositories.some((r) => sameRepository(r, sandbox)))
    throw wrong(
      `"organisation.sandbox" names ${repositoryName(sandbox)}, which "repositories" lists too: the organisation's App watches it, so take it out of "repositories"`,
    );
  if (app?.id === id)
    throw wrong(
      `"organisation.app" names App ${id}, which "app" names too: the organisation's App is another one`,
    );
  const theirs = organisationRepositoriesIn(line.repositories, sandbox, repositories, wrong);
  return { app: { id, keyPath }, sandbox, ...(theirs ? { repositories: theirs } : {}) };
}

const ORGANISATION_REPOSITORIES_SHAPE = `"organisation.repositories", when given, must list the organisation's repositories live mode watches besides its sandbox, each "owner/name"`;

/**
 * The `organisation.repositories` line (ADR 0060), `undefined` when absent; refused when not a list of repositories,
 * when one isn't owned by the sandbox's organisation (its login ignores case), is the sandbox, is in `repositories`
 * (the two Apps never watch one repository), or shares a name with another the organisation's App is given.
 */
function organisationRepositoriesIn(
  value: unknown,
  sandbox: RepositoryRef,
  repositories: RepositoryRef[],
  wrong: (what: string) => Error,
): RepositoryRef[] | undefined {
  if (value === undefined) return undefined;
  const listed = Array.isArray(value) ? value.map(repository) : [];
  const theirs = listed.filter((r) => r !== undefined);
  if (theirs.length === 0 || theirs.length !== listed.length) throw wrong(ORGANISATION_REPOSITORIES_SHAPE);
  for (const repo of theirs) {
    const name = repositoryName(repo);
    if (repo.owner.toLowerCase() !== sandbox.owner.toLowerCase())
      throw wrong(
        `"organisation.repositories" names ${name}, which ${sandbox.owner} doesn't own: the organisation's App watches the repositories of the organisation that owns "organisation.sandbox", so take it out`,
      );
    if (sameRepository(repo, sandbox))
      throw wrong(
        `"organisation.repositories" names ${name}, which is "organisation.sandbox": it is watched already, so take it out of "organisation.repositories"`,
      );
    if (repositories.some((r) => sameRepository(r, repo)))
      throw wrong(
        `"organisation.repositories" names ${name}, which "repositories" lists too: the two Apps never watch one repository, so take it out of one of them`,
      );
  }
  // The list the organisation's App is given: its sandbox, then these.
  noTwins([sandbox, ...theirs], "organisation.repositories", wrong);
  return theirs;
}

/** The config a live service runs on, and the one line its start says it with when that isn't the file as read. */
export interface ServedLiveConfig {
  live: LiveConfig;
  said?: string;
}

/**
 * The config a live service runs on (ADR 0060): `serve --live`, and the program a live config guards. With
 * `organisation.repositories`, the organisation's App on its sandbox then those repositories, no `fork` (the owner's
 * fork is the personal sandbox's) and no `organisation`; its key file must be there. `said` names the App by its id
 * (the config has no slug; it would cost a GitHub call) and the repositories it watches. Without, the config as read.
 * `path` is the file's, for the refusal.
 */
export function servedLiveConfig(config: LiveConfig, path: string): ServedLiveConfig {
  const organisation = config.organisation;
  if (organisation?.repositories === undefined) return { live: config };
  const { keyPath } = organisation.app;
  if (!existsSync(keyPath))
    throw new Error(
      `${path}: "organisation.app.keyPath" names no file: ${keyPath}. Write it with bun run export-app-key, or take "repositories" out of "organisation": with them, a live service runs as the organisation's App.\n${LIVE_CONFIG_HELP}`,
    );
  const repositories = [organisation.sandbox, ...organisation.repositories];
  const names = repositories.map(repositoryName);
  const listed = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return {
    live: { app: organisation.app, repositories, ...(config.ignored ? { ignored: config.ignored } : {}) },
    said: `Runs as ${organisation.sandbox.owner}'s App ${organisation.app.id} on ${listed}.`,
  };
}

/** What the file at `path` holds, parsed; `wrong` says so when it is not JSON. */
function jsonIn(path: string, wrong: (what: string) => Error): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw wrong("it is not JSON");
    throw error;
  }
}

/**
 * The live config at `path`. Throws, with the help text, when the file is missing or not of this shape; a `watch`
 * line is named in `ignored`, never refused.
 */
export function readLiveConfig(path: string): LiveConfig {
  if (!existsSync(path)) throw new Error(`No live config at ${path}.\n${LIVE_CONFIG_HELP}`);
  const wrong = (what: string) => new Error(`${path}: ${what}.\n${LIVE_CONFIG_HELP}`);
  const parsed = jsonIn(path, wrong);
  if (!isRecord(parsed)) throw wrong(`it must be an object`);
  const ignored: Pick<LiveConfig, "ignored"> = "watch" in parsed ? { ignored: ["watch"] } : {};
  const listed = Array.isArray(parsed.repositories) ? parsed.repositories.map(repository) : [];
  const repositories = listed.filter((r) => r !== undefined);
  if (repositories.length === 0 || repositories.length !== listed.length)
    throw wrong(`"repositories" must list the repositories live mode may use, each "owner/name"`);
  noTwins(repositories, "repositories", wrong);
  const fork = forkIn(parsed.fork, repositories, wrong);
  const app = appIn(parsed.app, wrong);
  const organisation = organisationIn(parsed.organisation, repositories, app, wrong);
  return {
    ...(app ? { app } : {}),
    repositories,
    ...(fork ? { fork } : {}),
    ...(organisation ? { organisation } : {}),
    ...ignored,
  };
}

/** The `app` line, `undefined` when absent; refused when not of its shape or when its key file is missing. */
function appIn(value: unknown, wrong: (what: string) => Error): LiveApp | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw wrong(`"app", when given, must be an object`);
  const { id, keyPath } = value;
  if (typeof id !== "number" || !Number.isInteger(id)) throw wrong(`"app.id" must be the App's numeric id`);
  if (typeof keyPath !== "string" || keyPath === "") throw wrong(`"app.keyPath" must be the key file's path`);
  if (!existsSync(keyPath)) throw wrong(`"app.keyPath" names no file: ${keyPath}`);
  return { id, keyPath };
}
