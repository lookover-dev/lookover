// The real `prepare` the runner takes (ADR 0050): a case built into its repository under the build root, then
// prepared through `retrieval`, whose own root the caller puts in the build root too. The replay gives the runner
// a `prepare` of its own, from the stored inputs.
import { join } from "node:path";
import type { Retrieval } from "@lookover/retrieval";
import { buildCase } from "./build.ts";
import { prepareCase } from "./prepare.ts";
import type { PrepareCase } from "./types.ts";

export interface CasePreparer {
  /** The corpus' `REVIEW.md`. */
  review: string;
  /** The build root: each case's repository goes in its `repos` folder. */
  buildRoot: string;
  /** The git program, by absolute path. */
  git: string;
  /** Retrieval, rooted in the build root. */
  retrieval: Retrieval;
}

/** Builds each case it is given under `<buildRoot>/repos`, then prepares it through `retrieval`. */
export function casePreparer(o: CasePreparer): PrepareCase {
  return (evalCase, signal) => {
    const built = buildCase({ evalCase, review: o.review, root: join(o.buildRoot, "repos"), git: o.git });
    return prepareCase(o.retrieval, built, signal);
  };
}
