// The live config file (ADR 0039, ADR 0041, ADR 0053, ADR 0054, ADR 0060): `live.json` in the data folder guards
// live mode, and the program when it has one (development and agents only: the owner runs the program without one).
// Its parts: `repositories`, the repositories a live service may use, on the shared App (ADR 0073); `app`, the test
// App, whose bot is someone other than the person in `bun run live`'s suites (nothing runs as it there); `fork`, the
// owner's fork of the sandbox (`bun run live`'s pull request from a fork). A live service (`serve --live`, a guarded
// program) reads only `repositories`; `bun run live` reads the file as written. The lines the file may still have
// that nothing reads, `watch` and `organisation`, are ignored, never refused. Read here and in no package:
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

export interface LiveConfig {
  /** The test App: in `bun run live`'s suites, its bot comments as someone other than the person; nothing runs as it. */
  app?: LiveApp;
  /** The repositories live mode may use; any other is refused before a request. */
  repositories: RepositoryRef[];
  /**
   * The owner's fork of the sandbox, where `bun run live` opens a pull request from a fork (ADR 0056); never listed
   * in `repositories` (the App is never installed on it). Absent, `bun run live` skips that step.
   */
  fork?: RepositoryRef;
  /**
   * The lines the file still has that nothing reads any more: `watch` (every repository listed is watched, ADR 0053)
   * and `organisation` (no run is on an organisation's App, ADR 0073). The owner's own file keeps them, and each
   * autopilot cycle copies that file, so they are ignored, not refused; their values are never read. Absent when
   * there are none.
   */
  ignored?: ("watch" | "organisation")[];
}

/** The one line a start prints for an ignored `watch` (the service's and `bun run live`'s). */
export const WATCH_IGNORED = "`watch` is ignored: every repository in `repositories` is watched.";

/** The one line `bun run live` prints for an ignored `organisation`. */
export const ORGANISATION_IGNORED =
  "`organisation` is ignored: bun run live runs on the shared App only, on both sandboxes.";

/** The lines ignored, in the order `ignored` names them. */
const IGNORED = ["watch", "organisation"] as const;

export const liveConfigPath = (home: string) => join(home, "live.json");

/** What to write when the file is missing or wrong, with the key named by its folder, never its content. */
export const LIVE_CONFIG_HELP = `Write it as:
  {
    "repositories": ["lookover-dev/lookover-private", "lookover-dev/lookover-sandbox"],
    "app": { "id": <the test App's id>, "keyPath": "<absolute path of its private key, PEM>" },
    "fork": "lookover-forks/lookover-sandbox"
  }
A live service (serve --live, a guarded program) reads "repositories" alone, as the allow-list, and runs on the
shared App; bun dev --live names its own repositories. bun run live runs on the shared App on both sandboxes, and
needs "app": the test App, lookover-spike-sasensi, whose bot comments as someone other than the person in its suites
(its id and key are in spikes/03-github/.secret/ of the main checkout). "fork", optional, is the owner's fork of
sasensi/lookover-sandbox, never listed in "repositories": bun run live opens a pull request from it, and skips that
step without it.`;

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
 * Refuses one repository listed twice in `repositories` (GitHub's names ignore case), saying which `line` lists it.
 * Two of one name on two accounts are two (a change is known by its owner and name, ADR 0066).
 */
function noRepeats(repositories: RepositoryRef[], line: string, wrong: (what: string) => Error): void {
  repositories.forEach((repo, i) => {
    const first = repositories.slice(0, i).find((r) => sameRepository(r, repo));
    if (first)
      throw wrong(
        `"${line}" lists ${repositoryName(first)} twice, the second time as ${repositoryName(repo)}: keep one of them`,
      );
  });
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
 * The live config at `path`. Throws, with the help text, when the file is missing or not of this shape; a `watch` or
 * `organisation` line is named in `ignored`, never refused, never read.
 */
export function readLiveConfig(path: string): LiveConfig {
  if (!existsSync(path)) throw new Error(`No live config at ${path}.\n${LIVE_CONFIG_HELP}`);
  const wrong = (what: string) => new Error(`${path}: ${what}.\n${LIVE_CONFIG_HELP}`);
  const parsed = jsonIn(path, wrong);
  if (!isRecord(parsed)) throw wrong(`it must be an object`);
  const lines = IGNORED.filter((line) => line in parsed);
  const ignored: Pick<LiveConfig, "ignored"> = lines.length > 0 ? { ignored: lines } : {};
  const listed = Array.isArray(parsed.repositories) ? parsed.repositories.map(repository) : [];
  const repositories = listed.filter((r) => r !== undefined);
  if (repositories.length === 0 || repositories.length !== listed.length)
    throw wrong(`"repositories" must list the repositories live mode may use, each "owner/name"`);
  noRepeats(repositories, "repositories", wrong);
  const fork = forkIn(parsed.fork, repositories, wrong);
  const app = appIn(parsed.app, wrong);
  return { ...(app ? { app } : {}), repositories, ...(fork ? { fork } : {}), ...ignored };
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
