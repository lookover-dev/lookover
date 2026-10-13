// S2 "The happy loop" (ADR 0046, I-164's story): the owner's agent, Claude, opens #148 "Add rate limiting to
// /v1/invoices" twenty seconds after the load. Codex finds three, F1 the API key logged on `rateLimit.ts` line 42,
// and Claude confirms them; round 1 is posted. The agent pushes its fix and comments `/lookover review`: round 2
// verifies two fixed and raises a Consider, which from round 2 is not posted (ADR 0042) and stays in the app. The
// agent adds the missing test and asks again: round 3 settles the loop, the Consider still in the app. #148 is
// also S1's first review and S7's finding, so its data is exported.
import { commitSha } from "@lookover/contracts";
import type { Scenario, ScenarioChange } from "../scenario.ts";
import {
  added,
  BY_CLAUDE,
  CONFIRM_MS,
  FIND_MS,
  LEDGER_API,
  MIN,
  OWNER,
  SHORT_FIND_MS,
  unified,
} from "./ledger-api.ts";

/** `src/middleware/rateLimit.ts` as the agent wrote it: the throttled request's headers logged on line 42. */
const LIMITER = [
  'import type { NextFunction, Request, Response } from "express";',
  'import { logger } from "../logger.ts";',
  "",
  "/** How many requests a client may make in one window. */",
  "export interface RateLimit {",
  "  limit: number;",
  "  windowMs: number;",
  "}",
  "",
  "interface Window {",
  "  startedAt: number;",
  "  hits: number;",
  "}",
  "",
  "/** The windows by client key. */",
  "const windows = new Map<string, Window>();",
  "",
  "/** The client a request counts against: its API key, else its address. */",
  "function clientOf(req: Request): string {",
  '  return req.header("authorization") ?? req.ip ?? "unknown";',
  "}",
  "",
  "/** The window of `client` at `now`: the current one, or a new one once it has run out. */",
  "function windowOf(client: string, now: number, windowMs: number): Window {",
  "  const current = windows.get(client);",
  "  if (current && now - current.startedAt < windowMs) return current;",
  "  const fresh = { startedAt: now, hits: 0 };",
  "  windows.set(client, fresh);",
  "  return fresh;",
  "}",
  "",
  "/** Express middleware: answers 429 once a client passes its limit in the window. */",
  "export function rateLimit({ limit, windowMs }: RateLimit) {",
  "  return (req: Request, res: Response, next: NextFunction) => {",
  "    const window = windowOf(clientOf(req), Date.now(), windowMs);",
  "    window.hits += 1;",
  "    const hits = window.hits;",
  '    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - hits)));',
  "",
  "    // throttle and log",
  "    if (hits > limit) {",
  '      logger.info("throttled", req.headers);',
  "      return res.status(429).end();",
  "    }",
  "    next();",
  "  };",
  "}",
];

const LOGGED = '      logger.info("throttled", req.headers);';
const REDACTED = '      logger.info("throttled", redact(req.headers));';

/** The fix: the headers redacted before they are logged (one import more, so every line below moves one down). */
const LIMITER_FIXED = [
  ...LIMITER.slice(0, 2),
  'import { redact } from "../redact.ts";',
  ...LIMITER.slice(2).map((line) => (line === LOGGED ? REDACTED : line)),
];

/** `src/routes/invoices.ts`: the limiter mounted, and the page size read from the query string. */
const ROUTES = (limit: string) =>
  unified(
    "diff --git a/src/routes/invoices.ts b/src/routes/invoices.ts",
    "--- a/src/routes/invoices.ts",
    "+++ b/src/routes/invoices.ts",
    "@@ -1,4 +1,6 @@",
    ' import { Router } from "express";',
    ' import { listInvoices } from "../invoices/list.ts";',
    '+import { rateLimit } from "../middleware/rateLimit.ts";',
    " ",
    " export const invoices = Router();",
    "+invoices.use(rateLimit({ limit: 100, windowMs: 60_000 }));",
    '@@ -84,5 +86,6 @@ invoices.get("/v1/invoices", async (req, res) => {',
    "   const account = req.query.account;",
    '   if (typeof account !== "string") return res.status(400).end();',
    "-  const page = await listInvoices(account, { limit: 50 });",
    `+${limit}`,
    "+  const page = await listInvoices(account, { limit });",
    "   res.json(page);",
    " });",
  );

const UNCAPPED = "  const limit = Number(req.query.limit ?? 50);";
const CAPPED = "  const limit = Math.min(Number(req.query.limit ?? 50), 100);";

/** The test the agent adds last: the request past the limit is answered 429. */
const LIMITER_TEST = added("test/rateLimit.test.ts", [
  'import { expect, test } from "bun:test";',
  'import { rateLimit } from "../src/middleware/rateLimit.ts";',
  "",
  'test("the request past the limit is answered 429", () => {',
  "  const limiter = rateLimit({ limit: 1, windowMs: 60_000 });",
  "  const statuses: number[] = [];",
  "  const res = {",
  "    setHeader: () => {},",
  "    status: (code: number) => {",
  "      statuses.push(code);",
  "      return { end: () => {} };",
  "    },",
  "  };",
  '  const req = { header: () => "key-1", headers: {} };',
  "  limiter(req as never, res as never, () => {});",
  "  limiter(req as never, res as never, () => {});",
  "  expect(statuses).toEqual([429]);",
  "});",
]);

export const RATE_LIMITING: ScenarioChange = {
  number: 148,
  title: "Add rate limiting to /v1/invoices",
  branch: "rate-limit-invoices",
  author: OWNER,
  commits: [
    {
      sha: commitSha("a1f9c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6"),
      message: `Add rate limiting to /v1/invoices\n\n${BY_CLAUDE}`,
      diff: added("src/middleware/rateLimit.ts", LIMITER) + ROUTES(UNCAPPED),
      find: {
        notes: "The limiter counts per key in a fixed window. Three things to raise, one of them a leak.",
        findings: [
          {
            path: "src/middleware/rateLimit.ts",
            line: 42,
            lineText: LOGGED,
            severity: "blocking",
            category: "security",
            title: "The API key is written to the request log",
            body: "When a client is throttled, the limiter logs the full request headers, Authorization included, so anyone who can read the logs can reuse the key.",
            defectKey: "key_in_log",
            suggestion: REDACTED,
          },
          {
            path: "src/routes/invoices.ts",
            line: 88,
            lineText: UNCAPPED,
            severity: "should_fix",
            category: "correctness",
            title: "The page size is not capped",
            body: "When a request asks for limit=100000, the handler loads every invoice of the account into memory, because the limit comes straight from the query string.",
            defectKey: "page_size_uncapped",
            suggestion: CAPPED,
          },
          {
            path: "src/middleware/rateLimit.ts",
            line: 43,
            lineText: "      return res.status(429).end();",
            severity: "should_fix",
            category: "tests",
            title: "The 429 answer has no test",
            body: "The limiter's one behaviour, answering 429 once a client passes its limit, is not tested, so a change to the window logic could stop it unseen.",
            defectKey: "no_429_test",
          },
        ],
        usage: { inputTokens: 4_100, outputTokens: 820 },
        tookMs: FIND_MS,
      },
      confirm: {
        notes: "All three hold.",
        verdicts: [
          {
            id: "C1",
            verdict: "confirmed",
            reason: "req.headers holds Authorization, and logger.info writes its second argument whole.",
            evidence: ["src/middleware/rateLimit.ts:20", "src/middleware/rateLimit.ts:42"],
            severity: "blocking",
          },
          {
            id: "C2",
            verdict: "confirmed",
            reason: "Nothing bounds the number between the query string and listInvoices.",
            evidence: ["src/routes/invoices.ts:88"],
            severity: "should_fix",
          },
          {
            id: "C3",
            verdict: "confirmed",
            reason: "No test in the diff calls the middleware.",
            evidence: ["src/middleware/rateLimit.ts:43"],
            severity: "should_fix",
          },
        ],
        usage: { inputTokens: 2_300, outputTokens: 310 },
        tookMs: CONFIRM_MS,
      },
    },
    {
      sha: commitSha("b2c3d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8"),
      message: `Redact the headers before logging, cap the page size\n\n${BY_CLAUDE}`,
      diff: added("src/middleware/rateLimit.ts", LIMITER_FIXED) + ROUTES(CAPPED),
      find: {
        notes: "The key is redacted and the page size capped. One thing to consider about the counters.",
        findings: [
          {
            path: "src/middleware/rateLimit.ts",
            line: 17,
            lineText: "const windows = new Map<string, Window>();",
            severity: "consider",
            category: "reliability",
            title: "The counters are lost on a restart",
            body: "When the service restarts or a second instance runs, every client starts again from zero, because the windows live in a Map in memory; a shared store would keep them.",
            defectKey: "counters_in_memory",
          },
        ],
        earlier: [
          { id: "F1", present: false, why: "The headers go through redact before they are logged." },
          { id: "F2", present: false, why: "The limit is capped at 100." },
          { id: "F3", present: true, why: "Still no test calls the middleware." },
        ],
        usage: { inputTokens: 4_300, outputTokens: 410 },
        tookMs: SHORT_FIND_MS,
      },
      // No confirm pass: a Consider from round 2 is never posted, so it is not double-checked (ADR 0044).
    },
    {
      sha: commitSha("c3d4e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9"),
      message: `Test the 429 answer of the limiter\n\n${BY_CLAUDE}`,
      diff: added("src/middleware/rateLimit.ts", LIMITER_FIXED) + ROUTES(CAPPED) + LIMITER_TEST,
      find: {
        notes: "The test covers the 429. Nothing new.",
        findings: [],
        earlier: [
          { id: "F3", present: false, why: "test/rateLimit.test.ts calls the limiter past its limit." },
          { id: "F4", present: true, why: "The windows are still a Map in memory." },
        ],
        emptyReason: "The new commit adds a test and changes no code.",
        usage: { inputTokens: 4_600, outputTokens: 230 },
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

export const S2: Scenario = {
  id: "S2",
  title: "The happy loop",
  what: "Your agent opens a pull request. Lookover reviews it, the agent fixes and asks again, until it is settled.",
  steps: [
    "Wait for #148 to appear on Home, or press Step to the next event.",
    "Open it and watch round 1: Codex finds three, Claude double-checks them.",
    "The agent pushes a fix and asks again. Round 2 finds a Consider: from round 2 a Consider is not posted, so it stays in the app.",
    "The agent adds the missing test and asks again. Round 3 settles the loop, the Consider still in the app.",
  ],
  later: "",
  path: "/",
  world: LEDGER_API,
  changes: [RATE_LIMITING],
  script: [
    { at: MIN + 20_000, move: { kind: "open", change: 148 } },
    { at: 6 * MIN, move: { kind: "push", change: 148 } },
    { at: 6 * MIN + 10_000, move: { kind: "ask", change: 148 } },
    { at: 10 * MIN, move: { kind: "push", change: 148 } },
    { at: 10 * MIN + 10_000, move: { kind: "ask", change: 148 } },
  ],
  seed: MIN,
};
