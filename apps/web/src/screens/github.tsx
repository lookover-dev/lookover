// A mock of the pull request on GitHub, as Lookover posts on it (ADR 0074), as the person signed in (ADR 0066, ADR
// 0073): the status block in the description, each round's review with its line comments, each thread with the newest
// claim a round read on it and Lookover's reply, and the check run. Every post opens with the wordmark. It uses
// GitHub's own colours on purpose, so it never reads as part of Lookover.
import { type Change, type CommitSha, type Finding, shortSha } from "@lookover/contracts";
import { Fragment, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { reviewPath, useAppState } from "../store.tsx";
import { BrandIcon } from "../ui/basics.tsx";
import { WORDMARK_BOX } from "../ui/eyes.generated.ts";
import { InlineCode } from "../ui/inline-code.tsx";
import { severityLabel } from "../view-model/confirm.ts";
import { placeText } from "../view-model/findings.ts";
import { agoSentence, clock } from "../view-model/format.ts";
import {
  agentLine,
  type BlockItem,
  checkOf,
  postedAs,
  quotedLines,
  replyOf,
  type StatusBlock,
  statusBlock,
  threadOf,
  timelineOf,
  type Words,
} from "../view-model/github.ts";
import { type ChangeReview, changeReviewAt } from "../view-model/select.ts";
import { timelineText } from "../view-model/timeline.ts";

function Avatar() {
  return <span className="gh-avatar" />;
}

/** The wordmark's files, one per theme (brand.md): its width from their drawing, so nothing moves as it loads. */
const WORDMARK = { dark: "/brand/lookover-wordmark-on-dark.svg", light: "/brand/lookover-wordmark.svg" };
const WORDMARK_RATIO = WORDMARK_BOX.width / WORDMARK_BOX.height;

/** The wordmark Lookover's posts open with, `px` high, set on the text's line as GitHub's `absmiddle` sets it. */
function Wordmark({ px }: { px: 18 | 26 }) {
  const width = Math.round(px * WORDMARK_RATIO);
  return (
    <>
      <img className="gh-wordmark on-dark" src={WORDMARK.dark} height={px} width={width} alt="Lookover" />
      <img className="gh-wordmark on-light" src={WORDMARK.light} height={px} width={width} alt="Lookover" />
    </>
  );
}

/** A commit as GitHub links it in a post: its first seven characters, as code. */
function Commit({ sha }: { sha: CommitSha }) {
  return (
    <span className="gh-link">
      <code>{shortSha(sha)}</code>
    </span>
  );
}

function Said({ words }: { words: Words }) {
  return (
    <>
      {words.map((w, i) =>
        typeof w === "string" ? <InlineCode key={i} text={w} /> : <Commit key={i} sha={w.commit} />,
      )}
    </>
  );
}

/** A permalink on its own line, as GitHub embeds it: the file and the commit over the lines it names. */
function Embed({ item }: { item: BlockItem }) {
  const { finding: f, permalink } = item;
  if (permalink === null) return null;
  const quoted = quotedLines(f);
  if (quoted.length === 0) return <div className="gh-link gh-url">{permalink.url}</div>;
  return (
    <div className="gh-embed">
      <div className="gh-embed-head">
        <span className="gh-link">{f.file}</span>
        <span className="gh-muted">
          {placeText(f)} in <code>{shortSha(permalink.sha)}</code>
        </span>
      </div>
      <pre className="gh-code">
        {quoted.map(({ number, text }, i) => (
          <Fragment key={number}>
            {i > 0 ? "\n" : null}
            <span>{number}</span>
            {text}
          </Fragment>
        ))}
      </pre>
    </div>
  );
}

/** Lookover's block in the description: the heading after the wordmark, its line, the open findings. */
function Block({ block }: { block: StatusBlock }) {
  return (
    <>
      <h3 className="gh-block-head">
        <Wordmark px={26} /> · <Said words={block.head} />
      </h3>
      <p>
        <Said words={block.line} />
      </p>
      {block.items.length > 0 ? (
        <ul>
          {block.items.map((item) => (
            <li key={item.finding.id}>
              <b>{item.severity}</b> ·{" "}
              {item.linked ? (
                <a href={`#thread-${item.finding.id}`}>
                  <InlineCode text={item.finding.title} />
                </a>
              ) : (
                <InlineCode text={item.finding.title} />
              )}{" "}
              · <code>{item.finding.file}</code> {item.place}
              {item.note ? (
                <div>
                  <InlineCode text={item.note} />
                </div>
              ) : null}
              <Embed item={item} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** One of Lookover's posts: the wordmark and its kind, then its paragraphs. */
function Post({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <>
      <p>
        <Wordmark px={18} /> · {kind}
      </p>
      {children}
    </>
  );
}

function Inline({ change, finding, author }: { change: Change; finding: Finding; author: string }) {
  const thread = threadOf(change, finding);
  const reply = replyOf(finding);
  const quoted = quotedLines(finding);
  return (
    <details id={`thread-${finding.id}`} className="gh-box gh-thread" open={!thread.resolved}>
      <summary>
        <code>{finding.file}</code>
        <span className="gh-muted">{placeText(finding)}</span>
        {thread.label ? <span className="gh-label">{thread.label}</span> : null}
      </summary>
      {quoted.length > 0 ? (
        <pre className="gh-code">
          {quoted.map(({ number, text }, i) => (
            <Fragment key={number}>
              {i > 0 ? "\n" : null}
              <span>{number}</span>
              {text}
            </Fragment>
          ))}
        </pre>
      ) : null}
      <div className="gh-comment">
        <Avatar />
        {thread.hidden ? (
          <div>
            <b>{author}</b>
            <p className="gh-muted">This comment was marked as resolved.</p>
          </div>
        ) : (
          <div>
            <b>{author}</b>
            <Post kind={severityLabel(finding)}>
              <p>
                <b>
                  <InlineCode text={finding.title} />
                </b>
              </p>
              <p>
                <InlineCode text={finding.body} />
              </p>
            </Post>
          </div>
        )}
      </div>
      {finding.claim ? (
        <div className="gh-comment">
          <Avatar />
          <div>
            <b>{finding.claim.by}</b>
            <p>
              <InlineCode text={finding.claim.text} />
            </p>
          </div>
        </div>
      ) : null}
      {reply ? (
        <div className="gh-comment">
          <Avatar />
          <div>
            <b>{author}</b>
            <Post kind={reply.kind}>
              {reply.said.map((text) => (
                <p key={text}>
                  <InlineCode text={text} />
                </p>
              ))}
            </Post>
          </div>
        </div>
      ) : null}
      {thread.note ? <div className="gh-resolved">{thread.note}</div> : null}
    </details>
  );
}

function AgentTerminal({ it }: { it: ChangeReview }) {
  return (
    <div className="gh-box gh-term">
      <div className="gh-muted">What the coding agent sees</div>
      <pre>
        $ lookover wait --pr {it.change.number}
        {"\n"}
        {agentLine(it)}
      </pre>
    </div>
  );
}

export function GitHubMock() {
  const state = useAppState();
  const navigate = useNavigate();
  const { owner, name, number } = useParams();
  const it = changeReviewAt(state, owner, name, number);
  if (!it) {
    return (
      <div className="gh">
        <div className="gh-strip">
          Simulated GitHub. <Link to="/">Back to Lookover</Link>
        </div>
      </div>
    );
  }
  const { change, review } = it;
  const author = postedAs(state.connection);
  const block = statusBlock(it, state);
  const c = checkOf(it);
  return (
    <div className="gh">
      <div className="gh-strip">
        <span>
          Simulated GitHub: this is how the pull request looks to you and to your agent. Nothing here is real.
        </span>
        <button type="button" onClick={() => navigate(state.setup.done ? reviewPath(change) : "/")}>
          ← Back to Lookover
        </button>
      </div>
      <div className="gh-page">
        <h1>
          {change.title} <span className="gh-muted">#{change.number}</span>
        </h1>
        <div className="gh-sub">
          <span className="gh-state">Open</span>
          <span className="gh-muted">
            <b>{change.openedBy}</b> wants to merge into <code>main</code> · {change.repoId} · opened{" "}
            {agoSentence(state.now, change.openedAt)}
          </span>
        </div>
        <div className="gh-timeline">
          <div className="gh-box">
            <div className="gh-comment-head">
              <Avatar />
              <b>{change.openedBy}</b>
              <span className="gh-muted">commented</span>
            </div>
            <div className="gh-body">
              {block ? <Block block={block} /> : <p className="gh-muted">No description provided.</p>}
            </div>
          </div>
          {timelineOf(review).map((t) =>
            t.kind === "event" ? (
              <div className="gh-event" key={`${t.at}-${t.entry.kind}`}>
                <span className="gh-dot" />
                <span>{timelineText(change, t.entry)}</span>
                {t.entry.sha ? <code>{shortSha(t.entry.sha)}</code> : null}
                <span className="gh-muted">{clock(t.at)}</span>
              </div>
            ) : (
              <Fragment key={`round-${t.round.n}`}>
                <div className="gh-event">
                  <span className="gh-dot" />
                  <b>{author}</b>
                  <span className="gh-muted">reviewed · {clock(t.at)}</span>
                </div>
                {t.findings.map((f) => (
                  <Inline key={f.id} change={change} finding={f} author={author} />
                ))}
              </Fragment>
            ),
          )}
          {review.preview ? (
            <div className="gh-event">
              <span className="gh-dot" />
              <span className="gh-muted">Lookover ran a preview. Nothing was posted here.</span>
            </div>
          ) : null}
        </div>
        <div className="gh-box gh-checks">
          {c ? (
            <div className={`gh-check ${c.tone}`}>
              <span className="gh-check-icon" />
              <span className="gh-avatar bot small">
                <BrandIcon />
              </span>
              <b>Lookover</b>
              <span className="gh-muted">
                {c.title} · {c.text}
              </span>
            </div>
          ) : (
            <div className="gh-check neutral">
              <span className="gh-muted">No check from Lookover on this commit.</span>
            </div>
          )}
        </div>
        {change.writtenBy ? <AgentTerminal it={it} /> : null}
      </div>
    </div>
  );
}
