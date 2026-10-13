// `lookover.review-result/v1` through contracts' entry: the schema and `readResult`, on a worked example.
import { describe, expect, test } from "bun:test";
import {
  RESULT_MARKER,
  REVIEW_RESULT_SCHEMA,
  type ReviewResult,
  type ReviewResultFinding,
  readResult,
  reviewResultV1,
} from "./index.ts";

// A valid `lookover.review-result/v1` document: spike 05's example (round 2 of a loop on a GitHub pull
// request), written again in the frozen format with ADR 0029 (no round cap), ADR 0030 (`verified_fixed`, a
// claim) and ADR 0039 (only posted findings count) applied. Every field the schema knows appears at least once.
const ROUND_1 = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const FIX = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1";
const ROUND_2 = "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2";

const reviewResultExample: ReviewResult = {
  schema: REVIEW_RESULT_SCHEMA,
  change: {
    host: "github",
    repository: "sasensi/demo-app",
    number: 42,
    url: "https://github.com/sasensi/demo-app/pull/42",
    head_sha: ROUND_2,
    base_sha: "0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3",
  },
  run: {
    id: "run_01JB7Q2M4X",
    state: "done",
    trigger: "push",
    engine: { finder: "claude", confirmer: "codex", model: "claude-opus-5-5" },
    ruled_out: 1,
    started_at: "2026-09-30T10:12:05Z",
    completed_at: "2026-09-30T10:14:41Z",
  },
  verdict: {
    value: "blocking",
    conclusion: "neutral",
    headline: "2 blocking · round 2 · 1 verified fixed, 1 withdrawn",
  },
  loop: {
    state: "open",
    round: 2,
    next_action: "fix",
    reasons: [],
    history: [
      {
        run_id: "run_01JB7N8K1A",
        round: 1,
        sha: ROUND_1,
        state: "done",
        verdict: "blocking",
        trigger: "opened",
        new: 3,
        verified_fixed: 0,
        withdrawn: 0,
        kept: 0,
        completed_at: "2026-09-30T09:58:10Z",
      },
      {
        run_id: "run_01JB7Q2M4X",
        round: 2,
        sha: ROUND_2,
        state: "done",
        verdict: "blocking",
        trigger: "push",
        new: 1,
        verified_fixed: 1,
        withdrawn: 1,
        kept: 1,
        completed_at: "2026-09-30T10:14:41Z",
      },
    ],
  },
  // Over posted findings only: F5 is `consider`, kept off the pull request, and counted only as kept in the app.
  counts: {
    open: { blocking: 2, should_fix: 0, consider: 0 },
    escalated: 0,
    verified_fixed: 1,
    withdrawn: 1,
    acknowledged: 0,
    dismissed: 0,
    obsolete: 0,
    kept_in_app: 1,
  },
  findings: [
    {
      id: "F1",
      fingerprints: { location: "loc:9f2c41d0b7", meaning: "sem:4e1a77c0d9" },
      status: "verified_fixed",
      posted: true,
      placement: "inline",
      needs_action_by: "none",
      severity: "blocking",
      category: "correctness",
      title: "Retry loop never stops on 4xx",
      body: "When the upstream returns a 4xx, `sendWithRetry` retries forever because only 5xx sets `done`. A bad request then blocks the worker.",
      location: { path: "src/queue/send.ts", start_line: 41, end_line: 48, side: "head", sha: ROUND_1 },
      suggestion: null,
      rule: null,
      evidence: ["src/queue/send.ts:44"],
      confidence: "high",
      raised: { round: 1, sha: ROUND_1, on_fix: false },
      confirmation: { verdict: "not_checked", demoted: false },
      last_checked: { round: 2, sha: ROUND_2 },
      thread: {
        id: "PRRT_kwDOAbc123",
        comment_id: 2001,
        url: "https://github.com/sasensi/demo-app/pull/42#discussion_r2001",
        resolved: true,
      },
      claim: {
        kind: "claimed_fixed",
        commit: FIX,
        text: "Stop on any non-retryable status.",
        by: "sasensi",
        at: "2026-09-30T10:05:00Z",
        count: 1,
      },
      resolution: {
        kind: "verified_fixed",
        round: 2,
        explanation: "4xx now breaks out of the loop (src/queue/send.ts:45).",
      },
      agent_prompt: null,
    },
    {
      id: "F2",
      fingerprints: { location: "loc:31aa0c77e2", meaning: "sem:b08f2d61e3" },
      status: "withdrawn",
      posted: true,
      placement: "inline",
      needs_action_by: "none",
      severity: "should_fix",
      category: "reliability",
      title: "Missing timeout on fetch",
      body: "The call has no timeout, so a hung upstream holds the request open.",
      location: { path: "src/queue/send.ts", start_line: 30, end_line: 30, side: "head", sha: ROUND_1 },
      raised: { round: 1, sha: ROUND_1, on_fix: false },
      confirmation: { verdict: "not_checked", demoted: false },
      thread: { id: "PRRT_kwDOAbc124", comment_id: 2002, resolved: true },
      claim: {
        kind: "disputed",
        text: "The shared client sets a 10 s timeout: src/http/client.ts:12.",
        by: "sasensi",
        at: "2026-09-30T10:05:00Z",
        count: 1,
      },
      resolution: {
        kind: "withdrawn",
        round: 2,
        explanation:
          "Confirmed: the default client timeout applies (src/http/client.ts:12). Not raised again on this pull request.",
        evidence: ["src/http/client.ts:12"],
      },
    },
    {
      id: "F3",
      fingerprints: { location: "loc:c08d5e1f44", meaning: "sem:7d2e90ab15" },
      status: "open",
      posted: true,
      placement: "inline",
      needs_action_by: "agent",
      severity: "blocking",
      category: "security",
      title: "Webhook signature compared with ==",
      body: "`verify()` compares the HMAC with `===`, which leaks timing. Use `timingSafeEqual`.",
      location: { path: "src/webhooks/verify.ts", start_line: 18, end_line: 18, side: "head", sha: ROUND_1 },
      raised: { round: 1, sha: ROUND_1, on_fix: false },
      confirmation: { verdict: "not_checked", demoted: false },
      thread: { id: "PRRT_kwDOAbc125", comment_id: 2003, resolved: false },
      claim: {
        kind: "wont_fix",
        text: "Only internal callers reach this endpoint.",
        by: "sasensi",
        at: "2026-09-30T10:05:00Z",
        count: 1,
      },
      resolution: {
        kind: "kept",
        round: 2,
        explanation:
          "The route is public: src/routes.ts:77 mounts it without the internal-network guard. Fix it, or reply with new evidence. A second dispute hands this finding to a human.",
        evidence: ["src/routes.ts:77"],
      },
      agent_prompt:
        "In src/webhooks/verify.ts:18 replace the === comparison with crypto.timingSafeEqual on equal-length buffers. Verify first.",
    },
    {
      id: "F4",
      fingerprints: { location: "loc:77be90aa13", meaning: "sem:e5c3016f28" },
      status: "open",
      posted: true,
      placement: "inline",
      needs_action_by: "agent",
      severity: "blocking",
      category: "correctness",
      title: "Fix drops the last batch item",
      body: "The new `break` in the F1 fix runs before the final `ack()`, so the last message of a batch is never acknowledged and is redelivered.",
      location: { path: "src/queue/send.ts", start_line: 45, end_line: 47, side: "head", sha: ROUND_2 },
      raised: { round: 2, sha: ROUND_2, on_fix: true },
      confirmation: { verdict: "not_checked", demoted: false },
      thread: { id: "PRRT_kwDOAbc130", comment_id: 2050, resolved: false },
      claim: null,
      resolution: null,
      agent_prompt:
        "Move ack() before the break in src/queue/send.ts:45-47 so the last item is acknowledged. Verify first.",
    },
    {
      id: "F5",
      fingerprints: { location: "loc:0d3e2b9c55", meaning: "sem:12fa6b8c90" },
      status: "open",
      posted: false,
      placement: "check_only",
      needs_action_by: "none",
      severity: "consider",
      category: "maintainability",
      title: "Magic number for retry delay",
      body: "`250` appears twice; a named constant would make the backoff easier to tune.",
      location: { path: "src/queue/send.ts", start_line: 52, end_line: 52, side: "head", sha: ROUND_1 },
      raised: { round: 1, sha: ROUND_1, on_fix: false },
      confirmation: { verdict: "not_checked", demoted: false },
      thread: null,
      claim: null,
      resolution: null,
    },
  ],
  truncated: false,
};

describe("lookover.review-result/v1", () => {
  test("accepts spike 05's example, updated for ADRs 0029, 0030 and 0039, and keeps every field", () => {
    const parsed = reviewResultV1.safeParse(reviewResultExample);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(reviewResultExample);
  });

  test("rejects a document missing a required field, naming it", () => {
    const { findings: _, ...withoutFindings } = reviewResultExample;
    const parsed = reviewResultV1.safeParse(withoutFindings);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join("."))).toEqual(["findings"]);
  });

  test("rejects another schema name, such as a spike's: only the frozen one is the format", () => {
    const old = { ...reviewResultExample, schema: "spike.review-result/v1" };
    expect(reviewResultV1.safeParse(old).success).toBe(false);
  });

  test("a finding is posted exactly when it is inline or in the summary", () => {
    const [first, ...rest] = reviewResultExample.findings;
    const contradiction = { ...first, posted: false, placement: "inline" };
    const parsed = reviewResultV1.safeParse({ ...reviewResultExample, findings: [contradiction, ...rest] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["findings", 0, "posted"]);
  });

  test("accepts a round's confirmer and each finding's confirmation (ADR 0044)", () => {
    // F1 confirmed, F2 unsure, F3 not checked and lowered from blocking ("Should fix, unconfirmed"); F4 and F5
    // written before the confirm pass, without one.
    const confirmations: ReviewResultFinding["confirmation"][] = [
      {
        verdict: "confirmed",
        by: "claude",
        reason: "Only 5xx sets `done`.",
        evidence: ["src/queue/send.ts:44"],
      },
      {
        verdict: "unsure",
        by: "claude",
        reason: "The client may set a timeout.",
        evidence: [],
        demoted: false,
      },
      { verdict: "not_checked", demoted: true },
    ];
    const confirmed: ReviewResult = {
      ...reviewResultExample,
      run: { ...reviewResultExample.run, engine: { finder: "codex", confirmer: "claude" } },
      findings: reviewResultExample.findings.map((f, i) => {
        const confirmation = confirmations[i];
        return confirmation ? { ...f, confirmation } : f;
      }),
    };
    const parsed = reviewResultV1.safeParse(confirmed);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(confirmed);
  });

  test("a round nobody confirmed says so; refuted is never a finding's confirmation", () => {
    const [first, ...rest] = reviewResultExample.findings;
    const unconfirmed = {
      ...reviewResultExample,
      run: { ...reviewResultExample.run, engine: { finder: "claude", confirmer: null } },
    };
    expect(reviewResultV1.safeParse(unconfirmed).success).toBe(true);
    const refuted = {
      ...first,
      confirmation: { verdict: "refuted", by: "claude", reason: "", evidence: [] },
    };
    const parsed = reviewResultV1.safeParse({ ...reviewResultExample, findings: [refuted, ...rest] });
    expect(parsed.success).toBe(false);
  });

  test("only an inline finding says where its comment went", () => {
    const [first, ...rest] = reviewResultExample.findings;
    const placed = { path: "src/queue/send.ts", start_line: 44, end_line: 44, side: "head" };
    const inline = { ...first, placement: "inline", posted: true, placed };
    expect(reviewResultV1.safeParse({ ...reviewResultExample, findings: [inline, ...rest] }).success).toBe(
      true,
    );
    const summary = { ...inline, placement: "summary" };
    const parsed = reviewResultV1.safeParse({ ...reviewResultExample, findings: [summary, ...rest] });
    expect(parsed.error?.issues[0]?.path).toEqual(["findings", 0, "placed"]);
  });
});

describe("readResult", () => {
  // The line as `publish` writes it: the marker, the JSON, the comment's end, last in the check's text.
  const line = `${RESULT_MARKER}${JSON.stringify(reviewResultExample)} -->`;
  const text = `Looked over c3d4e5f. 2 things to fix.\n${line}`;

  test("reads the result from the last line of a check's text, trailing whitespace or not", () => {
    expect(readResult(text)).toEqual(reviewResultExample);
    expect(readResult(`${text}\n`)).toEqual(reviewResultExample);
  });

  test("a text without a result, or with one the host cut, reads as none", () => {
    expect(readResult("Looked over c3d4e5f. Nothing to fix.")).toBeNull();
    expect(readResult(text.slice(0, -20))).toBeNull();
    expect(readResult(`${RESULT_MARKER}{"schema":"lookover.review-result/v2"} -->`)).toBeNull();
  });
});
