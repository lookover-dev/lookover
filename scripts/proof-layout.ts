// `bun run proof`'s layout pass (ADR 0086): held room is width, never height. The main screens, on the scenarios their
// shots load (S20 and S21 with real-looking names among them), laid out at 1024 and 1440 px wide, and at 390 px where a
// screen has a phone layout, in the dark theme (a theme changes colours, never layout), and judged at scroll top by two
// measures, in the page (`judgeLayout`):
// - held: no stacked-alternatives cell is taller than the alternative it shows: a copy hidden (`visibility: hidden`,
//   `opacity: 0`) that ends below everything its cell shows makes the cell taller than what it shows. A copy as tall as
//   the one shown (a fix floor beside its fix) only holds a width, and passes; `SameWidth`'s hidden labels are laid out
//   zero tall, so they hold no height at all. A copy in a line (inline-level) whose width wraps it onto a line below
//   everything its cell shows holds that line, zero tall or not (a chip held at a title's end, wrapped under it).
// - room: no row or card ends on empty room: its content box ends within a pixel of the lowest thing it shows (a text
//   line's box, a control, a drawn box no sibling's content stretches), lines cut where an ancestor clips them (line
//   clamps, scroll containers). Content centred in its box (as much room above) passes only in a box whose height is
//   the design's (a bar's, a control's, a table row's cells'), never one held to lines (`min-height: 2lh`) or to room.
//   A box stretched by a sibling beside it is judged by that sibling, unless no sibling's content reaches its end.
// A failure names the screen, the width, the element and the child that holds its room. Before any screen is judged, a
// page of its own under the app's CSS (`LAYOUT_BITES`) must fail today's two cases, a hold centred in its room and a
// card taller than its content beside a shorter one, and pass a correct page (its `SameWidth` places as wide as their
// widest label, as tall as the one shown), as the console's bite does: otherwise proof fails. `ALLOWANCES` lists, with
// its ticket, each failure a later ticket fixes: that ticket deletes its lines, and a whole run that judged every screen
// fails on an allowance nothing needed any more (`unneeded`).
// The judge itself, run in the page, is scripts/proof-layout-judge.ts.
import type { AllowedInPage, Failure } from "./proof-layout-judge.ts";

export { type Failure, judgeScript } from "./proof-layout-judge.ts";

/** The widths every measured screen is laid out at; `PHONE` too for a screen with a phone layout. */
export const WIDTHS = [1024, 1440] as const;
export const PHONE = 390;
/** The narrowest phone a screen must fit (an iPhone SE): a shot's `phone: "narrow"`, and what an act lays out there. */
export const NARROW_PHONE = 375;

/** A screen the pass judges: a shot of `SHOTS` (its world, its path, its act), and whether it has a phone layout. */
export interface Measured {
  shot: string;
  phone?: true;
}

/** The main screens (ADR 0086): Reviews, a review, Repositories, Settings and its sections, setup's steps. */
export const MEASURED: readonly Measured[] = [
  { shot: "home-quiet" },
  { shot: "home-org" },
  { shot: "home-names" },
  { shot: "all-reviews" },
  { shot: "all-reviews-mine" },
  { shot: "review-settled" },
  { shot: "review-clean" },
  { shot: "review-running" },
  { shot: "review-posting-longest" },
  { shot: "repositories", phone: true },
  { shot: "repositories-two-accounts", phone: true },
  { shot: "repositories-org", phone: true },
  { shot: "repositories-names", phone: true },
  { shot: "repositories-look-looking", phone: true },
  { shot: "repositories-look-arrived", phone: true },
  { shot: "settings" },
  { shot: "settings-rules" },
  { shot: "settings-github-shared" },
  { shot: "settings-github-names" },
  { shot: "settings-github-look-looking" },
  { shot: "settings-github-look-arrived" },
  { shot: "settings-github-look-nothing" },
  { shot: "settings-github-approved-later" },
  { shot: "settings-agent" },
  { shot: "settings-agent-done" },
  { shot: "settings-agent-npm" },
  { shot: "setup-1-ai", phone: true },
  { shot: "setup-github-every-account", phone: true },
  { shot: "setup-github-names", phone: true },
  { shot: "setup-github-signed-in", phone: true },
  { shot: "setup-github-signed-in-looking", phone: true },
  { shot: "setup-github-look-looking", phone: true },
  { shot: "setup-github-look-arrived", phone: true },
  { shot: "setup-github-look-nothing", phone: true },
  { shot: "setup-3-repositories-org", phone: true },
  { shot: "setup-3-repositories-names", phone: true },
  { shot: "setup-4-first-review", phone: true },
  { shot: "setup-4-first-review-reviewed", phone: true },
  { shot: "setup-4-first-review-names", phone: true },
  { shot: "setup-5-agent", phone: true },
];

/** The widths a measured screen is laid out at. */
export const widthsOf = (m: Measured): number[] => (m.phone ? [...WIDTHS, PHONE] : [...WIDTHS]);

/**
 * A failure a later ticket fixes, let pass until then: the element it names (a selector the failing element matches),
 * the child holding its room if it names one, on the screens it names (every measured one without).
 */
export interface Allowance {
  /** The issue (lookover-private) whose work removes it. */
  ticket: number;
  element: string;
  child?: string;
  screens?: readonly string[];
  why: string;
}

/** None left: row 52 (#690, #691, #692) reworked every held place the pass found (ADR 0086). */
export const ALLOWANCES: readonly Allowance[] = [];

/** The allowances that apply to `screen`, as the page reads them. */
export function allowedOn(screen: string): AllowedInPage[] {
  return ALLOWANCES.flatMap((a, i): AllowedInPage[] =>
    a.screens === undefined || a.screens.includes(screen) ? [[i, a.element, a.child ?? null]] : [],
  );
}

/**
 * What a whole run says of the allowances nothing needed: each is one its ticket fixed, so it must go and the pass
 * judge that place again. Said only when every measured screen was judged: no words chose among them, the bite bit,
 * every world was entered and every screen measured; otherwise an allowance unused may be one not reached.
 */
export function unneeded(
  used: ReadonlySet<number>,
  judgedAll: boolean,
  allowances: readonly Allowance[] = ALLOWANCES,
): string[] {
  if (!judgedAll) return [];
  return allowances.flatMap((a, i) =>
    used.has(i)
      ? []
      : [
          `the allowance for #${a.ticket} on ${a.element} is no longer needed: remove it (scripts/proof-layout.ts)`,
        ],
  );
}

/** A failure as proof prints it: the screen, the width, the measure, the element and the child. */
export function failureLine(screen: string, width: number, f: Failure): string {
  const what =
    f.measure === "held"
      ? `a hidden copy makes it ${f.by} px taller than what it shows`
      : `it ends ${f.by} px below what it shows`;
  const allowed = f.allowedBy === null ? "" : ` (allowed until #${ALLOWANCES[f.allowedBy]?.ticket})`;
  return `${screen} at ${width} px: ${f.element}: ${what}, held by ${f.child}${allowed}`;
}

/**
 * In the page: each `SameWidth` place (the app's own CSS) that isn't as wide as its widest label, or is taller than the
 * label it shows (none: no height), said; so the place holds width, never height.
 */
export function sameWidthMisses(): string[] {
  return [...document.querySelectorAll(".same-width")].flatMap((place) => {
    const r = place.getBoundingClientRect();
    const slots = [...place.children];
    const widest = Math.max(...slots.map((s) => s.firstElementChild?.getBoundingClientRect().width ?? 0));
    const shown = slots.find((s) => s.getAttribute("aria-hidden") !== "true");
    const tall = shown === undefined ? 0 : shown.getBoundingClientRect().height;
    const label = (place.textContent ?? "").trim();
    return [
      ...(r.width < widest - 1
        ? [`"${label}" is ${Math.round(r.width)} px wide, its widest label ${Math.round(widest)}`]
        : []),
      ...(r.height > tall + 1
        ? [`"${label}" is ${Math.round(r.height)} px tall, what it shows ${Math.round(tall)}`]
        : []),
    ];
  });
}

/** A page of the self-test: its markup and the rules it adds to the app's CSS, and what the pass must find on it. */
export interface BitePage {
  name: string;
  html: string;
  css: string;
  /** The measure it must fail, or null for the page that must pass. */
  fails: Failure["measure"] | null;
}

/** The rules every page of the self-test shares: a column as wide as a narrow window's content. */
const BITE_BASE = ".layout-bite { width: 640px; padding: 24px; display: grid; gap: 16px; }";

/**
 * Today's two cases, each laid out as the app laid it out before ADR 0086, its rules written here so that the app
 * dropping them later doesn't make the self-test pass, and a correct page.
 */
export const LAYOUT_BITES: readonly BitePage[] = [
  {
    name: "a held cause wrapping beside a long fix",
    fails: "held",
    css: `${BITE_BASE}
.bite-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; align-items: center; }
.bite-cause { display: grid; }
.bite-cause > span { grid-area: 1 / 1; }
.bite-cause > span[aria-hidden="true"] { visibility: hidden; }`,
    html: `<div class="layout-bite"><div class="card bite-head">
<span class="t-small bite-cause"><span>Asks you to sign in with SSO.</span><span aria-hidden="true">Not installed. On GitHub, you ask its owners to install it.</span></span>
<a class="btn btn-secondary btn-sm" href="about:blank">Ask an owner of northwind-platform-infrastructure-group</a>
</div></div>`,
  },
  {
    name: "a two-line hold around a one-line sentence",
    fails: "room",
    css: `${BITE_BASE}
.bite-try { display: grid; gap: 8px; }
.bite-try > * { margin: 0; }
.bite-next { min-height: 2lh; }`,
    html: `<div class="layout-bite"><div class="card bite-try">
<h3>Try it</h3><p class="bite-next">Then run lookover wait in your terminal.</p>
</div></div>`,
  },
  {
    name: "a two-line hold centred around a one-line sentence",
    fails: "room",
    css: `${BITE_BASE}
.bite-centred { display: flex; align-items: center; box-sizing: content-box; min-height: 2lh; }
.bite-centred > p { margin: 0; }`,
    html: `<div class="layout-bite"><div class="card bite-centred">
<p>Lookover already reviewed ledger-api #171 by itself.</p>
</div></div>`,
  },
  {
    name: "a card beside a shorter one, taller than its content",
    fails: "room",
    css: `${BITE_BASE}
.bite-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.bite-pair > .card { margin: 0; }
.bite-tall { min-height: 3lh; }`,
    html: `<div class="layout-bite"><div class="bite-pair">
<div class="card">Signed in as sasensi.</div>
<div class="card bite-tall">Then run lookover wait in your terminal.</div>
</div></div>`,
  },
  {
    // First review's phone rows before row 52's review fixes: a hidden chip, zero tall, holding its width at a title's
    // end, wrapped onto a line of its own, an empty line between the title and its small line.
    name: "a zero-tall hidden chip wrapped onto a line of its own",
    fails: "held",
    css: `${BITE_BASE}
.bite-title { display: block; width: 260px; }
.bite-chip { display: inline-block; vertical-align: top; width: 140px; height: 0; margin-left: 8px; visibility: hidden; }`,
    html: `<div class="layout-bite"><div class="card">
<b class="bite-title">Cache exchange rates<span class="bite-chip" aria-hidden="true"></span></b>
<span class="t-small">sasensi/ledger-api #148 · by sasensi</span>
</div></div>`,
  },
  {
    name: "a correct page",
    fails: null,
    css: `${BITE_BASE}
.bite-row { display: flex; gap: 12px; align-items: flex-start; }
.bite-row > p { margin: 0; flex: 1; }
.bite-scroll { height: 120px; overflow: auto; }
.bite-sticky { position: sticky; top: 0; }
.bite-clamp { margin: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.bite-card > p { margin: 0 0 12px; }
.bite-bar { display: flex; align-items: center; height: 96px; }
.bite-bar > p { margin: 0; }`,
    html: `<div class="layout-bite">
<div class="card bite-row"><p>A sentence long enough to wrap onto a second and a third line beside the button, which keeps the width of its widest label whichever it shows.</p>
<span class="same-width"><span class="same-width-slot"><button type="button" class="btn btn-secondary btn-sm">Try again</button></span><span class="same-width-slot" aria-hidden="true"><button type="button" class="btn btn-secondary btn-sm" tabindex="-1">Review this pull request</button></span></span></div>
<div class="card bite-row"><p>A row whose action's place is kept, empty, as wide as the label it may show.</p>
<span class="same-width"><span class="same-width-slot" aria-hidden="true"><button type="button" class="btn btn-secondary btn-sm" tabindex="-1">Sign in from a terminal</button></span></span></div>
<div class="card bite-scroll"><table class="tbl"><thead class="bite-sticky"><tr><th>Repository</th><th>Pull requests</th></tr></thead>
<tbody><tr><td>ledger-api</td><td>2 open</td></tr><tr><td>ledger-web</td><td>1 open</td></tr><tr><td>ledger-docs</td><td>None open</td></tr><tr><td>ledger-cli</td><td>None open</td></tr></tbody></table></div>
<div class="card"><p class="bite-clamp">A row's title clamped to two lines: long enough to need a third and a fourth line at this width, so the clamp cuts it after the second, and the row ends where its second line ends.</p></div>
<div class="card bite-bar"><p>A bar as tall as the design sets it, its line centred in it.</p></div>
<div class="card bite-card"><p>A card that ends on its button.</p><button type="button" class="btn btn-primary">Continue</button></div>
</div>`,
  },
];
