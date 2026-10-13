// Which pull request a command is about: `--pr`, else the current branch's open one, in the `origin` repository.
import type { AgentHost, ChangeRef } from "@lookover/contracts";
import type { World } from "./world.ts";

/** The current branch's open pull request's number, or why there is none. */
export async function branchChange(
  host: AgentHost,
  w: World,
  repo: ChangeRef["repo"],
): Promise<number | string> {
  const branch = await w.git.branch();
  if (branch === null) return "Not on a branch: give the pull request with --pr.";
  const found = await host.changeOf(repo, branch);
  if (found === null)
    return `No open pull request for ${branch}: push the branch and open one, or give --pr.`;
  return found.number;
}

/** The pull request `--pr` names, else the current branch's, or why there is none. */
export async function changeOf(host: AgentHost, w: World, pr: number | null): Promise<ChangeRef | string> {
  const repo = await w.git.origin();
  const number = pr ?? (await branchChange(host, w, repo));
  return typeof number === "string" ? number : { repo, number };
}
