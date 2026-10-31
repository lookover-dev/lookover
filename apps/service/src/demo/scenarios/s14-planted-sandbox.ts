// S14 "The planted sandbox" (ADR 0046): the story `bun run proof`'s `service-*` shots told on the fake programs,
// as fixture data. Pull request #1 of `sasensi/lookover-sandbox` holds the planted bugs (testkit's
// `plantSandbox`): Claude finds three, Codex confirms one, is unsure of one and rules the third out; the fix is
// pushed and the owner asks again; round 2 sees the key no longer logged, the cap still gone and a new `eval`,
// which Codex confirms. Then #2 is closed on GitHub, reviews are paused for an hour and "Review now" waits for
// the resume. A newer Codex failing its self-test is the drawer's `codex-failed-self-test`.
//
// The words of #1's rounds are the recordings' (testkit's `fake-claude/recordings/review`, `review-round-2` and
// `fake-codex/recordings/confirm-mixed`, `confirm-round-2`), transcribed: each block's fields, the notes before
// it, the tokens counted as `engines` counts them, Claude's durations as recorded. The diffs are what `retrieval`
// prints for the planted commits (`git diff -M` from the merge base), so the shas are the planted ones. Codex's
// recordings carry no duration: its durations are chosen. What each session did as it went (ADR 0055) is the
// recordings' too, read as the engines read them (Claude's tool calls, Codex's commands unwrapped); the moments are
// chosen, the streams carrying none. #2 and #3 are the sandbox's other branches;
// #2's clean round is hand-written, there being no recording of it.
import { changeId, commitSha } from "@lookover/contracts";
import { on, type Scenario, type ScenarioChange, type World } from "../scenario.ts";
import { MIN, OWNER, unified } from "./ledger-api.ts";

const SEC = 1_000;

const WORLD: World = {
  repo: { owner: "sasensi", name: "lookover-sandbox" },
  bot: { id: 2, login: "lookover-spike-sasensi[bot]" },
  owner: OWNER,
  // The versions the recordings were made with.
  engines: {
    claude: { installed: true, version: "2.1.283", signedIn: true },
    codex: { installed: true, version: "0.162.1", signedIn: true },
  },
  main: { ref: "main", sha: commitSha("610d86d8a2803f372824568f561862ad97de6880") },
  // A tab without the session is told the program's command, as the owner's first run was (#281).
  namesOpen: true,
};

/** What #1 adds besides `src/invoices.ts`, at both of its commits: the badge, and the rename. */
const BADGE_AND_RENAME = [
  "diff --git a/assets/invoice-badge.png b/assets/invoice-badge.png",
  "new file mode 100644",
  "index 0000000..08cd6f2",
  "Binary files /dev/null and b/assets/invoice-badge.png differ",
  "diff --git a/src/legacy-name.ts b/src/greeting.ts",
  "similarity index 100%",
  "rename from src/legacy-name.ts",
  "rename to src/greeting.ts",
];

/** #1's planted commit: the key logged, the cap gone, `==`, the loop rewrite. */
const PLANTED = unified(
  ...BADGE_AND_RENAME,
  "diff --git a/src/invoices.ts b/src/invoices.ts",
  "index dab659a..ee014bc 100644",
  "--- a/src/invoices.ts",
  "+++ b/src/invoices.ts",
  "@@ -2,12 +2,20 @@ export interface Invoice {",
  "   id: string;",
  "   amountCents: number;",
  "   paid: boolean;",
  "+  apiKey?: string;",
  " }",
  " ",
  " export function listInvoices(all: Invoice[], limit: number): Invoice[] {",
  "-  return all.slice(0, Math.min(limit, 100));",
  '+  console.log("listing invoices", all.map((i) => i.apiKey));',
  "+  return all.slice(0, limit);",
  "+}",
  "+",
  "+export function unpaid(invoices: Invoice[]): Invoice[] {",
  "+  return invoices.filter((i) => i.paid == false);",
  " }",
  " ",
  " export function total(invoices: Invoice[]): number {",
  "-  return invoices.reduce((sum, i) => sum + i.amountCents, 0);",
  "+  let sum = 0;",
  "+  for (let i = 0; i < invoices.length; i++) sum += invoices[i].amountCents;",
  "+  return sum;",
  " }",
);

/** #1 after the fix commit: the key no longer logged, the cap still gone, a filter that runs `eval`. */
const FIXED = unified(
  ...BADGE_AND_RENAME,
  "diff --git a/src/invoices.ts b/src/invoices.ts",
  "index dab659a..8b6d89d 100644",
  "--- a/src/invoices.ts",
  "+++ b/src/invoices.ts",
  "@@ -2,12 +2,23 @@ export interface Invoice {",
  "   id: string;",
  "   amountCents: number;",
  "   paid: boolean;",
  "+  apiKey?: string;",
  " }",
  " ",
  " export function listInvoices(all: Invoice[], limit: number): Invoice[] {",
  "-  return all.slice(0, Math.min(limit, 100));",
  "+  return all.slice(0, limit);",
  "+}",
  "+",
  "+export function unpaid(invoices: Invoice[]): Invoice[] {",
  "+  return invoices.filter((i) => i.paid == false);",
  "+}",
  "+",
  "+export function matching(invoices: Invoice[], expression: string): Invoice[] {",
  "+  return invoices.filter((i) => eval(expression));",
  " }",
  " ",
  " export function total(invoices: Invoice[]): number {",
  "-  return invoices.reduce((sum, i) => sum + i.amountCents, 0);",
  "+  let sum = 0;",
  "+  for (let i = 0; i < invoices.length; i++) sum += invoices[i].amountCents;",
  "+  return sum;",
  " }",
);

const EXPORT_CSV = unified(
  "diff --git a/src/export.ts b/src/export.ts",
  "new file mode 100644",
  "index 0000000..5e8b55d",
  "--- /dev/null",
  "+++ b/src/export.ts",
  "@@ -0,0 +1,6 @@",
  '+import type { Invoice } from "./invoices.ts";',
  "+",
  "+export function toCsv(invoices: Invoice[]): string {",
  '+  const rows = invoices.map((i) => [i.id, String(i.amountCents), i.paid ? "paid" : "unpaid"].join(","));',
  '+  return ["id,amount_cents,status", ...rows].join("\\n");',
  "+}",
);

const WEBHOOK_RETRY = unified(
  "diff --git a/src/webhook.ts b/src/webhook.ts",
  "new file mode 100644",
  "index 0000000..9e6234f",
  "--- /dev/null",
  "+++ b/src/webhook.ts",
  "@@ -0,0 +1,7 @@",
  "+export async function deliver(url: string, body: string, attempts = 3): Promise<void> {",
  "+  for (let i = 0; i < attempts; i++) {",
  '+    const response = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(5000) });',
  "+    if (response.ok) return;",
  "+  }",
  '+  throw new Error("webhook not delivered");',
  "+}",
);

/** Claude's notes before the block of `review`, as recorded. */
const ROUND_1_NOTES = `## Review

This change adds an optional \`apiKey\` field to \`Invoice\` and a new \`unpaid()\` filter. It rewrites \`total()\` as a \`for\` loop, renames \`src/legacy-name.ts\` to \`src/greeting.ts\`, and adds a binary badge image. The \`total()\` rewrite gives the same result as before. Nothing in the repo imports \`legacy-name\`, so the rename breaks nothing in this checkout.

**1. API keys are written to the logs (blocking, security).** \`listInvoices\` now runs \`console.log("listing invoices", all.map((i) => i.apiKey))\`. Every call writes the API key of every invoice to stdout, including invoices outside \`limit\`. Anything that collects logs then stores those secrets in plain text. This looks like leftover debugging; it should be removed.

**2. The 100-item cap on \`limit\` was removed (should_fix, reliability).** \`Math.min(limit, 100)\` became plain \`limit\`. A caller passing a large or unchecked \`limit\` (for example, from a query parameter) now gets the whole list back, so the cap no longer limits response size. Also, \`slice\` treats a negative \`limit\` as counting from the end, so \`limit = -1\` returns everything except the last invoice. If dropping the cap was on purpose, the PR doesn't say why.

**3. No tests (consider).** The repo has no test files, and this change adds none. That leaves \`unpaid()\`, the \`total()\` rewrite (empty list, a single invoice) and the change to \`listInvoices\` paging untested. A test for \`listInvoices\` paging would have caught the removed cap.`;

/** Claude's notes before the block of `review-round-2`, as recorded. */
const ROUND_2_NOTES = `## What the change does

Compared with the merge base, this PR:
- adds an optional \`apiKey\` field to \`Invoice\`
- removes the 100-item cap from \`listInvoices\`
- adds \`unpaid()\` and \`matching(invoices, expression)\`
- rewrites \`total\` as a \`for\` loop, which returns the same result
- renames \`src/legacy-name.ts\` to \`src/greeting.ts\`; nothing in the repo imports the old path, so the rename breaks nothing
- adds a binary badge image

This round's commit removes the \`console.log\` of API keys and adds \`matching\`.

## Earlier findings

- **F1 is fixed.** \`listInvoices\` (\`src/invoices.ts:8-10\`) no longer calls \`console.log\`, so API keys no longer reach stdout.
- **F2 is still there.** \`src/invoices.ts:9\` is still \`all.slice(0, limit)\` with no cap and no check on \`limit\`. A large \`limit\` returns everything, and a negative one counts from the end of the list.

## New problem

**\`matching\` runs caller-supplied text as code with \`eval\` (blocking, security).** At \`src/invoices.ts:17\`, \`invoices.filter((i) => eval(expression))\` executes \`expression\` as JavaScript, with access to \`i\` and to everything the module can reach. That includes \`process\`, \`require\` (in CommonJS) and the environment. If the filter string comes from a user, such as a query parameter or a saved-search field, anyone who controls it can run any code in the server. For example, \`process.env\` dumps the secrets, and \`require('child_process').execSync(...)\` runs shell commands. It also runs once per invoice, so side effects repeat. The function's name and signature suggest the text is meant to come from outside, so this must not merge as written. It needs a fixed set of supported fields and operators that are checked and parsed, or a callback predicate supplied by trusted code.

## What the tests miss

The repo has no tests at all. Nothing covers \`unpaid\`, \`matching\`, the uncapped or negative \`limit\` in \`listInvoices\`, or the rewritten \`total\`.`;

const CHANGES: ScenarioChange[] = [
  {
    number: 1,
    title: "Add unpaid filter and rewrite total",
    branch: "feature/invoice-filters",
    author: OWNER,
    commits: [
      {
        sha: commitSha("703205dec59961a3a08427d7b4af007e278451a4"),
        message: "Add unpaid filter, rewrite total, rename greeting (squashed)",
        diff: PLANTED,
        find: {
          notes: ROUND_1_NOTES,
          findings: [
            {
              path: "src/invoices.ts",
              line: 9,
              lineText: '  console.log("listing invoices", all.map((i) => i.apiKey));',
              severity: "blocking",
              category: "security",
              title: "listInvoices logs every invoice's apiKey to stdout",
              body: "Whenever listInvoices is called, the apiKey of every invoice in `all` (even ones beyond `limit`) goes to console.log. Anything that collects logs then stores these secrets in plain text, where anyone who can read the logs can see them.",
              defectKey: "secret_logged",
            },
            {
              path: "src/invoices.ts",
              line: 10,
              lineText: "  return all.slice(0, limit);",
              severity: "should_fix",
              category: "reliability",
              title: "Removed the 100-item cap on limit; a large or negative limit is no longer bounded",
              body: "When a caller passes a large or unchecked limit, the whole list comes back because the Math.min(limit, 100) cap is gone. A negative limit makes slice count from the end, so limit = -1 returns everything except the last invoice.",
              defectKey: "removed_pagination_cap",
              suggestion: "  return all.slice(0, Math.max(0, Math.min(limit, 100)));",
            },
            {
              path: "src/invoices.ts",
              line: 13,
              endLine: 15,
              lineText: "export function unpaid(invoices: Invoice[]): Invoice[] {",
              severity: "consider",
              category: "tests",
              title: "No tests for unpaid(), the total() rewrite, or the change to listInvoices paging",
              body: "The repo has no tests, so nothing checks the new filter, that the loop-based total matches the old reduce (empty list included), or the listInvoices limit behaviour. The removed cap is exactly the kind of regression a test would catch.",
              defectKey: "missing_tests",
            },
          ],
          // input 6, cache creation 2,920 and cache read 17,101, as `engines` adds them; output 1,631.
          usage: { inputTokens: 20_027, outputTokens: 1_631 },
          tookMs: 23_889,
          activity: [
            {
              afterMs: 4 * SEC,
              activity: { kind: "search", pattern: "legacy-name|listInvoices|unpaid|apiKey" },
            },
            { afterMs: 9 * SEC, activity: { kind: "list", pattern: "**/*.{ts,js,json}" } },
          ],
        },
        confirm: {
          notes:
            "I’ll read the code and repository context, then check each claim and its severity.\n\n- C1 confirmed: logging exposes every supplied API key, including invoices beyond the requested limit.\n- C2 confirmed for the removed 100-item cap; negative limits already behaved this way before the change.\n- C3 confirmed: there are no tests in the checkout. This is a coverage suggestion, not a separate demonstrated bug.",
          verdicts: [
            {
              id: "C1",
              verdict: "confirmed",
              reason:
                "The unconditional console.log receives API keys from the entire input array before the limit is applied.",
              evidence: ["src/invoices.ts:9", "src/invoices.ts:10"],
              severity: "blocking",
            },
            {
              id: "C2",
              verdict: "unsure",
              reason: "Whether a caller passes a large limit depends on code outside this pull request.",
              severity: "should_fix",
            },
            {
              id: "C3",
              verdict: "refuted",
              reason:
                "The repository has no tests at all, so this change leaves nothing less tested than before.",
              severity: "consider",
            },
          ],
          usage: { inputTokens: 37_643, outputTokens: 615 },
          // Chosen: Codex's recordings carry no duration.
          tookMs: 41 * SEC,
          activity: [
            {
              afterMs: 4 * SEC,
              activity: {
                kind: "command",
                text: "Get-Location; rg --files -g '!node_modules' -g '!\\.git'; git status --short; git show --format=fuller --stat HEAD; git show HEAD -- src/invoices.ts",
              },
            },
            {
              afterMs: 15 * SEC,
              activity: {
                kind: "command",
                text: "$files = @('src/invoices.ts', 'src/greeting.ts', 'README.md'); foreach ($file in $files) { Write-Output $file; $line = 0; Get-Content -LiteralPath $file | ForEach-Object { $line++; '{0}: {1}' -f $line, $_ } }; git ls-tree -r --name-only HEAD; git show HEAD^:src/invoices.ts; Get-ChildItem -Force -Name",
              },
            },
          ],
        },
      },
      {
        sha: commitSha("4700cffcc191fa0290cc7d91340f924a74c7f803"),
        message: "Stop logging the key, add a filter on an expression",
        diff: FIXED,
        find: {
          notes: ROUND_2_NOTES,
          findings: [
            {
              path: "src/invoices.ts",
              line: 17,
              lineText: "  return invoices.filter((i) => eval(expression));",
              severity: "blocking",
              category: "security",
              title: "matching() evals a caller-supplied string, allowing arbitrary code execution",
              body: "When `expression` comes from anything a user controls (a query parameter, a saved filter), eval runs it as JavaScript once per invoice with full access to the process: e.g. `process.env` leaks secrets and `require('child_process').execSync(...)` runs shell commands. The function's string signature invites exactly this use. Use a callback predicate supplied by trusted code, or parse a small, checked filter language instead of eval.",
              defectKey: "eval_of_untrusted_input",
              suggestion: "  return invoices.filter(predicate);",
            },
          ],
          earlier: [
            {
              id: "F1",
              present: false,
              why: "The console.log of each invoice's apiKey is gone from listInvoices, which now only returns the slice.",
            },
            {
              id: "F2",
              present: true,
              why: "listInvoices still returns all.slice(0, limit) with no Math.min cap and no check on limit, so large limits return everything and negative ones count from the end.",
            },
          ],
          // input 4, cache creation 3,719 and cache read 10,876; output 1,541.
          usage: { inputTokens: 14_599, outputTokens: 1_541 },
          tookMs: 18_363,
          activity: [
            {
              afterMs: 5 * SEC,
              activity: { kind: "search", pattern: "matching|listInvoices|legacy-name|greeting" },
            },
            { afterMs: 9 * SEC, activity: { kind: "read", path: "src/invoices.ts" } },
          ],
        },
        confirm: {
          notes:
            "I’ll check `matching()` and its callers for any safeguards around the expression.\n\nC1 is confirmed: `matching()` directly evaluates the supplied string for each invoice, with no validation or isolation. An attacker-controlled expression can execute arbitrary JavaScript in the host process; this is blocking.",
          verdicts: [
            {
              id: "C1",
              verdict: "confirmed",
              reason:
                "matching() passes the caller-supplied expression directly to eval without validation or isolation, allowing arbitrary code execution if the string is attacker-controlled.",
              evidence: ["src/invoices.ts:16", "src/invoices.ts:17"],
              severity: "blocking",
            },
          ],
          usage: { inputTokens: 23_132, outputTokens: 265 },
          // Chosen: Codex's recordings carry no duration.
          tookMs: 33 * SEC,
          activity: [
            {
              afterMs: 4 * SEC,
              activity: {
                kind: "command",
                text: "Get-Content src/invoices.ts; rg -n \"matching\\(|expression|invoices\" . --glob '!package-lock.json' --glob '!node_modules/**'; rg --files -g AGENTS.md -g package.json -g tsconfig.json",
              },
            },
          ],
        },
      },
    ],
  },
  {
    number: 2,
    title: "Export invoices as CSV",
    branch: "export-csv",
    author: OWNER,
    commits: [
      {
        sha: commitSha("412369790eb712c5856aabfb5c392895a7fe6086"),
        message: "Export invoices as CSV",
        diff: EXPORT_CSV,
        // Hand-written: no recording of #2.
        find: {
          notes: "One new function that writes the invoices as CSV rows.",
          findings: [],
          emptyReason: "The export writes each invoice's three fields under a matching header.",
          usage: { inputTokens: 9_800, outputTokens: 210 },
          tookMs: 40 * SEC,
        },
      },
    ],
  },
  {
    number: 3,
    title: "Retry the webhook on a timeout",
    branch: "webhook-retry",
    author: OWNER,
    draft: true,
    commits: [
      {
        sha: commitSha("b4ce97d950e82ba750910f3fdd3b2b876b80a79d"),
        message: "Retry the webhook on a timeout",
        diff: WEBHOOK_RETRY,
      },
    ],
  },
];

/** The pull request the story is about. */
const PLANTED_ID = changeId("sasensi/lookover-sandbox#1");

/** A pull request of the world's repository, by its number. */
const pr = on(WORLD.repo);

export const S14: Scenario = {
  id: "S14",
  title: "The planted sandbox",
  what: "The planted bugs of the sandbox's #1, in the words Claude and Codex really gave: round 1, the fix pushed, round 2.",
  steps: [
    "Round 1 runs on #1: Claude finds, Codex double-checks.",
    "Open #1: one confirmed, one unsure, one ruled out (How this review ran).",
    "The fix is pushed; you ask again; round 2 finds the eval.",
    "#2 closes on GitHub; then reviews pause and “Review now” waits.",
    "Inject “Codex fails its self-test” from the drawer.",
  ],
  later: "",
  path: "/reviews/sasensi/lookover-sandbox/1",
  world: WORLD,
  changes: CHANGES,
  script: [
    { at: 1 * MIN, move: { kind: "open", change: pr(2) } },
    { at: 2 * MIN, move: { kind: "open", change: pr(3) } },
    { at: 3 * MIN, move: { kind: "open", change: pr(1) } },
    { at: 5 * MIN + 30 * SEC, move: { kind: "push", change: pr(1) } },
    {
      at: 6 * MIN + 30 * SEC,
      move: { kind: "command", command: { type: "review.request", changeId: PLANTED_ID } },
    },
    { at: 8 * MIN + 30 * SEC, move: { kind: "close", change: pr(2) } },
    { at: 9 * MIN + 30 * SEC, move: { kind: "command", command: { type: "service.pause", for: "hour" } } },
    {
      at: 9 * MIN + 40 * SEC,
      move: { kind: "command", command: { type: "review.request", changeId: PLANTED_ID } },
    },
  ],
  // Round 1 of #1 is finding when the app opens.
  seed: 3 * MIN + 10 * SEC,
};
