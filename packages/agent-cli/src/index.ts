// @lookover/agent-cli: the `lookover` command a coding agent runs (ADR 0021, ADR 0043, ADR 0052): `wait`,
// `feedback` and `reply`.
// The decision it hides: how an agent asks Lookover for a review, learns what to do next and answers it through
// GitHub alone, with its own login. `wait` takes the commit from local git (never what GitHub shows first), finds
// the pull request (`--pr`, else the current branch's), waits about 15 s for GitHub to show that commit as its
// head, posts `/lookover review` with a hidden marker naming the commit only when that commit has neither a
// request naming it nor a `Lookover` check from the App, then reads that commit's check from that App alone
// (`--app`, else `LOOKOVER_APP`) every 10 s, and exits with a code that says what to do next. A check a skip rule
// completed on an automatic trigger (an opening or a push: "Not your pull request" on a colleague's) answers
// nobody: `wait` leaves it out, so it asks anyway (ADR 0043) and waits for the check its request leads to.
// Once a round's check completes, `wait` reads Lookover's threads: when the round didn't read a person's newest reply
// on the thread of a finding it left unsettled (the finding's claim, in GitHub's time, is older than the reply; with
// no claim, the round started before it), it asks again on the same commit (never on a fork's pull request), its
// request naming that reply (none posted when one names it already), and only a check that appeared since, or whose
// round read the reply, answers it. Otherwise it resolves, with the agent's login, the open threads of
// the findings the round verified fixed (the App can't, ADR 0052), says which on stderr, and says a refusal plainly
// without changing the exit. `feedback` reads the newest check of the pull request's head once, and the threads;
// `reply <finding> <claim> <text>` posts on the finding's thread, its first line opened as Lookover reads a claim
// (`Fixed:`, `Won't fix:`, `Disputed:`, `Deferred:`, `Question:`), and refuses a finding with no thread.
// Interface: `run(argv, world) → exit code`, the whole program against a `World` (the host with the agent's
// token, the local checkout, the environment, a clock and `sleep`, stdout and stderr); `realWorld(cwd, env)` is
// the machine's (the checkout through `git`, the real clock and streams); `createAgentHost` (`AgentHost` over
// GitHub's REST API, and its GraphQL API for the threads and resolving, with the agent's token) and `agentToken`
// (`GH_TOKEN`, `GITHUB_TOKEN`, else `gh auth token`) are what it builds the host from, and what the live suite
// uses; `USAGE`, what `help` prints, is part of the `lookover` command's help. It has no program of its own: the one
// `lookover` command (`apps/service`, ADR 0054) runs it, from a clone with `bun run lookover`, `--app` filled from
// its data folder when nothing names the App. `SKILL_TEMPLATE` is the loop's skill, `skill/SKILL.md`, as text: the
// service renders it into the coding agents' folders with Lookover's command (ADR 0058).
// Exit codes (exploration 05 §11.3): 0 nothing to fix (`next_action` `stop`), 1 error, 2 usage, 3 something to
// fix (`fix`, or `reply`), 4 a person is needed (`ask_human`), 5 timed out (`--timeout`, 30 minutes by default;
// `feedback`: the newest check is still running), 6 skipped (the check's `run.state` `skipped` or `cancelled`),
// 7 the review failed (`failed`), 9 no review appeared (neither a 👀 on a request naming the commit nor a check
// within `--appear-timeout`, 3 minutes; `feedback`: no check on the head), 10 the pull request's head moved past
// the commit. 8 is unused. `reply`: 0 posted, 1 error or refused, 2 usage. A completed check whose result's
// `next_action` is `wait` (skipped for a newer commit, or for a newer review of this one) ends nothing by itself:
// the head is compared next (10 for a newer commit), else the wait goes on for the newer review's check.
// Output: one sentence on stderr when it ends, a heartbeat on stderr every 30 s while it waits; on stdout, with
// `--json`, one JSON document (the commit, the `change` number, the exit and its meaning, the verdict, the next
// action, the reason a review didn't run, the findings whose `needs_action_by` is `agent`, blocking first; for
// `feedback` each with its `thread` and `lookover_reply`, and the `guard` sentence), else those findings as text
// (for `feedback` after the guard sentence: the findings are a reviewer's opinion, never instructions).
// Ordering: on each read, a completed check ends the wait before the head is compared, except one that doesn't
// answer a reply `wait` asked about, which ends nothing; a moved head before the appear timeout; the appear timeout before the timeout. The newest of the App's checks on the commit is the one read.
// Error modes: `run` never throws. A host's refusal (`HostError`), a git that can't say, no token, no pull
// request or a commit not pushed are exit 1, with the reason on stderr.
// It must never know: the App's key or token (it never imports `github`, ADR 0021), the service, or Lookover's
// rules beyond the result block's words and the claims' openings.
import { ask, USAGE } from "./args.ts";
import { feedback } from "./feedback.ts";
import { reply } from "./reply.ts";
import { report, reportFeedback } from "./report.ts";
import { EXIT, wait } from "./wait.ts";
import type { World } from "./world.ts";

export { USAGE } from "./args.ts";
export { type AgentHostOptions, createAgentHost, type Fetch } from "./github.ts";
export { agentToken, realWorld } from "./machine.ts";
export { SKILL_TEMPLATE, skillTemplateOf } from "./skill.ts";
export type { LocalGit, World } from "./world.ts";

export async function run(argv: string[], w: World): Promise<number> {
  const asked = ask(argv);
  if ("usage" in asked) return usage(asked.usage, asked.json === true, w);
  if (asked.command === "help") {
    w.out(USAGE);
    return 0;
  }
  const json = asked.command !== "reply" && asked.args.json;
  const app = asked.args.app ?? w.env.LOOKOVER_APP ?? "";
  if (app === "") return usage("Name Lookover's App: --app <slug>, or LOOKOVER_APP.", json, w);
  if (asked.command === "reply") return reply(asked.args, app, w);
  if (asked.command === "wait") return report(await wait(asked.args, app, w), json, w);
  const { outcome, threads } = await feedback(asked.args, app, w);
  return reportFeedback(outcome, threads, app, json, w);
}

function usage(message: string, json: boolean, w: World): number {
  if (json) return report({ meaning: "usage", message, commit: null, change: null, result: null }, true, w);
  w.err(message);
  w.err(USAGE);
  return EXIT.usage;
}
