// Setup: three steps (your AI, GitHub, repositories), then a real first review, then your coding agent (ADR 0058),
// which ends the setup: reviews in the background, start at login, and "Go to my reviews", whatever was done there.
// No step moves on by itself (ADR 0058): a satisfied step says so, with its Continue enabled, and only the owner's
// click moves it. Going back never loses the way forward: finished steps stay reachable from the top bar.
import {
  type ChangeId,
  type DeviceCode,
  type Engine,
  isCounted,
  type Review,
  SETUP_ORDER,
  type SetupStep,
} from "@lookover/contracts";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp, useAppState, useHeld, useRepositoriesBar, useSend, useStoreStatus } from "../store.tsx";
import {
  Button,
  Card,
  Check,
  Chip,
  Disclosure,
  Empty,
  Icon,
  Mark,
  Notice,
  Radio,
  Said,
  SameWidth,
  Search,
} from "../ui/basics.tsx";
import { FoldRows } from "../ui/fold.tsx";
import { Tip } from "../ui/layers.tsx";
import { SetupTicks, signedIn } from "../view-model/accounts.ts";
import { AGENT_INTRO } from "../view-model/coding-agent.ts";
import { CollapsedGroups } from "../view-model/collapsed.ts";
import {
  type FirstReviewRow,
  firstReviewMeta,
  firstReviewPick,
  firstReviewPrimary,
  firstReviewRows,
  firstReviewSecondary,
  OPEN_ON_GITHUB,
  REVIEWED_CHIPS,
  reviewedLine,
  titleEnd,
} from "../view-model/first-review.ts";
import { plural } from "../view-model/format.ts";
import {
  aiStepActs,
  aiStepLabels,
  ENGINE_SETUP_LABELS,
  engineSetupAction,
  engineSetupNext,
  engineSetupText,
} from "../view-model/onboarding.ts";
import { REPOSITORIES_BAR, RepositoriesChoice, setupRepoList } from "../view-model/repositories.ts";
import { type ChangeReview, changeLabel, changeReviews, problems } from "../view-model/select.ts";
import { SETUP_REVIEWERS_TEXT } from "../view-model/settings.ts";
import { SIGN_IN_TEXT, signInEnd, signInStep } from "../view-model/sign-in.ts";
import { BACKGROUND_TEXT, backgroundLine } from "../view-model/start-at-login.ts";
import { engineMark } from "../view-model/state-square.ts";
import { CodingAgent } from "./coding-agent.tsx";
import { roundDuration, Sentence, StateSquare, StepList, SubStep } from "./common.tsx";
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

function EngineRow({ engine, now }: { engine: Engine; now: number }) {
  // A missing AI's next step after the install, the sign-in, on its own line under the service's (#431).
  const next = engineSetupNext(engine);
  return (
    <div className="engine">
      <StateSquare state={engineMark(engine)} />
      <div>
        <b>{engine.name}</b>
        <span>
          {engineSetupText(engine, now)}
          {next === null ? null : (
            <>
              <br />
              {next}
            </>
          )}
        </span>
      </div>
      <EngineAction engine={engine} />
    </div>
  );
}

/**
 * The row's one action, in a place as wide as every label it can take, kept, empty, when there is none: the line
 * beside it wraps the same in every state (design-system.md, "Setup's AI row action").
 */
function EngineAction({ engine }: { engine: Engine }) {
  const send = useSend();
  const action = engineSetupAction(engine);
  const labels: Record<string, ReactNode> = { "": null };
  for (const label of ENGINE_SETUP_LABELS)
    labels[label] = (
      <Button
        size="sm"
        disabled={action?.label !== label || !action.enabled}
        onClick={() => action !== null && send(action.command)}
      >
        {label}
      </Button>
    );
  return <SameWidth shown={action?.label ?? ""} labels={labels} />;
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
        <EngineRow key={e.id} engine={e} now={state.now} />
      ))}
      <p className="t-small t-help">{SETUP_REVIEWERS_TEXT}</p>
      {/* Continue alone: the cards say which AI is ready, and its label which it goes on with. */}
      <div className="setup-acts">
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
        todo="sign-in"
        title={T.signIn}
        action={<CodeActions code={step.signIn.code} onCancel={cancel} />}
      >
        <Said words={step.signIn.text} />
      </SubStep>
      <SubStep
        state={step.accounts.state}
        todo="install"
        title={T.accounts}
        below={step.accounts.list.rows.length > 0 ? <AccountsList list={step.accounts.list} /> : null}
      >
        {step.accounts.text}
      </SubStep>
      <div className="setup-acts">
        {/* Against the primary it is about: a refusal of a sign-in it started, else the step satisfied. Always there,
            as tall as it says, beside buttons taller than its two lines (on a phone, under them), so nothing moves
            when one is said or cleared (ADR 0086). */}
        <p className={`setup-said ${step.refused === null ? "t-small" : "refused-line"}`} role="status">
          {step.refused ?? (step.done ? T.done : "")}
        </p>
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

/**
 * One visit of setup's Repositories step: what the owner ticked or unticked there (the rest follows the installation,
 * which GitHub may change meanwhile) and, past ten repositories (ADR 0082, 0083), Repositories' search and the groups
 * folded or opened from their head, each first as Repositories' rule starts it (a group of more than ten folded; round
 * 6), kept so while the step is shown.
 */
export interface SetupReposVisit {
  ticks: SetupTicks;
  choice: RepositoriesChoice;
  folded: CollapsedGroups;
}

export const setupReposVisit = (): SetupReposVisit => ({
  ticks: new SetupTicks(),
  choice: new RepositoriesChoice(),
  folded: new CollapsedGroups(),
});

function StepRepos() {
  const [visit] = useState(setupReposVisit);
  return <StepReposOn visit={visit} />;
}

/** Setup's Repositories step on one `visit` of it (design-system.md "Setup's grouped checklist"). */
export function StepReposOn({ visit }: { visit: SetupReposVisit }) {
  const { ticks, choice, folded } = visit;
  const state = useAppState();
  const send = useSend();
  const groupId = useId();
  const chosen = useHeld(choice);
  const list = setupRepoList(state, useHeld(ticks), {
    shown: useRepositoriesBar(),
    choice: chosen,
    collapsed: useHeld(folded),
  });
  // Each group's first fold, held the first time it shows: one growing past ten while shown never folds by itself.
  useEffect(() => folded.remember(list.firstFolds), [folded, list.firstFolds]);
  const large = list.searchable;
  return (
    <>
      <Sentence
        title="Pick the repositories to review."
        small="These are the repositories you installed the App on. Untick an account, or any repository, it should not review. To add more later, open the App's settings on GitHub, from Repositories."
      />
      {large ? (
        <Search
          placeholder={REPOSITORIES_BAR.search}
          aria-label={REPOSITORIES_BAR.search}
          value={chosen.query}
          onChange={(e) => choice.search(state, e.target.value)}
        />
      ) : null}
      {list.empty ? (
        <Empty title={list.empty.title}>{list.empty.text}</Empty>
      ) : (
        <Card className={large ? "checklist checklist-large" : "checklist"}>
          {list.groups.map(({ group: g, collapsed }) => {
            const login = `${groupId}-${g.key}`;
            // Past ten, on the account's head band: its name and how many of it are ticked, on one line.
            const head = large ? (
              <>
                <b id={login} className="group-band-name">
                  {g.key}
                </b>
                <span id={`${login}-count`} className="group-band-count">
                  {/* As wide as every count it may say, as tall as the one it says: a tick changes no width. */}
                  <SameWidth shown={g.count} labels={Object.fromEntries(g.counts.map((c) => [c, c]))} />
                </span>
              </>
            ) : (
              <>
                <b id={login}>{g.key}</b>
                <span id={`${login}-count`} className="t-small">
                  {g.size}
                </span>
              </>
            );
            const { control } = g;
            const box =
              control === null ? (
                <div className="checklist-head">
                  <span>{head}</span>
                </div>
              ) : (
                <Check
                  checked={g.ticked === "all"}
                  mixed={g.ticked === "some"}
                  label={control.label}
                  // Its count read after its name: "29 of 30 to review" past ten, its size before.
                  describedBy={`${login}-count`}
                  onChange={(on) => ticks.tick(control.repoIds, on)}
                >
                  {head}
                </Check>
              );
            return (
              // A group named by its account, not a landmark: S19 has four of them.
              <div key={g.key} className="checklist-group" role="group" aria-labelledby={login}>
                {large ? (
                  // The account's head band: the chevron that collapses the group, then the account's box.
                  <div className="checklist-band group-band">
                    <button
                      type="button"
                      className="group-toggle"
                      aria-label={g.toggleLabel}
                      aria-expanded={!collapsed}
                      onClick={() =>
                        list.searching ? choice.collapseInSearch(g.key) : folded.toggle(g.key, collapsed)
                      }
                    >
                      <Icon name="next" />
                    </button>
                    {box}
                  </div>
                ) : (
                  box
                )}
                {/* Its rows fold by its chevron (ADR 0087): a search moves none. */}
                <FoldRows open={!collapsed} chosenBy={chosen.held}>
                  {collapsed
                    ? null
                    : g.rows.map(({ repo: r, ticked, open, zero, label }) => (
                        // Shown by its name alone under its account's head; its label names it in full, open pull
                        // requests included. Its count in Repositories' words, zero said too, muted: zero is data.
                        <Check
                          key={r.id}
                          checked={ticked}
                          label={label}
                          onChange={(on) => ticks.tick([r.id], on)}
                        >
                          <b>{r.name}</b>
                          <span
                            className={zero ? "t-small checklist-open open-zero" : "t-small checklist-open"}
                          >
                            {open}
                          </span>
                        </Check>
                      ))}
                </FoldRows>
              </div>
            );
          })}
        </Card>
      )}
      <p className="t-small t-help">
        <b>Whose pull requests?</b> Yours and your coding agents'. Pull requests from other people are
        skipped, to stay within the Claude and ChatGPT terms.
      </p>
      <Disclosure summary="Why?">
        Your Claude and ChatGPT subscriptions are personal. Using them to review other people's code is
        outside their terms, so Lookover skips those pull requests on purpose.
      </Disclosure>
      <p className="t-small t-help">
        Recommended settings are used. Everything can be changed later in Settings.
      </p>
      {/* Past ten, a footer that stays in reach while the list scrolls, saying how many Continue sends. */}
      <div className={large ? "setup-acts setup-acts-footer" : "setup-acts"}>
        {large ? <span className="t-small">{list.count}</span> : null}
        <Button variant="ghost" onClick={() => send({ type: "setup.goto", step: "github" })}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={list.enabled.length === 0}
          onClick={() => send({ type: "setup.chooseRepos", enabled: list.enabled })}
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
        {review.preview ? null : <GitHubButton change={change}>{OPEN_ON_GITHUB}</GitHubButton>}
        <Button variant="primary" size="lg" onClick={() => send({ type: "setup.goto", step: "agent" })}>
          Continue
        </Button>
      </div>
    </>
  );
}

/**
 * The setup's end (ADR 0058): what lets the owner's coding agent run the loop, which they may skip, then reviews
 * going on in the background, and the step's footer, as every step's: Back, start at login, and "Go to my reviews".
 */
function StepAgent() {
  return (
    <>
      <Sentence
        title="Let your coding agent run the loop."
        small={`${AGENT_INTRO} All of this is optional.`}
      />
      <CodingAgent place="setup" />
      <BackgroundCard />
      <AgentActs />
    </>
  );
}

/** "Reviews keep running in the background": the same words whatever is chosen, so the footer under it never moves. */
export function BackgroundCard() {
  return (
    <div className="card background-note">
      <h4 className="card-title">Reviews keep running in the background</h4>
      <p>{BACKGROUND_TEXT}</p>
    </div>
  );
}

/**
 * The setup's last footer: Back to the first review, as every step has; start at login off or on again; and the end
 * of setup, which works whatever was done. Under it, the step's end, what start at login does: the button changes
 * it, and there its growth moves nothing (ADR 0086).
 */
export function AgentActs() {
  const state = useAppState();
  const { mode } = useApp();
  const send = useSend();
  const navigate = useNavigate();
  return (
    <>
      <div className="setup-acts">
        <Button variant="ghost" onClick={() => send({ type: "setup.goto", step: "first-review" })}>
          Back
        </Button>
        {/* One width for both labels, so the row keeps its places when it is pressed (#279). A secondary, outlined: a
          choice, never a link beside Back (round 5). */}
        <SameWidth
          shown={state.service.startAtLogin ? "on" : "off"}
          labels={{
            on: (
              <Button onClick={() => send({ type: "service.startAtLogin", on: false })}>
                Don't start at login
              </Button>
            ),
            off: (
              <Button onClick={() => send({ type: "service.startAtLogin", on: true })}>
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
      <p className="t-small t-help at-login-line">
        <Said words={backgroundLine(state.service, mode)} />
      </p>
    </>
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

export function StepFirstReview() {
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
  /**
   * The one "Review this pull request": a secondary beside Continue, as the preview it replaces, so the bar has one
   * primary and every other choice a button (round 5: as a ghost it read as a link between Back and Continue), else
   * the step's primary.
   */
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
  const reviewed = reviewedLine(rows, picked);

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
              <Button disabled={picked === null} onClick={() => firstReview(true)}>
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
      {/* Under the bar, the step's end, as tall as what it says (ADR 0086): a review landing or another pick may
          grow it, moving nothing about to be clicked. */}
      {reviewed.length > 0 ? (
        <p className="t-small first-reviewed-line">
          {reviewed.map((sentence) => (
            <span key={sentence} className="line-sentence">
              {sentence}
            </span>
          ))}
        </p>
      ) : null}
    </>
  );
}

/**
 * One pull request First review offers (design-system.md "First review's list"): its radio, and, their widths held on
 * every row (never their heights, ADR 0086), the state chip at the end of its title and "Open on GitHub" alone at its
 * right, centred on both lines (its icon alone on a phone), of one Lookover already reviewed on its head, whose radio
 * is off.
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
  const [lead, last] = titleEnd(change.title);
  return (
    <div className={`first-row${reviewed ? " reviewed" : ""}`}>
      <Radio name="first" checked={picked} disabled={reviewed} onChange={onPick}>
        <b>
          {lead}
          {/* The chip's place wraps with the title's last character (its word with it), never onto a line of its own. */}
          <span className="first-row-title-end">
            {last}
            <span className="first-row-chip" aria-hidden={reviewed ? undefined : true}>
              <SameWidth shown={reviewed && chip.label in chips ? chip.label : ""} labels={chips} />
            </span>
          </span>
        </b>
        <span className="t-small">{firstReviewMeta(change, now)}</span>
      </Radio>
      <span className="first-row-reviewed" aria-hidden={reviewed ? undefined : true}>
        {/* Its words at the desktop width; on a phone, which has no room for them, the Icon button: a small square,
            its external icon alone, named by its words and said on hover by its tip (design-system.md "Icon
            button"). Only one of the two is laid out at a time. */}
        <span className="first-row-link-words">
          <GitHubButton change={change} variant="ghost" size="sm">
            {OPEN_ON_GITHUB}
          </GitHubButton>
        </span>
        <span className="first-row-link-icon">
          <Tip text={OPEN_ON_GITHUB} end>
            <GitHubButton change={change} variant="ghost" size="sm" square label={OPEN_ON_GITHUB}>
              {null}
            </GitHubButton>
          </Tip>
        </span>
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
