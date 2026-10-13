// The one reducer: every change to the state is an event applied here.
// The service's truth is its store: it builds the snapshot by applying the store's event log here. The UI applies
// the same events to its copy.
// Events carry the job, run, findings and loop they result in: `apply` records them and decides nothing.
// The timeline it keeps is data (what happened, and the facts to say it); the words are the UI's.

import { RUN_ACTIVITIES_KEPT } from "./activity.ts";
import type { Change } from "./change.ts";
import type { Event } from "./event.ts";
import type { ChangeId } from "./ids.ts";
import { type ReviewJob, sameDeferral } from "./job.ts";
import type { Review, TimelineEntry } from "./review.ts";
import { type Run, stepsDone } from "./run.ts";
import { furthestReached } from "./setup.ts";
import type { State } from "./state.ts";

export function emptyReview(changeId: ChangeId, at: number): Review {
  return {
    changeId,
    job: null,
    run: null,
    loop: null,
    rounds: [],
    findings: [],
    preview: false,
    updatedAt: at,
    timeline: [],
  };
}

/** The change's review, updated; a closed change's too (its running review still finishes, and the store keeps it). */
function withReview(state: State, changeId: ChangeId, at: number, update: (review: Review) => Review): State {
  const review = state.reviews[changeId];
  if (!review) return state;
  return {
    ...state,
    reviews: { ...state.reviews, [changeId]: { ...update(review), updatedAt: at } },
  };
}

/** What the timeline gains when a job changes: what asked for a new one, why a job waits or was skipped. */
function jobEntries(before: ReviewJob | null, job: ReviewJob, at: number): TimelineEntry[] {
  const fresh = before?.id !== job.id;
  if (job.state === "skipped") {
    return before?.state === "skipped" && !fresh ? [] : [{ at, sha: null, kind: "skipped" }];
  }
  const out: TimelineEntry[] = fresh ? [{ at, sha: null, kind: "queued", trigger: job.trigger }] : [];
  const said = fresh ? null : (before?.deferral ?? null);
  if (job.deferral && !sameDeferral(job.deferral, said)) {
    out.push({ at, sha: null, kind: "deferred", deferral: job.deferral });
  }
  return out;
}

type Of<T extends Event["type"]> = Extract<Event, { type: T }>;

function jobChanged(s: State, event: Of<"job.changed">): State {
  return withReview(s, event.changeId, event.at, (r) => ({
    ...r,
    job: event.job,
    run: event.job.state === "running" ? r.run : null,
    timeline: [...r.timeline, ...jobEntries(r.job, event.job, event.at)],
  }));
}

function runStarted(s: State, event: Of<"run.started">): State {
  return withReview(s, event.changeId, event.at, (r) => ({
    ...r,
    job: event.job,
    run: event.run,
    preview: event.run.preview,
    timeline: [
      ...r.timeline,
      { at: event.at, sha: event.run.sha, kind: "started", round: r.rounds.length + 1 },
    ],
  }));
}

function runStep(s: State, event: Of<"run.step">): State {
  return withReview(s, event.changeId, event.at, (r) => ({
    ...r,
    run: r.run ? { ...r.run, steps: stepsDone(r.run, event.at), step: event.step, stepAt: event.at } : null,
  }));
}

/**
 * The change's running run, updated; nothing happens when no run goes. The review's `updatedAt` stays: activities
 * and the outbox move up to once a second, and Home orders its rows by it ("Nothing shifts").
 */
function withRun(state: State, changeId: ChangeId, update: (run: Run) => Run): State {
  const review = state.reviews[changeId];
  if (!review?.run) return state;
  return { ...state, reviews: { ...state.reviews, [changeId]: { ...review, run: update(review.run) } } };
}

function roundFinished(s: State, event: Of<"round.finished">): State {
  const { round } = event;
  const next = withReview(s, event.changeId, event.at, (r) => ({
    ...r,
    job: event.job,
    run: null,
    rounds: [...r.rounds, round],
    findings: event.findings,
    loop: event.loop,
    preview: event.preview,
    timeline: [
      ...r.timeline,
      { at: event.at, sha: round.sha, kind: "posted", round: round.n, open: round.open },
    ],
  }));
  // The round moved its repository's "Too noisy?" counts (ADR 0049), its change still open or closed meanwhile.
  const { noise } = event;
  const counted =
    noise === undefined
      ? next
      : {
          ...next,
          repos: next.repos.map((r) => (r.id === noise.repoId ? { ...r, noise: noise.counts } : r)),
        };
  const change = counted.changes[event.changeId];
  if (!change) return counted;
  return {
    ...counted,
    changes: { ...counted.changes, [change.id]: { ...change, newCommits: event.newCommits } },
  };
}

function findingDismissed(s: State, event: Of<"finding.dismissed">): State {
  return withReview(s, event.changeId, event.at, (r) => ({
    ...r,
    findings: event.findings,
    loop: event.loop,
    timeline: [...r.timeline, { at: event.at, sha: null, kind: "dismissed", findingIds: event.findingIds }],
  }));
}

function changeOpened(s: State, event: Of<"change.opened">): State {
  const { change } = event;
  const shown = s.changes[change.id];
  if (shown) {
    // A draft marked ready: what the host shows now, over what Lookover kept of it.
    const next: Change = { ...change, openedAt: shown.openedAt, newCommits: shown.newCommits };
    return { ...s, changes: { ...s.changes, [change.id]: next } };
  }
  // New, or reopened: a reopened change goes on with the review it had, as the store goes on with its rounds.
  const kept = s.reviews[change.id] ?? emptyReview(change.id, event.at);
  const review: Review = {
    ...kept,
    updatedAt: event.at,
    timeline: [...kept.timeline, { at: event.at, sha: change.headSha, kind: "opened", by: change.openedBy }],
  };
  return {
    ...s,
    changes: { ...s.changes, [change.id]: change },
    reviews: { ...s.reviews, [change.id]: review },
  };
}

/** A closed change leaves the list; its review is kept, for a round still running and for a reopening. */
function changeClosed(s: State, event: Of<"change.closed">): State {
  const { [event.changeId]: _change, ...changes } = s.changes;
  return { ...s, changes };
}

/**
 * A repository gone from the installation leaves with its open changes and its rules, and the setup's first review
 * when that change was one of them; their reviews are kept. It is said departed from then (ADR 0059), once: a
 * repository the copy never held was never shown, so it isn't said either.
 */
function repoRemoved(s: State, event: Of<"repo.removed">): State {
  const changes = Object.fromEntries(
    Object.entries(s.changes).filter(([, change]) => change.repoId !== event.repoId),
  );
  const first = s.setup.firstReviewChange;
  const firstGone = first !== null && s.changes[first]?.repoId === event.repoId;
  const gone = s.repos.find((r) => r.id === event.repoId);
  const departed = s.departed.filter((d) => d.id !== event.repoId);
  return {
    ...s,
    repos: s.repos.filter((r) => r.id !== event.repoId),
    departed:
      gone === undefined
        ? s.departed
        : [...departed, { id: gone.id, owner: gone.owner, name: gone.name, at: event.at }],
    rules: s.rules.filter((r) => r.repoId !== event.repoId),
    changes,
    setup: firstGone ? { ...s.setup, firstReviewChange: null } : s.setup,
  };
}

function changePushed(s: State, event: Of<"change.pushed">): State {
  const change = s.changes[event.changeId];
  if (!change) return s;
  const next = { ...change, headSha: event.sha, newCommits: change.newCommits + event.commits };
  const entry: TimelineEntry = {
    at: event.at,
    sha: event.sha,
    kind: "pushed",
    by: event.by,
    commits: event.commits,
  };
  return withReview(
    { ...s, changes: { ...s.changes, [event.changeId]: next } },
    event.changeId,
    event.at,
    (r) => ({
      ...r,
      timeline: [...r.timeline, entry],
    }),
  );
}

export function apply(state: State, event: Event): State {
  // The service's clock between events (ADR 0046): the stream's keepalive, applied at the last number seen
  // and never stored. It moves `now` forward and nothing else; a clock standing still changes nothing.
  if (event.type === "clock" && event.seq === state.seq)
    return event.at > state.now ? { ...state, now: event.at } : state;
  // Already in the snapshot: an event sent twice, or one older than the snapshot it arrives on. A replacement
  // is taken whatever its number: a reload after a data reset, or one the service asked for because the
  // number was past its end, starts lower (ADR 0038).
  if (event.type !== "state.replaced" && event.seq <= state.seq) return state;
  const s: State = { ...state, seq: event.seq, now: Math.max(state.now, event.at) };
  switch (event.type) {
    case "clock":
      return s;
    case "state.replaced":
      return { ...event.state, seq: event.seq };
    case "setup.changed": {
      const setup = { ...s.setup, ...event.setup };
      return { ...s, setup: { ...setup, reached: furthestReached(setup.reached, setup.step) } };
    }
    case "engine.changed":
      return { ...s, engines: { ...s.engines, [event.id]: { ...s.engines[event.id], ...event.patch } } };
    case "connection.changed":
      return { ...s, connection: { ...s.connection, ...event.patch } };
    case "service.changed":
      return { ...s, service: { ...s.service, ...event.patch } };
    case "settings.changed":
      return {
        ...s,
        settings: event.settings,
        repos: s.repos.map((r) => {
          const settings = event.repos[r.id];
          return settings ? { ...r, settings } : r;
        }),
      };
    case "repo.changed":
      return { ...s, repos: s.repos.map((r) => (r.id === event.repoId ? { ...r, ...event.patch } : r)) };
    case "repo.added":
      return {
        ...s,
        repos: [...s.repos.filter((r) => r.id !== event.repo.id), event.repo],
        departed: s.departed.filter((d) => d.id !== event.repo.id),
      };
    case "repo.removed":
      return repoRemoved(s, event);
    case "repo.dismissed":
      return { ...s, departed: s.departed.filter((d) => d.id !== event.repoId) };
    case "rule.changed":
      return {
        ...s,
        rules: s.rules.map((r) => (r.id === event.ruleId ? { ...r, enabled: event.enabled } : r)),
      };
    case "rules.changed":
      return { ...s, rules: [...s.rules.filter((r) => r.repoId !== event.repoId), ...event.rules] };
    case "change.opened":
      return changeOpened(s, event);
    case "change.closed":
      return changeClosed(s, event);
    case "change.pushed":
      return changePushed(s, event);
    case "job.changed":
      return jobChanged(s, event);
    case "run.started":
      return runStarted(s, event);
    case "run.step":
      return runStep(s, event);
    case "run.activity":
      return withRun(s, event.changeId, (run) => ({
        ...run,
        activities: [...run.activities, ...event.activities].slice(-RUN_ACTIVITIES_KEPT),
      }));
    case "run.posting":
      return withRun(s, event.changeId, (run) => ({ ...run, posting: event.posting }));
    case "round.finished":
      return roundFinished(s, event);
    case "finding.dismissed":
      return findingDismissed(s, event);
  }
}
