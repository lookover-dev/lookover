// The status block (ADR 0074) through the publisher's entry: each state's Markdown, written by hand from the owner's
// prototype (`play4.ts`, its `words`), word for word but for its allowed departures: the permalink under a finding
// off the diff (I-227) and the line numbers.
import { describe, expect, test } from "bun:test";
import { commitSha, type Finding, findingId } from "@lookover/contracts";
import { FakeGitHost } from "@lookover/testkit";
import { createPublisher, type Status, type StatusRound } from "./index.ts";

/** The prototype's wordmark, by the reader's theme, linked to the site. */
const mark = (px: number) =>
  `<a href="https://lookover.dev"><picture><source media="(prefers-color-scheme: dark)" srcset="https://lookover.dev/brand/lookover-wordmark-on-dark.svg"><img src="https://lookover.dev/brand/lookover-wordmark.svg" height="${px}" alt="Lookover" align="absmiddle"></picture></a>`;

const repo = { owner: "sasensi", name: "relay" };
const change = { repo, number: 26 };
const SHA_1 = commitSha("1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const SHA_2 = commitSha("2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const SHA_3 = commitSha("3333333ccccccccccccccccccccccccccccccccc");
const BASE = commitSha("0000000ddddddddddddddddddddddddddddddddd");
const at = (sha: string) =>
  `[\`${sha.slice(0, 7)}\`](https://github.com/sasensi/relay/pull/26/commits/${sha})`;
const thread = (id: number) => `https://github.com/sasensi/relay/pull/26#discussion_r${id}`;

function finding(id: string, overrides: Partial<Finding>): Finding {
  return {
    id: findingId(id),
    severity: "blocking",
    category: "correctness",
    title: "Retry loop never stops on 4xx",
    file: "src/queue/send.ts",
    side: "head",
    line: 11,
    endLine: null,
    lineText: null,
    anchoring: "reported",
    foundBy: "claude",
    confirmation: { verdict: "not_checked", demoted: false },
    body: "When the webhook answers a 4xx, `sendWithRetry` retries forever, because only a 5xx counts down `attempts` and `res.ok` stays false.",
    why: { ruleText: null },
    rule: null,
    snippet: null,
    fix: null,
    suggestion: null,
    status: "open",
    posted: true,
    commented: true,
    raisedIn: 1,
    anchoredIn: 1,
    closedIn: null,
    verifiedSha: null,
    closedWhy: null,
    claim: null,
    kept: 0,
    fingerprints: { location: `loc:${id}`, meaning: `sem:${id}` },
    ...overrides,
  };
}

const F1 = finding("F1", {});
const F2 = finding("F2", {
  severity: "should_fix",
  title: "A thrown delivery waits for the broker",
  file: "src/queue/ack.ts",
  line: 19,
  body: "When `sendWithRetry` throws, the message is neither acked nor dead-lettered, so it waits out the broker's visibility timeout before anyone tries again.",
});
const F3 = finding("F3", {
  severity: "should_fix",
  title: "Missing timeout on fetch",
  file: "src/http/client.ts",
  line: 2,
  commented: false,
  body: "When the webhook hangs, the request stays open forever, because the shared client sets no timeout.",
});
const F5 = finding("F5", {
  title: "A refused delivery is acked",
  file: "src/queue/ack.ts",
  line: 18,
  raisedIn: 2,
  anchoredIn: 2,
  body: "When the webhook answers a 4xx, `sendWithRetry` now returns it and `deliver` acks the message anyway, because it never reads `res.ok`: the message is gone without a trace.",
});

const round = (
  n: number,
  sha: typeof SHA_1,
  findings: Finding[],
  over: Partial<StatusRound> = {},
): StatusRound => ({
  n,
  sha,
  base: BASE,
  rounds: [
    { n: 1, sha: SHA_1 },
    { n: 2, sha: SHA_2 },
    { n: 3, sha: SHA_3 },
  ].filter((r) => r.n <= n),
  findings,
  loop: findings.some((f) => f.posted && f.status === "escalated")
    ? "needs_owner"
    : findings.some((f) => f.posted && f.status === "open")
      ? "open"
      : "settled",
  threads: [
    { findingId: F1.id, url: thread(101) },
    { findingId: F2.id, url: thread(102) },
    { findingId: F5.id, url: thread(105) },
  ],
  ...over,
});

const ROUND_1 = round(1, SHA_1, [F1, F2, F3]);

/** The machine's time is UTC here: the reset reads as given. */
const publisher = () =>
  createPublisher({
    writer: new FakeGitHost({
      repo,
      bot: { id: 9001, login: "lookover[bot]" },
      person: { id: 1, login: "sasensi" },
      changes: [],
    }),
    person: () => 1,
    offset: () => 0,
  });
const block = (status: Status, room = 65_536) => publisher().statusBlock(change, status, room);

describe("the status block, as the prototype words each state", () => {
  test("S1: round 1 is running", () => {
    expect(block({ kind: "running", sha: SHA_1, round: 1, again: false })).toBe(
      `### ${mark(26)} · Looking over ${at(SHA_1)}\n\nRound 1`,
    );
  });

  test("S2: three things to fix, the one off the diff with its lines through a permalink", () => {
    expect(block({ kind: "posted", posted: ROUND_1 })).toBe(
      [
        `### ${mark(26)} · 3 things to fix`,
        `Round 1 · ${at(SHA_1)}`,
        [
          `- **Blocking** · [Retry loop never stops on 4xx](${thread(101)}) · \`src/queue/send.ts\` line 11`,
          `- **Should fix** · [A thrown delivery waits for the broker](${thread(102)}) · \`src/queue/ack.ts\` line 19`,
          "- **Should fix** · Missing timeout on fetch · `src/http/client.ts` line 2",
          "  Not in the diff: when the webhook hangs, the request stays open forever, because the shared client sets no timeout.",
          "",
          `  https://github.com/sasensi/relay/blob/${SHA_1}/src/http/client.ts#L2`,
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  test("S3: a later round running shows no list from the round before", () => {
    expect(block({ kind: "running", sha: SHA_2, round: 2, again: false })).toBe(
      `### ${mark(26)} · Looking over ${at(SHA_2)}\n\nRound 2`,
    );
  });

  test("S4: nothing to fix", () => {
    expect(block({ kind: "posted", posted: round(1, SHA_1, []) })).toBe(
      `### ${mark(26)} · Nothing to fix\n\nRound 1 · ${at(SHA_1)}`,
    );
  });

  test("round 2: one thing to fix, with what was fixed and withdrawn so far", () => {
    const fixed = (f: Finding): Finding => ({ ...f, status: "verified_fixed", closedIn: 2 });
    const posted = round(2, SHA_2, [fixed(F1), { ...F2, status: "withdrawn", closedIn: 2 }, fixed(F3), F5]);
    expect(block({ kind: "posted", posted })).toBe(
      [
        `### ${mark(26)} · One thing to fix`,
        `Round 2 · ${at(SHA_2)} · 2 fixed, 1 withdrawn`,
        `- **Blocking** · [A refused delivery is acked](${thread(105)}) · \`src/queue/ack.ts\` line 18`,
      ].join("\n\n"),
    );
  });

  test("S5: all settled after three rounds", () => {
    const fixed = (f: Finding): Finding => ({ ...f, status: "verified_fixed" });
    const posted = round(3, SHA_3, [fixed(F1), { ...F2, status: "withdrawn" }, fixed(F3), fixed(F5)]);
    expect(block({ kind: "posted", posted })).toBe(
      `### ${mark(26)} · Nothing to fix\n\nRound 3 · ${at(SHA_3)} · 3 fixed, 1 withdrawn`,
    );
  });

  test("S6: the same commit looked over again, then a finding kept twice against won't fix needs the owner", () => {
    const claim = {
      kind: "wont_fix" as const,
      text: "Won't fix.",
      by: "dana",
      at: "2026-11-03T09:00:00Z",
      commentId: 7,
    };
    const keptOnce: Finding = { ...F2, claim, kept: 1 };
    const second = round(2, SHA_2, [{ ...F1, status: "verified_fixed", closedIn: 2 }, keptOnce]);
    expect(block({ kind: "posted", posted: second })).toBe(
      [
        `### ${mark(26)} · One thing to fix`,
        `Round 2 · ${at(SHA_2)} · 1 fixed`,
        `- **Should fix** · [A thrown delivery waits for the broker](${thread(102)}) · \`src/queue/ack.ts\` line 19`,
      ].join("\n\n"),
    );
    expect(block({ kind: "running", sha: SHA_2, round: 3, again: true })).toBe(
      `### ${mark(26)} · Looking over ${at(SHA_2)} again\n\nRound 3`,
    );
    const escalated: Finding = { ...F2, status: "escalated", claim, kept: 2 };
    const posted = round(3, SHA_2, [{ ...F1, status: "verified_fixed" }, escalated], {
      rounds: [
        { n: 1, sha: SHA_1 },
        { n: 2, sha: SHA_2 },
        { n: 3, sha: SHA_2 },
      ],
    });
    expect(block({ kind: "posted", posted })).toBe(
      [
        `### ${mark(26)} · Needs your look`,
        `Round 3 · ${at(SHA_2)} · 1 fixed`,
        [
          `- **Should fix** · [A thrown delivery waits for the broker](${thread(102)}) · \`src/queue/ack.ts\` line 19`,
          "  Said won't fix twice, kept twice: the owner decides on the thread.",
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  const NOW = Date.UTC(2026, 10, 3, 9, 0);

  test("S7: waiting for an AI's limit, until a time today", () => {
    const until = Date.UTC(2026, 10, 3, 14, 20);
    const deferral = { reason: "engine-limit" as const, engine: "claude" as const };
    expect(block({ kind: "waiting", sha: SHA_1, round: 1, deferral, until, now: NOW, posted: null })).toBe(
      `### ${mark(26)} · Waiting to look over ${at(SHA_1)}\n\nClaude reached its usage limit. The review starts when it resets, at 14:20.`,
    );
  });

  test("S8: the review failed", () => {
    expect(
      block({
        kind: "failed",
        sha: SHA_1,
        round: 1,
        failure: { kind: "review_failed", cause: null, limitMs: null },
        engine: "claude",
        posted: null,
      }),
    ).toBe(
      `### ${mark(26)} · Couldn't look over ${at(SHA_1)}\n\nClaude stopped before it finished. Push again, or comment \`/lookover review\`, to try again.`,
    );
  });
});

const signedIn = { bot: { id: 9001, login: "lookover[bot]" }, person: { id: 1, login: "sasensi" } };
type Waiting = Extract<Status, { kind: "waiting" }>;
type Failed = Extract<Status, { kind: "failed" }>;

describe("why a review waits, in the machine's time", () => {
  const NOW = Date.UTC(2026, 10, 3, 9, 0);
  const limit = { reason: "engine-limit" as const, engine: "codex" as const };
  const waiting = (deferral: Waiting["deferral"], until: number | null = null) =>
    block({ kind: "waiting", sha: SHA_1, round: 1, deferral, until, now: NOW, posted: null })?.split(
      "\n\n",
    )[1];

  test("an AI's limit that resets another day says the day", () => {
    expect(waiting(limit, Date.UTC(2026, 10, 4, 14, 20))).toBe(
      "Codex reached its usage limit. The review starts when it resets, on Wed 4 Nov at 14:20.",
    );
  });

  test("an AI's limit whose reset is unknown says it starts when it resets", () => {
    expect(waiting(limit)).toBe("Codex reached its usage limit. The review starts when it resets.");
  });

  test("the time is the machine's: its offset at the reset, the day too", () => {
    const status: Status = {
      kind: "waiting",
      sha: SHA_1,
      round: 1,
      deferral: limit,
      until: Date.UTC(2026, 10, 3, 22, 30),
      now: NOW,
      posted: null,
    };
    const east = createPublisher({
      writer: new FakeGitHost({ repo, ...signedIn, changes: [] }),
      person: () => 1,
      offset: () => 120,
    });
    expect(east.statusBlock(change, status, 65_536)).toEndWith("when it resets, on Wed 4 Nov at 00:30.");
  });

  test("every other reason says why in today's words, and when it starts", () => {
    expect(waiting({ reason: "paused" })).toBe(
      "Reviews are paused. The review starts once the owner resumes reviews.",
    );
    expect(waiting({ reason: "engine-signed-out", engine: "claude" })).toBe(
      "Claude is signed out. The review starts by itself once the owner signs Claude in.",
    );
    expect(waiting({ reason: "engine-missing", engine: "codex", unusable: null })).toBe(
      "Codex is not installed. The review starts by itself once Codex is installed.",
    );
    expect(waiting({ reason: "engine-failed-self-test", engine: "claude" })).toBe(
      "Claude didn't pass Lookover's safety check. The review starts by itself once a version of Claude passes it.",
    );
    expect(waiting({ reason: "engine-self-test-unfinished", engine: "codex" })).toBe(
      "Codex couldn't finish Lookover's safety check. The review starts by itself once Codex passes it.",
    );
    expect(waiting(null)).toBe("The review starts once the reviews before it are done.");
  });
});

describe("why a review failed", () => {
  const failed = (
    kind: Failed["failure"]["kind"],
    engine: "claude" | null = null,
    cause: Failed["failure"]["cause"] = null,
    limitMs: number | null = null,
  ) =>
    block({
      kind: "failed",
      sha: SHA_1,
      round: 1,
      failure: { kind, cause, limitMs },
      engine,
      posted: null,
    })?.split("\n\n")[1];
  const AGAIN = " Push again, or comment `/lookover review`, to try again.";

  test("its cause's sentence, then how to try again only where another try can help (ADR 0081)", () => {
    expect(failed("prepare_failed", null, "git_silent", 120_000)).toBe(
      `Git sent nothing for 2 minutes while Lookover got the code ready.${AGAIN}`,
    );
    expect(failed("review_failed", "claude", "engine_time_limit", 1_200_000)).toBe(
      "Claude ran past its 20-minute limit. A smaller pull request fits in the time.",
    );
    expect(failed("prepare_failed", null, "base_not_found")).toBe(
      "Lookover couldn't find where the commit branches off its base branch. Rebase onto the base branch, then push.",
    );
  });

  test("with no cause known, one sentence per kind of failure, then how to try again", () => {
    expect(failed("review_failed", "claude")).toBe(`Claude stopped before it finished.${AGAIN}`);
    expect(failed("review_failed")).toBe(`The reviewer stopped before it finished.${AGAIN}`);
    expect(failed("service_stopped")).toBe(`Lookover stopped before it finished.${AGAIN}`);
    expect(failed("prepare_failed")).toBe(`Lookover couldn't get the code ready.${AGAIN}`);
    expect(failed("host_failed")).toBe(`GitHub didn't answer.${AGAIN}`);
    expect(failed("publish_failed")).toBe(`Lookover couldn't post the round.${AGAIN}`);
    expect(failed("unexpected")).toBe(`Something went wrong in Lookover.${AGAIN}`);
  });
});

describe("waiting or failed after round 1", () => {
  const F1_ITEM = `- **Blocking** · [Retry loop never stops on 4xx](${thread(101)}) · \`src/queue/send.ts\` line 11`;

  test("the line names the round, and the last round's open findings stay listed under it", () => {
    const deferral = { reason: "engine-limit" as const, engine: "claude" as const };
    const posted = round(1, SHA_1, [F1]);
    expect(block({ kind: "waiting", sha: SHA_2, round: 2, deferral, until: null, now: 0, posted })).toBe(
      [
        `### ${mark(26)} · Waiting to look over ${at(SHA_2)}`,
        "Round 2 · Claude reached its usage limit. The review starts when it resets.",
        F1_ITEM,
      ].join("\n\n"),
    );
    expect(
      block({
        kind: "failed",
        sha: SHA_2,
        round: 2,
        failure: { kind: "host_failed", cause: null, limitMs: null },
        engine: null,
        posted,
      }),
    ).toBe(
      [
        `### ${mark(26)} · Couldn't look over ${at(SHA_2)}`,
        "Round 2 · GitHub didn't answer. Push again, or comment `/lookover review`, to try again.",
        F1_ITEM,
      ].join("\n\n"),
    );
  });
});

describe("the open findings", () => {
  const items = (findings: Finding[]) =>
    block({ kind: "posted", posted: round(2, SHA_2, findings) })
      ?.split("\n\n")
      .slice(2)
      .join("\n\n");

  test("escalated first, then by severity, then by id; one kept in the app is neither listed nor counted", () => {
    const consider = finding("F6", { severity: "consider", title: "Name the delay", posted: false });
    const disputed: Finding = {
      ...finding("F7", { severity: "should_fix", title: "Ack before the retry", commented: false }),
      status: "escalated",
      claim: { kind: "disputed", text: "Not a bug.", by: "dana", at: "2026-11-03T09:00:00Z", commentId: 8 },
    };
    const shown = block({ kind: "posted", posted: round(2, SHA_2, [F2, F1, consider, disputed]) }) ?? "";
    expect(shown.split("\n\n")[0]).toBe(`### ${mark(26)} · Needs your look`);
    expect(shown.split("\n\n")[2]).toBe(
      [
        "- **Should fix** · Ack before the retry · `src/queue/send.ts` line 11",
        "  Disputed, and the finder still calls it wrong: the owner decides on the thread.",
        `- **Blocking** · [Retry loop never stops on 4xx](${thread(101)}) · \`src/queue/send.ts\` line 11`,
        `- **Should fix** · [A thrown delivery waits for the broker](${thread(102)}) · \`src/queue/ack.ts\` line 19`,
      ].join("\n"),
    );
    expect(block({ kind: "posted", posted: round(2, SHA_2, [F1, consider]) })?.split("\n\n")[0]).toBe(
      `### ${mark(26)} · One thing to fix`,
    );
  });

  test("a blocking finding the confirm pass didn't confirm reads Should fix, unconfirmed", () => {
    const demoted = finding("F1", {
      severity: "should_fix",
      confirmation: {
        verdict: "unsure",
        by: "codex",
        reason: "No 4xx reaches it.",
        evidence: [],
        demoted: true,
      },
    });
    expect(items([demoted])).toStartWith("- **Should fix, unconfirmed** · ");
  });

  test("a finding the owner dismissed counts as withdrawn", () => {
    const shown = block({ kind: "posted", posted: round(2, SHA_2, [{ ...F1, status: "dismissed" }]) });
    expect(shown?.split("\n\n")[1]).toBe(`Round 2 · ${at(SHA_2)} · 1 withdrawn`);
  });

  test("off the diff, a range is shown on the commit its lines are on, a removed line on the base", () => {
    const range = finding("F3", { commented: false, line: 2, endLine: 4, body: "No timeout." });
    const removed = finding("F4", {
      commented: false,
      side: "base",
      file: "src/old name.ts",
      line: 7,
      body: "Was used.",
    });
    expect(items([range, removed])).toBe(
      [
        "- **Blocking** · Retry loop never stops on 4xx · `src/queue/send.ts` lines 2 to 4",
        "  Not in the diff: no timeout.",
        "",
        `  https://github.com/sasensi/relay/blob/${SHA_1}/src/queue/send.ts#L2-L4`,
        "- **Blocking** · Retry loop never stops on 4xx · `src/old name.ts` old line 7",
        "  Not in the diff: was used.",
        "",
        `  https://github.com/sasensi/relay/blob/${BASE}/src/old%20name.ts#L7`,
      ].join("\n"),
    );
  });

  test("a title and a body are filtered: no mention, no tag; a link's text can't close the link", () => {
    const Z = "\u{200B}";
    const hostile = finding("F1", { title: "Ping @dana [here]" });
    const off = finding("F2", { commented: false, body: "Ask @lee, <img src=x>." });
    const shown = items([hostile, off]) ?? "";
    expect(shown).toContain(`[Ping @${Z}dana \\[here\\]](${thread(101)})`);
    expect(shown).toContain(`Not in the diff: ask @${Z}lee, <${Z}img src=x>.`);
  });
});

describe("the room the description leaves", () => {
  const off = [1, 2, 3, 4].map((n) =>
    finding(`F1${n}`, {
      commented: false,
      line: n,
      body: `Problem ${n}.`,
      severity: n === 4 ? "consider" : "blocking",
    }),
  );
  const status: Status = { kind: "posted", posted: round(1, SHA_1, off) };
  const whole = block(status) ?? "";
  const size = (text: string) => [...text].length;
  const bare = `### ${mark(26)} · 4 things to fix\n\nRound 1 · ${at(SHA_1)}`;
  const first =
    "- **Blocking** · Retry loop never stops on 4xx · `src/queue/send.ts` line 1\n  Not in the diff: problem 1.";

  test("a block that fits is whole, to the character", () => {
    expect(block(status, size(whole))).toBe(whole);
  });

  test("one character short, the least urgent item goes first, from the end", () => {
    const shown = block(status, size(whole) - 1) ?? "";
    expect(shown).toContain("problem 3.");
    expect(shown).not.toContain("problem 4.");
    expect(shown.split("\n\n")[0]).toBe(`### ${mark(26)} · 4 things to fix`);
  });

  test("then the permalinks; then the heading and its line alone; then nothing", () => {
    expect(block(status, size(`${bare}\n\n${first}`))).toBe(`${bare}\n\n${first}`);
    expect(block(status, size(bare))).toBe(bare);
    expect(block(status, size(bare) - 1)).toBeNull();
  });
});
