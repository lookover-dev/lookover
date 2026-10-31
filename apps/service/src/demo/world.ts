// The fake world a scenario plays in (ADR 0046): the fake host, the scripted engines and the scripted retrieval,
// built from the scenario's data, and each move of its script played on them. A move the host would show (a
// change opened, pushed, asked about, closed) is followed by a listing now, so the service sees it at once; one
// on an engine by a health check, so the state shows at once. An engine installed again is the exception: that
// waits for the owner's "Check again", as it would on their machine; so does a reply on a finding's thread, which
// the next round reads (ADR 0052). The lines the fake host accepts a comment
// on are read from each commit's diff (`@lookover/diff`), never written twice. Who wrote a change is read as the
// service reads it (`core.writerOf` over the commits' messages), so the drawer's "your agent opens a pull
// request" and the round plan agree. Signed in to the shared App (`World.shared`, ADR 0066), the host's App stands for
// its installation on the owner's account, and each organisation the world reaches has its own, its repositories
// beside the owner's: a change is named by its repository and number, so two repositories of one name each have theirs.
import {
  type ChangeRef,
  type CommitSha,
  changeName,
  DEMO_API,
  type DiffHunk,
  type EngineId,
  HostError,
  newestThread,
  type RepositoryRef,
  reviewRequest,
} from "@lookover/contracts";
import { writerOf } from "@lookover/core";
import { indexDiff } from "@lookover/diff";
import { CODEX_MODEL, MINIMUM } from "@lookover/engines";
import {
  type CommentableRange,
  type DemoClock,
  type FakeChange,
  FakeGitHost,
  ScriptedEngines,
  ScriptedRetrieval,
} from "@lookover/testkit/demo";
import type { Room } from "../room.ts";
import { appInstalled, appMade } from "../snapshot.ts";
import type { Account, Move, Scenario, ScenarioChange, World } from "./scenario.ts";

/** The removed lines of a hunk on `base`, as runs of consecutive lines of `path`. */
function removedRuns(path: string, hunk: DiffHunk): CommentableRange[] {
  const runs: CommentableRange[] = [];
  for (const line of hunk.lines) {
    if (line.kind !== "removed" || line.oldLine === null) continue;
    const last = runs.at(-1);
    if (last && last.to === line.oldLine - 1) last.to += 1;
    else runs.push({ path, side: "base", from: line.oldLine, to: line.oldLine });
  }
  return runs;
}

/** The lines a host accepts a comment on, from the diff: each hunk's new lines on `head`, its removed lines on `base`. */
function commentableOf(diff: string): CommentableRange[] {
  return indexDiff(diff).files.flatMap((file) =>
    file.hunks.flatMap((hunk) => {
      const head: CommentableRange[] =
        hunk.newLines > 0
          ? [{ path: file.path, side: "head", from: hunk.newStart, to: hunk.newStart + hunk.newLines - 1 }]
          : [];
      return [...head, ...removedRuns(file.oldPath ?? file.path, hunk)];
    }),
  );
}

/**
 * The App ledger-co's admin made and handed to the owner (ADR 0059), in every world: an organisation's, which "Use an
 * existing App" takes only for an active member of ledger-co, as the person's own `gh` says: its id and the key file
 * handed over with it, which the demo's tests and proof shots give. Every scenario refuses it (the owner is no member
 * of ledger-co); the organisation's App taken is S15's `MADE_APP`, on ledger-dev.
 */
export const HANDED_APP = {
  id: 7,
  slug: "lookover-ledger-co",
  owner: { id: 4242, login: "ledger-co", type: "Organization" },
  key: "-----BEGIN RSA PRIVATE KEY-----\nledger-co's App, handed over\n-----END RSA PRIVATE KEY-----\n",
} as const;

/**
 * The App every world's GitHub holds before Lookover keeps one (made on another computer, or by an admin of S15's
 * organisation): its id and the key file downloaded when it was made, which "Use an existing App" is given in S15's
 * test and proof shot.
 */
export const MADE_APP = {
  id: 1,
  key: "-----BEGIN RSA PRIVATE KEY-----\nthe App made before, its key downloaded then\n-----END RSA PRIVATE KEY-----\n",
} as const;

/** Who wrote the change, as the service reads it: an engine, or nobody known. */
const writtenBy = (change: ScenarioChange): EngineId | null =>
  writerOf({ branch: change.branch, messages: change.commits.map((c) => c.message), before: null });

export interface DemoWorld {
  host: FakeGitHost;
  engines: ScriptedEngines;
  retrieval: ScriptedRetrieval;
  /** Plays one move; the room is told what it would hear of from the host or the engines. */
  play(move: Move, room: Room): Promise<void>;
  /** The next change the script hasn't opened, written by the owner's agent or by someone else; null when none is left. */
  unopened(by: "agent" | "other"): ChangeRef | null;
  /** The owner's open changes with a commit left to push, oldest opened first. */
  pushable(): ChangeRef[];
  /** The open changes, oldest opened first. */
  open(): ChangeRef[];
}

/** A change's repository: its own, or the world's first. */
const repoOf = (scenario: Scenario, change: ScenarioChange): RepositoryRef =>
  change.repo ?? scenario.world.repo;

/** A change as a move names it: its repository and number. */
const refOf = (scenario: Scenario, change: ScenarioChange): ChangeRef => ({
  repo: repoOf(scenario, change),
  number: change.number,
});

/** A change as written, `<owner>/<name>#<number>`: what the world keys and names it by. */

/** Every move's row: what it does to the world, and what the room is told. */
type Moves = { [K in Move["kind"]]: (move: Extract<Move, { kind: K }>, room: Room) => Promise<void> };

/** A change opened so far: the scenario's, the index of its next commit to push, whether it was closed since. */
interface Held {
  change: ScenarioChange;
  next: number;
  closed: boolean;
}

/** An organisation of the shared App's, as the fake host keeps it: the account, and its repositories. */
const reachOf = ({
  organisation,
  repositories,
  owners = [],
}: {
  organisation: Account;
  repositories: RepositoryRef[];
  owners?: Account[];
}) => ({
  account: { ...organisation, type: "Organization" as const },
  repositories,
  owners: owners.map((o) => o.login),
});

/** GitHub as the world says it at the start: the App, its installations, the shared App's organisations. */
function hostOf(world: World, clock: DemoClock): FakeGitHost {
  // The App is on GitHub (ADR 0047, ADR 0053), installed once the setup says so; one the setup says isn't made yet
  // was made on another computer, installed there on every repository (the driver keeps it only once the setup says
  // it was made). The fake's pages make a new one as GitHub's do (the manifest flow), which replaces it.
  const installed =
    world.shared?.ownAccountInstalled !== false &&
    (world.setup === undefined || !appMade(world.setup) || appInstalled(world.setup));
  // The App is the owner's (ADR 0053), or the organisation's they work in (ADR 0059): the bot the snapshot shows is
  // its. Beside it, an App an organisation's admin made and handed over (ADR 0059), for "Use an existing App": its id
  // and key file are what the owner was given.
  // The owner may sign in to the shared App instead (ADR 0066), on GitHub's fake device page: the App on GitHub
  // stands for it, so its installation is what the sign-in reaches, with the shared App's on the organisations the
  // world reaches, and the organisations it doesn't (ADR 0067). The bot posts until the service signs in.
  const host = new FakeGitHost({
    repo: world.repo,
    repositories: world.repositories ?? [],
    bot: world.bot,
    person: world.owner,
    devicePage: `${DEMO_API.github}/login/device`,
    changes: [],
    clock,
    installed,
    reaches: (world.shared?.reaches ?? []).map(reachOf),
    unreached: (world.shared?.unreached ?? []).map(reachOf),
    app: {
      owner:
        world.organisation === undefined
          ? { ...world.owner, type: "User" }
          : { ...world.organisation.account, type: "Organization" },
      id: MADE_APP.id,
      key: MADE_APP.key,
    },
    handed: [HANDED_APP],
  });
  host.postAs("bot");
  for (const { organisation, sso } of world.shared?.reaches ?? [])
    if (sso === true) host.askSso(organisation.login);
  return host;
}

export function createWorld(scenario: Scenario, clock: DemoClock, worktrees: string): DemoWorld {
  const { world } = scenario;
  const host = hostOf(world, clock);
  const engines = new ScriptedEngines({ timers: clock });
  const retrieval = new ScriptedRetrieval({ root: worktrees });
  for (const engine of ["claude", "codex"] as const) engines.setHealth(engine, world.engines[engine]);
  retrieval.scriptRules(
    world.repo,
    (world.rules ?? []).map((file) => ({ ...file, commit: world.main.sha })),
  );
  for (const change of scenario.changes) {
    const ref = refOf(scenario, change);
    for (const commit of change.commits) {
      retrieval.script(ref, commit.sha, commit.diff);
      const worktree = retrieval.worktreeOf(ref, commit.sha);
      if (commit.find) engines.scriptFind(worktree, commit.find);
      if (commit.confirm) engines.scriptConfirm(worktree, commit.confirm);
    }
  }
  /** The changes opened so far, by `changeName`. */
  const opened = new Map<string, Held>();
  const changeOf = (ref: ChangeRef): ScenarioChange => {
    const change = scenario.changes.find((c) => changeName(refOf(scenario, c)) === changeName(ref));
    if (!change) throw new Error(`${scenario.id} has no pull request ${changeName(ref)}`);
    return change;
  };
  const heldOf = (ref: ChangeRef): Held => {
    const held = opened.get(changeName(ref));
    if (!held) throw new Error(`${changeName(ref)} is not open`);
    return held;
  };
  const headOf = (ref: ChangeRef): CommitSha => {
    const held = heldOf(ref);
    const head = held.change.commits[held.next - 1];
    if (!head) throw new Error(`${changeName(ref)} has no commit ${held.next}`);
    return head.sha;
  };
  /** A listing now; a host that refuses is the poller's to show, not the move's to fail on. */
  const listed = async (room: Room) => {
    try {
      await room.refresh();
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
    }
  };

  const moves: Moves = {
    open: async (move, room) => {
      const change = changeOf(move.change);
      const repo = repoOf(scenario, change);
      const [first] = change.commits;
      const shown: FakeChange = {
        repo,
        number: change.number,
        title: change.title,
        url: `https://github.com/${repo.owner}/${repo.name}/pull/${change.number}`,
        author: change.author,
        draft: change.draft ?? false,
        fork: change.fork ?? false,
        head: { ref: change.branch, sha: first.sha },
        base: { ...world.main },
        diff: commentableOf(first.diff),
        messages: [first.message],
      };
      host.open(shown);
      opened.set(changeName(move.change), { change, next: 1, closed: false });
      await listed(room);
    },
    push: async (move, room) => {
      const held = heldOf(move.change);
      const commit = held.change.commits[held.next];
      if (!commit) throw new Error(`${changeName(move.change)} has no commit left to push`);
      const messages = [...(commit.pushedWith ?? []), commit.message];
      host.push(move.change, commit.sha, commentableOf(commit.diff), [], {
        commits: messages.length,
        messages,
      });
      held.next += 1;
      await listed(room);
    },
    ask: async (move, room) => {
      await host.asAgent(world.owner).comment(move.change, reviewRequest(headOf(move.change)));
      await listed(room);
    },
    reply: async (move) => {
      // The newest thread on the finding: a later round's review may have commented on it again.
      const thread = newestThread(await host.threads(move.change), move.finding);
      if (!thread) throw new Error(`${changeName(move.change)} has no thread on ${move.finding}`);
      host.seedReply(move.change, thread.commentId, { author: move.by, body: move.text });
    },
    close: async (move, room) => {
      heldOf(move.change).closed = true;
      host.close(move.change);
      await listed(room);
    },
    "sign-out": (move, room) => {
      engines.setHealth(move.engine, { ...engines.healthOf(move.engine), signedIn: false });
      return room.checkEngines();
    },
    missing: (move, room) => {
      engines.setHealth(move.engine, { installed: false, version: null, signedIn: false });
      return room.checkEngines();
    },
    // Codex's model and the oldest version that serves it on a plan, as the real engine's health would say them.
    "too-old": (move, room) => {
      const why = {
        kind: "too-old",
        version: move.version,
        model: CODEX_MODEL,
        needs: MINIMUM[CODEX_MODEL],
      } as const;
      engines.setHealth(move.engine, { installed: false, version: move.version, signedIn: true, why });
      return room.checkEngines();
    },
    installed: (move) => {
      engines.setHealth(move.engine, { installed: true, version: move.version, signedIn: true });
      return Promise.resolve();
    },
    refuse: (move, room) => {
      host.refuse(move.failure, move.failure === "rate_limited" ? { retryAt: clock.now() + move.forMs } : {});
      clock.after(move.forMs, () => host.refuse(null));
      return listed(room);
    },
    update: (move, room) => {
      if (move.selfTest === "fails") engines.failSelfTest(move.engine, move.version);
      engines.setHealth(move.engine, { installed: true, version: move.version, signedIn: true });
      return room.checkEngines();
    },
    command: async (move, room) => {
      const { command } = move;
      if (command.type === "review.request") await room.review(command.changeId);
      else room.pause(command.for);
    },
  };
  /** One move through the row of its kind. */
  const play = <K extends Move["kind"]>(kind: K, move: Extract<Move, { kind: K }>, room: Room) =>
    moves[kind](move, room);

  return {
    host,
    engines,
    retrieval,
    play: (move, room) => play(move.kind, move, room),
    unopened: (by) => {
      const wanted = (change: ScenarioChange) =>
        by === "other"
          ? change.author.id !== world.owner.id
          : change.author.id === world.owner.id && writtenBy(change) !== null;
      const next = scenario.changes.find((c) => !opened.has(changeName(refOf(scenario, c))) && wanted(c));
      return next === undefined ? null : refOf(scenario, next);
    },
    pushable: () =>
      [...opened.values()]
        .filter((h) => !h.closed && h.change.author.id === world.owner.id && h.next < h.change.commits.length)
        .map((h) => refOf(scenario, h.change)),
    open: () => [...opened.values()].filter((h) => !h.closed).map((h) => refOf(scenario, h.change)),
  };
}
