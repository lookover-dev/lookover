// Review detail: the verdict first, then the open findings. Everything else is one click down.
import { type Finding, type SkipReason, type State, shortSha, skipText } from "@lookover/contracts";
import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePageKeys } from "../shell.tsx";
import { useAppState, useSend } from "../store.tsx";
import { useTickingNow } from "../ticking.tsx";
import {
  Button,
  Card,
  Chip,
  Code,
  Disclosure,
  Empty,
  Eyes,
  LiveLog,
  Notice,
  Ring,
  SameWidth,
  SectionHead,
  Tabs,
  Tag,
} from "../ui/basics.tsx";
import { Layer, MenuItem, Tip, useToast } from "../ui/layers.tsx";
import { liveLog } from "../view-model/activity.ts";
import {
  CONFIRM_LABELS,
  checkedBy,
  confirmDetails,
  findersOf,
  foundByLine,
  severityLabel,
} from "../view-model/confirm.ts";
import {
  doneLine,
  type FindingTab,
  findingGroups,
  findingTabs,
  type NoiseOption,
  needsYou,
  noiseChoices,
  onGitHub,
  placeText,
  replyLine,
  roundOnHead,
  whyRaised,
} from "../view-model/findings.ts";
import { agoSentence, duration, plural } from "../view-model/format.ts";
import { roundRow } from "../view-model/rounds.ts";
import { runLineParts, runSteps } from "../view-model/run.ts";
import {
  type ChangeReview,
  canReviewAgain,
  changeLabel,
  changeReviewAt,
  differences,
  lookedOver,
  nextStep,
  REVIEW_BUTTON,
  reviewAgainNote,
  reviewButton,
  reviewerOf,
  reviewLabel,
  settledVerdict,
  skipWhy,
  status,
  unsettledFindings,
  waitNotice,
  writerName,
} from "../view-model/select.ts";
import { cancelSentence, failureSentence } from "../view-model/status.ts";
import { logLine, startedBy } from "../view-model/timeline.ts";
import { Page, RunLine, StepList } from "./common.tsx";
import { GitHubButton, useOpenOnGitHub } from "./github-app.tsx";

function fixPrompt(it: ChangeReview): string {
  const open = unsettledFindings(it.review);
  const lines = open.map(
    (f, i) => `${i + 1}. [${severityLabel(f)}] ${f.title} (${f.file}, ${placeText(f)})\n   ${f.body}`,
  );
  return `Fix the open review findings on ${changeLabel(it.change)} "${it.change.title}". Then push, and comment \`/lookover review\` on the pull request to ask for the next round.\n\n${lines.join("\n")}`;
}

function TooNoisy({ it, finding }: { it: ChangeReview; finding: Finding }) {
  const { rules } = useAppState();
  // Whether the menu is open: it keeps what it opened with, so it stays even when no choice is left meanwhile.
  const [open, setOpen] = useState(false);
  const choices = noiseChoices(
    {
      changeId: it.change.id,
      repo: it.repo.name,
      strictness: it.repo.settings.strictness.value,
      ...(it.repo.noise === undefined ? {} : { noise: it.repo.noise }),
      rules,
      onHead: roundOnHead(it.review, it.change),
    },
    finding,
  );
  // A finding with no choice left shows no "Too noisy?" (ADR 0049), once its menu is closed.
  if (choices.length === 0 && !open) return null;
  return (
    <Layer
      className="pop"
      trigger={(props) => (
        <Button variant="ghost" size="sm" {...props}>
          Too noisy?
        </Button>
      )}
    >
      {(close) => <NoiseMenu opened={choices} close={close} onOpen={setOpen} />}
    </Layer>
  );
}

/** A choice's label, the repository's name it ends with kept on one line. */
function NoiseLabel({ option }: { option: NoiseOption }) {
  const { label, named } = option;
  if (named === undefined || !label.endsWith(named)) return <>{label}</>;
  return (
    <>
      {label.slice(0, -named.length)}
      <span className="nowrap">{named}</span>
    </>
  );
}

/**
 * "Too noisy?"'s menu, mounted while it is open: it keeps the choices and the numbers it opened with (ADR 0049), so
 * a round landing meanwhile never moves a line under the pointer. It says when it opens and closes (`onOpen`).
 */
function NoiseMenu({
  opened,
  close,
  onOpen,
}: {
  opened: NoiseOption[];
  close: () => void;
  onOpen: (open: boolean) => void;
}) {
  const send = useSend();
  const toast = useToast();
  const [choices] = useState(opened);
  const [picked, setPicked] = useState<NoiseOption | null>(null);
  useEffect(() => {
    onOpen(true);
    return () => onOpen(false);
  }, [onOpen]);
  if (picked) {
    return (
      <>
        <h4>
          <NoiseLabel option={picked} />
        </h4>
        <p>{picked.effect}</p>
        <div className="pop-acts">
          <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
            Back
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              // Said once the service took it: a locked server asks to unlock first.
              send({ type: "noise.apply", choice: picked.choice }, () => toast({ text: picked.saved }));
              close();
            }}
          >
            Save
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <h4>Make this reviewer quieter</h4>
      <p>Each choice says what it changes before you save it.</p>
      <div className="menu">
        {choices.map((c) => (
          <MenuItem key={c.label} hint={c.hint} onSelect={() => setPicked(c)}>
            <NoiseLabel option={c} />
          </MenuItem>
        ))}
      </div>
    </>
  );
}

function FindingCard({ it, finding }: { it: ChangeReview; finding: Finding }) {
  const toast = useToast();
  const checked = checkedBy(it.review, finding);
  const why = whyRaised(finding);
  const reply = replyLine(it.change, finding);
  return (
    <Card className="finding">
      <div className="t">
        <span className={`sev ${finding.severity === "blocking" ? "" : "fix"}`}>
          {severityLabel(finding)}
        </span>
        {needsYou(finding) ? <Chip tone="need">Needs you</Chip> : null}
        <span>
          {finding.category} · open since round {finding.raisedIn}
          {finding.posted ? "" : " · not posted on GitHub"}
        </span>
      </div>
      <h5>{finding.title}</h5>
      <div className="t">
        <Tag>{finding.file}</Tag>
        <span>{placeText(finding)}</span>
      </div>
      <p>{finding.body}</p>
      {finding.snippet ? (
        <Code start={finding.snippet.start} lines={finding.snippet.lines} mark={finding.snippet.mark} />
      ) : null}
      {finding.fix ? <Code start={finding.line} lines={[]} diff={finding.fix} /> : null}
      <div className="why">
        {why ? (
          <span>
            <b>Why it was raised:</b> {why}
          </span>
        ) : null}
        <span>
          <b>{checked.head}</b>
          {checked.text ? ` ${checked.text}` : null}
          {checked.evidence.map((line, i) => (
            <Fragment key={`${i}-${line}`}>
              {" "}
              <code>{line}</code>
            </Fragment>
          ))}
        </span>
        {reply ? (
          <span>
            <b>{reply.head}</b> {reply.text}
          </span>
        ) : null}
        {reply?.kept ? (
          <span>
            <b>{reply.kept}</b> Lookover still sees it after the reply.
          </span>
        ) : null}
      </div>
      <div className="acts">
        <Button
          size="sm"
          onClick={() => {
            navigator.clipboard?.writeText(
              fixPrompt({ ...it, review: { ...it.review, findings: [finding] } }),
            );
            toast({ text: "Fix prompt copied. Paste it to your coding agent." });
          }}
        >
          Copy fix prompt
        </Button>
        {onGitHub(it.review, finding) ? (
          <GitHubButton change={it.change} variant="ghost" size="sm">
            View on GitHub
          </GitHubButton>
        ) : null}
        <TooNoisy it={it} finding={finding} />
      </div>
    </Card>
  );
}

function ClosedRow({ finding }: { finding: Finding }) {
  const line = doneLine(finding);
  return (
    <div className="rowi static">
      <span className={`sev-label ${finding.severity === "blocking" ? "" : "fix"}`}>
        {severityLabel(finding)}
      </span>
      <div className="rowi-main">
        <div className="ti">{finding.title}</div>
        <div className="me">
          {line.kind === "verified" ? (
            <>
              <span>verified fixed in</span>
              <code>{line.sha}</code>
              {line.round === null ? null : <span>round {line.round}</span>}
            </>
          ) : (
            <span className="wrap">{line.text}</span>
          )}
        </div>
      </div>
      <span className="ac" />
    </div>
  );
}

function NotReviewed({ it, reason }: { it: ChangeReview; reason: SkipReason }) {
  const why = skipWhy(it, reason);
  return (
    <Card className="verdict">
      <b>Not reviewed: {skipText(reason)}.</b>
      <Disclosure summary="Why wasn't it reviewed?">
        <p>
          {why.text}
          {why.ask ? (
            <>
              {" "}
              {why.ask.lead} <code>{why.ask.command}</code> {why.ask.tail}
            </>
          ) : null}
        </p>
      </Disclosure>
    </Card>
  );
}

/** The running round: its number, and the steps of the run done so far. */
function Running({ it, state, round }: { it: ChangeReview; state: State; round: number }) {
  const { review } = it;
  const steps = runSteps(review);
  const step = review.run?.step ?? "preparing";
  const now = useTickingNow(state);
  return (
    <Card className="running">
      <div className="running-head">
        <Ring
          value={steps.indexOf(step) + 1}
          of={steps.length}
          label={`Step ${steps.indexOf(step) + 1} of ${steps.length}`}
        />
        <div>
          <b>Round {round}</b>
          <div className="t-small">
            <RunLine parts={runLineParts(now, review)} />
          </div>
        </div>
      </div>
      <StepList review={review} state={state} />
    </Card>
  );
}

function Verdict({ it, state }: { it: ChangeReview; state: State }) {
  const send = useSend();
  const { change, review } = it;
  const s = status(it);

  switch (s.kind) {
    case "needs-you": {
      const n = review.findings.filter(needsYou).length;
      return (
        <Notice>
          {change.writtenBy ? "The agent" : "The author"} and the reviewer disagree on{" "}
          {n === 1 ? "one finding" : `${n} findings`} after {plural(review.rounds.length, "round")}. Only you
          can settle {n === 1 ? "it" : "them"}: read both sides below.
        </Notice>
      );
    }
    case "failed":
      return (
        <Card className="verdict">
          <b>{failureSentence(s.failure)}</b> {reviewLabel(it)} to try once more.
        </Card>
      );
    case "cancelled":
      return (
        <Card className="verdict">
          <b>This review was cancelled.</b> {cancelSentence(s.reason)}
        </Card>
      );
    case "running":
      return <Running it={it} state={state} round={s.round} />;
    case "waiting":
      return (
        <Notice
          label="Waiting"
          tone="warn"
          action={
            s.deferral?.reason === "paused" ? (
              <Button size="sm" onClick={() => send({ type: "service.resume" })}>
                Resume reviews
              </Button>
            ) : null
          }
        >
          {waitNotice(state, it)}
        </Notice>
      );
    case "skipped":
      return <NotReviewed it={it} reason={s.reason} />;
    case "not-asked":
      return <NotReviewed it={it} reason="on-open-off" />;
    case "settled":
      return <SettledVerdict it={it} state={state} clean={s.clean} />;
    case "to-fix":
      return <ToFixVerdict it={it} />;
  }
}

/** A settled review's verdict: the commit it looked over, then nothing to fix, or what it closed and what stays here. */
function SettledVerdict({ it, state, clean }: { it: ChangeReview; state: State; clean: boolean }) {
  const { review } = it;
  // Only posted findings count (I-152): one kept off the pull request stays here, open, once the loop settles.
  const verdict = settledVerdict(review);
  return clean ? (
    <Card className="verdict">
      <Eyes still />
      <span>
        <b>Looked over {lookedOver(it)}. Nothing to fix.</b>
        <span className="t-small"> {agoSentence(state.now, review.updatedAt)}</span>
      </span>
    </Card>
  ) : (
    <Card className="verdict">
      <Eyes still />
      <span>
        <b>
          Looked over {lookedOver(it)}. {verdict.closed}
        </b>
        <span className="t-small"> {verdict.rest}</span>
      </span>
    </Card>
  );
}

function ToFixVerdict({ it }: { it: ChangeReview }) {
  const open = unsettledFindings(it.review);
  const blocking = open.filter((f) => f.severity === "blocking").length;
  return (
    <Card className="verdict">
      <span>
        <b>
          Looked over {lookedOver(it)}. {open.length === 1 ? "One thing" : `${open.length} things`} to fix
          {blocking > 0 ? `, ${blocking} blocking` : ""}.
        </b>
        <span className="t-small"> {nextStep(it)}</span>
      </span>
    </Card>
  );
}

function Details({ it, state }: { it: ChangeReview; state: State }) {
  const { review, repo } = it;
  const last = review.rounds.at(-1);
  const checks = confirmDetails(review);
  // Every listed round has ended: their time shows, 0 s included (a frozen clock's); none yet, the first is running.
  const total = review.rounds.reduce((ms, r) => ms + (r.endedAt - r.startedAt), 0);
  const { run } = review;
  const diffs = differences(repo);
  const strictness = repo.settings.strictness.value;
  const log = review.timeline.map((t) => logLine(it.change, t));
  // The running round counts here, as a row of the table still running.
  const sha = run?.sha ?? last?.sha;
  if (!sha) return null;
  return (
    <>
      <SectionHead>Details</SectionHead>
      <div className="list">
        <Disclosure
          row
          summary="How this review ran"
          value={
            <>
              {findersOf(review)}
              {checks?.count ? ` · ${checks.count}` : ""} · {last ? duration(total) : "running"}
            </>
          }
        >
          <dl>
            <dt>Started by</dt>
            <dd>{startedBy(review.timeline)}</dd>
            <dt>{CONFIRM_LABELS.found}</dt>
            <dd>{foundByLine(review, state.engines)}</dd>
            {checks ? (
              <>
                <dt>{CONFIRM_LABELS.checked}</dt>
                <dd>{checks.checked}</dd>
              </>
            ) : null}
            {checks && checks.ruledOut.length > 0 ? (
              <>
                <dt>{CONFIRM_LABELS.ruledOut}</dt>
                <dd>
                  {checks.ruledOut.map((r, i) => (
                    <div key={`${i}-${r.title}`}>
                      {r.title}: {r.reason}
                    </div>
                  ))}
                </dd>
              </>
            ) : null}
            <dt>Posted</dt>
            <dd>
              {review.preview ? (
                "Nothing: this was a preview"
              ) : (
                // The bot's name is never broken at a hyphen: the line wraps before it.
                <>
                  As <span className="nowrap">{state.connection.bot}</span>, with a check on {shortSha(sha)}
                </>
              )}
            </dd>
          </dl>
        </Disclosure>
        <Disclosure
          row
          summary="Rounds"
          value={
            <>
              {review.rounds.length + (run ? 1 : 0)} · last commit <code>{shortSha(sha)}</code>
            </>
          }
        >
          <div className="tbl-wrap">
            <table className="tbl nowrap">
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Commit</th>
                  <th>New</th>
                  <th>Verified fixed</th>
                  <th>Still open</th>
                  <th>By</th>
                  <th>Tokens</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {review.rounds.map((r) => {
                  const row = roundRow(r);
                  return (
                    <tr key={r.n}>
                      <td>{r.n}</td>
                      <td>
                        <code>{row.commit}</code>
                      </td>
                      <td>{r.raised}</td>
                      <td>{r.verifiedFixed}</td>
                      <td>{r.open}</td>
                      <td>{row.by}</td>
                      <td className="num">{row.tokens}</td>
                      <td>{duration(r.endedAt - r.startedAt)}</td>
                    </tr>
                  );
                })}
                {run ? (
                  <tr>
                    <td>{review.rounds.length + 1}</td>
                    <td>
                      <code>{shortSha(run.sha)}</code>
                    </td>
                    <td>…</td>
                    <td>…</td>
                    <td>…</td>
                    <td>…</td>
                    <td>…</td>
                    <td>running</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Disclosure>
        <Disclosure
          row
          summary="Settings used"
          value={
            <>
              {
                {
                  recommended: "Recommended",
                  blocking: "Only blocking findings",
                  everything: "Everything",
                }[strictness]
              }
              {diffs.length > 0 ? (
                <Tag origin>
                  {plural(diffs.length, "difference")} in {repo.name}
                </Tag>
              ) : null}
            </>
          }
        >
          <p className="t-small">
            {diffs.length > 0 ? `${repo.name} differs from your defaults. ` : "Your defaults were used. "}
            <Link to={`/repositories/${repo.owner}/${repo.name}`}>See what applies to {repo.name}</Link>
          </p>
        </Disclosure>
        <Disclosure row summary="Log" value={<>{plural(log.length, "line")} · secrets removed</>}>
          <div className="stack">
            <Code start={1} lines={log} />
            <LiveLog {...liveLog(run)} />
          </div>
        </Disclosure>
      </div>
    </>
  );
}

function Findings({ it }: { it: ChangeReview }) {
  const [tab, setTab] = useState<FindingTab>("todo");
  const groups = findingGroups(it.review);
  const tabs = findingTabs(it.review);
  const [first] = tabs;
  if (!first) return null;
  const current = groups[tab].length > 0 ? tab : first.value;
  return (
    <>
      {tabs.length > 1 ? (
        <Tabs value={current} tabs={tabs} onChange={setTab} />
      ) : (
        <SectionHead count={first.count}>{first.label}</SectionHead>
      )}
      <div className="list findings">
        {groups[current].map((f) =>
          current === "todo" ? (
            <FindingCard key={f.id} it={it} finding={f} />
          ) : (
            <ClosedRow key={f.id} finding={f} />
          ),
        )}
      </div>
    </>
  );
}

function ReviewHead({ it, state }: { it: ChangeReview; state: State }) {
  const { change, review } = it;
  const engine = reviewerOf(review);
  const reviewerName = engine ? state.engines[engine].name : null;
  return (
    <div className="rv-head">
      <h3>{change.title}</h3>
      <div className="me">
        <Tag>
          {change.repoId} #{change.number}
        </Tag>
        <span>
          {change.writtenBy
            ? `opened by ${change.openedBy}, written by ${writerName(change)}`
            : `opened by ${change.openedBy}`}
        </span>
        {reviewerName ? <span>reviewed by {reviewerName}</span> : null}
        {review.preview ? (
          <Tip text="Nothing was posted on GitHub for this round.">
            <Tag origin>preview only</Tag>
          </Tip>
        ) : null}
      </div>
    </div>
  );
}

interface ReviewActionsProps {
  it: ChangeReview;
  again: (() => unknown) | undefined;
  copy: (() => unknown) | undefined;
}

function ReviewActions({ it, again, copy }: ReviewActionsProps) {
  const state = useAppState();
  const shown = reviewButton(it);
  const busy = shown === "running" || shown === "waiting";
  const note = again ? reviewAgainNote(state) : null;
  // The button keeps one width through its labels, so the buttons after it never move (#279).
  return (
    <div className="rv-acts">
      {busy || again ? (
        <SameWidth
          shown={shown}
          labels={{
            now: (
              <Button variant="primary" kbd="R" onClick={again}>
                {REVIEW_BUTTON.now}
              </Button>
            ),
            again: (
              <Button variant="primary" kbd="R" onClick={again}>
                {REVIEW_BUTTON.again}
              </Button>
            ),
            running: (
              <Button loading disabled>
                {REVIEW_BUTTON.running}
              </Button>
            ),
            waiting: (
              <Button loading disabled>
                {REVIEW_BUTTON.waiting}
              </Button>
            ),
          }}
        />
      ) : null}
      {copy ? (
        <Button kbd="C" onClick={copy}>
          Copy a fix prompt for my agent
        </Button>
      ) : null}
      <GitHubButton change={it.change} kbd="G">
        Open on GitHub
      </GitHubButton>
      {/* Last, so the buttons keep their places when it comes and goes. */}
      {note ? <span className="t-small">{note}</span> : null}
    </div>
  );
}

export function Review() {
  const state = useAppState();
  const send = useSend();
  const toast = useToast();
  const navigate = useNavigate();
  const { owner, name, number } = useParams();
  const it = changeReviewAt(state, owner, name, number);

  const open = it ? unsettledFindings(it.review) : [];
  const again =
    it && canReviewAgain(it) ? () => send({ type: "review.request", changeId: it.change.id }) : undefined;
  const copy =
    it && open.length > 0
      ? () => {
          navigator.clipboard?.writeText(fixPrompt(it));
          toast({ text: "Fix prompt copied. Paste it to your coding agent." });
        }
      : undefined;
  const openOnGitHub = useOpenOnGitHub();
  const github = it ? () => openOnGitHub(it.change) : undefined;
  usePageKeys({ r: again, c: copy, g: github, escape: () => navigate("/") });

  if (!it) {
    return (
      <Page>
        <Empty title="No such pull request">
          <Link to="/">Back to reviews</Link>
        </Empty>
      </Page>
    );
  }
  return (
    <Page screen="review">
      <div className="crumb">
        <Link to="/">Reviews</Link> / <b>{changeLabel(it.change)}</b>
      </div>
      <ReviewHead it={it} state={state} />
      <ReviewActions it={it} again={again} copy={copy} />
      <Verdict it={it} state={state} />
      <Findings it={it} />
      <Details it={it} state={state} />
    </Page>
  );
}
