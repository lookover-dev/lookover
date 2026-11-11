// The status block in the pull request's description (ADR 0074), through the service's entry, on FakeGitHost: the
// owner's prototype's states as a round posts them (`play4.ts`, its `words` and `describe`, on its relay webhook
// example), the description compared with the prototype's word for word but for the allowed departures: the markers'
// JSON, the permalink under a finding with no line comment (I-227), and the line numbers. One departure more, in S6:
// the finding kept twice against "won't fix" is blocking, not "Should fix", for `core` keeps a won't fix only on a
// blocking finding (ADR 0052: on any other it is the author's call). The confirm pass confirms every new finding.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  type ChangeRef,
  type CommitSha,
  changeId,
  characterCount,
  commitSha,
  DESCRIPTION_MAX_CHARACTERS,
  findingId,
  STATUS_END_MARKER,
  STATUS_MARKER,
  spliceStatus,
} from "@lookover/contracts";
import {
  DemoClock,
  type FakeChange,
  type FakeGitHost,
  ScriptedRetrieval,
  type ScriptedRun,
} from "@lookover/testkit";
import { answered } from "./claims.test-support.ts";
import {
  api,
  fakeEngines,
  messages,
  OWNER,
  openApp,
  post,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  T0,
  TEST_LIMIT_MS,
  until,
} from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const MIN = 60_000;
const OCTOCAT = { id: 583231, login: "octocat" };

// ---------- the prototype's words (play4.ts) ----------

const SITE = "https://lookover.dev";
/** The wordmark, by the reader's theme, linked to the site. */
const mark = (px: number) =>
  `<a href="${SITE}"><picture><source media="(prefers-color-scheme: dark)" srcset="${SITE}/brand/lookover-wordmark-on-dark.svg"><img src="${SITE}/brand/lookover-wordmark.svg" height="${px}" alt="Lookover" align="absmiddle"></picture></a>`;
const repo = `${SANDBOX.owner}/${SANDBOX.name}`;
const at = (n: number, sha: string) =>
  `[\`${sha.slice(0, 7)}\`](https://github.com/${repo}/pull/${n}/commits/${sha})`;
const things = (n: number) =>
  n === 0 ? "Nothing to fix" : n === 1 ? "One thing to fix" : `${n} things to fix`;
/** The block: the heading, one line under it, then the open findings. */
const block = (head: string, line: string, entries: string[] = []) =>
  [`### ${mark(26)} · ${head}`, line, ...(entries.length ? [entries.join("\n")] : [])].join("\n\n");
/** The description: the author's text, the rule, then the block between its markers. */
const describe = (human: string, b: string) =>
  `${human ? `${human}\n\n---\n\n` : ""}${STATUS_MARKER}\n${b}\n${STATUS_END_MARKER}`;

/** A finding as the prototype has it, and as the finder answers it. */
interface F {
  id: string;
  sev: "Blocking" | "Should fix";
  title: string;
  body: string;
  path: string;
  line: number;
}
const SEVERITY = { Blocking: "blocking", "Should fix": "should_fix" } as const;

const F1: F = {
  id: "F1",
  sev: "Blocking",
  title: "Retry loop never stops on 4xx",
  body: "When the webhook answers a 4xx, `sendWithRetry` retries forever, because only a 5xx counts down `attempts` and `res.ok` stays false.",
  path: "src/queue/send.ts",
  line: 11,
};
const F2: F = {
  id: "F2",
  sev: "Should fix",
  title: "A thrown delivery waits for the broker",
  body: "When `sendWithRetry` throws, the message is neither acked nor dead-lettered, so it waits out the broker's visibility timeout before anyone tries again.",
  path: "src/queue/ack.ts",
  line: 19,
};
/** Off the diff: the shared client is not in it. */
const F3: F = {
  id: "F3",
  sev: "Should fix",
  title: "Missing timeout on fetch",
  body: "When the webhook hangs, the request stays open forever, because the shared client sets no timeout.",
  path: "src/http/client.ts",
  line: 2,
};
/** The prototype's F5, raised in round 2: the ledger's fourth finding. */
const F5: F = {
  id: "F4",
  sev: "Blocking",
  title: "A refused delivery is acked",
  body: "When the webhook answers a 4xx, `sendWithRetry` now returns it and `deliver` acks the message anyway, because it never reads `res.ok`: the message is gone without a trace.",
  path: "src/queue/ack.ts",
  line: 18,
};

const where = (f: F) => `\`${f.path}\` line ${f.line}`;
/** A finding's list item: its title linked to its thread when it has one; else its note, and its permalink. */
const item = (f: F, thread: string | null, note?: string, permalink?: string) =>
  [
    `- **${f.sev}** · ${thread ? `[${f.title}](${thread})` : f.title} · ${where(f)}`,
    ...(note ? [`  ${note}`] : []),
  ].join("\n") + (permalink ? `\n\n  ${permalink}` : "");
const outside = (f: F) => `Not in the diff: ${f.body.charAt(0).toLowerCase()}${f.body.slice(1)}`;
/** The permalink to a finding's lines on `sha` (I-227): a departure from the prototype, which has none. */
const permalink = (f: F, sha: string) => `https://github.com/${repo}/blob/${sha}/${f.path}#L${f.line}`;

const TEMPLATE = `## What

Documents how deliveries are retried, in the README and on \`send\`.

## How to test

Read the README's new section.

- [x] Docs only, no behaviour change`;

// ---------- the world ----------

const SHA_1 = commitSha("1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const SHA_2 = commitSha("2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const SHA_3 = commitSha("3333333ccccccccccccccccccccccccccccccccc");
const BASE = commitSha("0000000ddddddddddddddddddddddddddddddddd");

/** `send.ts` and `ack.ts` added whole, as git prints it: where a comment can go. */
const DIFF = [
  "diff --git a/src/queue/send.ts b/src/queue/send.ts",
  "--- /dev/null",
  "+++ b/src/queue/send.ts",
  "@@ -0,0 +1,17 @@",
  ...Array.from({ length: 17 }, (_, i) => `+send ${i + 1}`),
  "diff --git a/src/queue/ack.ts b/src/queue/ack.ts",
  "--- /dev/null",
  "+++ b/src/queue/ack.ts",
  "@@ -0,0 +1,25 @@",
  ...Array.from({ length: 25 }, (_, i) => `+ack ${i + 1}`),
  "",
].join("\n");
const COMMENTABLE: FakeChange["diff"] = [
  { path: "src/queue/send.ts", side: "head", from: 1, to: 17 },
  { path: "src/queue/ack.ts", side: "head", from: 1, to: 25 },
];

/** The agent's pull request #1, as it opens: the owner's, its description the author's. */
const opened = (description: string | null = null): FakeChange => ({
  number: 1,
  title: "Retry failed deliveries",
  url: `https://github.com/${repo}/pull/1`,
  author: OWNER,
  draft: false,
  fork: false,
  head: { ref: "retry", sha: SHA_1 },
  base: { ref: "main", sha: BASE },
  diff: COMMENTABLE,
  description,
});
const PR: ChangeRef = { repo: SANDBOX, number: 1 };

/**
 * A round's passes: the find pass raising `found` and saying of each earlier finding what `earlier` gives, then, when
 * it raised any, the confirm pass confirming each at its severity.
 */
const finds = (
  found: F[],
  earlier: { id: string; present: boolean; wrong?: boolean; why: string }[] = [],
): ScriptedRun[] => [
  answered({
    findings: found.map((f) => ({
      path: f.path,
      line: f.line,
      severity: SEVERITY[f.sev],
      category: "correctness",
      title: f.title,
      body: f.body,
      defect_key: f.title.toLowerCase().replaceAll(" ", "_"),
    })),
    earlier,
  }),
  ...(found.length === 0
    ? []
    : [
        answered({
          verdicts: found.map((f, i) => ({
            id: `C${i + 1}`,
            verdict: "confirmed",
            reason: "Seen in the code.",
            evidence: [`${f.path}:${f.line}`],
            severity: SEVERITY[f.sev],
          })),
        }),
      ]),
];

/** A round's passes, its first taking `ms` on the test's clock: a round still running while the test looks. */
const slow = (ms: number, [first, ...rest]: ScriptedRun[]): ScriptedRun[] =>
  first === undefined ? [] : [{ ...first, tookMs: ms }, ...rest];

/**
 * The service on a fake GitHub, on a clock the test holds (from T0), the pull request opened as `change` says:
 * round 1 runs as it opens, on `first`. `ask` is the owner's `/lookover review` after `pushed` (when given), its
 * round on `runs`.
 */
async function opening(
  change: FakeChange,
  first: ScriptedRun[],
  options: { log?: (line: string) => void; ready?: (host: FakeGitHost) => void } = {},
) {
  const clock = new DemoClock({ at: T0 });
  const engines = fakeEngines({ time: clock });
  engines.answer(...first);
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = DIFF;
  const { host, time, service } = await start({
    changes: [],
    engines,
    retrieval,
    time: clock,
    ...(options.log ? { log: options.log } : {}),
  });
  options.ready?.(host);
  host.open(change);
  await time.advance(MIN);
  /** Each finding's thread on the pull request: the newest one's URL. */
  const thread = async (id: string): Promise<string> => {
    const threads = (await host.threads(PR)).filter((t) => t.findingId === findingId(id));
    const url = threads.at(-1)?.url;
    if (url === undefined) throw new Error(`${id} has no thread`);
    return url;
  };
  return {
    host,
    engines,
    time,
    service,
    thread,
    description: () => host.view(PR).description,
    /** The heading of each block the writes left, in order. */
    headings: () =>
      host.posts.flatMap((p) =>
        p.kind === "status.written" ? [p.description.split("\n")[1]?.split(" · ").slice(1).join(" · ")] : [],
      ),
    /** The owner replies on `id`'s thread. */
    reply: async (id: string, body: string) => {
      const root = (await host.threads(PR)).find((t) => t.findingId === findingId(id));
      if (!root) throw new Error(`${id} has no thread`);
      host.seedReply(PR, root.commentId, { author: OWNER, body });
    },
    /** The owner's `/lookover review`, after a push to `pushed` when given: the round runs on `runs`. */
    ask: async (runs: ScriptedRun[], pushed?: CommitSha) => {
      if (pushed) host.push(PR, pushed, COMMENTABLE);
      engines.answer(...runs);
      host.seedComment(PR, { author: OWNER, body: "/lookover review" });
      await time.advance(MIN);
    },
  };
}

const cookies = new WeakMap<Awaited<ReturnType<typeof opening>>["service"], string>();
/** The job the app's page says pull request #1's block is (`Review.described`, ADR 0092), as the app's state has it. */
async function described(w: Awaited<ReturnType<typeof opening>>) {
  // The link opens the app once: its cookie is kept for the next look.
  const cookie = cookies.get(w.service) ?? (await openApp(w.service));
  cookies.set(w.service, cookie);
  const state = await snapshot(w.service, cookie);
  return state.reviews[changeId(`${repo}#1`)]?.described;
}

// ---------- the states ----------

test("S1: round 1 is running: Looking over its commit, no list; then the round posts over it", async () => {
  const w = await opening(opened(), slow(10 * MIN, finds([F1, F2, F3])));
  expect(w.description()).toBe(describe("", block(`Looking over ${at(1, SHA_1)}`, "Round 1")));
  await w.time.advance(10 * MIN);
  // One write per standing: nothing said twice.
  expect(w.headings()).toEqual([`Looking over ${at(1, SHA_1)}`, things(3)]);
});

test("S3: a later round is running: Looking over the new commit, with its round's number", async () => {
  const w = await opening(opened(), finds([F1, F2, F3]));
  await w.ask(
    slow(10 * MIN, finds([F5], [{ id: "F1", present: false, why: "The loop now returns on a 4xx." }])),
    SHA_2,
  );
  expect(w.description()).toBe(describe("", block(`Looking over ${at(1, SHA_2)}`, "Round 2")));
});

test("S7: waiting for the AI's limit, under the author's description, with its reset today", async () => {
  // Today, 14:20 in the machine's time: bun test runs in UTC.
  const reset = Date.UTC(2026, 9, 6, 14, 20);
  const w = await opening(opened(TEMPLATE), [{ outcome: "quota_exhausted", text: "", limitUntil: reset }]);
  expect(w.description()).toBe(
    describe(
      TEMPLATE,
      block(
        `Waiting to look over ${at(1, SHA_1)}`,
        "Claude reached its usage limit. The review starts when it resets, at 14:20.",
      ),
    ),
  );
});

test("S8: the review failed: Couldn't look over, its cause (the engine crashed), and how to try again", async () => {
  const w = await opening(opened(), [{ outcome: "crashed", text: "" }]);
  expect(w.description()).toBe(
    describe(
      "",
      block(
        `Couldn't look over ${at(1, SHA_1)}`,
        "Claude gave no usable review. Push again, or comment `/lookover review`, to try again.",
      ),
    ),
  );
});

test("S9: a fork's request waiting when the fork is pushed: Didn't look over its commit, and how to ask for the newest (ADR 0092)", async () => {
  const w = await opening({ ...opened(), fork: true }, []);
  // A fork is skipped as it opens: no block.
  expect(w.description()).toBe("");
  w.engines.setHealth("claude", { installed: true, version: "2.4.1", signedIn: false });
  w.host.seedComment(PR, { author: OWNER, body: "/lookover review" });
  await w.time.advance(MIN);
  expect(w.headings()).toEqual([`Waiting to look over ${at(1, SHA_1)}`]);
  w.host.push(PR, SHA_2, COMMENTABLE);
  await w.time.advance(MIN);
  await w.time.advance(0);
  expect(w.description()).toBe(
    describe(
      "",
      block(
        `Didn't look over ${at(1, SHA_1)}`,
        "A newer commit was pushed after the request. Comment `/lookover review` to look over the newest one.",
      ),
    ),
  );
});

test("a fork's first review still running keeps Looking over when a push ends the request that waits behind it (ADR 0092)", async () => {
  const w = await opening({ ...opened(), fork: true }, []);
  w.engines.answer(...slow(10 * MIN, finds([F1])));
  w.host.seedComment(PR, { author: OWNER, body: "/lookover review" });
  await w.time.advance(MIN);
  expect(w.headings()).toEqual([`Looking over ${at(1, SHA_1)}`]);
  // A second request waits behind the running review; the push ends it, never the review.
  w.host.seedComment(PR, { author: OWNER, body: "/lookover review" });
  await w.time.advance(MIN);
  w.host.push(PR, SHA_2, COMMENTABLE);
  await w.time.advance(MIN);
  await w.time.advance(0);
  expect(w.headings()).toEqual([`Looking over ${at(1, SHA_1)}`]);
  // The app's page says the block GitHub has: the running review's.
  expect(await described(w)).toMatchObject({ state: "running", sha: SHA_1 });
  // The review posts its round over it, never the ended block.
  await w.time.advance(10 * MIN);
  expect(w.headings()).toEqual([`Looking over ${at(1, SHA_1)}`, things(1)]);
});

test("a fork's first review that fails after a push ended the request behind it: Didn't look over, never Looking over left (ADR 0092)", async () => {
  const w = await opening({ ...opened(), fork: true }, []);
  w.engines.answer({ outcome: "crashed", text: "", tookMs: 10 * MIN });
  w.host.seedComment(PR, { author: OWNER, body: "/lookover review" });
  await w.time.advance(MIN);
  w.host.seedComment(PR, { author: OWNER, body: "/lookover review" });
  await w.time.advance(MIN);
  w.host.push(PR, SHA_2, COMMENTABLE);
  await w.time.advance(MIN);
  expect(w.headings()).toEqual([`Looking over ${at(1, SHA_1)}`]);
  expect(await described(w)).toMatchObject({ state: "running", sha: SHA_1 });
  await w.time.advance(10 * MIN);
  await w.time.advance(0);
  expect(w.headings()).toEqual([`Looking over ${at(1, SHA_1)}`, `Didn't look over ${at(1, SHA_1)}`]);
  // The app's page says it too, though the newest job is the fork's skip on the new head.
  expect(await described(w)).toMatchObject({ state: "cancelled", cancel: "pushed", sha: SHA_1 });
});

test("S2: round 1 posts three things to fix, the one off the diff with its lines through a permalink", async () => {
  const w = await opening(opened(), finds([F1, F2, F3]));
  expect(w.description()).toBe(
    describe(
      "",
      block(things(3), `Round 1 · ${at(1, SHA_1)}`, [
        item(F1, await w.thread("F1")),
        item(F2, await w.thread("F2")),
        item(F3, null, outside(F3), permalink(F3, SHA_1)),
      ]),
    ),
  );
  // No summary comment any more: the conversation holds nothing of Lookover's.
  expect(w.host.view(PR).comments).toEqual([]);
});

test("S4: nothing found, the block under the author's description", async () => {
  const w = await opening(opened(TEMPLATE), finds([]));
  expect(w.description()).toBe(describe(TEMPLATE, block(things(0), `Round 1 · ${at(1, SHA_1)}`)));
});

test("S5: all settled after three rounds: two fixed and one withdrawn in round 2, the last one fixed in round 3", async () => {
  const w = await opening(opened(), finds([F1, F2, F3]));
  // The author disputes F2; the fix for F1 and F3 is pushed; the finder agrees F2 was wrong, and finds F5.
  await w.reply("F2", "Not a bug: the broker's 30 s visibility timeout is the retry we want here.");
  await w.ask(
    finds(
      [F5],
      [
        { id: "F1", present: false, why: "The loop now returns on a 4xx." },
        {
          id: "F2",
          present: true,
          wrong: true,
          why: "The visibility timeout is the intended retry: dead-lettering on a throw would drop messages a later try delivers.",
        },
        { id: "F3", present: false, why: "The client now times out." },
      ],
    ),
    SHA_2,
  );
  expect(w.description()).toBe(
    describe(
      "",
      block(things(1), `Round 2 · ${at(1, SHA_2)} · 2 fixed, 1 withdrawn`, [item(F5, await w.thread(F5.id))]),
    ),
  );
  await w.ask(
    finds([], [{ id: F5.id, present: false, why: "A refused delivery is dead-lettered now." }]),
    SHA_3,
  );
  expect(w.description()).toBe(
    describe("", block(things(0), `Round 3 · ${at(1, SHA_3)} · 3 fixed, 1 withdrawn`)),
  );
});

test("S6: a finding the author won't fix, kept twice, needs your look", async () => {
  const F2_BLOCKING: F = { ...F2, sev: "Blocking" };
  const w = await opening(opened(), finds([F1, F2_BLOCKING]));
  expect(w.description()).toBe(
    describe(
      "",
      block(things(2), `Round 1 · ${at(1, SHA_1)}`, [
        item(F1, await w.thread("F1")),
        item(F2_BLOCKING, await w.thread("F2")),
      ]),
    ),
  );
  await w.reply(
    "F2",
    "Won't fix: the broker's 30 s visibility timeout is the retry we want here. Dead-lettering a thrown delivery would drop messages on a network blip.",
  );
  const kept =
    "A network blip throws before the webhook answers, and the message then sits for 30 s with nobody retrying it: a nack would retry it at once without dropping it.";
  await w.ask(
    finds(
      [],
      [
        { id: "F1", present: false, why: "The loop now returns on a 4xx." },
        { id: "F2", present: true, why: kept },
      ],
    ),
    SHA_2,
  );
  expect(w.description()).toBe(
    describe(
      "",
      block(things(1), `Round 2 · ${at(1, SHA_2)} · 1 fixed`, [item(F2_BLOCKING, await w.thread("F2"))]),
    ),
  );
  await w.reply(
    "F2",
    "Won't fix: a blip is retried by the broker; I'd rather wait 30 s than lose the message.",
  );
  // The owner asks again on the same commit: the round looks over it again, then the owner decides.
  await w.ask(slow(10 * MIN, finds([], [{ id: "F2", present: true, why: kept }])));
  expect(w.description()).toBe(describe("", block(`Looking over ${at(1, SHA_2)} again`, "Round 3")));
  await w.time.advance(10 * MIN);
  expect(w.description()).toBe(
    describe(
      "",
      block("Needs your look", `Round 3 · ${at(1, SHA_2)} · 1 fixed`, [
        item(
          F2_BLOCKING,
          await w.thread("F2"),
          "Said won't fix twice, kept twice: the owner decides on the thread.",
        ),
      ]),
    ),
  );
});

// ---------- the write ----------

test("a failed review's block GitHub refused for a moment is written at the next take", async () => {
  // The first block, Looking over, lands; the failure's is refused once.
  const w = await opening(opened(), [{ outcome: "crashed", text: "" }], {
    ready: (host) => host.refuseNext("unavailable", { post: "status", skip: 1 }),
  });
  expect(w.description()).toBe(describe("", block(`Looking over ${at(1, SHA_1)}`, "Round 1")));
  // The next poll takes, and the take writes what was owed.
  await w.time.advance(MIN);
  expect(w.description()).toBe(
    describe(
      "",
      block(
        `Couldn't look over ${at(1, SHA_1)}`,
        "Claude gave no usable review. Push again, or comment `/lookover review`, to try again.",
      ),
    ),
  );
});

test("an older job's late failure never overwrites the block of the newer job that runs after it", async () => {
  // Round 1 runs five minutes, then fails; a push and a request meanwhile ask for the new commit.
  const w = await opening(opened(), [{ outcome: "crashed", text: "", tookMs: 5 * MIN }]);
  await w.ask(slow(10 * MIN, finds([])), SHA_2);
  await w.time.advance(5 * MIN);
  expect(w.description()).toBe(describe("", block(`Looking over ${at(1, SHA_2)}`, "Round 1")));
  expect(w.headings().filter((h) => h?.startsWith("Couldn't"))).toEqual([]);
});

test("a dismissal while a review waits keeps the block waiting, the finding gone from its list", async () => {
  const w = await opening(opened(), finds([F1, F2]));
  // Round 2 meets Claude's limit, until tomorrow: the job waits.
  const reset = Date.UTC(2026, 9, 7, 9, 5);
  await w.ask([{ outcome: "quota_exhausted", text: "", limitUntil: reset }], SHA_2);
  const waiting = `Waiting to look over ${at(1, SHA_2)}`;
  const line =
    "Round 2 · Claude reached its usage limit. The review starts when it resets, on Wed 7 Oct at 09:05.";
  expect(w.description()).toBe(
    describe("", block(waiting, line, [item(F1, await w.thread("F1")), item(F2, await w.thread("F2"))])),
  );
  const cookie = await openApp(w.service);
  const res = await post(w.service, cookie, {
    type: "noise.apply",
    choice: { kind: "wrong", changeId: changeId(`${repo}#1`), findingId: findingId("F1") },
  });
  expect(res.status).toBe(200);
  await w.time.advance(1_000);
  expect(w.description()).toBe(describe("", block(waiting, line, [item(F2, await w.thread("F2"))])));
});

test("a preview that verifies a posted finding fixed puts the posted round back as it posted, the finding still listed", async () => {
  const w = await opening(opened(), finds([F1, F2]));
  const posted = describe(
    "",
    block(things(2), `Round 1 · ${at(1, SHA_1)}`, [
      item(F1, await w.thread("F1")),
      item(F2, await w.thread("F2")),
    ]),
  );
  // The owner's "Review now" on the fix meets Claude's limit; a preview joins it, and finds F1 fixed once Claude is back.
  const id = changeId(`${repo}#1`);
  w.host.push(PR, SHA_2, COMMENTABLE);
  w.engines.answer(
    { outcome: "quota_exhausted", text: "", limitUntil: T0 + 12 * MIN },
    ...finds([], [{ id: "F1", present: false, why: "The loop now returns on a 4xx." }]),
  );
  const cookie = await openApp(w.service);
  expect((await post(w.service, cookie, { type: "review.request", changeId: id })).status).toBe(200);
  await w.time.advance(0);
  expect(w.headings().at(-1)).toBe(`Waiting to look over ${at(1, SHA_2)}`);
  expect(
    (await post(w.service, cookie, { type: "setup.firstReview", changeId: id, preview: true })).status,
  ).toBe(200);
  await w.time.advance(15 * MIN);
  expect((await snapshot(w.service, cookie)).reviews[id]).toMatchObject({
    preview: true,
    job: { state: "done" },
    findings: [
      { id: "F1", status: "verified_fixed" },
      { id: "F2", status: "open" },
    ],
  });
  // A preview posts nothing: the block is round 1's again, F1 still to fix.
  expect(w.description()).toBe(posted);
  // The owner dismisses F2: the block is written again, round 1's still, F1 listed.
  const res = await post(w.service, cookie, {
    type: "noise.apply",
    choice: { kind: "wrong", changeId: id, findingId: findingId("F2") },
  });
  expect(res.status).toBe(200);
  await w.time.advance(1_000);
  expect(w.description()).toBe(
    describe(
      "",
      block(things(1), `Round 1 · ${at(1, SHA_1)} · 1 withdrawn`, [item(F1, await w.thread("F1"))]),
    ),
  );
});

test("a block too large for the room the author's text leaves drops its items from the end, never the author's text", async () => {
  // The block round 1 would write, and what fits once its last item goes.
  const line = `Round 1 · ${at(1, SHA_1)}`;
  const items = (f1: string, f2: string) => [item(F1, f1), item(F2, f2)];
  // The threads are the fake's, in the order the review's comments were taken: its first two comments.
  const thread = (n: number) => `https://github.com/${repo}/pull/1#discussion_r${n}`;
  const fits = block(things(3), line, items(thread(100001), thread(100002)));
  // The author's text leaves exactly the room that block takes.
  const author = "a".repeat(DESCRIPTION_MAX_CHARACTERS - characterCount(spliceStatus("", fits)) - 7);
  expect(characterCount(spliceStatus(author, fits))).toBe(DESCRIPTION_MAX_CHARACTERS);
  const w = await opening(opened(author), finds([F1, F2, F3]));
  expect([await w.thread("F1"), await w.thread("F2")]).toEqual([thread(100001), thread(100002)]);
  expect(w.description()).toBe(describe(author, fits));
});

test("a pull request Lookover skips never gets a block: another author's, a draft", async () => {
  const theirs = { ...opened("Their words."), author: OCTOCAT };
  const w = await opening(theirs, finds([F1]));
  const draft = { ...opened("A draft."), number: 2, url: `https://github.com/${repo}/pull/2`, draft: true };
  w.host.open(draft);
  // A minute on: the service has polled the draft, and skipped it.
  await w.time.advance(MIN);
  expect(w.host.posts.filter((p) => p.kind === "status.written")).toEqual([]);
  expect(w.description()).toBe("Their words.");
  expect(w.host.view({ repo: SANDBOX, number: 2 }).description).toBe("A draft.");
});

test("a description the person may not edit is said in the log, never a sign-out, and the round lands all the same", async () => {
  const said: string[] = [];
  const engines = fakeEngines();
  engines.answer(...finds([F3]));
  const retrieval = new ScriptedRetrieval();
  retrieval.diff = DIFF;
  const { host, time, service } = await start({
    changes: [],
    engines,
    retrieval,
    log: (l) => said.push(l),
  });
  const cookie = await openApp(service);
  const events = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  host.open(opened("Mine alone."));
  host.forbidDescription(PR);
  await time.advance(MIN);
  // Off the diff, so no review: the block it couldn't write is what lands the round.
  expect((await until(events, "round.finished")).at(-1)).toMatchObject({
    job: { state: "done" },
    findings: [{ id: "F1", title: F3.title, posted: true }],
  });
  expect(said.some((l) => l.includes("no status block: invalid"))).toBe(true);
  expect(host.view(PR).description).toBe("Mine alone.");
  expect((await snapshot(service, cookie)).connection.state).toBe("connected");
});
