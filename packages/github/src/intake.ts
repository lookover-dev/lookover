// `HostIntake` on GitHub: the open pull requests, the repository's conversation comments since a point, one
// pull request, the commits between two heads, and what a fetch needs (the default branch read at each fetch, so
// a rename is followed). The two listings are polled at stable addresses (ADR 0043): no moving `since` in the
// address, which would be a new ETag every time, so a listing read again with nothing changed is GitHub's free
// `304`.
import type {
  ChangeRef,
  CommitCount,
  FetchSpec,
  HostChange,
  HostConversationComment,
  HostIntake,
  HostThread,
  Listing,
  RepositoryRef,
} from "@lookover/contracts";
import { commitSha, findingOfMarker, HostError } from "@lookover/contracts";
import type { Allowed } from "./allowed.ts";
import type { GitHubApi } from "./api.ts";
import { graphql } from "./graphql.ts";
import {
  comparison,
  defaultBranch,
  outdatedNodes,
  parse,
  pull,
  pulls,
  repositoryComments,
  threadComments,
} from "./schemas.ts";
import type { Session } from "./session.ts";

type Pull = ReturnType<typeof pull.parse>;
type Comment = ReturnType<typeof repositoryComments.parse>[number];
type ThreadComment = ReturnType<typeof threadComments.parse>[number];

/** How many ids GitHub takes in one `nodes` query. */
const NODES_MAX = 100;

const OUTDATED = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequestReviewComment { id outdated } }
}`;

/**
 * Lookover's threads among a pull request's inline comments (ADR 0052, ADR 0066): each root comment written by who
 * posts (`poster`, the bot or the signed-in person, by numeric id) holding a finding marker, with the replies to it,
 * oldest first, those of a deleted account left out; `outdated` names the root comments GitHub shows outdated.
 */
function threadsOf(comments: ThreadComment[], poster: number, outdated: Set<string>): HostThread[] {
  const byId = [...comments].sort((a, b) => a.id - b.id);
  const threads: HostThread[] = [];
  for (const root of byId) {
    const finding = findingOfMarker(root.body);
    if (root.in_reply_to_id !== undefined || root.user?.id !== poster || finding === null) continue;
    const replies = byId.flatMap((c) =>
      c.in_reply_to_id === root.id && c.user !== null
        ? [
            {
              commentId: c.id,
              nodeId: c.node_id,
              author: { id: c.user.id, login: c.user.login, bot: c.user.type === "Bot" },
              body: c.body,
              at: c.created_at,
            },
          ]
        : [],
    );
    threads.push({
      commentId: root.id,
      nodeId: root.node_id,
      url: root.html_url,
      findingId: finding,
      outdated: outdated.has(root.node_id),
      replies,
    });
  }
  return threads;
}

const shown = (p: Pull): HostChange => ({
  host: "github",
  number: p.number,
  title: p.title,
  url: p.html_url,
  author: { login: p.user.login, id: p.user.id },
  draft: p.draft,
  // By id, never name (a rename keeps the id); a head repository gone is a deleted fork's (ADR 0048).
  fork: p.head.repo === null || p.head.repo.id !== p.base.repo.id,
  head: { ref: p.head.ref, sha: commitSha(p.head.sha) },
  base: { ref: p.base.ref, sha: commitSha(p.base.sha) },
});

/** A comment as polling reads it; null for one whose author's account is gone, which can be no one's request. */
const written = (c: Comment): HostConversationComment | null =>
  c.user === null
    ? null
    : {
        id: String(c.id),
        nodeId: c.node_id,
        change: Number(c.issue_url.slice(c.issue_url.lastIndexOf("/") + 1)),
        author: { id: c.user.id, login: c.user.login },
        body: c.body,
        createdAt: Date.parse(c.created_at),
        updatedAt: Date.parse(c.updated_at),
      };

export function createIntake(api: GitHubApi, session: Session, allowed: Allowed): HostIntake {
  const repoPath = (repo: RepositoryRef) => `/repos/${repo.owner}/${repo.name}`;

  /**
   * A listing's pages from `path` on, each read with its ETag, while `more` says the page read calls for the
   * next. Unchanged when every page read was; answered when GitHub answered its first page.
   */
  const pages = async <T>(
    repo: RepositoryRef,
    path: string,
    read: (body: unknown, where: string) => T[],
    more: (items: T[]) => boolean = () => true,
  ): Promise<Listing<T>> =>
    session.withToken(repo, async (token) => {
      const items: T[] = [];
      let unchanged = true;
      let answered: number | null = null;
      let where: string | null = path;
      while (where !== null) {
        const page = await api.page(where, token);
        answered ??= page.at;
        const these = read(page.body, `GET ${where}`);
        items.push(...these);
        unchanged &&= page.unchanged;
        where = more(these) ? page.next : null;
      }
      return { unchanged, items, at: answered ?? 0 };
    });

  /**
   * Every inline comment of `change`, every page read whole: read once a round, not one of the poll's listings, so
   * no ETag is kept for it.
   */
  const inlineComments = async (change: ChangeRef, token: string): Promise<ThreadComment[]> => {
    const comments: ThreadComment[] = [];
    const pullPath = `${repoPath(change.repo)}/pulls/${change.number}`;
    let where: string | null = `${pullPath}/comments?per_page=100`;
    try {
      while (where !== null) {
        const page = await api.page(where, token, false);
        comments.push(...parse(threadComments, page.body, `GET ${where}`));
        where = page.next;
      }
    } catch (error) {
      // GitHub refuses the comments of a pull request it hasn't with a 403, not a 404 (#174's live run): the pull
      // request read alone tells a missing one, whose 404 is the refusal, from a real one.
      if (!(error instanceof HostError) || error.failure !== "unauthorized") throw error;
      await api.request({ path: pullPath, bearer: token });
      throw error;
    }
    return comments;
  };

  /** The review comments among `ids` GitHub's GraphQL shows outdated: one `nodes` query per hundred. */
  const outdatedOf = async (ids: string[], token: string): Promise<Set<string>> => {
    const outdated = new Set<string>();
    for (let at = 0; at < ids.length; at += NODES_MAX) {
      const variables = { ids: ids.slice(at, at + NODES_MAX) };
      const read = await graphql(api, token, { query: OUTDATED, variables, what: "nodes" }, outdatedNodes);
      for (const node of read.nodes) if (node?.outdated) outdated.add(node.id);
    }
    return outdated;
  };

  return {
    async listOpenChanges(repo) {
      allowed(repo);
      const path = `${repoPath(repo)}/pulls?state=open&per_page=100`;
      return pages(repo, path, (body, where) => parse(pulls, body, where).map(shown));
    },
    async listComments(repo, since) {
      allowed(repo);
      // Newest edited first: the pages past the one that reaches back before `since` hold nothing newer.
      const path = `${repoPath(repo)}/issues/comments?sort=updated&direction=desc&per_page=100`;
      const listing = await pages(
        repo,
        path,
        (body, where) => parse(repositoryComments, body, where),
        (page) => {
          const last = page.at(-1);
          return last !== undefined && Date.parse(last.updated_at) >= since;
        },
      );
      const items = listing.items
        .map(written)
        .filter((c): c is HostConversationComment => c !== null && c.updatedAt >= since);
      return { unchanged: listing.unchanged, items, at: listing.at };
    },
    async getChange(repo, number) {
      allowed(repo);
      const path = `${repoPath(repo)}/pulls/${number}`;
      return session.withToken(repo, async (token) => {
        const answer = await api.request({ path, bearer: token });
        return shown(parse(pull, answer.body, `GET ${path}`));
      });
    },
    async threads(change) {
      allowed(change.repo);
      const { id: poster } = await session.poster(change.repo);
      return session.withToken(change.repo, async (token) => {
        const comments = await inlineComments(change, token);
        // Lookover's roots, asked whether outdated: GraphQL showed it seconds after a push, REST's `line` minutes.
        const roots = threadsOf(comments, poster, new Set()).map((t) => t.nodeId);
        return threadsOf(comments, poster, await outdatedOf(roots, token));
      });
    },
    async poster(repo) {
      allowed(repo);
      // Through a token for the repository: the session keeps who posts. The App's token is bought for the repository,
      // so one it isn't installed on is refused there; the person's is the same for every repository, so the
      // repository is read with it, and one it can't see is not_found.
      return session.withToken(repo, async (token) => {
        const { id, login, bot } = await session.poster(repo);
        if (!bot) await api.request({ path: repoPath(repo), bearer: token });
        return { id, login };
      });
    },
    async countCommits(repo, from, to): Promise<CommitCount> {
      allowed(repo);
      // The counts are the whole comparison's; the commits' messages, the first page's (100, GitHub's most).
      const path = `${repoPath(repo)}/compare/${from}...${to}?per_page=100`;
      return session.withToken(repo, async (token) => {
        const answer = await api.request({ path, bearer: token });
        const compared = parse(comparison, answer.body, `GET ${path}`);
        return {
          commits: compared.ahead_by,
          diverged: compared.status === "diverged" || compared.status === "behind",
          messages: compared.commits.map((c) => c.commit.message),
        };
      });
    },
    async fetchSpec(repo): Promise<FetchSpec> {
      allowed(repo);
      // Read at each fetch, so a renamed default branch is followed; with the fetch's own read-only token.
      const path = repoPath(repo);
      const branch = await session.withToken(
        repo,
        async (token) =>
          parse(defaultBranch, (await api.request({ path, bearer: token })).body, `GET ${path}`)
            .default_branch,
        "fetch",
      );
      return {
        cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
        // GitHub's layout: the branches, and each pull request's head under `refs/pull/<n>/head`.
        refspecs: ["+refs/heads/*:refs/heads/*", "+refs/pull/*/head:refs/pull/*/head"],
        defaultBranch: branch,
        // GitHub's form for an installation token over HTTPS: the token as the password of `x-access-token`.
        credentials: () =>
          session.withToken(
            repo,
            (token) => Promise.resolve({ username: "x-access-token", password: token }),
            "fetch",
          ),
      };
    },
  };
}
