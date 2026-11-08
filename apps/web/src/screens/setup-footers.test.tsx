// Setup's footers (design-system.md "Setup's Continue"): every choice but Back is a button, the step's one primary
// filled and every other choice a secondary, outlined, so none reads as a link beside it (round 5: "Don't start at
// login" and "Review this pull request" as ghosts read as text links between Back and the primary).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { emptyReview, type State } from "@lookover/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { HeldDetail } from "./common.tsx";
import { app, change, screen, world } from "./repositories.test-support.tsx";
import { AgentActs, StepFirstReview } from "./setup.tsx";

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

test("first review's line under the list never leaves one word alone: each sentence its own block, balanced (round 6)", () => {
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  expect(css).toMatch(/\n\.first-reviewed-line\s*\{[^}]*text-wrap:\s*balance;/);
  // No break in the words: the sentences are parts, each drawn as a block of its own, in every copy held.
  expect(css).not.toMatch(/pre-line/);
  const html = renderToStaticMarkup(
    <HeldDetail shown={["One by itself.", "Go on."]} details={[[], ["One by itself.", "Go on."]]} />,
  );
  expect(html).toContain(
    '<span><span class="held-sentence">One by itself.</span><span class="held-sentence">Go on.</span></span>',
  );
  const system = readFileSync(new URL("../styles/system.css", import.meta.url), "utf8");
  expect(system).toMatch(/\n\.held-sentence\s*\{[^}]*display:\s*block;/);
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
  // line keeps its whole column (at its end the chip wrapped onto a third line: "· 6 min ago" leaves no room).
  expect(html).toMatch(/<b>[^<]+<span class="first-row-chip" aria-hidden="true">/);
  expect(html).toMatch(/<span class="t-small">[^<]+<\/span>/);
  expect(html).toMatch(
    /<span class="first-row-reviewed" aria-hidden="true"><a [^>]*>.*?Open on GitHub<\/a><\/span>/,
  );
});
