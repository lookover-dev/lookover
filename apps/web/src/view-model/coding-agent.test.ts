// What Your coding agent's rows and Try it say for a given snapshot (ADR 0058): each row's state and its one action,
// Try it's choice of pull request, and a refused write said on the rows' refusal line. Snapshots are built by hand.
import { expect, test } from "bun:test";
import {
  type Change,
  type CodingAgent,
  changeId,
  commitSha,
  type Engine,
  type EngineId,
  emptyReview,
  type Finding,
  findingId,
  GITHUB_WEB,
  type ResolvedSettings,
  type Review,
  type Round,
  repositoryId,
  type State,
} from "@lookover/contracts";
import { Refused } from "../api/http.ts";
import {
  type AgentRow,
  agentRefusal,
  PATH_LABELS,
  pathRow,
  rowAction,
  rowDetails,
  rowLabels,
  SKILL_LABELS,
  skillRows,
  tryIt,
} from "./coding-agent.ts";
import { refusalOf, refusalToast } from "./refusal.ts";

const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const MIN = 60_000;
const WINDOWS = "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin";
const CLAUDE_SKILL = "C:\\Users\\Your Name\\.claude\\skills\\lookover-review-loop";
const CODEX_SKILL = "C:\\Users\\Your Name\\.agents\\skills\\lookover-review-loop";

function agent(more: Partial<CodingAgent> = {}): CodingAgent {
  return {
    path: { reach: "no", folder: WINDOWS },
    offer: "binary",
    skills: [
      { agent: "claude", state: "none", folder: CLAUDE_SKILL },
      { agent: "codex", state: "none", folder: CODEX_SKILL },
    ],
    ...more,
  };
}

/** The PATH row and its details for Lookover's command `lookover`, the program on the PATH on its usual data folder. */
const pathOf = (a: CodingAgent) => pathRow(a, "lookover");
const detailsOf = (a: CodingAgent, id: AgentRow["id"]) => rowDetails(a, "lookover", id);

// ---- lookover in your terminal ----

test("Lookover's launcher running another copy: said with that copy, and Point it at this Lookover", () => {
  const old = "C:\\Users\\Your Name\\Downloads\\lookover.exe";
  expect(pathOf(agent({ path: { reach: "stale", folder: WINDOWS, other: old } }))).toMatchObject({
    state: "idle",
    action: { label: "Point it at this Lookover", command: { type: "agent.path", on: true } },
    undo: null,
    detail: {
      before: "Lookover's launcher runs",
      command: old,
      after: "instead of this copy. Terminals already open need a restart.",
    },
  });
  expect(PATH_LABELS.setup).toContain("Point it at this Lookover");
});

test("on another data folder, the done row names Lookover's command as a terminal runs it", () => {
  const command = "lookover '--home=D:\\lookover data'";
  expect(pathRow(agent({ path: { reach: "yes", folder: WINDOWS } }), command).detail).toEqual({
    before: "A terminal's",
    command,
    after: "runs this Lookover.",
  });
});

test("the binary off the PATH offers Add to my PATH, saying what it adds and that open terminals need a restart", () => {
  expect(pathOf(agent())).toEqual({
    id: "path",
    state: "idle",
    title: { before: "", command: "lookover", after: "in your terminal" },
    detail: {
      before: "Adds",
      command: WINDOWS,
      after: "to your PATH. It holds only Lookover's launcher. Terminals already open need a restart.",
    },
    action: { label: "Add to my PATH", command: { type: "agent.path", on: true } },
    undo: null,
  });
  // On macOS and Linux, a link in ~/.local/bin.
  expect(pathOf(agent({ path: { reach: "no", folder: "/home/sam/.local/bin" } })).detail).toEqual({
    before: "Links lookover into",
    command: "/home/sam/.local/bin",
    after: "for new terminals; open ones need a restart.",
  });
});

test("on the PATH, the row is done, with Remove from my PATH as its undo", () => {
  const row = pathOf(agent({ path: { reach: "yes", folder: WINDOWS } }));
  expect(row).toMatchObject({
    state: "done",
    detail: { before: "A terminal's", command: "lookover", after: "runs this Lookover." },
    action: null,
    undo: { label: "Remove from my PATH", command: { type: "agent.path", on: false } },
  });
});

test("linked off the PATH, or another lookover first: said, with no Add", () => {
  const linked = pathOf(agent({ path: { reach: "linked", folder: "/home/sam/.local/bin" } }));
  expect(linked).toMatchObject({
    state: "idle",
    action: null,
    undo: { label: "Remove from my PATH" },
    detail: {
      before: "Lookover's link is in",
      command: "/home/sam/.local/bin",
      after: ", but that folder isn't on your PATH. Add it there, then open a new terminal.",
    },
  });
  const other = "C:\\Users\\Your Name\\AppData\\Roaming\\npm\\lookover.cmd";
  expect(pathOf(agent({ path: { reach: "other", folder: WINDOWS, other } }))).toMatchObject({
    state: "idle",
    action: null,
    undo: null,
    detail: {
      before: "A terminal runs another",
      command: "lookover",
      after: { before: "first:", command: other, after: ". Take it off your PATH to reach this one." },
    },
  });
});

test("an npm install has no PATH offer: npm put it there, unless another lookover comes first", () => {
  const npm = "C:\\Users\\Your Name\\AppData\\Roaming\\npm";
  expect(pathOf(agent({ offer: "npm", path: { reach: "yes", folder: npm } }))).toEqual({
    id: "path",
    state: "done",
    title: { before: "", command: "lookover", after: "in your terminal" },
    detail: {
      before: "npm put it on your PATH: a terminal's",
      command: "lookover",
      after: "runs this Lookover.",
    },
    action: null,
    undo: null,
  });
  // npm's folder off the PATH (a Node installed without it): said with that folder, and nothing offered.
  expect(pathOf(agent({ offer: "npm", path: { reach: "no", folder: npm } }))).toEqual({
    id: "path",
    state: "idle",
    title: { before: "", command: "lookover", after: "in your terminal" },
    detail: {
      before: "npm put it in",
      command: npm,
      after: ", but that folder isn't on your PATH. Add it there, then open a new terminal.",
    },
    action: null,
    undo: null,
  });
  // Another lookover first (bun's, pnpm's), maybe the person's only other one: said with its path, not to remove it.
  const other = "C:\\Users\\Your Name\\.bun\\bin\\lookover.exe";
  expect(pathOf(agent({ offer: "npm", path: { reach: "other", folder: WINDOWS, other } }))).toMatchObject({
    state: "idle",
    action: null,
    undo: null,
    detail: {
      before: "A terminal runs another",
      command: "lookover",
      after: { before: "first, at", command: other, after: "." },
    },
  });
});

test("a clone has no PATH offer: the skill needs none", () => {
  expect(pathOf(agent({ offer: "clone" }))).toMatchObject({
    state: "idle",
    detail: "Lookover runs from its clone here: the skill calls it there, so your agent needs no PATH.",
    action: null,
    undo: null,
  });
});

// ---- one row per agent found ----

test("each agent found has its row: Install the skill, Replace for another's or a hand-made one, done with Remove", () => {
  const rows = skillRows(
    agent({
      skills: [
        { agent: "claude", state: "ours", folder: CLAUDE_SKILL },
        { agent: "codex", state: "none", folder: CODEX_SKILL },
      ],
    }),
  );
  expect(rows).toEqual([
    {
      id: "claude",
      state: "done",
      title: "Claude Code",
      detail: {
        before: "The review loop's skill is in",
        command: CLAUDE_SKILL,
        after: "and calls this Lookover.",
      },
      action: null,
      undo: { label: "Remove the skill", command: { type: "agent.skill", agent: "claude", on: false } },
    },
    {
      id: "codex",
      state: "idle",
      title: "Codex",
      detail: {
        before: "Installs the review loop's skill in",
        command: CODEX_SKILL,
        after: "so Codex knows the loop.",
      },
      action: { label: "Install the skill", command: { type: "agent.skill", agent: "codex", on: true } },
      undo: null,
    },
  ]);
  const replaced = skillRows(
    agent({
      skills: [
        { agent: "claude", state: "another", folder: CLAUDE_SKILL },
        { agent: "codex", state: "foreign", folder: CODEX_SKILL },
      ],
    }),
  );
  expect(replaced.map((r) => [r.state, r.action?.label, r.undo, r.detail])).toEqual([
    [
      "idle",
      "Replace",
      null,
      {
        before: "Another Lookover's skill is in",
        command: CLAUDE_SKILL,
        after: "Replace it to call this one.",
      },
    ],
    [
      "idle",
      "Replace",
      null,
      {
        before: "A skill Lookover didn't write is in",
        command: CODEX_SKILL,
        after: "Replace it to call this Lookover.",
      },
    ],
  ]);
  // Replace writes over it.
  expect(replaced[0]?.action?.command).toEqual({ type: "agent.skill", agent: "claude", on: true });
});

test("each row kind's labels list every label its rows can show, setup's apart from Settings' undo", () => {
  const paths: AgentRow[] = [
    pathOf(agent()),
    pathOf(agent({ path: { reach: "yes", folder: WINDOWS } })),
    pathOf(agent({ path: { reach: "linked", folder: "/home/sam/.local/bin" } })),
    pathOf(agent({ path: { reach: "stale", folder: WINDOWS, other: "D:\\old\\lookover.exe" } })),
  ];
  const skills: AgentRow[] = (["none", "ours", "another", "foreign"] as const).flatMap((state) =>
    skillRows(agent({ skills: [{ agent: "claude", state, folder: CLAUDE_SKILL }] })),
  );
  const shown = (rows: AgentRow[], key: "action" | "undo") =>
    [...new Set(rows.flatMap((r) => r[key]?.label ?? []))].sort();
  expect(shown(paths, "action")).toEqual([...PATH_LABELS.setup].sort());
  expect(shown(paths, "undo")).toEqual([...PATH_LABELS.undo].sort());
  expect(shown(skills, "action")).toEqual([...SKILL_LABELS.setup].sort());
  expect(shown(skills, "undo")).toEqual([...SKILL_LABELS.undo].sort());
});

// ---- Settings › Your coding agent: each done row offers its undo ----

test("in Settings a done row offers its undo; in setup only what moves it forward", () => {
  const onPath = pathOf(agent({ path: { reach: "yes", folder: WINDOWS } }));
  const rows = skillRows(
    agent({
      skills: [
        { agent: "claude", state: "ours", folder: CLAUDE_SKILL },
        { agent: "codex", state: "none", folder: CODEX_SKILL },
      ],
    }),
  );
  const [installed, missing] = rows;
  if (!installed || !missing) throw new Error("two agents, two rows");
  expect(rowAction(onPath, "settings")).toEqual({
    label: "Remove from my PATH",
    command: { type: "agent.path", on: false },
  });
  expect(rowAction(installed, "settings")).toEqual({
    label: "Remove the skill",
    command: { type: "agent.skill", agent: "claude", on: false },
  });
  // A row still to do offers its action in both places.
  expect(rowAction(missing, "settings")?.label).toBe("Install the skill");
  expect(rowAction(missing, "setup")?.label).toBe("Install the skill");
  // Setup never offers an undo.
  expect(rowAction(onPath, "setup")).toBeNull();
  expect(rowAction(installed, "setup")).toBeNull();
  // Lookover's link off the PATH: nothing to add, but Settings can take it out.
  const linked = pathOf(agent({ path: { reach: "linked", folder: "/home/sam/.local/bin" } }));
  expect(rowAction(linked, "setup")).toBeNull();
  expect(rowAction(linked, "settings")?.label).toBe("Remove from my PATH");
});

test("a row's action keeps the width of every label it can show there: Settings adds the undo", () => {
  expect(rowLabels(PATH_LABELS, "setup")).toEqual(["Add to my PATH", "Point it at this Lookover"]);
  expect(rowLabels(PATH_LABELS, "settings")).toEqual([
    "Add to my PATH",
    "Point it at this Lookover",
    "Remove from my PATH",
  ]);
  expect(rowLabels(SKILL_LABELS, "settings")).toEqual(["Install the skill", "Replace", "Remove the skill"]);
});

test("a row holds every detail a click there can bring, so its height holds when it is done or undone", () => {
  const done = { before: "A terminal's", command: "lookover", after: "runs this Lookover." };
  const adds = pathOf(agent()).detail;
  // Off the PATH or on it, the PATH row holds both details, the done one first.
  expect(detailsOf(agent(), "path")).toEqual([done, adds]);
  expect(detailsOf(agent({ path: { reach: "yes", folder: WINDOWS } }), "path")).toEqual([done, adds]);
  // Linked off the PATH: its own detail too, which Remove from my PATH turns into Add's.
  const linked = agent({ path: { reach: "linked", folder: "/home/sam/.local/bin" } });
  expect(detailsOf(linked, "path")).toHaveLength(3);
  expect(detailsOf(linked, "path")).toContainEqual(pathOf(linked).detail);
  // A clone's row has one detail: no click changes it.
  const clone = agent({ offer: "clone" });
  expect(detailsOf(clone, "path")).toEqual([pathOf(clone).detail]);
  // A skill row: installed, not installed, and Replace's detail while it shows.
  const skills = agent({
    skills: [
      { agent: "claude", state: "ours", folder: CLAUDE_SKILL },
      { agent: "codex", state: "foreign", folder: CODEX_SKILL },
    ],
  });
  const now = skillRows(skills).map((r) => r.detail);
  const fresh = skillRows(agent()).map((r) => r.detail);
  expect(detailsOf(skills, "claude")).toEqual([...now.slice(0, 1), ...fresh.slice(0, 1)]);
  expect(detailsOf(skills, "codex")).toEqual([
    { before: "The review loop's skill is in", command: CODEX_SKILL, after: "and calls this Lookover." },
    ...fresh.slice(1),
    ...now.slice(1),
  ]);
});

test("an agent not found has no row", () => {
  expect(skillRows(agent({ skills: [] }))).toEqual([]);
});

// ---- Try it ----

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

function finding(posted: boolean, status: Finding["status"] = "open"): Finding {
  return {
    id: findingId("F1"),
    fingerprints: { location: "src/app.ts:1", meaning: "m" },
    severity: "should_fix",
    category: "Correctness",
    title: "F1",
    file: "src/app.ts",
    side: "head",
    line: 1,
    endLine: null,
    lineText: null,
    anchoring: "reported",
    foundBy: "codex",
    confirmation: { verdict: "not_checked", demoted: false },
    body: "",
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    status,
    posted,
    commented: false,
    raisedIn: 1,
    anchoredIn: 1,
    closedIn: null,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
  };
}

function engine(id: EngineId, name: string): Engine {
  return {
    id,
    name,
    cli: id,
    version: "1.0.0",
    state: "ready",
    detail: "",
    unusable: null,
    since: NOW,
    limitUntil: null,
    signingIn: false,
  };
}

/** The owner's ledger-api, its pull requests as given: each with its author, its review's findings and preview. */
function world(
  prs: {
    n: number;
    author?: Change["author"];
    findings: Finding[];
    preview?: boolean;
    ago?: number;
    rounds?: Round[];
  }[],
  firstReview: number | null = null,
): State {
  const repoId = repositoryId("sasensi/ledger-api");
  const changes: State["changes"] = {};
  const reviews: State["reviews"] = {};
  for (const pr of prs) {
    const id = changeId(`ledger-api#${pr.n}`);
    changes[id] = {
      id,
      repoId,
      number: pr.n,
      title: `Change ${pr.n}`,
      openedBy: "sasensi",
      author: pr.author ?? "you",
      writtenBy: null,
      headSha: commitSha("a1f9c2e"),
      openedAt: NOW - 60 * MIN,
      draft: false,
      fork: false,
      newCommits: 0,
    };
    const review: Review = {
      ...emptyReview(id, NOW - (pr.ago ?? 0)),
      findings: pr.findings,
      rounds: pr.rounds ?? [],
      preview: pr.preview ?? false,
    };
    reviews[id] = review;
  }
  return {
    seq: 0,
    now: NOW,
    setup: {
      done: false,
      step: "agent",
      reached: "agent",
      github: "done",
      githubRefused: null,
      firstReviewChange: firstReview === null ? null : changeId(`ledger-api#${firstReview}`),
    },
    engines: { claude: engine("claude", "Claude"), codex: engine("codex", "Codex") },
    connection: {
      id: null,
      state: "connected",
      cause: null,
      bot: "lookover-k3x9q2[bot]",
      app: null,
      installationId: null,
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
      gh: null,
    },
    service: {
      state: "running",
      since: NOW,
      version: "0.1.0",
      command: "lookover",
      agent: agent(),
      startAtLogin: true,
      startsAtLogin: false,
      loginItem: "os",
      paused: null,
      remote: false,
      unlocked: false,
      checks: null,
    },
    settings: DEFAULTS,
    repos: [{ id: repoId, owner: "sasensi", name: "ledger-api", enabled: true, settings: DEFAULTS }],
    departed: [],
    rules: [],
    changes,
    reviews,
  };
}

const NEXT = {
  before: "Your agent fixes and pushes, then",
  command: "lookover wait",
  after: "asks Lookover for round 2. Each finding it fixed has its thread resolved.",
};

test("Try it names the owner's pull request with a finding posted on GitHub, and what happens next", () => {
  expect(tryIt(world([{ n: 148, findings: [finding(true)] }]))).toEqual({
    sentence:
      "Get pull request #148 of sasensi/ledger-api through Lookover's review: fix what it found and push.",
    line: NEXT,
  });
});

test("Try it's next line names Lookover's command, the one a terminal runs: off the PATH, or on another data folder", () => {
  const state = world([{ n: 148, findings: [finding(true)] }]);
  const command = "& 'C:\\Users\\Your Name\\Downloads\\lookover.exe'";
  expect(tryIt({ ...state, service: { ...state.service, command } }).line).toEqual({
    ...NEXT,
    command: `${command} wait`,
  });
});

test("Try it prefers the setup's first review, else the pull request reviewed last", () => {
  const prs = [
    { n: 150, findings: [finding(true)], ago: 0 },
    { n: 148, findings: [finding(true)], ago: 10 * MIN },
  ];
  expect(tryIt(world(prs, 148)).sentence).toContain("#148 ");
  expect(tryIt(world(prs)).sentence).toContain("#150 ");
});

test("a preview posted nothing: Try it names no pull request and says to post a review first", () => {
  expect(tryIt(world([{ n: 148, findings: [finding(false)], preview: true }], 148))).toEqual({
    sentence: null,
    line: "Your first review was a preview, so nothing is on GitHub for your agent to read. Post a review on one of your pull requests first.",
  });
  // A preview that wasn't the setup's first review isn't called the first.
  expect(tryIt(world([{ n: 148, findings: [finding(false)], preview: true }])).line).toBe(
    "None of your pull requests has a finding on GitHub yet. Post a review on one first.",
  );
});

const ROUND: Round = {
  n: 1,
  sha: commitSha("a1f9c2e"),
  reviewer: "codex",
  secondFind: null,
  confirmer: null,
  confirmFallback: null,
  confirmFailure: null,
  ruledOut: [],
  startedAt: NOW - 2 * MIN,
  endedAt: NOW - MIN,
  raised: 0,
  verifiedFixed: 0,
  open: 0,
  steps: [],
  sessions: [],
};

test("a posted review left nothing to fix: none to fix yet, without asking for a review", () => {
  const nothing = "None of your pull requests has a finding to fix on GitHub yet.";
  // The setup's first review, posted, found nothing.
  const clean = world([{ n: 148, findings: [], rounds: [ROUND] }], 148);
  expect(tryIt(clean)).toEqual({ sentence: null, line: nothing });
  // Posted, then fixed: the same.
  expect(tryIt(world([{ n: 1, findings: [finding(true, "verified_fixed")], rounds: [ROUND] }])).line).toBe(
    nothing,
  );
});

test("nothing posted, or only on someone else's pull request: none, and post a review first", () => {
  const none = "None of your pull requests has a finding on GitHub yet. Post a review on one first.";
  expect(tryIt(world([]))).toEqual({ sentence: null, line: none });
  // Kept off the pull request, or on another person's: nothing for the agent to fix.
  expect(
    tryIt(
      world([
        { n: 2, findings: [finding(false)] },
        { n: 3, author: "other", findings: [finding(true)] },
      ]),
    ),
  ).toEqual({ sentence: null, line: none });
});

// ---- a refused write, said under the rows ----

test("a refused write is said under the rows, never in the toast; another command's refusal isn't the rows'", () => {
  const skill = { type: "agent.skill", agent: "codex", on: false } as const;
  const notOurs = refusalOf(
    new Refused(409, { error: "the skill isn't Lookover's", agent: "not_ours" }),
    skill,
  );
  expect(agentRefusal(notOurs)).toBe(
    "Lookover didn't write this skill, so it leaves it there. Replace it, or remove it by hand.",
  );
  expect(refusalToast(notOurs)).toBeNull();

  const path = { type: "agent.path", on: true } as const;
  const denied = refusalOf(new Refused(500, { error: "The PATH didn't change: Access is denied." }), path);
  expect(agentRefusal(denied)).toBe("This computer refused to change your PATH. Try again.");
  const offered = refusalOf(new Refused(409, { error: "no PATH offer here", agent: "not_offered" }), path);
  expect(agentRefusal(offered)).toBe(
    "Lookover puts itself on the PATH only when it runs as its own program.",
  );
  const written = refusalOf(new Refused(500, { error: "The skill didn't change: Access is denied." }), {
    type: "agent.skill",
    agent: "claude",
    on: true,
  });
  expect(agentRefusal(written)).toBe("This computer refused to change the skill's folder. Try again.");
  const gone = refusalOf(new Refused(404, { error: "no such agent", agent: "no_such_agent" }), skill);
  expect(agentRefusal(gone)).toBe("Lookover doesn't find that agent on this computer any more.");

  const other = refusalOf(new Refused(500, { error: "Start at login didn't change: no" }), {
    type: "service.startAtLogin",
    on: true,
  });
  expect(agentRefusal(other)).toBeNull();
  expect(refusalToast(other)).toBe("Lookover couldn't do that.");
  expect(agentRefusal(null)).toBeNull();
});
