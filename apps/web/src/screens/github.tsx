// A mock of the pull request on GitHub: the bot's summary comment, its inline comments (each with the newest reply
// a round read on its thread, the claim) and the check run.
// It uses GitHub's own colours on purpose, so it never reads as part of Lookover.
import { type Change, type Finding, isCounted, shortSha } from "@lookover/contracts";
import { Fragment } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { reviewPath, useAppState } from "../store.tsx";
import { BrandIcon } from "../ui/basics.tsx";
import { severityLabel } from "../view-model/confirm.ts";
import { placeText } from "../view-model/findings.ts";
import { clock } from "../view-model/format.ts";
import {
  agentLine,
  checkOf,
  quotedLines,
  summaryComment,
  summaryFooter,
  threadOf,
} from "../view-model/github.ts";
import { type ChangeReview, changeReviewAt } from "../view-model/select.ts";
import { timelineText } from "../view-model/timeline.ts";

function Avatar({ bot }: { bot?: boolean }) {
  return <span className={`gh-avatar ${bot ? "bot" : ""}`}>{bot ? <BrandIcon /> : null}</span>;
}

function Inline({ change, finding, bot }: { change: Change; finding: Finding; bot: string }) {
  const thread = threadOf(change, finding);
  const quoted = quotedLines(finding);
  return (
    <details className="gh-box gh-thread" open={!thread.resolved}>
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
        <Avatar bot />
        <div>
          <b>{bot}</b> <span className="gh-muted">bot</span>
          <p>
            <b>{severityLabel(finding)}:</b> {finding.title}. {finding.body}
          </p>
        </div>
      </div>
      {finding.claim ? (
        <div className="gh-comment">
          <Avatar />
          <div>
            <b>{finding.claim.by}</b>
            <p>{finding.claim.text}</p>
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
  const { repo, number } = useParams();
  const it = changeReviewAt(state, repo, number);
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
  const bot = state.connection.bot ?? "sam-reviewer[bot]";
  const posted = review.rounds.length > 0 && !review.preview;
  const inline = review.findings.filter((f) => f.posted);
  const c = checkOf(it);
  const open = review.findings.filter(isCounted);
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
            <b>{change.openedBy}</b> wants to merge into <code>main</code> · {change.repoId}
          </span>
        </div>
        <div className="gh-timeline">
          {review.timeline
            .filter((t) => t.kind === "opened" || t.kind === "pushed")
            .map((t) => (
              <div className="gh-event" key={`${t.at}-${t.kind}`}>
                <span className="gh-dot" />
                <span>{timelineText(change, t)}</span>
                {t.sha ? <code>{shortSha(t.sha)}</code> : null}
                <span className="gh-muted">{clock(t.at)}</span>
              </div>
            ))}
          {posted ? (
            <div className="gh-box">
              <div className="gh-comment-head">
                <Avatar bot />
                <b>{bot}</b> <span className="gh-label">bot</span>
                <span className="gh-muted">
                  commented ·{" "}
                  {review.rounds.length > 1 ? "edited" : clock(review.rounds[0]?.endedAt ?? review.updatedAt)}
                </span>
              </div>
              <div className="gh-body">
                <p>{summaryComment(it)}</p>
                {open.length > 0 ? (
                  <ul>
                    {open.map((f) => (
                      <li key={f.id}>
                        <b>{severityLabel(f)}:</b> {f.title} <code>{f.file}</code> {placeText(f)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="gh-muted">{summaryFooter(review)}</p>
              </div>
            </div>
          ) : review.preview ? (
            <div className="gh-event">
              <span className="gh-dot" />
              <span className="gh-muted">Lookover ran a preview. Nothing was posted here.</span>
            </div>
          ) : null}
          {posted ? inline.map((f) => <Inline key={f.id} change={change} finding={f} bot={bot} />) : null}
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
