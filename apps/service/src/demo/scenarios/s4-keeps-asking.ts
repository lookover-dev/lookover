// S4 "The agent keeps asking without fixing" (ADR 0046): the owner's agent, Claude, opens #149 "Accept payment
// webhooks"; Codex finds, Claude double-checks (a blocking finding must be confirmed to stay blocking). Round 1
// raises one: the webhook's signature is never checked. Twice the agent answers F1 "Won't fix" on its thread
// (with the owner's login, as `lookover wait`'s agent does), pushes something else and comments `/lookover review`.
// Round 2 finds F1 still there and keeps it, with Lookover's reply on the thread; round 3 keeps it against its
// author a second time and escalates it: only the owner settles it now (ADR 0052, "Needs you").
import { commitSha, findingId } from "@lookover/contracts";
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
} from "./ledger-api.ts";

const UNCHECKED = "  const event = JSON.parse(req.body.toString()) as PaymentEvent;";

/** `src/webhooks/payments.ts` as the agent leaves it after each push: `extra` lines added before the handler. */
const HANDLER = (extra: string[]) => [
  'import type { Request, Response } from "express";',
  'import { markPaid } from "../invoices/paid.ts";',
  'import { logger } from "../logger.ts";',
  "",
  "interface PaymentEvent {",
  "  type: string;",
  "  invoice: string;",
  "}",
  ...extra,
  "",
  "/** The payment provider's webhook: an invoice paid is marked paid. */",
  "export async function paymentWebhook(req: Request, res: Response) {",
  UNCHECKED,
  '  if (event.type === "payment.succeeded") await markPaid(event.invoice);',
  "  res.status(204).end();",
  "}",
];

const LOGGED = [
  "",
  "/** Every event received, for support. */",
  'const received = (event: PaymentEvent) => logger.info("payment event", event.type);',
];
const COUNTED = [...LOGGED, "", "let count = 0;", "export const receivedCount = () => count;"];

/** Where the unchecked parse sits in a version of the handler. */
const lineOf = (lines: string[]) => lines.indexOf(UNCHECKED) + 1;

/** Why F1 is still there, as Codex says it in rounds 2 and 3. */
const STILL_THERE = "The body is still parsed and trusted with no signature check.";

const F1 = findingId("F1");
/** The agent's two answers on F1's thread: the same claim, won't fix, each before it asks again. */
const FIRST_ANSWER = "Won't fix: the provider only calls us from its own IP range.";
const SECOND_ANSWER = "Won't fix. The firewall drops every other sender.";

const PAYMENTS: ScenarioChange = {
  number: 149,
  title: "Accept payment webhooks",
  branch: "payment-webhooks",
  author: OWNER,
  commits: [
    {
      sha: commitSha("a7b8c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3"),
      message: `Accept payment webhooks\n\n${BY_CLAUDE}`,
      diff: added("src/webhooks/payments.ts", HANDLER([])),
      find: {
        notes: "One thing, and it blocks.",
        findings: [
          {
            path: "src/webhooks/payments.ts",
            line: lineOf(HANDLER([])),
            lineText: UNCHECKED,
            severity: "blocking",
            category: "security",
            title: "Anyone can mark an invoice paid",
            body: "When anyone posts a payment.succeeded event to this URL, the invoice is marked paid, because the provider's signature header is never checked before the body is trusted.",
            defectKey: "webhook_signature_unchecked",
          },
        ],
        usage: { inputTokens: 3_200, outputTokens: 420 },
        tookMs: FIND_MS,
      },
      confirm: {
        notes: "It holds.",
        verdicts: [
          {
            id: "C1",
            verdict: "confirmed",
            reason: "Nothing reads the signature header; the parsed body goes straight to markPaid.",
            evidence: [`src/webhooks/payments.ts:${lineOf(HANDLER([]))}`],
            severity: "blocking",
          },
        ],
        usage: { inputTokens: 1_900, outputTokens: 170 },
        tookMs: CONFIRM_MS,
      },
    },
    {
      sha: commitSha("b8c9d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4"),
      message: `Log every payment event\n\n${BY_CLAUDE}`,
      diff: added("src/webhooks/payments.ts", HANDLER(LOGGED)),
      find: {
        notes: "The new log line is fine. F1 is not fixed.",
        findings: [],
        earlier: [{ id: "F1", present: true, why: STILL_THERE }],
        emptyReason: "The push adds a log line and nothing else.",
        usage: { inputTokens: 3_400, outputTokens: 210 },
        tookMs: SHORT_FIND_MS,
      },
    },
    {
      sha: commitSha("c9d0e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5"),
      message: `Count the payment events\n\n${BY_CLAUDE}`,
      diff: added("src/webhooks/payments.ts", HANDLER(COUNTED)),
      find: {
        notes: "A counter added. F1 is still not fixed.",
        findings: [],
        earlier: [{ id: "F1", present: true, why: STILL_THERE }],
        emptyReason: "The push adds a counter and nothing else.",
        usage: { inputTokens: 3_500, outputTokens: 200 },
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

export const S4: Scenario = {
  id: "S4",
  title: "The agent keeps asking",
  what: 'Your agent answers the blocking finding "won\'t fix" and asks again without fixing it. The second time, Lookover hands it to you.',
  steps: [
    "Wait for #149 to appear on Home, or press Step to the next event. Round 1 finds one blocking finding.",
    'The agent replies "won\'t fix", pushes something else and asks again. Round 2 keeps it: its card shows the reply and "Kept once."',
    "Once more: round 3 keeps it again, and it needs you.",
  ],
  later: "",
  path: "/",
  world: LEDGER_API,
  changes: [PAYMENTS],
  script: [
    { at: MIN + 20_000, move: { kind: "open", change: 149 } },
    {
      at: 6 * MIN - 10_000,
      move: { kind: "reply", change: 149, finding: F1, by: OWNER, text: FIRST_ANSWER },
    },
    { at: 6 * MIN, move: { kind: "push", change: 149 } },
    { at: 6 * MIN + 10_000, move: { kind: "ask", change: 149 } },
    {
      at: 10 * MIN - 10_000,
      move: { kind: "reply", change: 149, finding: F1, by: OWNER, text: SECOND_ANSWER },
    },
    { at: 10 * MIN, move: { kind: "push", change: 149 } },
    { at: 10 * MIN + 10_000, move: { kind: "ask", change: 149 } },
  ],
  seed: MIN,
};
