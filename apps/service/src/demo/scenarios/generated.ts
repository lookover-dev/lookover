// The helpers of the scenarios whose pull requests are generated rather than written (S18, S20): a change of one
// commit adding one file, its sha the SHA-1 of what names it, a clean find pass on it, and `DAY` for how long ago one
// was opened. Shared as `ledger-api.ts` shares its world's helpers.
import { createHash } from "node:crypto";
import { type CommitSha, commitSha, type RepositoryRef } from "@lookover/contracts";
import type { ScriptedFindAnswer } from "@lookover/testkit/demo";
import type { Account, ScenarioChange } from "../scenario.ts";
import { BY_CLAUDE, MIN, unified } from "./ledger-api.ts";

export const DAY = 24 * 60 * MIN;

/** A commit's sha, generated: the SHA-1 of what names it, so no two changes share one. */
const shaOf = (name: string): CommitSha => commitSha(createHash("sha1").update(`S18 ${name}`).digest("hex"));

/** A clean find pass, as Claude answers on a short change. */
export const clean = (why: string): ScriptedFindAnswer => ({
  notes: "A short change.",
  findings: [],
  emptyReason: why,
  usage: { inputTokens: 1_800, outputTokens: 120 },
  tookMs: 30_000,
});

/**
 * A pull request of one generated commit: a new file at `path` holding one line. `find` scripted only where a review
 * runs (the owner's, or one a step invites asking about).
 */
export function change(
  repo: RepositoryRef,
  number: number,
  title: string,
  author: Account,
  path: string,
  options: { openedAgo?: number; find?: ScriptedFindAnswer; byClaude?: true } = {},
): ScenarioChange {
  const branch = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const message = options.byClaude ? `${title}\n\n${BY_CLAUDE}` : title;
  const diff = unified(
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,1 @@",
    `+// ${title}`,
  );
  const sha = shaOf(`${repo.owner}/${repo.name}#${number}`);
  return {
    repo,
    number,
    title,
    branch,
    author,
    ...(options.openedAgo === undefined ? {} : { openedAgo: options.openedAgo }),
    commits: [{ sha, message, diff, ...(options.find === undefined ? {} : { find: options.find }) }],
  };
}
