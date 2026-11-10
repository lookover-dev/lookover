// `readState` (ADR 0085): what a start keeps of the state its log replayed. A change goes with its review, each
// repository, departed repository and rule alone; a section it can't read is the start's own; check results always
// are. Every demo scenario's state reads back whole in the service's scenario tests.
import { expect, test } from "bun:test";
import {
  type Change,
  changeId,
  commitSha,
  type DroppedWhy,
  type Engine,
  emptyReview,
  GITHUB_WEB,
  type Repository,
  type ResolvedSettings,
  type Rule,
  readState,
  repositoryId,
  type Service,
  type State,
} from "./index.ts";

const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
const ONE = changeId("sam/app#1");
const TWO = changeId("sam/app#2");

const PARTNER: DroppedWhy = { kind: "partner-dropped" };

/** Unreadable at `path`, whatever zod's words for it. */
function unreadable(path: string): DroppedWhy {
  return { kind: "unreadable", path, message: expect.any(String) };
}

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

function change(id: typeof ONE, number: number): Change {
  return {
    id,
    repoId: repositoryId("sam/app"),
    number,
    title: `Change ${number}`,
    openedBy: "sam",
    author: "agent",
    writtenBy: "claude",
    headSha: commitSha("a1f9c2e"),
    openedAt: NOW - 60_000,
    draft: false,
    fork: false,
    newCommits: 0,
  };
}

const CHANGE_ONE = change(ONE, 1);
const CHANGE_TWO = change(TWO, 2);
const REVIEW_ONE = emptyReview(ONE, NOW - 60_000);
const REVIEW_TWO = emptyReview(TWO, NOW - 30_000);
const APP: Repository = {
  id: repositoryId("sam/app"),
  owner: "sam",
  name: "app",
  enabled: true,
  settings: DEFAULTS,
};
const WEB: Repository = { ...APP, id: repositoryId("sam/web"), name: "web" };

const RULE: Rule = {
  id: "rule-1",
  text: "Name every timeout.",
  source: "yours",
  line: null,
  repoId: null,
  raised: 0,
  acted: 0,
  enabled: true,
  parentOff: false,
  nestedIn: false,
  nested: 0,
};

/** The service of the start `version` names, so `own`'s pieces tell from the stored ones. */
function service(version: string): Service {
  return {
    state: "running",
    since: NOW,
    version,
    command: "lookover",
    agent: { path: { reach: "yes", folder: "/home/sam/.local/bin" }, offer: "binary", skills: [] },
    startAtLogin: true,
    atLogin: "this",
    loginItem: "os",
    paused: null,
    remote: false,
    unlocked: false,
    checks: null,
  };
}

function state(version: string): State {
  const engine = (id: "claude" | "codex", name: string): Engine => ({
    id,
    name,
    cli: id,
    version: "1.0.0",
    state: "ready",
    detail: version,
    unusable: null,
    since: NOW,
    limitUntil: null,
    signingIn: false,
  });
  return {
    seq: 12,
    now: NOW,
    setup: { done: true, step: "background", reached: "background", github: "done", firstReviewChange: null },
    engines: { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") },
    connection: {
      id: null,
      state: "connected",
      cause: null,
      accounts: [
        { account: { id: 7, login: "sam", type: "User" }, installationId: 77, cause: null, owner: null },
      ],
      listed: true,
      listingCause: null,
      unreached: [],
      signIn: null,
      person: { id: 7, login: "sam" },
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
    },
    service: service(version),
    settings: DEFAULTS,
    repos: [APP, WEB],
    departed: [{ id: repositoryId("sam/old"), owner: "sam", name: "old", at: NOW - 1_000 }],
    rules: [RULE],
    changes: { [ONE]: CHANGE_ONE, [TWO]: CHANGE_TWO },
    reviews: { [ONE]: REVIEW_ONE, [TWO]: REVIEW_TWO },
  };
}

const OWN = state("0.12.0");
const STORED = state("0.9.0");

/** `STORED` with some of its sections replaced, as JSON: what the log replayed, unchecked. */
function stored(sections: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify({ ...STORED, ...sections }));
}

/** `value` without its field `field`: what an older version wrote before the field was added. */
function without<T extends object, K extends keyof T>(value: T, field: K): Omit<T, K> {
  const { [field]: _gone, ...rest } = value;
  return rest;
}

test("a state as this version writes it reads back equal, nothing dropped", () => {
  expect(readState(stored({}), OWN)).toEqual({ state: STORED, dropped: [] });
});

test("a review missing a field is dropped with its change; the other change and its review stay", () => {
  const read = readState(
    stored({ reviews: { [ONE]: without(REVIEW_ONE, "rounds"), [TWO]: REVIEW_TWO } }),
    OWN,
  );
  expect(read.state).toEqual({ ...STORED, changes: { [TWO]: CHANGE_TWO }, reviews: { [TWO]: REVIEW_TWO } });
  expect(read.dropped).toEqual([
    {
      section: "reviews",
      key: ONE,
      why: {
        kind: "unreadable",
        path: "rounds",
        message: "Invalid input: expected array, received undefined",
      },
    },
    { section: "changes", key: ONE, why: PARTNER },
  ]);
});

test("a change it can't read is dropped with its review", () => {
  const read = readState(
    stored({ changes: { [ONE]: CHANGE_ONE, [TWO]: { ...CHANGE_TWO, number: "two" } } }),
    OWN,
  );
  expect(read.state).toEqual({ ...STORED, changes: { [ONE]: CHANGE_ONE }, reviews: { [ONE]: REVIEW_ONE } });
  expect(read.dropped).toEqual([
    { section: "changes", key: TWO, why: unreadable("number") },
    { section: "reviews", key: TWO, why: PARTNER },
  ]);
});

test("a closed change's review reads alone: kept when it reads, dropped when it doesn't", () => {
  const closed = { changes: { [ONE]: CHANGE_ONE } };
  expect(readState(stored(closed), OWN)).toEqual({ state: { ...STORED, ...closed }, dropped: [] });
  const old = without(REVIEW_TWO, "timeline");
  const read = readState(stored({ ...closed, reviews: { [ONE]: REVIEW_ONE, [TWO]: old } }), OWN);
  expect(read.state).toEqual({ ...STORED, ...closed, reviews: { [ONE]: REVIEW_ONE } });
  expect(read.dropped).toEqual([{ section: "reviews", key: TWO, why: unreadable("timeline") }]);
});

test("a repository in an old shape is dropped alone, so are a departed repository and a rule", () => {
  const read = readState(
    stored({
      repos: [{ ...without(APP, "settings"), reviewers: "both" }, WEB],
      departed: [...STORED.departed, { id: "sam/gone", owner: "sam" }],
      rules: [RULE, "Name every timeout."],
    }),
    OWN,
  );
  expect(read.state).toEqual({ ...STORED, repos: [WEB] });
  expect(read.dropped).toEqual([
    { section: "repos", key: "sam/app", why: unreadable("settings") },
    { section: "departed", key: "sam/gone", why: unreadable("name") },
    { section: "rules", key: "1", why: unreadable("") },
  ]);
});

test("#671's service check gives `checks: null` and keeps the service: check results are always the start's own", () => {
  const checks = {
    at: NOW,
    running: false,
    items: [{ check: "service", state: "running", startsAtLogin: true }],
  };
  const read = readState(stored({ service: { ...STORED.service, checks } }), OWN);
  expect(read.state).toEqual(STORED);
  expect(read.dropped).toEqual([]);
});

test("check results this version wrote are dropped as well", () => {
  const checks = { at: NOW, running: true, items: [] };
  expect(readState(stored({ service: { ...STORED.service, checks } }), OWN).state.service.checks).toBeNull();
});

test("a service it can't read is the start's own, and so are the setup, the engines, the connection and the settings", () => {
  const read = readState(
    stored({
      service: without(STORED.service, "atLogin"),
      setup: { ...STORED.setup, step: "welcome-back" },
      engines: without(STORED.engines, "codex"),
      connection: "connected",
      settings: without(DEFAULTS, "depth"),
    }),
    OWN,
  );
  expect(read.state).toEqual({
    ...STORED,
    setup: OWN.setup,
    engines: OWN.engines,
    connection: OWN.connection,
    service: OWN.service,
    settings: OWN.settings,
  });
  expect(read.dropped.map(({ section, key }) => [section, key])).toEqual([
    ["setup", null],
    ["engines", null],
    ["connection", null],
    ["service", null],
    ["settings", null],
  ]);
});

test("a connection stored before `listed` is the start's own, not listed until the start's listing answers (ADR 0086)", () => {
  const own: State = { ...OWN, connection: { ...OWN.connection, listed: false } };
  const read = readState(stored({ connection: without(STORED.connection, "listed") }), own);
  expect(read.state.connection).toEqual({ ...OWN.connection, listed: false });
  expect(read.dropped.map(({ section, key }) => [section, key])).toEqual([["connection", null]]);
});

test("a list it can't read at all is empty; so are the changes and the reviews when either record isn't one", () => {
  const read = readState(stored({ repos: { "sam/app": true }, reviews: [] }), OWN);
  expect(read.state).toEqual({ ...STORED, repos: [], changes: {}, reviews: {} });
  expect(read.dropped).toEqual([
    { section: "repos", key: null, why: { kind: "not-list", found: "object" } },
    { section: "reviews", key: null, why: { kind: "not-record", found: "list" } },
  ]);
});

test("top-level garbage gives the start's own state", () => {
  const garbage = [null, "state", [STORED], 12] as const;
  expect(garbage.map((value) => readState(value, OWN))).toEqual(
    (["null", "string", "list", "number"] as const).map((found) => ({
      state: OWN,
      dropped: [{ section: "state", key: null, why: { kind: "not-object", found } }],
    })),
  );
});
