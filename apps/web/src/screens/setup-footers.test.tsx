// Setup's footers (design-system.md "Setup's Continue"): every choice but Back is a button, the step's one primary
// filled and every other choice a secondary, outlined, so none reads as a link beside it (round 5: "Don't start at
// login" and "Review this pull request" as ghosts read as text links between Back and the primary).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Change, emptyReview, type Review, type State } from "@lookover/contracts";
import { app, change, screen, world } from "./repositories.test-support.tsx";
import { job } from "./review.test-support.tsx";
import { AgentActs, StepFirstReview } from "./setup.tsx";

/** Reviewed by itself on its head: a round posted there, clean, its job done. */
const postedClean = (c: Change): Review => ({
  ...emptyReview(c.id, c.openedAt),
  job: job("done", { sha: c.headSha }),
  loop: "settled",
  rounds: [
    {
      n: 1,
      sha: c.headSha,
      base: null,
      reviewer: "claude",
      secondFind: null,
      confirmer: null,
      confirmFallback: null,
      confirmFailure: null,
      ruledOut: [],
      startedAt: c.openedAt,
      endedAt: c.openedAt + 60_000,
      raised: 0,
      verifiedFixed: 0,
      open: 0,
      steps: [],
      sessions: [],
    },
  ],
});

/** Each button's variant and label in `html`, in order: ["ghost", "Back"]. */
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*class="btn btn-(\w+)[^"]*"[^>]*>(.*?)<\/button>/g)].map(
    ([, variant, label]) => [variant, label?.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'")],
  );

test("the last step's footer: Back a ghost, start at login a secondary in both its forms, Go to my reviews the primary", () => {
  const html = screen(app(), world(), AgentActs);
  expect(buttons(html)).toEqual([
    ["ghost", "Back"],
    ["secondary", "Don't start at login"],
    ["secondary", "Start at login after all"],
    ["primary", "Go to my reviews"],
  ]);
});

test("first review's footer: Back a ghost, the preview a secondary, Review this pull request the primary", () => {
  const pr = change("sasensi/ledger-api", 148);
  const state: State = {
    ...world(),
    changes: { [pr.id]: pr },
    reviews: { [pr.id]: emptyReview(pr.id, pr.openedAt) },
  };
  const shown = buttons(screen(app(), state, StepFirstReview));
  expect(shown[0]).toEqual(["ghost", "Back"]);
  expect(shown).toContainEqual(["secondary", "Preview here only, post nothing"]);
  expect(shown).toContainEqual(["primary", "Review this pull request"]);
  // The middle place's other form, Review this pull request beside Continue once a review was posted: a secondary.
  expect(shown).toContainEqual(["secondary", "Review this pull request"]);
  expect(shown.filter(([variant]) => variant === "ghost")).toEqual([["ghost", "Back"]]);
});

test("first review's line is under the bar, the step's end, as tall as it says: each sentence its own block, balanced (round 6, ADR 0086)", () => {
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  expect(css).toMatch(/\n\.first-reviewed-line\s*\{[^}]*text-wrap:\s*balance;/);
  // No break in the words: the sentences are parts, each drawn as a block of its own.
  expect(css).not.toMatch(/pre-line/);
  const system = readFileSync(new URL("../styles/system.css", import.meta.url), "utf8");
  expect(system).toMatch(/\n\.line-sentence\s*\{[^}]*display:\s*block;/);
  const [reviewed, left] = [change("sasensi/ledger-api", 152), change("sasensi/ledger-api", 148)];
  const state: State = {
    ...world(),
    changes: { [reviewed.id]: reviewed, [left.id]: left },
    reviews: {
      [reviewed.id]: postedClean(reviewed),
      [left.id]: emptyReview(left.id, left.openedAt),
    },
  };
  const html = screen(app(), state, StepFirstReview);
  const [, under] = html.split('<div class="setup-acts first-review-acts">');
  // Under the bar, after Continue, holding no copy of another line.
  expect(under?.split("Continue")[1]).toContain(
    '<p class="t-small first-reviewed-line"><span class="line-sentence">Lookover already reviewed sasensi/ledger-api #152 by itself: Clean.</span><span class="line-sentence">Go on, or review sasensi/ledger-api #148 too.</span></p>',
  );
  expect(html).not.toContain("held-detail");
  // Nothing reviewed: no line at all.
  const fresh: State = {
    ...world(),
    changes: { [left.id]: left },
    reviews: { [left.id]: emptyReview(left.id, left.openedAt) },
  };
  expect(screen(app(), fresh, StepFirstReview)).not.toContain("first-reviewed-line");
});

test("a reviewed row's chip ends its small line, and Open on GitHub stands alone at its right, centred on both lines", () => {
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  const block = (selector: string) =>
    css.match(new RegExp(`\\n${selector.replace(/[.>]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  // The right column holds the link alone, across the title and its small line, centred on them, no height its own.
  const place = block(".first-row-reviewed");
  expect(place).toMatch(/grid-area:\s*1 \/ 3 \/ 3 \/ 4;/);
  expect(place).toMatch(/align-self:\s*center;/);
  expect(place).not.toMatch(/flex-direction:\s*column;/);
  expect(block(".first-row > .check > span > .t-small")).toMatch(/grid-area:\s*2 \/ 2;/);
  // The chip sits in the small line's own line box, never taller than it: the title and the line keep their 2 px.
  expect(block(".first-row-chip")).toMatch(/vertical-align:\s*top;/);
  expect(block(".first-row-chip")).toMatch(/margin-block:/);
  const pr = change("sasensi/ledger-api", 148);
  const state: State = {
    ...world(),
    changes: { [pr.id]: pr },
    reviews: { [pr.id]: emptyReview(pr.id, pr.openedAt) },
  };
  const html = screen(app(), state, StepFirstReview);
  // Held, hidden, at the title's end on a row that can be picked, so a review landing wraps nothing anew; the small
  // line keeps its whole column (at its end the chip wrapped onto a third line: "· 6 min ago" leaves no room). The
  // place wraps with the title's last character (its last word with it), never onto a line of its own (row 52: an
  // empty line under the title); the rest keeps every break, so a title with no space wraps in its column.
  expect(html).toMatch(
    /<b>Change 14<span class="first-row-title-end">8<span class="first-row-chip" aria-hidden="true">/,
  );
  expect(block(".first-row-title-end")).toMatch(/white-space:\s*nowrap;/);
  // A word wider than the column (a long name, a path) breaks inside rather than run past it.
  expect(block(".first-row > .check > span > b")).toMatch(/overflow-wrap:\s*anywhere;/);
  // Balanced when it wraps: its last character, with no space to break at, never alone under a full line.
  expect(block(".first-row > .check > span > b")).toMatch(/text-wrap:\s*balance;/);
  expect(html).toMatch(/<span class="t-small">[^<]+<\/span>/);
  // Its words at the desktop width; on a phone the Icon button, a small square named by its words and said on hover by
  // its tip, ending at its right edge (design-system.md "Icon button"): one of the two laid out at a time.
  expect(html).toMatch(
    /<span class="first-row-reviewed" aria-hidden="true"><span class="first-row-link-words"><a [^>]*>.*?Open on GitHub<\/a><\/span><span class="first-row-link-icon"><span class="anchor tip-end"><a class="btn btn-ghost btn-sm btn-square" aria-label="Open on GitHub"[^>]*>.*?<\/a><span class="tip" role="tooltip">Open on GitHub<\/span><\/span><\/span><\/span>/,
  );
  // On a phone the link keeps its column: no rule moves it under the small line, where it held a button's height.
  expect(css).not.toMatch(/\.first-row-reviewed\s*\{[^}]*grid-area:\s*3 \/ 2;/);
  expect(block(".first-row-link-icon")).toMatch(/display:\s*none;/);
  const phone =
    css.match(/@media \(max-width: 640px\) \{\n {2}\.first-row-link-words[\s\S]*?\n\}\n/)?.[0] ?? "";
  expect(phone).toMatch(/\.first-row-link-words\s*\{\s*display:\s*none;/);
  expect(phone).toMatch(/\.first-row-link-icon\s*\{\s*display:\s*flex;/);
  // The square and the tip at the right are system.css's, not copies here.
  expect(css).not.toMatch(/width:\s*var\(--h-sm\);\s*padding:\s*0;/);
  expect(css).not.toMatch(/transform-origin:\s*bottom right;/);
  // No copy of system.css's visually hidden rule.
  expect(css).not.toMatch(/clip-path:\s*inset\(50%\)/);
});
