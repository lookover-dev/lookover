// S4 "The agent keeps asking without fixing" (ADR 0046): the owner's agent, Claude, opens #149 "Accept payment
// webhooks"; Codex finds, Claude double-checks (a blocking finding must be confirmed to stay blocking). Round 1
// raises one: the webhook's signature is never checked. Twice the agent answers F1 "Won't fix" on its thread
// (with the owner's login, as `lookover wait`'s agent does), pushes something else and comments `/lookover review`.
// Round 2 finds F1 still there and keeps it, with Lookover's reply on the thread; round 3 keeps it against its
// author a second time and escalates it: only the owner settles it now (ADR 0052, "Needs you"). Once #149's story is
// over, #154 "Refund an invoice" goes the same way, and the owner tells the agent to accept its escalated F1 as is:
// the agent's settle comment, on the owner's word with their reason (ADR 0101), is read at the next poll and settles
// it as the app's Accept does, through the agent. #149's F1 stays the owner's to settle in the app.
import { commitSha, findingId } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange } from "../scenario.ts";
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

/** Where `line` sits in a version of a file: the unchecked parse by default. */
const lineOf = (lines: string[], line = UNCHECKED) => lines.indexOf(line) + 1;

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

const UNGUARDED = "  await provider.refunds.create({ charge: invoice.chargeId, amount: invoice.total });";

/** `src/invoices/refund.ts` as the agent leaves it after each push: `extra` lines added before the function. */
const REFUND = (extra: string[]) => [
  'import { findInvoice } from "./find.ts";',
  'import { provider } from "../payments/provider.ts";',
  ...extra,
  "",
  "/** Refunds an invoice's payment in full: the invoice page's Refund button. */",
  "export async function refundInvoice(invoiceId: string) {",
  "  const invoice = await findInvoice(invoiceId);",
  UNGUARDED,
  "}",
];

const LOGGED_REFUNDS = [
  'import { logger } from "../logger.ts";',
  "",
  "/** Every refund asked for, for support. */",
  'const asked = (invoiceId: string) => logger.info("refund asked", invoiceId);',
];
const COUNTED_REFUNDS = [
  ...LOGGED_REFUNDS,
  "",
  "let refunds = 0;",
  "export const refundCount = () => refunds;",
];

/** Why #154's F1 is still there, as Codex says it in rounds 2 and 3. */
const STILL_UNGUARDED =
  "The refund is still sent with no idempotency key and the invoice is not marked first.";

/** The agent's two answers on #154's F1, then the owner's word it settles F1 on. */
const REFUND_ANSWER = "Won't fix: the provider refuses a second refund of one charge.";
const REFUND_AGAIN = "Won't fix. A charge can't be refunded past its amount.";
const OWNERS_WORD = "The provider refuses a refund over the charge's amount, so a second one fails.";

const REFUNDS: ScenarioChange = {
  number: 154,
  title: "Refund an invoice",
  branch: "invoice-refunds",
  author: OWNER,
  commits: [
    {
      sha: commitSha("d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0"),
      message: `Refund an invoice\n\n${BY_CLAUDE}`,
      diff: added("src/invoices/refund.ts", REFUND([])),
      find: {
        notes: "One thing, and it blocks.",
        findings: [
          {
            path: "src/invoices/refund.ts",
            line: lineOf(REFUND([]), UNGUARDED),
            lineText: UNGUARDED,
            severity: "blocking",
            category: "correctness",
            title: "A double click refunds the invoice twice",
            body: "When Refund is pressed twice, the payment is refunded twice, because the refund is sent with no idempotency key and the invoice is never marked refunded first.",
            defectKey: "refund_not_idempotent",
          },
        ],
        usage: { inputTokens: 2_900, outputTokens: 380 },
        tookMs: FIND_MS,
      },
      confirm: {
        notes: "It holds.",
        verdicts: [
          {
            id: "C1",
            verdict: "confirmed",
            reason: "Nothing guards the call: two requests each create a refund of the full total.",
            evidence: [`src/invoices/refund.ts:${lineOf(REFUND([]), UNGUARDED)}`],
            severity: "blocking",
          },
        ],
        usage: { inputTokens: 1_700, outputTokens: 160 },
        tookMs: CONFIRM_MS,
      },
    },
    {
      sha: commitSha("e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1"),
      message: `Log every refund asked for\n\n${BY_CLAUDE}`,
      diff: added("src/invoices/refund.ts", REFUND(LOGGED_REFUNDS)),
      find: {
        notes: "The new log line is fine. F1 is not fixed.",
        findings: [],
        earlier: [{ id: "F1", present: true, why: STILL_UNGUARDED }],
        emptyReason: "The push adds a log line and nothing else.",
        usage: { inputTokens: 3_000, outputTokens: 200 },
        tookMs: SHORT_FIND_MS,
      },
    },
    {
      sha: commitSha("f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2"),
      message: `Count the refunds\n\n${BY_CLAUDE}`,
      diff: added("src/invoices/refund.ts", REFUND(COUNTED_REFUNDS)),
      find: {
        notes: "A counter added. F1 is still not fixed.",
        findings: [],
        earlier: [{ id: "F1", present: true, why: STILL_UNGUARDED }],
        emptyReason: "The push adds a counter and nothing else.",
        usage: { inputTokens: 3_100, outputTokens: 190 },
        tookMs: SHORT_FIND_MS,
      },
    },
  ],
};

/** #154's story starts this long after #149's: once #149's round 3 is posted, and after S4's earlier shots. */
const LATER = 11 * MIN;

/** A pull request of the world's repository, by its number. */
const pr = on(LEDGER_API.repo);

export const S4: Scenario = {
  id: "S4",
  title: "The agent keeps asking",
  what: 'Your agent answers the blocking finding "won\'t fix" and asks again without fixing it. The second time, Lookover hands it to you. On #154 you tell the agent to accept it as is, and it settles the finding on your word.',
  steps: [
    "Wait for #149 to appear on Home, or press Step to the next event. Round 1 finds one blocking finding.",
    'The agent replies "won\'t fix", pushes something else and asks again. Round 2 keeps it: its card shows the reply and "Kept once."',
    "Once more: round 3 keeps it again, and it needs you.",
    "Then #154 goes the same way. You tell the agent to accept its finding as is: it settles it on your word, and the card and the thread say so.",
  ],
  later: "",
  path: "/",
  world: LEDGER_API,
  changes: [PAYMENTS, REFUNDS],
  script: [
    { at: MIN + 20_000, move: { kind: "open", change: pr(149) } },
    {
      at: 6 * MIN - 10_000,
      move: { kind: "reply", change: pr(149), finding: F1, by: OWNER, text: FIRST_ANSWER },
    },
    { at: 6 * MIN, move: { kind: "push", change: pr(149) } },
    { at: 6 * MIN + 10_000, move: { kind: "ask", change: pr(149) } },
    {
      at: 10 * MIN - 10_000,
      move: { kind: "reply", change: pr(149), finding: F1, by: OWNER, text: SECOND_ANSWER },
    },
    { at: 10 * MIN, move: { kind: "push", change: pr(149) } },
    { at: 10 * MIN + 10_000, move: { kind: "ask", change: pr(149) } },
    { at: LATER + MIN + 20_000, move: { kind: "open", change: pr(154) } },
    {
      at: LATER + 6 * MIN - 10_000,
      move: { kind: "reply", change: pr(154), finding: F1, by: OWNER, text: REFUND_ANSWER },
    },
    { at: LATER + 6 * MIN, move: { kind: "push", change: pr(154) } },
    { at: LATER + 6 * MIN + 10_000, move: { kind: "ask", change: pr(154) } },
    {
      at: LATER + 10 * MIN - 10_000,
      move: { kind: "reply", change: pr(154), finding: F1, by: OWNER, text: REFUND_AGAIN },
    },
    { at: LATER + 10 * MIN, move: { kind: "push", change: pr(154) } },
    { at: LATER + 10 * MIN + 10_000, move: { kind: "ask", change: pr(154) } },
    {
      at: LATER + 12 * MIN,
      move: { kind: "settle", change: pr(154), finding: F1, decision: "accepted", reason: OWNERS_WORD },
    },
  ],
  seed: MIN,
};
