// The UI's state as a runtime schema (ADR 0085): the shape this version writes, what a start must read its replayed
// log through rather than trust it. Every object `State` reaches has its schema here, each tied exactly to its type
// by `tiedTo`: a field added to a type and not here, an optional one included, fails the typecheck naming that type.
// Written leaves first, in the order of the types they reach. Each section of `State` and each item of its lists and
// records has its own schema, reached through `stateSchema.shape`, so a reader can keep what reads and drop only
// what doesn't.
// Under `exactOptionalPropertyTypes`, a `?:` field is `.exactOptional()`; a branded id is `z.custom`, checked by its
// constructor; an intersection is its union flattened; `Record<EngineId, …>` needs every engine.
import { z } from "zod";
import type { EngineActivity, RunActivity } from "./activity.ts";
import type { Change } from "./change.ts";
import type { FindingClaim } from "./claim.ts";
import type { AgentSkill, CodingAgent, CommandPathState } from "./coding-agent.ts";
import type { Confirmation, ConfirmFailure, ConfirmFallback } from "./confirm.ts";
import type {
  Connection,
  ConnectionAccount,
  ConnectionCause,
  InstallLook,
  UnreachedAccount,
} from "./connection.ts";
import type { Anchoring, DiffSide } from "./diff.ts";
import type { Engine, EngineId, EngineState } from "./engine.ts";
import type { EngineUnusable, EngineUsage } from "./engines-port.ts";
import { enumOf } from "./enum-of.ts";
import type { Finding, Fingerprints, Severity } from "./finding.ts";
import type { AccountCause, HostAccount, HostLogin } from "./github-app.ts";
import type { TransientHostFailure } from "./host.ts";
import {
  type ChangeId,
  type CommitSha,
  type ConnectionId,
  changeId,
  commitSha,
  connectionId,
  type FindingId,
  findingId,
  type JobId,
  jobId,
  type RepositoryId,
  type RunId,
  repositoryId,
  runId,
} from "./ids.ts";
import type { AskedBy, Deferral, JobFailure, ReviewJob, Trigger, Turn } from "./job.ts";
import type { DepartedRepository, NoiseCounts, Repository } from "./repository.ts";
import type { Review, TimelineEntry } from "./review.ts";
import type { CandidateFinding, Round, RoundSession, RuledOut, SecondFind } from "./round.ts";
import { type CitedRule, RULES_FILES, type Rule } from "./rule.ts";
import type { Run, RunPass, RunPosting, RunStep } from "./run.ts";
import type { CheckItem, LoginHolder, LoginItemKind, Service } from "./service.ts";
import type {
  Depth,
  ResolvedSettings,
  Reviewers,
  SettingOrigin,
  SettingsFileError,
  SettingValues,
  Strictness,
} from "./settings.ts";
import type { Setup, SetupGitHub, SetupStep } from "./setup.ts";
import type { State } from "./state.ts";
import { tiedTo } from "./tied-to.ts";

/** A branded id: a string its constructor takes. */
function idOf<I>(make: (value: string) => I) {
  return z.custom<I>((value) => {
    if (typeof value !== "string") return false;
    try {
      make(value);
      return true;
    } catch {
      return false;
    }
  });
}

const changeIdSchema = idOf<ChangeId>(changeId);
const repositoryIdSchema = idOf<RepositoryId>(repositoryId);
const connectionIdSchema = idOf<ConnectionId>(connectionId);
const findingIdSchema = idOf<FindingId>(findingId);
const jobIdSchema = idOf<JobId>(jobId);
const runIdSchema = idOf<RunId>(runId);
const shaSchema = idOf<CommitSha>(commitSha);

// The setup.

const setupStep = enumOf<SetupStep>()(["ai", "github", "repos", "first-review", "agent", "background"]);
const setupGitHub = enumOf<SetupGitHub>()(["start", "waiting-for-install", "nothing-granted", "done"]);

const setupSchema = tiedTo<Setup>()(
  z.object({
    done: z.boolean(),
    step: setupStep,
    reached: setupStep,
    github: setupGitHub,
    firstReviewChange: changeIdSchema.nullable(),
  }),
);

// The engines.

const engineIdSchema = enumOf<EngineId>()(["claude", "codex"]);
const engineState = enumOf<EngineState>()([
  "ready",
  "signed-out",
  "missing",
  "limit",
  "failed-self-test",
  "self-test-unfinished",
]);
const engineUnusable = tiedTo<EngineUnusable>()(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("signed-in-otherwise"), how: z.string() }),
    z.object({ kind: z.literal("npm-launcher") }),
    z.object({ kind: z.literal("too-old"), version: z.string(), model: z.string(), needs: z.string() }),
  ]),
);

const engineSchema = tiedTo<Engine>()(
  z.object({
    id: engineIdSchema,
    name: z.string(),
    cli: z.string(),
    version: z.string().nullable(),
    state: engineState,
    detail: z.string(),
    unusable: engineUnusable.nullable(),
    since: z.number(),
    limitUntil: z.number().nullable(),
    signingIn: z.boolean(),
  }),
);

const enginesSchema = tiedTo<Record<EngineId, Engine>>()(z.record(engineIdSchema, engineSchema));

// The connection.

const hostLogin = tiedTo<HostLogin>()(z.object({ id: z.number(), login: z.string() }));
const hostAccount = tiedTo<HostAccount>()(
  z.object({ id: z.number(), login: z.string(), type: z.enum(["User", "Organization"]) }),
);
const uninstalled = z.object({
  kind: z.literal("uninstalled"),
  suspended: z.boolean(),
  suspendedBy: z.string().exactOptional(),
});
const sso = z.object({ kind: z.literal("sso"), organisation: z.string(), url: z.string().nullable() });
const accountCause = tiedTo<AccountCause>()(z.discriminatedUnion("kind", [uninstalled, sso]));
const connectionCause = tiedTo<ConnectionCause>()(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unreachable") }),
    uninstalled,
    z.object({ kind: z.literal("signed-out") }),
    sso,
  ]),
);
const connectionAccount = tiedTo<ConnectionAccount>()(
  z.object({
    account: hostAccount,
    installationId: z.number(),
    cause: accountCause.nullable(),
    owner: z.boolean().nullable(),
    granted: z.array(repositoryIdSchema),
  }),
);
const unreachedAccount = tiedTo<UnreachedAccount>()(
  z.object({
    account: hostLogin,
    kind: z.enum(["user", "organisation"]),
    owner: z.boolean().nullable(),
    askedAt: z.number().nullable(),
  }),
);
const installLook = tiedTo<InstallLook>()(
  z.object({
    since: z.number(),
    until: z.number(),
    lookedAt: z.number().nullable(),
    ended: z.number().nullable(),
    arrived: z
      .object({ accounts: z.array(z.string()), back: z.array(z.string()), repositories: z.number() })
      .nullable(),
    stopped: z.literal("rate-limited").nullable(),
  }),
);
const connectionState = z.enum(["not-connected", "connected", "disconnected"]);

const connectionSchema = tiedTo<Connection>()(
  z.object({
    id: connectionIdSchema.nullable(),
    state: connectionState,
    cause: connectionCause.nullable(),
    signIn: z.object({ userCode: z.string(), verificationUri: z.string(), expiresAt: z.number() }).nullable(),
    person: hostLogin.nullable(),
    accounts: z.array(connectionAccount),
    listed: z.boolean(),
    listingCause: connectionCause.nullable(),
    look: installLook.nullable(),
    unreached: z.array(unreachedAccount),
    web: z.string(),
    since: z.number(),
    limitUntil: z.number().nullable(),
  }),
);

// The service.

const loginHolder = tiedTo<LoginHolder>()(
  z.union([z.enum(["this", "none"]), z.object({ other: z.string() })]),
);
const loginItemKind = enumOf<LoginItemKind>()(["os", "stand-in"]);
const settingsFileError = tiedTo<SettingsFileError>()(
  z.object({
    file: z.string(),
    problem: z.enum(["unreadable", "not_yaml", "wrong_version", "unknown_key", "wrong_type"]),
    key: z.string().nullable(),
  }),
);
const checkItem = tiedTo<CheckItem>()(
  z.discriminatedUnion("check", [
    z.object({
      check: z.literal("engine"),
      engine: engineIdSchema,
      state: engineState,
      cli: z.string(),
      version: z.string().nullable(),
      unusable: engineUnusable.nullable(),
      detail: z.string(),
    }),
    z.object({ check: z.literal("connection"), state: connectionState, cause: connectionCause.nullable() }),
    z.object({
      check: z.literal("service"),
      state: z.literal("running"),
      startAtLogin: z.boolean(),
      atLogin: loginHolder,
      loginItem: loginItemKind,
    }),
    z.object({ check: z.literal("settings"), invalid: z.array(settingsFileError) }),
    z.object({ check: z.literal("disk"), freeGb: z.number() }),
    z.object({ check: z.literal("version"), version: z.string(), upToDate: z.boolean().nullable() }),
  ]),
);
const commandPathState = tiedTo<CommandPathState>()(
  z.union([
    z.object({ folder: z.string(), reach: z.enum(["yes", "no", "linked"]) }),
    z.object({ folder: z.string(), reach: z.enum(["other", "stale"]), other: z.string() }),
  ]),
);
const agentSkill = tiedTo<AgentSkill>()(
  z.object({
    agent: engineIdSchema,
    state: z.enum(["none", "ours", "another", "foreign"]),
    folder: z.string(),
  }),
);
const codingAgent = tiedTo<CodingAgent>()(
  z.object({
    path: commandPathState,
    offer: z.enum(["binary", "clone", "npm"]),
    skills: z.array(agentSkill),
  }),
);

const serviceSchema = tiedTo<Service>()(
  z.object({
    state: z.literal("running"),
    since: z.number(),
    version: z.string(),
    command: z.string(),
    agent: codingAgent,
    startAtLogin: z.boolean(),
    atLogin: loginHolder,
    loginItem: loginItemKind,
    paused: z.object({ since: z.number(), until: z.number().nullable() }).nullable(),
    remote: z.boolean(),
    unlocked: z.boolean(),
    checks: z.object({ at: z.number(), running: z.boolean(), items: z.array(checkItem) }).nullable(),
  }),
);

// The settings.

const settingOrigin = enumOf<SettingOrigin>()(["lookover-default", "owner-default", "owner-repository"]);

/** One key's resolved setting, its values parsed by `value`. */
function resolvedSetting<V extends SettingValues[keyof SettingValues]>(value: z.ZodType<V>) {
  return z.object({
    value,
    origin: settingOrigin,
    overrode: z.object({ value, origin: settingOrigin }).nullable(),
  });
}

const settingsSchema = tiedTo<ResolvedSettings>()(
  z.object({
    strictness: resolvedSetting(enumOf<Strictness>()(["recommended", "blocking", "everything"])),
    reviewers: resolvedSetting(enumOf<Reviewers>()(["both", "claude", "codex"])),
    depth: resolvedSetting(enumOf<Depth>()(["quick", "standard", "deep"])),
    onOpen: resolvedSetting(z.boolean()),
    onPush: resolvedSetting(z.boolean()),
  }),
);

// The repositories, those departed, and the rules.

const noiseCounts = tiedTo<NoiseCounts>()(
  z.object({
    reviews: z.number(),
    postedBelowBlocking: z.number(),
    raisedByRule: z.record(z.string(), z.number()),
  }),
);

const repositorySchema = tiedTo<Repository>()(
  z.object({
    id: repositoryIdSchema,
    owner: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    settings: settingsSchema,
    noise: noiseCounts.exactOptional(),
  }),
);

const departedRepositorySchema = tiedTo<DepartedRepository>()(
  z.object({ id: repositoryIdSchema, owner: z.string(), name: z.string(), at: z.number() }),
);

const rulesFileName = z.enum(RULES_FILES);

const ruleSchema = tiedTo<Rule>()(
  z.object({
    id: z.string(),
    text: z.string(),
    source: z.union([rulesFileName, z.literal("yours")]),
    line: z.number().nullable(),
    repoId: repositoryIdSchema.nullable(),
    raised: z.number(),
    acted: z.number(),
    enabled: z.boolean(),
    parentOff: z.boolean(),
    nestedIn: z.boolean(),
    nested: z.number(),
  }),
);

// The changes.

const changeSchema = tiedTo<Change>()(
  z.object({
    id: changeIdSchema,
    repoId: repositoryIdSchema,
    number: z.number(),
    title: z.string(),
    openedBy: z.string(),
    author: z.enum(["you", "agent", "other"]),
    writtenBy: engineIdSchema.nullable(),
    headSha: shaSchema,
    openedAt: z.number(),
    draft: z.boolean(),
    fork: z.boolean(),
    newCommits: z.number(),
  }),
);

// The reviews: their findings, rounds, runs and jobs, then the review itself.

const severity = enumOf<Severity>()(["blocking", "should_fix", "consider"]);
const diffSide = enumOf<DiffSide>()(["head", "base"]);
const anchoring = enumOf<Anchoring>()(["reported", "moved", "unmatched"]);
const runStep = enumOf<RunStep>()(["preparing", "finding", "confirming", "publishing"]);
const runPass = enumOf<RunPass>()(["find", "find-2", "confirm"]);
const steps = z.array(z.object({ step: runStep, ms: z.number() }));
const fingerprints = tiedTo<Fingerprints>()(z.object({ location: z.string(), meaning: z.string() }));
const citedRule = tiedTo<CitedRule>()(z.object({ id: z.string(), file: rulesFileName, line: z.number() }));
const confirmation = tiedTo<Confirmation>()(
  z.discriminatedUnion("verdict", [
    z.object({
      verdict: z.literal("confirmed"),
      by: engineIdSchema,
      reason: z.string(),
      evidence: z.array(z.string()),
    }),
    z.object({
      verdict: z.literal("unsure"),
      by: engineIdSchema,
      reason: z.string(),
      evidence: z.array(z.string()),
      demoted: z.boolean(),
    }),
    z.object({ verdict: z.literal("not_checked"), demoted: z.boolean() }),
  ]),
);
const findingClaim = tiedTo<FindingClaim>()(
  z.object({
    kind: z.enum(["claimed_fixed", "wont_fix", "disputed", "deferred", "question"]),
    text: z.string(),
    by: z.string(),
    at: z.string(),
    commentId: z.number(),
  }),
);

const finding = tiedTo<Finding>()(
  z.object({
    id: findingIdSchema,
    fingerprints,
    severity,
    category: z.string(),
    title: z.string(),
    file: z.string(),
    side: diffSide,
    line: z.number(),
    endLine: z.number().nullable(),
    lineText: z.string().nullable(),
    anchoring,
    body: z.string(),
    foundBy: engineIdSchema,
    confirmation,
    why: z.object({ ruleText: z.string().nullable() }),
    rule: citedRule.nullable(),
    snippet: z.object({ start: z.number(), lines: z.array(z.string()), mark: z.number() }).nullable(),
    fix: z.object({ del: z.string(), add: z.string() }).nullable(),
    suggestion: z.string().nullable(),
    status: z.enum([
      "open",
      "escalated",
      "verified_fixed",
      "acknowledged",
      "withdrawn",
      "dismissed",
      "obsolete",
    ]),
    posted: z.boolean(),
    commented: z.boolean(),
    raisedIn: z.number(),
    anchoredIn: z.number(),
    closedIn: z.number().nullable(),
    verifiedSha: shaSchema.nullable(),
    closedWhy: z.string().nullable(),
    claim: findingClaim.nullable(),
    kept: z.number(),
  }),
);

const confirmFailure = enumOf<ConfirmFailure>()([
  "invalid_output",
  "auth_required",
  "quota_exhausted",
  "timeout",
  "crashed",
  "cancelled",
  "unreadable",
]);
const confirmFallback = tiedTo<ConfirmFallback>()(
  z.union([
    z.object({ reason: z.enum(["settings", "not-own"]), engine: engineIdSchema }),
    z.object({
      reason: z.literal("not-ready"),
      engine: engineIdSchema,
      state: engineState.exclude(["ready"]),
    }),
  ]),
);
const secondFind = tiedTo<SecondFind>()(
  z.object({ engine: engineIdSchema, failure: confirmFailure.nullable() }),
);
const engineUsage = tiedTo<EngineUsage>()(z.object({ inputTokens: z.number(), outputTokens: z.number() }));
const roundSession = tiedTo<RoundSession>()(
  z.object({ pass: runPass, engine: engineIdSchema, ms: z.number(), usage: engineUsage.nullable() }),
);
const candidateFinding = tiedTo<CandidateFinding>()(
  z.object({
    severity,
    category: z.string(),
    title: z.string(),
    body: z.string(),
    location: z.object({
      path: z.string(),
      side: diffSide,
      line: z.number(),
      endLine: z.number().nullable(),
    }),
    lineText: z.string().nullable(),
    anchoring,
    foundBy: engineIdSchema,
    defectKey: z.string(),
    suggestion: z.string().nullable(),
    preExisting: z.boolean(),
    rule: citedRule.nullable(),
    fingerprints,
  }),
);
const ruledOut = tiedTo<RuledOut>()(
  z.object({
    candidate: candidateFinding,
    by: engineIdSchema,
    reason: z.string(),
    evidence: z.array(z.string()),
  }),
);

const round = tiedTo<Round>()(
  z.object({
    n: z.number(),
    sha: shaSchema,
    base: shaSchema.nullable(),
    reviewer: engineIdSchema,
    secondFind: secondFind.nullable(),
    confirmer: engineIdSchema.nullable(),
    confirmFallback: confirmFallback.nullable(),
    confirmFailure: confirmFailure.nullable(),
    ruledOut: z.array(ruledOut),
    startedAt: z.number(),
    endedAt: z.number(),
    raised: z.number(),
    verifiedFixed: z.number(),
    open: z.number(),
    steps,
    sessions: z.array(roundSession),
  }),
);

const engineActivity = tiedTo<EngineActivity>()(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("read"), path: z.string() }),
    z.object({ kind: z.literal("search"), pattern: z.string() }),
    z.object({ kind: z.literal("list"), pattern: z.string() }),
    z.object({ kind: z.literal("command"), text: z.string() }),
  ]),
);
const runActivity = tiedTo<RunActivity>()(
  z.object({ engine: engineIdSchema, pass: runPass, activity: engineActivity }),
);
const runPosting = tiedTo<RunPosting>()(
  z.object({
    sent: z.number(),
    owed: z.number(),
    wait: z
      .object({
        until: z.number(),
        refusal: enumOf<TransientHostFailure>()(["rate_limited", "unavailable"]),
      })
      .nullable(),
  }),
);

const run = tiedTo<Run>()(
  z.object({
    id: runIdSchema,
    reviewer: engineIdSchema,
    secondFinder: engineIdSchema.nullable(),
    confirmer: engineIdSchema.nullable(),
    confirmFallback: confirmFallback.nullable(),
    sha: shaSchema,
    preview: z.boolean(),
    startedAt: z.number(),
    step: runStep,
    stepAt: z.number(),
    steps,
    activities: z.array(runActivity),
    posting: runPosting.nullable(),
  }),
);

const trigger = enumOf<Trigger>()(["opened", "push", "comment", "manual", "first-review"]);
const askedBy = enumOf<AskedBy>()(["agent", "person"]);
const deferral = tiedTo<Deferral>()(
  z.union([
    z.object({ reason: z.enum(["paused", "connection"]) }),
    z.object({
      reason: z.enum([
        "engine-signed-out",
        "engine-limit",
        "engine-failed-self-test",
        "engine-self-test-unfinished",
      ]),
      engine: engineIdSchema,
    }),
    z.object({
      reason: z.literal("engine-missing"),
      engine: engineIdSchema,
      unusable: engineUnusable.nullable(),
    }),
  ]),
);
const jobFailure = tiedTo<JobFailure>()(
  z.object({
    kind: z.enum([
      "service_stopped",
      "prepare_failed",
      "review_failed",
      "publish_failed",
      "host_failed",
      "unexpected",
    ]),
    detail: z.string(),
    engine: engineIdSchema.nullable(),
    cause: z
      .enum([
        "git_silent",
        "git_time_limit",
        "engine_time_limit",
        "base_not_found",
        "path_too_long",
        "git_missing",
        "network",
        "engine_answer",
      ])
      .nullable(),
    limitMs: z.number().nullable(),
  }),
);
const turn = tiedTo<Turn>()(
  z.discriminatedUnion("behind", [
    z.object({
      behind: z.literal("engines"),
      engines: z.array(engineIdSchema),
      changes: z.array(changeIdSchema),
      testing: z.boolean(),
    }),
    z.object({ behind: z.literal("change") }),
  ]),
);

const reviewJob = tiedTo<ReviewJob>()(
  z.object({
    id: jobIdSchema,
    sha: shaSchema,
    trigger,
    state: z.enum(["queued", "deferred", "running", "done", "skipped", "cancelled", "failed"]),
    deferral: deferral.nullable(),
    stepIn: engineIdSchema.nullable(),
    skip: z.enum(["not-yours", "draft", "repo-off", "on-open-off", "codex-not-yours", "fork"]).nullable(),
    cancel: z.enum(["closed", "replaced", "pushed", "sign-in-changed"]).nullable(),
    failure: jobFailure.nullable(),
    turn: turn.nullable(),
    askedBy: askedBy.nullable(),
  }),
);

/** A timeline entry of `kind`: its own fields, after what every entry carries (when, and the commit it concerns). */
const entry = <K extends string, F extends z.ZodRawShape>(kind: K, fields: F) =>
  z.object({ at: z.number(), sha: shaSchema.nullable(), kind: z.literal(kind), ...fields });

const timelineEntry = tiedTo<TimelineEntry>()(
  z.discriminatedUnion("kind", [
    entry("opened", { by: z.string() }),
    entry("pushed", { by: z.literal("agent").nullable(), commits: z.number() }),
    entry("queued", { trigger, by: askedBy.nullable() }),
    entry("asked", { by: askedBy }),
    entry("deferred", { deferral }),
    entry("skipped", {}),
    entry("started", { round: z.number() }),
    entry("posted", { round: z.number(), open: z.number() }),
    entry("failed", { failure: jobFailure.nullable() }),
    entry("dismissed", { findingIds: z.array(findingIdSchema) }),
  ]),
);

const reviewSchema = tiedTo<Review>()(
  z.object({
    changeId: changeIdSchema,
    job: reviewJob.nullable(),
    described: reviewJob.nullable(),
    run: run.nullable(),
    loop: z.enum(["open", "needs_owner", "settled"]).nullable(),
    rounds: z.array(round),
    findings: z.array(finding),
    preview: z.boolean(),
    updatedAt: z.number(),
    timeline: z.array(timelineEntry),
  }),
);

// The state.

export const stateSchema = tiedTo<State>()(
  z.object({
    seq: z.number(),
    now: z.number(),
    setup: setupSchema,
    engines: enginesSchema,
    connection: connectionSchema,
    service: serviceSchema,
    settings: settingsSchema,
    repos: z.array(repositorySchema),
    departed: z.array(departedRepositorySchema),
    rules: z.array(ruleSchema),
    changes: z.record(changeIdSchema, changeSchema),
    reviews: z.record(changeIdSchema, reviewSchema),
  }),
);
