// Setup: three steps (your AI, GitHub, repositories), then a real first review, then your coding agent (ADR 0058),
// which ends the setup: reviews in the background, start at login, and "Go to my reviews", whatever was done there.
// No step moves on by itself (ADR 0058): a satisfied step says so, with its Continue enabled, and only the owner's
// click moves it. Going back never loses the way forward: finished steps stay reachable from the top bar.
import {
  type ChangeId,
  type Engine,
  isCounted,
  type RepositoryId,
  type Review,
  SETUP_ORDER,
  type SetupStep,
} from "@lookover/contracts";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { tabWhenTaken } from "../app-tab.ts";
import { isLocked, useApp, useAppState, useSend, useStoreStatus } from "../store.tsx";
import {
  Button,
  Card,
  Check,
  Disclosure,
  Icon,
  LinkButton,
  Mark,
  Notice,
  Radio,
  Said,
  SameWidth,
} from "../ui/basics.tsx";
import { type AppPlaceView, appPlace } from "../view-model/app-place.ts";
import { AGENT_INTRO } from "../view-model/coding-agent.ts";
import { agoSentence, plural } from "../view-model/format.ts";
import {
  aiStepActs,
  aiStepLabels,
  chosenRepos,
  engineSetupText,
  GITHUB_STEP_TEXT,
  githubStep,
  type StepLink,
} from "../view-model/onboarding.ts";
import {
  authorLabel,
  type ChangeReview,
  changeLabel,
  changeReviews,
  firstReviewCandidates,
  openChangeCount,
  problems,
} from "../view-model/select.ts";
import { SETUP_REVIEWERS_TEXT } from "../view-model/settings.ts";
import { BACKGROUND_TEXT, backgroundLine } from "../view-model/start-at-login.ts";
import { AgentRows } from "./coding-agent.tsx";
import { HeldDetail, roundDuration, Sentence, StateSquare, StepList, SubStep } from "./common.tsx";
import { FixButton, GitHubButton, UseAppForm } from "./github-app.tsx";

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
  return (
    <div className="engine">
      <StateSquare state={ready ? "done" : engine.signingIn ? "busy" : "idle"} />
      <div>
        <b>{engine.name}</b>
        <span>{engineSetupText(engine)}</span>
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
      <Disclosure summary="Neither installed?">
        Install Claude Code (<code>npm install -g @anthropic-ai/claude-code</code>) or Codex (
        <code>npm install -g @openai/codex</code>), then sign in. This page checks again by itself.
      </Disclosure>
      <div className="setup-acts">
        <span className="t-small">{acts.said}</span>
        <SameWidth shown={acts.label} labels={labels} />
      </div>
    </>
  );
}

/** The key of no action shown: a sub-step done keeps its action's place, empty. */
const NO_ACTION = "";

/**
 * What a sub-step offers: GitHub's page (or the service's, which posts to it) in a new tab, in a place as wide as every
 * label it can show (`labels`), none shown too, so its detail wraps the same in every state. One that makes the App
 * opens its tab at once, blank, while the click may still open one, and sends it to the page only once the service
 * took the place chosen (`organisation`, ADR 0059): refused, the tab closes and the step says why (`tabWhenTaken`).
 */
function SubStepLink({
  link,
  labels,
  organisation,
}: {
  link: StepLink | null;
  labels: string[];
  organisation: string | null;
}) {
  const send = useSend();
  const createApp = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!link) return;
    event.preventDefault();
    const tab = tabWhenTaken(window.open.bind(window), new URL(link.href, window.location.href).href);
    send({ type: "connection.createApp", organisation }, tab.sent, tab.refused);
  };
  const slots: Record<string, ReactNode> = { [NO_ACTION]: null };
  for (const label of labels)
    slots[label] =
      link?.label === label ? (
        <LinkButton href={link.href} {...(link.createApp ? { onClick: createApp } : {})}>
          {label}
        </LinkButton>
      ) : (
        // Seen nowhere, never focused nor clicked: it only holds the place's width.
        <LinkButton href={link?.href ?? "about:blank"}>{label}</LinkButton>
      );
  return <SameWidth shown={link?.label ?? NO_ACTION} labels={slots} />;
}

/**
 * Where the App is made (design-system.md "Where the App lives"): your own account or an organisation `gh` lists you
 * as an admin of, and the line under them with Check again.
 */
function AppPlace({ place, pick }: { place: AppPlaceView; pick: (organisation: string | null) => void }) {
  const send = useSend();
  return (
    <div className="app-place">
      {place.options.map((option) => (
        <Radio
          key={option.organisation ?? ""}
          name="app-place"
          checked={option.organisation === place.chosen}
          disabled={!place.enabled}
          onChange={() => pick(option.organisation)}
        >
          <b>{option.label}</b>
          <span className="t-small">{option.detail}</span>
        </Radio>
      ))}
      {/* The room kept for the organisations gh may list: seen nowhere, as tall as an option. */}
      {Array.from({ length: place.spare }, (_, i) => {
        const [own] = place.options;
        return (
          <div key={`spare-${i}`} className="check app-place-spare" aria-hidden="true">
            <span>
              <b>{own?.label}</b>
              <span className="t-small">{own?.detail}</span>
            </span>
          </div>
        );
      })}
      <div className="app-place-line">
        <span className="t-small">
          <HeldDetail shown={place.line} details={place.held} />
        </span>
        {/* Its place kept once the App is made: nothing is left to check, and nothing beside it moves. */}
        <Button
          size="sm"
          className={place.enabled ? "" : "hidden"}
          aria-hidden={!place.enabled}
          tabIndex={place.enabled ? 0 : -1}
          onClick={() => send({ type: "gh.check" })}
        >
          Check again
        </Button>
      </div>
    </div>
  );
}

function StepGitHub() {
  const state = useAppState();
  const send = useSend();
  const { store } = useApp();
  // "Create it on GitHub" refused: the service sends `answer.createApp` beside `error` (refusal.ts reads it).
  const { refusal } = useStoreStatus(store);
  const step = githubStep(state, refusal?.createApp ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  const place = appPlace(state.connection, picked);
  // The person's `gh` read as the step shows (ADR 0059): the places it offers. Never the unlock dialog's first ask.
  useEffect(() => {
    if (!isLocked(store.get())) void store.send({ type: "gh.check" });
  }, [store]);
  const T = GITHUB_STEP_TEXT;
  const [otherComputer, existing] = T.disclosures;
  return (
    <>
      <Sentence title={T.title} small={T.lead} />
      <SubStep
        state={step.create.state}
        title={T.create}
        action={
          <SubStepLink link={step.create.action} labels={step.create.labels} organisation={place.chosen} />
        }
        below={<AppPlace place={place} pick={setPicked} />}
      >
        <HeldDetail shown={step.create.text} details={step.create.held} />
      </SubStep>
      <SubStep
        state={step.access.state}
        title={T.access}
        action={
          <SubStepLink link={step.access.action} labels={step.access.labels} organisation={place.chosen} />
        }
      >
        <HeldDetail shown={step.access.text} details={step.access.held} />
      </SubStep>
      {/* Always there, empty until a refusal: nothing under it moves when one is said or cleared. */}
      <p className="refused-line" role="status">
        {step.refused}
      </p>
      <div className="disc-group">
        <Disclosure summary={otherComputer.summary}>{otherComputer.body}</Disclosure>
        <Disclosure summary={existing.summary}>
          <p>{existing.body}</p>
          <UseAppForm appId={state.connection.app?.id ?? null} />
        </Disclosure>
      </div>
      <div className="setup-acts">
        <span className="t-small">{step.done ? T.done : ""}</span>
        <Button variant="ghost" onClick={() => send({ type: "setup.goto", step: "ai" })}>
          Back
        </Button>
        {/* Always there, enabled once the step is done: setup waits for it (ADR 0058), and nothing beside it moves. */}
        <Button
          variant="primary"
          size="lg"
          disabled={!step.done}
          onClick={() => send({ type: "setup.goto", step: "repos" })}
        >
          Continue
        </Button>
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
      <b>{problem.title}.</b> {problem.detail}
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
        <Said words={backgroundLine(state.service, mode)} />
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
  const candidates = firstReviewCandidates(state);
  const [picked, setPicked] = useState<ChangeId | null>(candidates[0]?.change.id ?? null);
  const firstReview = (preview: boolean) => {
    if (picked) send({ type: "setup.firstReview", changeId: picked, preview });
  };
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
      {candidates.length > 0 ? (
        <Card className="checklist">
          {candidates.map(({ change }) => (
            <Radio
              key={change.id}
              name="first"
              checked={picked === change.id}
              onChange={() => setPicked(change.id)}
            >
              <b>{change.title}</b>
              <span className="t-small">
                {change.repoId} #{change.number} · {authorLabel(change)} ·{" "}
                {agoSentence(state.now, change.openedAt)}
              </span>
            </Radio>
          ))}
        </Card>
      ) : (
        <Card>
          No open pull request in the repositories you picked. Open one, or go on: the next one is reviewed by
          itself.
        </Card>
      )}
      <div className="setup-acts">
        <Button variant="ghost" onClick={() => send({ type: "setup.goto", step: "repos" })}>
          Back
        </Button>
        {candidates.length > 0 ? (
          <>
            <Button variant="ghost" onClick={() => firstReview(true)}>
              Preview here only, post nothing
            </Button>
            {/* The label never names the pull request: the bar must not move when the choice changes. */}
            <Button variant="primary" size="lg" onClick={() => firstReview(false)}>
              Review this pull request
            </Button>
          </>
        ) : (
          <Button variant="primary" size="lg" onClick={() => send({ type: "setup.goto", step: "agent" })}>
            Continue
          </Button>
        )}
      </div>
    </>
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
