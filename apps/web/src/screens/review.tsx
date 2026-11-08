// Review detail: the verdict first, then the open findings. Everything else is one click down.
import { asSentence, type CommitSha, type Finding, type State } from "@lookover/contracts";
import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePageKeys } from "../shell.tsx";
import { useAppState, useSend } from "../store.tsx";
import { useTickingNow } from "../ticking.tsx";
import {
  BusyStatus,
  Button,
  Card,
  Code,
  Disclosure,
  Empty,
  Eyes,
  Group,
  LiveLog,
  Notice,
  Ring,
  SameWidth,
  SectionHead,
  StatusLine,
  Tabs,
  Tag,
} from "../ui/basics.tsx";
import { InlineCode } from "../ui/inline-code.tsx";
import { Layer, MenuItem, Tip, useToast } from "../ui/layers.tsx";
import { CodePath } from "../ui/path.tsx";
import { Sha, ShaWords } from "../ui/sha.tsx";
import { liveLog, logSummary } from "../view-model/activity.ts";
import {
  checkedBy,
  confirmDetails,
  confirmLabels,
  foundByLine,
  howItRan,
  severityLabel,
} from "../view-model/confirm.ts";
import {
  doneLine,
  edgeNeedsYou,
  type FindingTab,
  findingGroups,
  findingMeta,
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
import { agoSentence, duration, plural, SEPARATOR } from "../view-model/format.ts";
import { postedAs } from "../view-model/github.ts";
import { roundRow } from "../view-model/rounds.ts";
import { runLineParts, runSteps } from "../view-model/run.ts";
import {
  CHIPS,
  type ChangeReview,
  canReviewAgain,
  changeLabel,
  changeReviewAt,
  differences,
  failedNotice,
  gitHubPrimary,
  lookedOver,
  nextStep,
  notReviewed,
  openVerdict,
  REVIEW_BUTTON,
  type ReviewButton,
  reviewAgainNote,
  reviewButton,
  reviewButtonPrimary,
  reviewerOf,
  reviewMeta,
  settledVerdict,
  status,
  unsettledFindings,
  waitNotice,
} from "../view-model/select.ts";
import { cancelSentence, type DisplayStatus, detailsShown, outcomeEyes } from "../view-model/status.ts";
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
  const edge = edgeNeedsYou(it.review, finding);
  return (
    // "Needs you" is the banner's, said once (ADR 0083, round 6); where the banner can't say which, or isn't there,
    // the edge marks the card, and its heading says it to a screen reader: colour alone is no answer.
    <Card className={edge ? "finding need" : "finding"}>
      {/* The severity opens the title's line, as on a closed finding's row (design-system.md "Finding card"). */}
      <h5>
        {edge ? <span className="visually-hidden">{asSentence(CHIPS["needs-you"].label)} </span> : null}
        <span className={`sev ${finding.severity === "blocking" ? "" : "fix"}`}>
          {/* A space, read as one ("Blocking SQL injection…"); its width is part of the gap the margin makes. */}
          {severityLabel(finding)}{" "}
        </span>
        <InlineCode text={finding.title} />
      </h5>
      {/* The meta line and the file read as one block under the title (`.finding-meta`). */}
      <div className="finding-meta">
        <div className="t">
          <span>{findingMeta(finding)}</span>
        </div>
        <div className="t">
          <Tag>
            <CodePath text={finding.file} kind="path" />
          </Tag>
          <span>{placeText(finding)}</span>
        </div>
      </div>
      <p>
        <InlineCode text={finding.body} />
      </p>
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
          {checked.said.length > 0 ? " " : null}
          {checked.said.map((part, i) =>
            typeof part === "string" ? (
              <Fragment key={i}>{part}</Fragment>
            ) : (
              <CodePath key={i} text={part.cite} kind="path" tight={part.tight} />
            ),
          )}
          {checked.under.map((line, i) => (
            <CodePath key={`${i}-${line}`} text={line} kind="path" line />
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
    <div className="rowi static nolead">
      <div className="rowi-main">
        <div className="ti">
          <span className={`sev-label ${finding.severity === "blocking" ? "" : "fix"}`}>
            {severityLabel(finding)}{" "}
          </span>
          <InlineCode text={finding.title} />
        </div>
        <div className="me">
          {line.kind === "verified" ? (
            <span>
              <ShaWords words={line.words} />
            </span>
          ) : (
            <span className="wrap">{line.text}</span>
          )}
        </div>
      </div>
      <span className="ac" />
    </div>
  );
}

/** A verdict card's class: `verdict`, then its eyes' tone where the outcome has one (`outcomeEyes`). */
function verdictClass(s: DisplayStatus): string {
  const tone = outcomeEyes(s);
  return tone === null ? "verdict" : `verdict ${tone}`;
}

function NotReviewed({ it }: { it: ChangeReview }) {
  const card = notReviewed(it);
  if (!card) return null;
  const { why } = card;
  return (
    <Card className={verdictClass(status(it))}>
      <Eyes still />
      <b>Not reviewed: {card.title}.</b>
      <Disclosure summary="Why wasn't it reviewed?">
        <p>
          {why.text}
          {why.ask ? (
            <>
              {" "}
              {why.ask.lead} <CodePath text={why.ask.command} /> {why.ask.tail}
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

/**
 * The newest review failed (ADR 0081): on which commit and why; under them, when, then what would change it where
 * another try can't help, or what another try may do where that is known, the page's one primary above saying "Try
 * again" (round 6, 2026-11-08: the commit ran into its time, the cause read as left to the log). Above the round when
 * there was one, which the verdict still shows. No action of its own: Details › Log, below, is the way to the log
 * (round 4, 2026-11-08: a "Show the log" here was a second way to it).
 */
function FailedNotice({ it, state }: { it: ChangeReview; state: State }) {
  const failed = failedNotice(it, state.now);
  if (!failed) return null;
  const more = [failed.when, failed.next].filter((part) => part !== null);
  return (
    <Notice label="Failed">
      <ShaWords words={[...failed.head, ". "]} />
      {failed.sentence}
      {/* Under the cause, apart from the commit: when, then what would change it or what another try may do. */}
      {more.length === 0 ? null : <span className="failed-more">{more.join(SEPARATOR)}</span>}
    </Notice>
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
      // Before any round, the failure is all there is to say, and `FailedNotice` says it, as after a round.
      return null;
    case "cancelled":
      return (
        <Card className={verdictClass(s)}>
          <Eyes still />
          <span>
            <b>This review was cancelled.</b> {cancelSentence(s.reason)}
          </span>
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
    case "not-asked":
      return <NotReviewed it={it} />;
    case "settled":
      return <SettledVerdict it={it} state={state} clean={s.clean} />;
    case "to-fix":
    case "preview":
      return <OpenVerdict it={it} />;
  }
}

/**
 * A settled review's verdict: the commit it looked over, then nothing to fix, or what it closed and what stays here.
 */
function SettledVerdict({ it, state, clean }: { it: ChangeReview; state: State; clean: boolean }) {
  const { review } = it;
  // Only posted findings count (I-152): one kept off the pull request stays here, open, once the loop settles.
  const verdict = settledVerdict(review);
  const className = verdictClass(status(it));
  return clean ? (
    <Card className={className}>
      <Eyes still />
      <span>
        <b>
          Looked over <Sha sha={lookedOver(it)} tight />. Nothing to fix.
        </b>
        <span className="t-small"> {agoSentence(state.now, review.updatedAt)}</span>
      </span>
    </Card>
  ) : (
    <Card className={className}>
      <Eyes still />
      <span>
        <b>
          Looked over <Sha sha={lookedOver(it)} tight />. {verdict.closed}
        </b>
        <span className="t-small t-help"> {verdict.rest}</span>
      </span>
    </Card>
  );
}

/**
 * Findings left open: to fix once posted, found after a preview (ADR 0072). It opens with the eyes as every outcome
 * does, amber while there is something to fix (`outcomeEyes`).
 */
function OpenVerdict({ it }: { it: ChangeReview }) {
  return (
    <Card className={verdictClass(status(it))}>
      <Eyes still />
      <span>
        <b>
          <ShaWords words={openVerdict(it)} />
        </b>
        <span className="t-small t-help"> {nextStep(it)}</span>
      </span>
    </Card>
  );
}

function Details({ it, state }: { it: ChangeReview; state: State }) {
  const { review, repo } = it;
  const { run } = review;
  const diffs = differences(repo);
  const strictness = repo.settings.strictness.value;
  const log = review.timeline.map((t) => logLine(t, state.now));
  // The running round counts here, as a row of the table still running.
  const sha = run?.sha ?? review.rounds.at(-1)?.sha;
  // Before any round, only a failed review has Details: its settings and its log, without how it ran.
  if (!detailsShown(review)) return null;
  return (
    <>
      <SectionHead>Details</SectionHead>
      <div className="list">
        {sha ? <HowItRan it={it} state={state} sha={sha} /> : null}
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
          <p className="t-small t-help">
            {diffs.length > 0 ? `${repo.name} differs from your defaults. ` : "Your defaults were used. "}
            <Link to={`/repositories/${repo.owner}/${repo.name}`}>See what applies to {repo.name}</Link>
          </p>
        </Disclosure>
        <Disclosure row summary="Log" value={logSummary(log.length, run)}>
          <div className="stack">
            <Group title="History">
              <Code start={1} lines={log} log />
            </Group>
            <Group title="Live">
              <LiveLog {...liveLog(run)} />
            </Group>
          </div>
        </Disclosure>
      </div>
    </>
  );
}

/** Details' first rows, once a round ran or runs: how the review ran, and its rounds, `sha` the newest's commit. */
function HowItRan({ it, state, sha }: { it: ChangeReview; state: State; sha: CommitSha }) {
  const { review } = it;
  const { run } = review;
  const checks = confirmDetails(review);
  const labels = confirmLabels(review);
  return (
    <>
      <Disclosure row summary="How this review ran" value={howItRan(review)}>
        <dl>
          <dt>Started by</dt>
          <dd>{startedBy(review.timeline)}</dd>
          <dt>{labels.found}</dt>
          <dd>{foundByLine(review, state.engines)}</dd>
          {checks ? (
            <>
              <dt>{labels.checked}</dt>
              <dd>
                {checks.checked.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </dd>
            </>
          ) : null}
          {checks && checks.ruledOut.length > 0 ? (
            <>
              <dt>{labels.ruledOut}</dt>
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
              // The person's login is never broken at a hyphen: the line wraps before it.
              <>
                As <span className="nowrap">{postedAs(state.connection)}</span>, with a check on{" "}
                <Sha sha={sha} />
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
            {review.rounds.length + (run ? 1 : 0)}
            {SEPARATOR}last commit <Sha sha={sha} />
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
                      <Sha sha={row.commit} />
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
                    <Sha sha={run.sha} />
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
        <span>{reviewMeta(change, reviewerName)}</span>
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

/**
 * The review button's place: one width through its labels, so the buttons after it never move (#279). The filled
 * primary only when pressing it is what the person is needed for (`reviewButtonPrimary`), else a secondary. While a
 * review runs or waits, a status stands there, never a dimmed button; its words are announced by one visually
 * hidden status line beside it, as the hidden slots that keep the width can't be.
 */
export function ReviewButtonPlace({
  shown,
  primary,
  again,
}: {
  shown: ReviewButton;
  primary: boolean;
  again: (() => void) | undefined;
}) {
  const busy = shown === "running" || shown === "waiting";
  const variant = primary ? "primary" : "secondary";
  return (
    <>
      <SameWidth
        shown={shown}
        labels={{
          now: (
            <Button variant={variant} kbd="R" onClick={again}>
              {REVIEW_BUTTON.now}
            </Button>
          ),
          again: (
            <Button variant={variant} kbd="R" onClick={again}>
              {REVIEW_BUTTON.again}
            </Button>
          ),
          retry: (
            <Button variant={variant} kbd="R" onClick={again}>
              {REVIEW_BUTTON.retry}
            </Button>
          ),
          running: <BusyStatus tone="run">{REVIEW_BUTTON.running}</BusyStatus>,
          waiting: <BusyStatus tone="wait">{REVIEW_BUTTON.waiting}</BusyStatus>,
        }}
      />
      <StatusLine>{busy ? REVIEW_BUTTON[shown] : ""}</StatusLine>
    </>
  );
}

function ReviewActions({ it, again, copy }: ReviewActionsProps) {
  const state = useAppState();
  const shown = reviewButton(it);
  const busy = shown === "running" || shown === "waiting";
  const note = again ? reviewAgainNote(state) : null;
  return (
    <div className="rv-acts">
      {copy ? (
        <Button kbd="C" onClick={copy}>
          Copy a fix prompt for my agent
        </Button>
      ) : null}
      {/* Just before Open on GitHub in every round, so "Reviewing…", at its place's end, stands beside it, never
          beside Copy with the room it holds read as an indent (round 6, 2026-11-08); held, so nothing moves. */}
      {busy || again ? (
        <ReviewButtonPlace shown={shown} primary={reviewButtonPrimary(it)} again={again} />
      ) : null}
      {/* A review that needs the person: Open on GitHub is the primary, where they settle the thread. */}
      <GitHubButton change={it.change} kbd="G" variant={gitHubPrimary(it) ? "primary" : "secondary"}>
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
      <FailedNotice it={it} state={state} />
      <Verdict it={it} state={state} />
      <Findings it={it} />
      <Details it={it} state={state} />
    </Page>
  );
}
