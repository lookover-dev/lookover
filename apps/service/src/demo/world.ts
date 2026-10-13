// The fake world a scenario plays in (ADR 0046): the fake host, the scripted engines and the scripted retrieval,
// built from the scenario's data, and each move of its script played on them. A move the host would show (a
// change opened, pushed, asked about, closed) is followed by a listing now, so the service sees it at once; one
// on an engine by a health check, so the state shows at once. An engine installed again is the exception: that
// waits for the owner's "Check again", as it would on their machine; so does a reply on a finding's thread, which
// the next round reads (ADR 0052). The lines the fake host accepts a comment
// on are read from each commit's diff (`@lookover/diff`), never written twice. Who wrote a change is read as the
// service reads it (`core.writerOf` over the commits' messages), so the drawer's "your agent opens a pull
// request" and the round plan agree.
import {
  type CommitSha,
  type DiffHunk,
  type EngineId,
  HostError,
  newestThread,
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
import type { Move, Scenario, ScenarioChange } from "./scenario.ts";

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
  unopened(by: "agent" | "other"): number | null;
  /** The owner's open changes with a commit left to push, oldest opened first. */
  pushable(): number[];
  /** The open changes, oldest opened first. */
  open(): number[];
}

/** Every move's row: what it does to the world, and what the room is told. */
type Moves = { [K in Move["kind"]]: (move: Extract<Move, { kind: K }>, room: Room) => Promise<void> };

/** A change opened so far: the scenario's, the index of its next commit to push, whether it was closed since. */
interface Held {
  change: ScenarioChange;
  next: number;
  closed: boolean;
}

export function createWorld(scenario: Scenario, clock: DemoClock, worktrees: string): DemoWorld {
  const { world } = scenario;
  // The App is on GitHub (ADR 0047, ADR 0053), installed once the setup says so; one the setup says isn't made yet
  // was made on another computer, installed there on every repository (the driver keeps it only once the setup says
  // it was made). The fake's pages make a new one as GitHub's do (the manifest flow), which replaces it.
  const installed = world.setup === undefined || !appMade(world.setup) || appInstalled(world.setup);
  // The App is the owner's (ADR 0053), or the organisation's they work in (ADR 0059): the bot the snapshot shows is
  // its. Beside it, an App an organisation's admin made and handed over (ADR 0059), for "Use an existing App": its id
  // and key file are what the owner was given.
  const host = new FakeGitHost({
    repo: world.repo,
    repositories: world.repositories ?? [],
    bot: world.bot,
    changes: [],
    clock,
    installed,
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
  const engines = new ScriptedEngines({ timers: clock });
  const retrieval = new ScriptedRetrieval({ root: worktrees });
  for (const engine of ["claude", "codex"] as const) engines.setHealth(engine, world.engines[engine]);
  retrieval.scriptRules(
    world.repo,
    (world.rules ?? []).map((file) => ({ ...file, commit: world.main.sha })),
  );
  for (const change of scenario.changes) {
    for (const commit of change.commits) {
      retrieval.script(change.number, commit.sha, commit.diff);
      const worktree = retrieval.worktreeOf(change.number, commit.sha);
      if (commit.find) engines.scriptFind(worktree, commit.find);
      if (commit.confirm) engines.scriptConfirm(worktree, commit.confirm);
    }
  }
  const opened = new Map<number, Held>();
  const ref = (number: number) => ({ repo: world.repo, number });
  const changeOf = (number: number): ScenarioChange => {
    const change = scenario.changes.find((c) => c.number === number);
    if (!change) throw new Error(`${scenario.id} has no pull request #${number}`);
    return change;
  };
  const heldOf = (number: number): Held => {
    const held = opened.get(number);
    if (!held) throw new Error(`#${number} is not open`);
    return held;
  };
  const headOf = (number: number): CommitSha => {
    const held = heldOf(number);
    const head = held.change.commits[held.next - 1];
    if (!head) throw new Error(`#${number} has no commit ${held.next}`);
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
      const [first] = change.commits;
      const shown: FakeChange = {
        number: change.number,
        title: change.title,
        url: `https://github.com/${world.repo.owner}/${world.repo.name}/pull/${change.number}`,
        author: change.author,
        draft: change.draft ?? false,
        fork: change.fork ?? false,
        head: { ref: change.branch, sha: first.sha },
        base: { ...world.main },
        diff: commentableOf(first.diff),
        messages: [first.message],
      };
      host.open(shown);
      opened.set(change.number, { change, next: 1, closed: false });
      await listed(room);
    },
    push: async (move, room) => {
      const held = heldOf(move.change);
      const commit = held.change.commits[held.next];
      if (!commit) throw new Error(`#${move.change} has no commit left to push`);
      const messages = [...(commit.pushedWith ?? []), commit.message];
      host.push(ref(move.change), commit.sha, commentableOf(commit.diff), [], {
        commits: messages.length,
        messages,
      });
      held.next += 1;
      await listed(room);
    },
    ask: async (move, room) => {
      await host.asAgent(world.owner).comment(ref(move.change), reviewRequest(headOf(move.change)));
      await listed(room);
    },
    reply: async (move) => {
      const change = ref(move.change);
      // The newest thread on the finding: a later round's review may have commented on it again.
      const thread = newestThread(await host.threads(change), move.finding);
      if (!thread) throw new Error(`#${move.change} has no thread on ${move.finding}`);
      host.seedReply(change, thread.commentId, { author: move.by, body: move.text });
    },
    close: async (move, room) => {
      heldOf(move.change).closed = true;
      host.close(ref(move.change));
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
      return scenario.changes.find((c) => !opened.has(c.number) && wanted(c))?.number ?? null;
    },
    pushable: () =>
      [...opened.values()]
        .filter((h) => !h.closed && h.change.author.id === world.owner.id && h.next < h.change.commits.length)
        .map((h) => h.change.number),
    open: () => [...opened.values()].filter((h) => !h.closed).map((h) => h.change.number),
  };
}
