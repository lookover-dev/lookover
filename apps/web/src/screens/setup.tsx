// Setup: three steps (your AI, GitHub, repositories), then a real first review, then your coding agent (ADR 0058),
// which ends the setup: reviews in the background, start at login, and "Go to my reviews", whatever was done there.
// No step moves on by itself (ADR 0058): a satisfied step says so, with its Continue enabled, and only the owner's
// click moves it. Going back never loses the way forward: finished steps stay reachable from the top bar.
import {
  type ChangeId,
  type DeviceCode,
  type Engine,
  isCounted,
  type RepositoryId,
  type Review,
  SETUP_ORDER,
  type SetupStep,
} from "@lookover/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp, useAppState, useSend, useStoreStatus } from "../store.tsx";
import {
  Button,
  Card,
  Check,
  Chip,
  Disclosure,
  Icon,
  Mark,
  Notice,
  Radio,
  Said,
  SameWidth,
} from "../ui/basics.tsx";
import { signedIn } from "../view-model/accounts.ts";
import { AGENT_INTRO } from "../view-model/coding-agent.ts";
import {
  type FirstReviewRow,
  firstReviewPick,
  firstReviewPrimary,
  firstReviewRows,
  firstReviewSecondary,
  REVIEWED_CHIPS,
  reviewedLine,
  reviewedLines,
} from "../view-model/first-review.ts";
import { agoSentence, plural } from "../view-model/format.ts";
import {
  aiStepActs,
  aiStepLabels,
  chosenRepos,
  engineSetupNext,
  engineSetupText,
} from "../view-model/onboarding.ts";
import {
  authorLabel,
  type ChangeReview,
  changeLabel,
  changeReviews,
  openChangeCount,
  problems,
} from "../view-model/select.ts";
import { SETUP_REVIEWERS_TEXT } from "../view-model/settings.ts";
import { SIGN_IN_TEXT, signInEnd, signInStep } from "../view-model/sign-in.ts";
import { BACKGROUND_TEXT, backgroundLine, backgroundLines } from "../view-model/start-at-login.ts";
import { AgentRows } from "./coding-agent.tsx";
import { HeldDetail, roundDuration, Sentence, StateSquare, StepList, SubStep } from "./common.tsx";
import { AccountsList, CodeActions, FixButton, GitHubButton } from "./github-app.tsx";

const STEPS: { id: SetupStep; label: string }[] = [
  { id: "ai", label: "Your AI" },
  { id: "github", label: "GitHub" },
  { id: "repos", label: "Repositories" },
  { id: "first-review", label: "First review" },
  { id: "agent", label: "Your coding agent" },
];

const index = (step: SetupStep) => Math.min(SETUP_ORDER.indexOf(step), STEPS.length - 1);

function Steps() {
  const state = useAppState();
  const send = useSend();
  const { step, reached, firstReviewChange } = state.setup;
  const at = index(step);
  const far = index(reached);
  const first = firstReviewChange ? state.reviews[firstReviewChange] : null;
  const firstDone = first?.rounds.some((r) => r.endedAt !== null) ?? false;
  // While the first review runs, the steps wait; before and after, every step reached can be opened.
  const locked = first != null && !firstDone;
  return (
    <nav className="steps" aria-label="Setup steps">
      {STEPS.map((s, i) => (
        <StepsItem
          key={s.id}
          index={i}
          // Done is a fact about the step, whichever step is on screen and whether it can still be opened.
          done={i < far || (s.id === "first-review" && firstDone)}
          current={i === at}
          reachable={i <= far && i !== at && !locked}
          onOpen={() => send({ type: "setup.goto", step: s.id })}
        >
          {s.label}
        </StepsItem>
      ))}
    </nav>
  );
}

function StepsItem({
  index,
  done,
  current,
  reachable,
  onOpen,
  children,
}: {
  index: number;
  done: boolean;
  current: boolean;
  reachable: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  // The marker always takes the same room: a number, then a check in the same place.
  const inside = (
    <>
      <span className="steps-mark">{done ? <Icon name="check" /> : index + 1}</span>
      {children}
    </>
  );
  const cls = `steps-step ${done ? "done" : ""} ${current ? "current" : ""}`;
  return (
    <span className="steps-item">
      {index > 0 ? <i /> : null}
      {reachable ? (
        <button type="button" className={cls} onClick={onOpen}>
          {inside}
        </button>
      ) : (
        <span className={cls} aria-current={current ? "step" : undefined}>
          {inside}
        </span>
      )}
    </span>
  );
}

function EngineRow({ engine }: { engine: Engine }) {
  const send = useSend();
  const ready = engine.state === "ready";
  // A missing AI's next step after the install, the sign-in, on its own line under the service's (#431).
  const next = engineSetupNext(engine);
  return (
    <div className="engine">
      <StateSquare state={ready ? "done" : engine.signingIn ? "busy" : "idle"} />
      <div>
        <b>{engine.name}</b>
        <span>
          {engineSetupText(engine)}
          {next === null ? null : (
            <>
              <br />
              {next}
            </>
          )}
        </span>
      </div>
      {ready ? null : engine.state === "missing" ? (
        <Button size="sm" onClick={() => send({ type: "engine.check" })}>
          Check again
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={engine.signingIn}
          onClick={() => send({ type: "engine.signIn", id: engine.id })}
        >
          {engine.signingIn ? "Waiting…" : "Sign in in a terminal"}
        </Button>
      )}
    </div>
  );
}

function StepAi() {
  const state = useAppState();
  const send = useSend();
  const engines = Object.values(state.engines);
  const acts = aiStepActs(engines);
  const next = () => send({ type: "setup.goto", step: "github" });
  // Every label Continue can take, laid out in one place: it keeps the widest one's width when an AI signs in.
  const labels: Record<string, ReactNode> = {};
  for (const label of aiStepLabels(engines))
    labels[label] = (
      <Button variant="primary" size="lg" disabled={!acts.enabled} onClick={next}>
        {label}
      </Button>
    );

  return (
    <>
      <Sentence
        title="Which AI reviews your code?"
        small="Lookover runs the official Claude and Codex programs on this computer, on your Claude and ChatGPT plans. It never sees your logins."
      />
      {engines.map((e) => (
        <EngineRow key={e.id} engine={e} />
      ))}
      <p className="t-small">{SETUP_REVIEWERS_TEXT}</p>
      <div className="setup-acts">
        <span className="t-small">{acts.said}</span>
        <SameWidth shown={acts.label} labels={labels} />
      </div>
    </>
  );
}

/**
 * The GitHub step, Sign in with GitHub, the one way in (ADR 0066, ADR 0073): the code, copied and GitHub's page opened
 * by one button, the wait, Cancel; then who you are and the accounts reached. The step's one primary starts it, then
 * is its Continue. How a code went without a sign-in is remembered here: the connection only says one waits.
 */
function StepGitHub() {
  const state = useAppState();
  const send = useSend();
  const { store } = useApp();
  const { refusal } = useStoreStatus(store);
  const { connection } = state;
  const [last, setLast] = useState<DeviceCode | null>(connection.signIn);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (connection.signIn === null) return;
    setLast(connection.signIn);
    setCancelled(false);
  }, [connection.signIn]);
  // The code that signed the person in ended nothing: signed out later, the step says that, not how it went.
  const inNow = signedIn(connection);
  useEffect(() => {
    if (inNow) setLast(null);
  }, [inNow]);
  const startRefused = refusal?.command?.type === "connection.signIn" ? (refusal.signIn ?? null) : null;
  const step = signInStep(state, {
    end: signInEnd(last, connection, state.now, cancelled),
    refusal: startRefused,
  });
  const cancel = () => {
    setCancelled(true);
    send({ type: "connection.cancelSignIn" });
  };
  const T = SIGN_IN_TEXT;
  return (
    <>
      <Sentence title={T.title} small={T.lead} />
      <SubStep
        state={step.signIn.state}
        title={T.signIn}
        action={<CodeActions code={step.signIn.code} onCancel={cancel} />}
      >
        <span className="code-whole">
          <HeldDetail shown={step.signIn.text} details={step.signIn.held} />
        </span>
      </SubStep>
      <SubStep
        state={step.accounts.state}
        title={T.accounts}
        below={step.accounts.list.rows.length > 0 ? <AccountsList list={step.accounts.list} /> : null}
      >
        <HeldDetail shown={step.accounts.text} details={step.accounts.held} />
      </SubStep>
      {/* Always there, empty until a refusal: nothing under it moves when one is said or cleared. */}
      <p className="refused-line" role="status">
        {step.refused}
      </p>
      <div className="setup-acts">
        <span className="t-small">{step.done ? T.done : ""}</span>
        <Button variant="ghost" onClick={() => send({ type: "setup.goto", step: "ai" })}>
          Back
        </Button>
        {/* One primary, as wide as both its labels: Sign in with GitHub starts it, then it is the step's Continue. */}
        <SameWidth
          shown={step.primary.label}
          labels={{
            [T.signIn]: (
              <Button
                variant="primary"
                size="lg"
                disabled={!step.primary.enabled}
                onClick={() => send({ type: "connection.signIn" })}
              >
                {T.signIn}
              </Button>
            ),
            [T.continue]: (
              <Button
                variant="primary"
                size="lg"
                disabled={!step.primary.enabled}
                onClick={() => send({ type: "setup.goto", step: "repos" })}
              >
                {T.continue}
              </Button>
            ),
          }}
        />
      </div>
    </>
  );
}

function StepRepos() {
  const state = useAppState();
  const send = useSend();
  // What the owner ticked or unticked here; the rest follows the installation, which GitHub may change meanwhile.
  const [choices, setChoices] = useState<ReadonlyMap<RepositoryId, boolean>>(() => new Map());
  const enabled = new Set(chosenRepos(state.repos, choices));
  const toggle = (id: RepositoryId, on: boolean) => setChoices(new Map(choices).set(id, on));
  return (
    <>
      <Sentence
        title="Pick the repositories to review."
        small="These are the repositories you installed the App on. Untick any it should not review. To add more later, open the App's settings on GitHub, from Repositories."
      />
      <Card className="checklist">
        {state.repos.map((r) => {
          const n = openChangeCount(state, r.id);
          return (
            <Check key={r.id} checked={enabled.has(r.id)} onChange={(on) => toggle(r.id, on)}>
              <b>{r.id}</b>
              <span className="t-small">
                {n === 0 ? "no open pull requests" : plural(n, "open pull request")}
              </span>
            </Check>
          );
        })}
      </Card>
      <p className="t-small">
        <b>Whose pull requests?</b> Yours and your coding agents'. Pull requests from other people are
        skipped, to stay within the Claude and ChatGPT terms.
      </p>
      <Disclosure summary="Why?">
        Your Claude and ChatGPT subscriptions are personal. Using them to review other people's code is
        outside their terms, so Lookover skips those pull requests on purpose.
      </Disclosure>
      <p className="t-small">Recommended settings are used. Everything can be changed later in Settings.</p>
      <div className="setup-acts">
        <Button variant="ghost" onClick={() => send({ type: "setup.goto", step: "github" })}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={enabled.size === 0}
          onClick={() => send({ type: "setup.chooseRepos", enabled: [...enabled] })}
        >
          Continue
        </Button>
      </div>
    </>
  );
}

/** Why the first review is stuck, with its one fix. */
function FirstReviewProblem({ review }: { review: Review }) {
  const state = useAppState();
  const deferral = review.job?.state === "deferred" ? review.job.deferral : null;
  if (!deferral || !("engine" in deferral)) return null;
  const problem = problems({ ...state, setup: { ...state.setup, done: true } }).find(
    (p) => p.id === deferral.engine,
  );
  if (!problem) return null;
  return (
    <Notice busy={problem.busy} action={<FixButton problem={problem} busyLabel="Waiting for the sign-in…" />}>
      <b>{problem.title}.</b> <Said words={problem.detail} />
    </Notice>
  );
}

function firstResult(review: Review): string {
  // A preview posts nothing, so it counts what was found; a posted review counts what the pull request got.
  const counted = review.preview ? review.findings : review.findings.filter(isCounted);
  if (counted.length === 0) return "Nothing to fix.";
  const blocking = counted.filter((f) => f.severity === "blocking").length;
  const where = review.preview ? "found" : "posted";
  return `${plural(counted.length, "finding")} ${where}${blocking > 0 ? `, ${blocking} of them blocking` : ""}.`;
}

function FirstReviewDone({ item }: { item: ChangeReview }) {
  const send = useSend();
  const { change, review } = item;
  return (
    <>
      <p className="first-result">
        <b>
          Done in {roundDuration(review)}. {firstResult(review)}
        </b>{" "}
        {review.preview ? "This was a preview: nothing was posted on GitHub." : null}
      </p>
      <div className="setup-acts">
        {review.preview ? null : <GitHubButton change={change}>Open on GitHub</GitHubButton>}
        <Button variant="primary" size="lg" onClick={() => send({ type: "setup.goto", step: "agent" })}>
          Continue
        </Button>
      </div>
    </>
  );
}

/**
 * The setup's end (ADR 0058): what lets the owner's coding agent run the loop, which they may skip, then reviews
 * going on in the background, start at login, and "Go to my reviews".
 */
function StepAgent() {
  return (
    <>
      <Sentence
        title="Let your coding agent run the loop."
        small={`${AGENT_INTRO} All of this is optional.`}
      />
      <AgentRows place="setup" />
      <BackgroundCard />
    </>
  );
}

/**
 * Reviews keep running in the background: start at login, and the end of setup, which works whatever was done; Back
 * to the first review, as every step has.
 */
function BackgroundCard() {
  const state = useAppState();
  const { mode } = useApp();
  const send = useSend();
  const navigate = useNavigate();
  return (
    <Card className="background-note">
      <h4 className="t-h4">Reviews keep running in the background</h4>
      <p>{BACKGROUND_TEXT}</p>
      <p className="t-small">
        <HeldDetail
          shown={backgroundLine(state.service, mode)}
          details={backgroundLines(state.service, mode)}
        />
      </p>
      <div className="setup-acts">
        <Button variant="ghost" onClick={() => send({ type: "setup.goto", step: "first-review" })}>
          Back
        </Button>
        {/* One width for both labels, so the row keeps its places when it is pressed (#279). */}
        <SameWidth
          shown={state.service.startAtLogin ? "on" : "off"}
          labels={{
            on: (
              <Button variant="ghost" onClick={() => send({ type: "service.startAtLogin", on: false })}>
                Don't start at login
              </Button>
            ),
            off: (
              <Button variant="ghost" onClick={() => send({ type: "service.startAtLogin", on: true })}>
                Start at login after all
              </Button>
            ),
          }}
        />
        <Button
          variant="primary"
          size="lg"
          onClick={() => {
            send({ type: "setup.finish" });
            void navigate("/");
          }}
        >
          Go to my reviews
        </Button>
      </div>
    </Card>
  );
}

function FirstReviewRunning({ item }: { item: ChangeReview }) {
  const state = useAppState();
  const { change, review } = item;
  const done = review.rounds.length > 0;
  return (
    <>
      <Sentence title={`Review of ${changeLabel(change)}`} small={change.title} />
      <FirstReviewProblem review={review} />
      <Card>
        <StepList review={review} state={state} />
      </Card>
      {done ? <FirstReviewDone item={item} /> : null}
    </>
  );
}

function StepFirstReview() {
  const state = useAppState();
  const send = useSend();
  // The rows keep the places they were shown in: a review ending moves none (#425).
  const [shown, setShown] = useState<readonly ChangeId[]>([]);
  const rows = firstReviewRows(state, shown);
  const order = rows.map((row) => row.change.id);
  // What is shown picked follows the list: the pick kept while it is listed and not reviewed, else the first such
  // (one opened on an empty list, the next when the picked one closes or gets reviewed). Kept once shown, so a pull
  // request opened above it never takes it.
  const [kept, setKept] = useState<ChangeId | null>(null);
  const picked = firstReviewPick(rows, kept);
  // Both kept as soon as they differ, during the render (React's adjusting state to a prop), so the next render has
  // them.
  if (order.join(" ") !== shown.join(" ")) setShown(order);
  if (picked !== kept) setKept(picked);
  const firstReview = (preview: boolean) => {
    if (picked) send({ type: "setup.firstReview", changeId: picked, preview });
  };
  /** The one "Review this pull request": the secondary beside Continue, else the step's primary. */
  const reviewThis = (primary: boolean) => (
    <Button
      variant={primary ? "primary" : "secondary"}
      size={primary ? "lg" : "md"}
      onClick={() => firstReview(false)}
    >
      Review this pull request
    </Button>
  );
  const running = state.setup.firstReviewChange
    ? changeReviews(state).find((i) => i.change.id === state.setup.firstReviewChange)
    : null;

  if (running) return <FirstReviewRunning item={running} />;

  return (
    <>
      <Sentence
        title="Try it on a real pull request."
        small="Pick one. The review is posted on GitHub, exactly like every review after this one."
      />
      {rows.length > 0 ? (
        <Card className="checklist">
          {rows.map((row) => (
            <FirstReviewChoice
              key={row.change.id}
              row={row}
              now={state.now}
              picked={picked === row.change.id}
              onPick={() => setKept(row.change.id)}
            />
          ))}
        </Card>
      ) : (
        <Card>
          No open pull request in the repositories you picked. Open one, or go on: the next one is reviewed by
          itself.
        </Card>
      )}
      {/* Held as tall as every line it can show under a list, so a row getting reviewed moves nothing under it. */}
      {rows.length > 0 ? (
        <p className="t-small first-reviewed-line">
          <HeldDetail shown={reviewedLine(rows)} details={reviewedLines(rows)} />
        </p>
      ) : null}
      <div className="setup-acts first-review-acts">
        <Button variant="ghost" onClick={() => send({ type: "setup.goto", step: "repos" })}>
          Back
        </Button>
        {/* One place for the preview and, once a review by itself made Continue the primary, reviewing another
            (ADR 0072): previewing is no longer offered once a review was posted, and the bar never moves. */}
        <SameWidth
          shown={firstReviewSecondary(rows, picked)}
          labels={{
            preview: (
              <Button variant="ghost" disabled={picked === null} onClick={() => firstReview(true)}>
                Preview here only, post nothing
              </Button>
            ),
            review: reviewThis(false),
          }}
        />
        {/* One place as wide as both labels, which never name the pull request: the bar never moves. */}
        <SameWidth
          shown={firstReviewPrimary(rows, picked)}
          labels={{
            review: reviewThis(true),
            "go-on": (
              <Button variant="primary" size="lg" onClick={() => send({ type: "setup.goto", step: "agent" })}>
                Continue
              </Button>
            ),
          }}
        />
      </div>
    </>
  );
}

/**
 * One pull request First review offers (design-system.md "First review's list"): its radio, and on its right, held
 * on every row, the state chip and "Open on GitHub" of one Lookover already reviewed on its head, whose radio is off.
 */
function FirstReviewChoice({
  row,
  now,
  picked,
  onPick,
}: {
  row: FirstReviewRow;
  now: number;
  picked: boolean;
  onPick: () => void;
}) {
  const { change, reviewed, chip } = row;
  // Only the chips a reviewed row can show hold the place, so its width never follows a label that isn't shown.
  const chips: Record<string, ReactNode> = {};
  for (const { tone, label } of REVIEWED_CHIPS) chips[label] = <Chip tone={tone}>{label}</Chip>;
  return (
    <div className={`first-row${reviewed ? " reviewed" : ""}`}>
      <Radio name="first" checked={picked} disabled={reviewed} onChange={onPick}>
        <b>{change.title}</b>
        <span className="t-small">
          {change.repoId} #{change.number} · {authorLabel(change)} · {agoSentence(now, change.openedAt)}
        </span>
      </Radio>
      <span className="first-row-reviewed" aria-hidden={reviewed ? undefined : true}>
        <SameWidth shown={reviewed && chip.label in chips ? chip.label : ""} labels={chips} />
        <GitHubButton change={change} variant="ghost" size="sm">
          Open on GitHub
        </GitHubButton>
      </span>
    </div>
  );
}

export function Setup() {
  const state = useAppState();
  const { step } = state.setup;
  return (
    <div className="app setup">
      <header className="top">
        <span className="mk">
          <Mark />
        </span>
        <Steps />
      </header>
      <main className="page narrow" key={step}>
        {step === "ai" ? (
          <StepAi />
        ) : step === "github" ? (
          <StepGitHub />
        ) : step === "repos" ? (
          <StepRepos />
        ) : step === "first-review" ? (
          <StepFirstReview />
        ) : (
          <StepAgent />
        )}
      </main>
    </div>
  );
}
