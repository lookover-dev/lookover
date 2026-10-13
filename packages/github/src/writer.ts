// `HostWriter` on GitHub: the `Lookover` check run, carrying its job's id as GitHub's `external_id` (found by it
// among the App's runs on the commit); one review
// with its inline comments, found again by its marker among the bot's own; the summary comment found by its marker
// among the bot's own. Both lookups read every page GitHub's `Link` header gives. GitHub's rules from spike 03
// (ADR 0022) are applied before a request leaves: the check output and every body are counted in UTF-8 bytes.
import type {
  CheckOutput,
  DiffSide,
  HostWriter,
  InlineComment,
  MinimizeReason,
  OpenCheckStatus,
  Reaction,
  RepositoryRef,
} from "@lookover/contracts";
import {
  CHECK_NAME,
  CHECK_OUTPUT_MAX_BYTES,
  COMMENT_MAX_BYTES,
  HostError,
  SUMMARY_MARKER,
  utf8Bytes,
} from "@lookover/contracts";
import type { Allowed } from "./allowed.ts";
import type { GitHubApi } from "./api.ts";
import type { AppSession } from "./auth.ts";
import { graphql } from "./graphql.ts";
import {
  authoredReviews,
  checkRun,
  externalRuns,
  issueComment,
  issueComments,
  minimizedComment,
  parse,
  replyId,
  reviewId,
} from "./schemas.ts";

/** Throws `too_large` when GitHub would refuse or cut the output; nothing has been sent yet. */
function fits(output: CheckOutput): void {
  for (const field of ["summary", "text"] as const) {
    const size = utf8Bytes(output[field]);
    if (size > CHECK_OUTPUT_MAX_BYTES) {
      throw new HostError(
        "too_large",
        `The check's ${field} is ${size} bytes; GitHub takes ${CHECK_OUTPUT_MAX_BYTES} at most`,
      );
    }
  }
}

/** Throws `too_large` for a body over `COMMENT_MAX_BYTES`, under GitHub's own limit; nothing is sent then. */
function fitsBody(what: string, body: string): void {
  const size = utf8Bytes(body);
  if (size > COMMENT_MAX_BYTES) {
    throw new HostError(
      "too_large",
      `The ${what} is ${size} bytes; Lookover posts ${COMMENT_MAX_BYTES} at most`,
    );
  }
}

const repoPath = (repo: RepositoryRef) => `/repos/${repo.owner}/${repo.name}`;

/** A check not yet completed, as GitHub names its status. */
const STATUS: Record<OpenCheckStatus, "queued" | "in_progress"> = {
  queued: "queued",
  in_progress: "in_progress",
};

/** A reaction as GitHub names it. */
const CONTENT: Record<Reaction, "eyes" | "rocket"> = { eyes: "eyes", rocket: "rocket" };

/** Why a comment is hidden, as GitHub's `minimizeComment` names it. */
const CLASSIFIER: Record<MinimizeReason, "RESOLVED" | "OUTDATED"> = {
  resolved: "RESOLVED",
  outdated: "OUTDATED",
};

const MINIMIZE = `mutation($id: ID!, $classifier: ReportedContentClassifiers!) {
  minimizeComment(input: { subjectId: $id, classifier: $classifier }) { minimizedComment { isMinimized } }
}`;

/** A diff side as GitHub names it in a review comment. */
const SIDE: Record<DiffSide, "LEFT" | "RIGHT"> = { head: "RIGHT", base: "LEFT" };

/**
 * A comment as GitHub takes it in a review. On a range, GitHub's `line` is the range's last line and
 * `start_line` its first, both on one side (spike 03, step 10); a range of one line is sent as that line.
 */
function reviewComment(c: InlineComment) {
  const side = SIDE[c.side];
  if (c.endLine === null || c.endLine === c.line) return { path: c.path, side, line: c.line, body: c.body };
  return { path: c.path, side, start_side: side, start_line: c.line, line: c.endLine, body: c.body };
}

/**
 * GitHub's 422 on a review: a comment it can't place, which the error never names: "Line could not be resolved"
 * (spike 03), "… line must be part of the diff", "… must be part of the same hunk"; nothing of the review was
 * posted. Any other words are the API's (`api.ts`).
 */
const unprocessable = (words: string): HostError | null =>
  /could not be resolved|must be part of the (diff|same hunk)/i.test(words)
    ? new HostError(
        "unplaceable_comment",
        `A comment is outside the diff; the review was not posted (${words})`,
      )
    : null;

export function createWriter(api: GitHubApi, session: AppSession, allowed: Allowed): HostWriter {
  /** Every item of a listing, page after page as GitHub's `Link` header gives them. */
  async function everyPage<T>(path: string, token: string, read: (body: unknown, where: string) => T[]) {
    const items: T[] = [];
    let where: string | null = path;
    while (where !== null) {
      const page = await api.page(where, token);
      items.push(...read(page.body, `GET ${where}`));
      where = page.next;
    }
    return items;
  }

  return {
    async createCheck(repo, sha, status, output, externalId) {
      allowed(repo);
      fits(output);
      const path = `${repoPath(repo)}/check-runs`;
      return session.withToken(repo, async (token) => {
        const body = {
          name: CHECK_NAME,
          head_sha: sha,
          status: STATUS[status],
          output,
          external_id: externalId,
        };
        const answer = await api.request({ method: "POST", path, bearer: token, body });
        return String(parse(checkRun, answer.body, `POST ${path}`).id);
      });
    },
    async findCheck(repo, sha, externalId) {
      allowed(repo);
      // The App's own runs of the check on the commit; the newest holding the id (the highest id) is the one.
      const query = `check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&app_id=${session.appId}&per_page=100`;
      const path = `${repoPath(repo)}/commits/${sha}/check-runs?${query}`;
      return session.withToken(repo, async (token) => {
        const listed = parse(externalRuns, (await api.request({ path, bearer: token })).body, `GET ${path}`);
        const own = listed.check_runs.filter((run) => run.external_id === externalId).map((run) => run.id);
        return own.length > 0 ? String(Math.max(...own)) : null;
      });
    },
    async updateCheck(repo, checkId, status, output) {
      allowed(repo);
      fits(output);
      const path = `${repoPath(repo)}/check-runs/${checkId}`;
      await session.withToken(repo, (token) =>
        api.request({ method: "PATCH", path, bearer: token, body: { status: STATUS[status], output } }),
      );
    },
    async completeCheck(repo, checkId, conclusion, output) {
      allowed(repo);
      fits(output);
      const path = `${repoPath(repo)}/check-runs/${checkId}`;
      await session.withToken(repo, (token) =>
        api.request({
          method: "PATCH",
          path,
          bearer: token,
          body: { status: "completed", conclusion, output },
        }),
      );
    },
    async publishReview(change, review) {
      allowed(change.repo);
      fitsBody("review's body", review.body);
      for (const c of review.comments) fitsBody(`comment on ${c.path}:${c.line}`, c.body);
      const path = `${repoPath(change.repo)}/pulls/${change.number}/reviews`;
      const body = {
        commit_id: review.sha,
        event: "COMMENT",
        body: review.body,
        comments: review.comments.map(reviewComment),
      };
      return session.withToken(change.repo, async (token) => {
        const answer = await api.request({ method: "POST", path, bearer: token, body, unprocessable });
        return String(parse(reviewId, answer.body, `POST ${path}`).id);
      });
    },
    async findReview(change, marker) {
      allowed(change.repo);
      const bot = await session.botId(change.repo);
      const path = `${repoPath(change.repo)}/pulls/${change.number}/reviews?per_page=100`;
      return session.withToken(change.repo, async (token) => {
        const listed = await everyPage(path, token, (body, where) => parse(authoredReviews, body, where));
        const own = listed.find((r) => r.user?.id === bot && r.body.includes(marker));
        return own ? String(own.id) : null;
      });
    },
    async upsertSummary(change, body) {
      allowed(change.repo);
      if (!body.includes(SUMMARY_MARKER)) {
        throw new HostError(
          "missing_marker",
          `The summary must hold the marker ${SUMMARY_MARKER}, or the next round can't find it`,
        );
      }
      fitsBody("summary", body);
      const bot = await session.botId(change.repo);
      const issue = `${repoPath(change.repo)}/issues/${change.number}/comments`;
      return session.withToken(change.repo, async (token) => {
        const comments = await everyPage(`${issue}?per_page=100`, token, (listed, where) =>
          parse(issueComments, listed, where),
        );
        const own = comments.find((c) => c.user.id === bot && c.body.includes(SUMMARY_MARKER));
        if (own) {
          const path = `${repoPath(change.repo)}/issues/comments/${own.id}`;
          await api.request({ method: "PATCH", path, bearer: token, body: { body } });
          return String(own.id);
        }
        const created = await api.request({ method: "POST", path: issue, bearer: token, body: { body } });
        return String(parse(issueComment, created.body, `POST ${issue}`).id);
      });
    },
    async react(repo, commentId, reaction) {
      allowed(repo);
      // GitHub answers 201 for a new reaction and 200 for one the bot already put there: both are done.
      const path = `${repoPath(repo)}/issues/comments/${commentId}/reactions`;
      await session.withToken(repo, (token) =>
        api.request({ method: "POST", path, bearer: token, body: { content: CONTENT[reaction] } }),
      );
    },
    async reply(change, commentId, body) {
      allowed(change.repo);
      fitsBody("reply", body);
      const path = `${repoPath(change.repo)}/pulls/${change.number}/comments/${commentId}/replies`;
      return session.withToken(change.repo, async (token) => {
        const answer = await api.request({ method: "POST", path, bearer: token, body: { body } });
        return String(parse(replyId, answer.body, `POST ${path}`).id);
      });
    },
    async minimize(repo, nodeId, reason) {
      allowed(repo);
      await session.withToken(repo, (token) =>
        graphql(
          api,
          token,
          {
            query: MINIMIZE,
            variables: { id: nodeId, classifier: CLASSIFIER[reason] },
            what: `minimizeComment on ${nodeId}`,
          },
          minimizedComment,
        ).then((answer) => {
          // GitHub said nothing went wrong and hid nothing: no comment to show for it.
          if (answer.minimizeComment.minimizedComment?.isMinimized !== true)
            throw new HostError("invalid", `GitHub hid nothing for minimizeComment on ${nodeId}`);
        }),
      );
    },
  };
}
