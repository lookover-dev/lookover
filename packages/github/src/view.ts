// What GitHub shows for a change now, as contracts' `HostView`: the `Lookover` check runs of a commit, the
// reviews with their inline comments, and the conversation's comments, each oldest first and every page GitHub's
// `Link` header gives (a busy pull request has more than 100 comments). The live run reads
// it back after each post; polling will read it later. GitHub names a range by its last line and `start_line`,
// Lookover by its first and `endLine`; a conclusion Lookover never posts (`cancelled`, `stale`…) reads as
// `other`, with GitHub's word. Whether a comment is hidden (ADR 0052) is GitHub's GraphQL's to say: one `nodes`
// query per hundred comments, a reason Lookover never gives read as `other`, with GitHub's word.
import type {
  ChangeRef,
  CheckConclusion,
  CommitSha,
  HostCheck,
  HostView,
  Minimized,
  MinimizeReason,
} from "@lookover/contracts";
import { CHECK_NAME, commitSha } from "@lookover/contracts";
import type { Allowed } from "./allowed.ts";
import type { GitHubApi } from "./api.ts";
import { graphql } from "./graphql.ts";
import {
  checkRuns,
  minimizedNodes,
  parse,
  pull,
  reviewComments,
  reviews,
  viewedComments,
} from "./schemas.ts";
import type { Session } from "./session.ts";

/** The words Lookover concludes a check with: a new `CheckConclusion` fails here until it is listed. */
const POSTED = { success: true, neutral: true, skipped: true } satisfies Record<CheckConclusion, true>;

/** GitHub's status of a check run as Lookover reads it: one it never sets (`waiting`, `pending`…) reads as running. */
function statusOf(word: string): HostCheck["status"] {
  if (word === "completed" || word === "queued") return word;
  return "in_progress";
}

const isPosted = (word: string): word is CheckConclusion => Object.hasOwn(POSTED, word);

/** GitHub's word for how a check concluded, as Lookover reads it: one of its own as itself, any other `other`. */
function conclusionOf(word: string | null): HostCheck["conclusion"] {
  if (word === null) return null;
  return isPosted(word) ? word : { other: word };
}

const byId = <T extends { id: number }>(items: T[]) => [...items].sort((a, b) => a.id - b.id);

/** The reasons Lookover hides a comment for: a new `MinimizeReason` fails here until it is listed. */
const HIDES = { resolved: true, outdated: true } satisfies Record<MinimizeReason, true>;

const isOwnReason = (word: string): word is MinimizeReason => Object.hasOwn(HIDES, word);

/** Why GitHub says a comment is hidden, as Lookover reads it: one of its own reasons, any other `other`. */
function minimizedOf(node: {
  isMinimized?: boolean | undefined;
  minimizedReason?: string | null | undefined;
}): Minimized {
  if (node.isMinimized !== true) return null;
  const word = (node.minimizedReason ?? "").toLowerCase();
  return isOwnReason(word) ? word : { other: word };
}

/** How many ids GitHub takes in one `nodes` query. */
const NODES_MAX = 100;

const NODES = `query($ids: [ID!]!) {
  nodes(ids: $ids) { id ... on Minimizable { isMinimized minimizedReason } }
}`;

export function createView(api: GitHubApi, session: Session, allowed: Allowed) {
  /** The checks of `commit`, or of the head commit when none is named (a round reviews an earlier head). */
  return async (change: ChangeRef, commit?: CommitSha): Promise<HostView> => {
    allowed(change.repo);
    const repo = `/repos/${change.repo.owner}/${change.repo.name}`;
    const number = change.number;
    return session.withToken(change.repo, async (token) => {
      const get = async <T>(path: string, schema: Parameters<typeof parse<T>>[0]) =>
        parse(
          schema,
          (await api.request({ path: `${repo}${path}`, bearer: token })).body,
          `GET ${repo}${path}`,
        );

      /** Every item of a listing, page after page as GitHub's `Link` header gives them. */
      const every = async <T>(path: string, schema: Parameters<typeof parse<T[]>>[0]): Promise<T[]> => {
        const items: T[] = [];
        let where: string | null = `${repo}${path}`;
        while (where !== null) {
          const page = await api.page(where, token);
          items.push(...parse(schema, page.body, `GET ${where}`));
          where = page.next;
        }
        return items;
      };

      const head = commit ?? (await get(`/pulls/${number}`, pull)).head.sha;
      // Lookover's runs only, and all of them: GitHub's default, `latest`, hides every run but the newest.
      const query = `check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`;
      const runs = await get(`/commits/${head}/check-runs?${query}`, checkRuns);
      const posted = await every(`/pulls/${number}/reviews?per_page=100`, reviews);
      const inline = await every(`/pulls/${number}/comments?per_page=100`, reviewComments);
      const conversation = await every(`/issues/${number}/comments?per_page=100`, viewedComments);

      // Whether each comment is hidden: REST doesn't say, GitHub's GraphQL does, a hundred ids a query.
      const ids = [...inline.map((c) => c.node_id), ...conversation.map((c) => c.node_id)];
      const hidden = new Map<string, Minimized>();
      for (let at = 0; at < ids.length; at += NODES_MAX) {
        const variables = { ids: ids.slice(at, at + NODES_MAX) };
        // A comment deleted since the REST read comes back NOT_FOUND beside partial data: the view fails, on purpose.
        const read = await graphql(api, token, { query: NODES, variables, what: "nodes" }, minimizedNodes);
        for (const node of read.nodes) if (node) hidden.set(node.id, minimizedOf(node));
      }

      return {
        checks: byId(runs.check_runs).map((run) => ({
          id: String(run.id),
          name: run.name,
          sha: commitSha(run.head_sha),
          status: statusOf(run.status),
          conclusion: conclusionOf(run.conclusion),
          output: {
            title: run.output.title ?? "",
            summary: run.output.summary ?? "",
            text: run.output.text ?? "",
          },
        })),
        reviews: byId(posted).map((review) => ({
          id: String(review.id),
          sha: commitSha(review.commit_id),
          body: review.body,
          comments: byId(inline)
            .filter((c) => c.pull_request_review_id === review.id)
            .map((c) => ({
              id: String(c.id),
              path: c.path,
              side: c.side === "LEFT" ? "base" : "head",
              // GitHub names a range by its last line and `start_line`; Lookover by its first and `endLine`.
              line: c.start_line ?? c.line,
              endLine: c.start_line == null ? null : c.line,
              originalLine: c.original_start_line ?? c.original_line,
              body: c.body,
              minimized: hidden.get(c.node_id) ?? null,
            })),
        })),
        comments: byId(conversation).map((c) => ({
          id: String(c.id),
          author: { id: c.user.id, login: c.user.login },
          body: c.body,
          reactions: { eyes: c.reactions.eyes, rocket: c.reactions.rocket },
          minimized: hidden.get(c.node_id) ?? null,
        })),
      };
    });
  };
}
