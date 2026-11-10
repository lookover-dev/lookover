// The design system's CSS takes its colours from the tokens (AGENTS.md rule 4), so both themes draw them: a colour
// written into a data-URI's SVG (`stroke='%23ACA69B'`) is one theme's grey in the other (row 47's review). The files
// are read once, and every rule is found by one helper, by its selector list and the at-rule it sits in.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

type File = "system.css" | "app.css" | "tokens.css";

const read = (file: File) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
const CSS: Record<File, string> = {
  "system.css": read("system.css"),
  "app.css": read("app.css"),
  "tokens.css": read("tokens.css"),
};

/** One rule: its selector list, its declarations and the at-rule it sits in (`@media (max-width: 640px)`), if any. */
interface Rule {
  file: File;
  selectors: string[];
  body: string;
  at: string | null;
}

const selectorList = (prelude: string) => prelude.split(",").map((s) => s.trim().replace(/\s+/g, " "));

/** Every rule of a file (or of `text`, a part of it), in its order, its comments taken out; an at-rule's own block is no rule. */
function parse(file: File, text: string = CSS[file]): Rule[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const open: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      open.push(css.slice(start, i).trim());
      start = i + 1;
    } else if (css[i] === "}") {
      const prelude = open.pop() ?? "";
      if (!prelude.startsWith("@"))
        rules.push({
          file,
          selectors: selectorList(prelude),
          body: css.slice(start, i),
          at: [...open].reverse().find((p) => p.startsWith("@")) ?? null,
        });
      start = i + 1;
    }
  }
  return rules;
}

const RULES: Rule[] = (["system.css", "app.css"] as const).flatMap((file) => parse(file));

/**
 * The declarations of the first rule whose selector list is exactly `selector` (system.css unless `file` says), outside
 * any at-rule unless `at` names one.
 */
function rule(
  selector: string,
  { file = "system.css", at = null }: { file?: File; at?: string | null } = {},
): string {
  const want = selectorList(selector).join(",");
  const found = RULES.find((r) => r.file === file && r.at === at && r.selectors.join(",") === want);
  if (found === undefined) throw new Error(`No rule ${selector} in ${file}${at === null ? "" : ` ${at}`}`);
  return found.body;
}

/** Every rule of `file` one of whose selectors `match` takes. */
const rulesWhere = (match: (selector: string) => boolean, file: File = "system.css") =>
  RULES.filter((r) => r.file === file && r.selectors.some(match));

const PHONE = "@media (max-width: 640px)";

test("no data-URI in the app's CSS carries a colour of its own", () => {
  for (const file of ["system.css", "app.css"] as const)
    expect(
      [...CSS[file].matchAll(/url\("data:[^"]*%23[0-9a-fA-F]{3,8}[^"]*"\)/g)].map((m) => `${file}: ${m[0]}`),
    ).toEqual([]);
});

// Motion is on tokens (ADR 0087): every duration a `--d-*`, a loop's `--loop-*` or the tooltip's `--delay-tip`, every
// easing an `--e-*`. Two places are not the app's to time: the eyes' region, written by `bun run brand` from
// @lookover/brand (ADR 0063), and the reduced-motion rule, which turns motion off whatever it is: only a rule inside
// `prefers-reduced-motion: reduce`, never one that asks for motion (`no-preference`).
const BRAND_REGION = /\/\* Written by `bun run brand`[\s\S]*?\/\* End of what `bun run brand` writes\. \*\//;
const REDUCED = /prefers-reduced-motion:\s*reduce\b/;
const reduced = (r: Rule) => r.at !== null && REDUCED.test(r.at);
const MOTION_RULES = (["system.css", "app.css"] as const)
  .flatMap((file) => parse(file, CSS[file].replace(BRAND_REGION, "")))
  .filter((r) => !reduced(r));

/** Each `property: value` of a rule's body. */
const declarations = (body: string) =>
  body
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.includes(":"))
    .map((d) => {
      const colon = d.indexOf(":");
      return {
        property: d.slice(0, colon).trim(),
        value: d
          .slice(colon + 1)
          .trim()
          .replace(/\s*!important$/, ""),
      };
    });

/** A value's comma-separated layers, a comma inside parentheses kept with its layer. */
function layers(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

/** What each motion property's every layer must be; a shorthand names a duration and an easing among its words. */
const ON_TOKENS: Record<string, (layer: string) => boolean> = {
  "": (layer) => /var\(--(d|loop)-[\w-]+\)/.test(layer) && /var\(--e-[\w-]+\)/.test(layer),
  "-duration": (layer) => /^var\(--(d|loop)-[\w-]+\)$/.test(layer),
  "-delay": (layer) => /^var\(--(d|delay)-[\w-]+\)$/.test(layer),
  "-timing-function": (layer) => /^var\(--e-[\w-]+\)$/.test(layer),
};

test("every transition and animation in the app's CSS names a duration token and an easing token (ADR 0087)", () => {
  const found = MOTION_RULES.flatMap(({ file, selectors, body }) =>
    declarations(body)
      .filter(
        ({ property, value }) => /^(transition|animation)(-[a-z-]+)?$/.test(property) && value !== "none",
      )
      .filter(({ property, value }) => {
        const onTokens = ON_TOKENS[property.replace(/^(transition|animation)/, "")];
        return onTokens !== undefined && !layers(value).every(onTokens);
      })
      .map(({ property, value }) => `${file} ${selectors.join(", ")}: ${property}: ${value}`),
  );
  expect(found).toEqual([]);
  // The test reads the motion it checks: the menus' entry is among its declarations.
  expect(
    MOTION_RULES.some((r) => r.selectors.includes(".layer") && /animation:\s*layer-in/.test(r.body)),
  ).toBe(true);
});

test("the motion check sets aside the reduced-motion rule and nothing else (ADR 0087)", () => {
  // The cut is there: the rule that turns motion off is in system.css, and only it is set aside.
  const cut = RULES.filter(reduced);
  expect(cut.length).toBeGreaterThan(0);
  expect(
    cut.every((r) =>
      r.selectors.every((s) => ["html", "*", "*::before", "*::after", "::backdrop"].includes(s)),
    ),
  ).toBe(true);
  // A rule that asks for motion is checked like any other.
  const asks = parse(
    "system.css",
    "@media (prefers-reduced-motion: no-preference) { .x { transition: opacity 1s; } }",
  );
  expect(asks.filter(reduced)).toEqual([]);
});

test("no raw duration or cubic-bezier in the app's CSS: they are tokens.css's (ADR 0087)", () => {
  const raw = /(?<![\w.-])\d*\.?\d+m?s\b|cubic-bezier/;
  const found = MOTION_RULES.flatMap(({ file, selectors, body }) =>
    declarations(body)
      .filter(({ value }) => raw.test(value))
      .map(({ property, value }) => `${file} ${selectors.join(", ")}: ${property}: ${value}`),
  );
  expect(found).toEqual([]);
  // The loops and the tooltip's delay are tokens; the eyes' 1.8 s stays in the region `bun run brand` writes.
  for (const token of ["--loop-pulse", "--loop-shimmer", "--loop-highlight", "--delay-tip", "--e-linear"])
    expect(CSS["tokens.css"]).toMatch(new RegExp(`${token}:\\s*[^;]+;`));
  expect(CSS["system.css"].match(BRAND_REGION)?.[0]).toContain("1.8s");
});

/**
 * A motion timed in code: a style's `transition`/`animationX` key, `.style.transition`, `setProperty("transition", …)`,
 * or a Web Animation whose duration is a number written there (`.animate(kf, { duration: 200 })`, `.animate(kf, 200)`);
 * a Web Animation reads its duration from a token, through `getComputedStyle`.
 */
const INLINE_MOTION = new RegExp(
  [
    /\b(transition|animation)([A-Z][A-Za-z]*)?\s*:/,
    /\.style\.(transition|animation)/,
    /\.setProperty\(\s*["'`](transition|animation)/,
    /\.animate\([^;]*?(\bduration\s*:\s*[\d.]|,\s*[\d.]+\s*\))/,
  ]
    .map((r) => r.source)
    .join("|"),
  "g",
);

test("the inline-motion scan catches each way code can time a motion", () => {
  for (const bad of [
    "<div style={{ transition: 'opacity 1s' }} />",
    "el.style.animation = 'x 1s';",
    'el.style.setProperty("transition", "opacity 1s");',
    "el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-in' });",
    "el.animate({ opacity: [0, 1] }, 180);",
  ])
    expect([...bad.matchAll(INLINE_MOTION)].length).toBe(1);
  // A duration read from a token is not caught.
  expect("el.animate(frames, { duration: ms(getComputedStyle(el).getPropertyValue('--d-2')) });").not.toMatch(
    INLINE_MOTION,
  );
});

test("no component of the app times a motion inline: transitions and animations are the CSS's (ADR 0087)", () => {
  const src = new URL("../", import.meta.url);
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
    // Test code (a test, its support: `dom.test-support.tsx` runs an exit by hand on happy-dom) is no component.
    (f) => /\.tsx?$/.test(f) && !/\.test(-support)?\.tsx?$/.test(f) && !f.endsWith(".d.ts"),
  );
  expect(files.filter((f) => f.endsWith(".tsx")).length).toBeGreaterThan(20);
  expect(files.filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(20);
  const inline = INLINE_MOTION;
  const found = files.flatMap((f) =>
    [...readFileSync(new URL(f.replaceAll("\\", "/"), src), "utf8").matchAll(inline)].map(
      (m) => `${f}: ${m[0]}`,
    ),
  );
  expect(found).toEqual([]);
});

test("no timer in the design system times a motion: the presence waits on the animations themselves (ADR 0087)", () => {
  const ui = new URL("../ui/", import.meta.url);
  // Sorted: readdirSync's order is the file system's, not the same on Linux as on Windows.
  const files = readdirSync(ui)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test(-support)?\.tsx?$/.test(f))
    .sort();
  expect(files).toContain("presence.tsx");
  const timers = files.flatMap((f) =>
    [...readFileSync(new URL(f, ui), "utf8").matchAll(/\bset(Timeout|Interval)\([^;]*/g)].map(
      (m) => `${f}: ${m[0]}`,
    ),
  );
  // A toast's own life, 5 s on screen, is no motion: its exit is the presence's. The presence's one safety bound, read
  // from the longest motion token, times no motion either: it ends a leave a paused animation would hold forever.
  expect(timers).toEqual([
    "layers.tsx: setTimeout(() => dismiss(id), 5000)",
    "presence.tsx: setTimeout(check, left)",
    "presence.tsx: setTimeout(check, limit)",
  ]);
  // That bound is the longest duration token's.
  const tokens = CSS["tokens.css"];
  const durations = [...tokens.matchAll(/(--d-\d+):\s*(\d+)ms;/g)].map((m) => [m[1], Number(m[2])] as const);
  const longest = durations.reduce((a, b) => (b[1] > a[1] ? b : a));
  expect(readFileSync(new URL("presence.tsx", ui), "utf8")).toContain(`const LONGEST = "${longest[0]}";`);
});

test("what leaves ends on its leaving class: fade out over --d-2, easing in, no fill mode holding the last frame", () => {
  expect(rule(".leaving")).toMatch(/pointer-events:\s*none;/);
  for (const [selector, name] of [
    [".layer.leaving", "layer-out"],
    [".scrim.leaving", "fade-out"],
    [".toast.leaving", "toast-out"],
  ] as const) {
    expect(rule(selector)).toContain(`animation: ${name} var(--d-2) var(--e-in);`);
    expect(rule(selector)).toMatch(/opacity:\s*0;/);
  }
  // The toast leaves the way it came in: back out to the right.
  expect(rule(".toast.leaving")).toMatch(/transform:\s*translateX\(16px\);/);
  expect(`${CSS["system.css"]}${CSS["app.css"]}`).not.toMatch(/\bforwards\b/);
  // Nothing in the app's CSS still keys an exit on the toast's old class.
  expect(rulesWhere((s) => s.includes(".toast.out"))).toEqual([]);
});

test("a row and its section, a notice, the band and its lines leave over --d-2, easing in, on their leaving class", () => {
  for (const [selector, name, file] of [
    [".rowi.leaving", "row-out", "system.css"],
    [".grp.leaving", "fade-out", "system.css"],
    [".banner.leaving", "fade-out", "system.css"],
    [".alerts.leaving", "band-out", "system.css"],
    [".alert.leaving", "fade-out", "system.css"],
    [".departed.leaving", "fade-out", "app.css"],
    [".departed-list li.leaving", "fade-out", "app.css"],
  ] as const) {
    expect(rule(selector, { file })).toContain(`animation: ${name} var(--d-2) var(--e-in);`);
    expect(rule(selector, { file })).toMatch(/opacity:\s*0;/);
  }
  // Each leaves the way it came: a row back up the 6 px it rose, the band back down the 6 px it slid up.
  expect(rule(".rowi.leaving")).toMatch(/transform:\s*translateY\(-6px\);/);
  expect(rule(".alerts.leaving")).toMatch(/transform:\s*translateY\(6px\);/);
  // The band's exit comes after its entry's rule of the same weight, so a band that slid in leaves the same way.
  const system = CSS["system.css"];
  expect(system.indexOf("\n.alerts.leaving {")).toBeGreaterThan(system.indexOf("\n.alerts[data-arrived] {"));
  // A section that comes with its first row fades in, behind the gate.
  expect(rule(".grp.new[data-arrived]")).toContain("animation: fade var(--d-4) var(--e-out);");
});

test("a fresh row rises in only behind the first-paint gate, never on the page's first paint", () => {
  expect(rule(".rowi.new[data-arrived]")).toMatch(/animation:\s*row-in /);
  expect(rulesWhere((s) => s === ".rowi.new")).toEqual([]);
});

test("the alert band slides in only behind the first-paint gate, never on the page's first paint", () => {
  expect(rule(".alerts[data-arrived]")).toMatch(/animation:\s*page-in /);
  expect(rulesWhere((s) => s === ".alerts").filter((r) => /animation/.test(r.body))).toEqual([]);
});

test("a group's rows come in only by its fold, rising 4 px, and leave the way they came, never by height", () => {
  expect(rule(".fold-row[data-unfolded]")).toContain("animation: fold-in var(--d-3) var(--e-out);");
  expect(rulesWhere((s) => s === ".fold-row").filter((r) => /animation/.test(r.body))).toEqual([]);
  expect(rule(".fold-row.leaving")).toContain("animation: fold-out var(--d-2) var(--e-in);");
  expect(rule(".fold-row.leaving")).toMatch(/opacity:\s*0;/);
  expect(rule(".fold-row.leaving")).toMatch(/transform:\s*translateY\(4px\);/);
  expect(rulesWhere((s) => s.includes(".fold-row")).filter((r) => /height/.test(r.body))).toEqual([]);
});

test("a state square draws no tile in any state: each state is its icon in its colour (round 5)", () => {
  // The square itself: no tile, so a done Claude and a Codex to do read as one pair.
  expect(rule(".engine .lg")).toMatch(/background:\s*none;/);
  // No state brings a tile back.
  const states = rulesWhere((s) => s.startsWith(".engine .lg") && s !== ".engine .lg");
  expect(states.length).toBeGreaterThan(0);
  for (const { selectors, body } of states)
    expect(`${selectors.join(", ")}: ${body}`).not.toMatch(/background(-color)?:\s*(?!none)/);
  // Each state's icon in its colour: to do `--ink-2`, done green, stale amber, refused pink.
  expect(rule(".engine .lg.todo .ic")).toMatch(/color:\s*var\(--ink-2\);/);
  expect(rule(".engine .lg .ic")).toMatch(/color:\s*var\(--ok-text\);/);
  expect(rule(".engine .lg.stale .ic")).toMatch(/color:\s*var\(--warn-text\);/);
  expect(rule(".engine .lg.refused .ic")).toMatch(/color:\s*var\(--acc-text\);/);
  // The to-do square's own colour drew nothing: its icon's rule says it.
  expect(rulesWhere((s) => s === ".engine .lg.todo")).toEqual([]);
  expect(CSS["system.css"]).not.toContain(".state-dot");
});

test("Your coding agent's rows share their columns, so each row's text is as wide as the others'", () => {
  expect(rule(".agent-rows > .engine")).toMatch(/grid-template-columns:\s*subgrid;/);
});

test("an agent row lays its title, sentence and line in tracks of their own, no room held for another detail", () => {
  // Three tracks, each as tall as the piece it shows; no flexible track taking room.
  expect(rule(".agent-rows > .agent-row")).toMatch(/grid-template-rows:\s*auto auto auto;/);
  expect(rule(".agent-rows > .agent-row")).toMatch(/row-gap:\s*0;/);
  // The title, then the sentence and the line across the text and action columns.
  expect(rule(".agent-row > b")).toMatch(/grid-area:\s*1 \/ 2;/);
  expect(rule(".agent-row > .substep-detail")).toMatch(/grid-column:\s*2 \/ -1;[^}]*grid-row:\s*2;/);
  expect(rule(".agent-row > .agent-line")).toMatch(/grid-column:\s*2 \/ -1;[^}]*grid-row:\s*3;/);
  // No hidden copy of another detail (ADR 0086).
  expect(CSS["system.css"]).not.toContain(".agent-held");
  // On a phone the action under the line, in a fourth track.
  const phone = rule(".agent-rows > .agent-row", { at: PHONE });
  expect(phone).toMatch(/grid-template-rows:\s*auto auto auto auto;/);
  expect(phone).not.toContain("1fr");
  expect(rule(".agent-row > .agent-act", { at: PHONE })).toMatch(/grid-row:\s*4;/);
});

test("Try it, the posting step, a held rule's why and a field's help hold no line they may not fill (ADR 0086)", () => {
  // Their text takes the lines it says; the layout pass in `proof` measures that nothing ends on held room.
  for (const selector of [
    ".try-it .try-next",
    ".steplist .two-lines",
    ".rule-held",
    ".field .help",
    ".field .err",
  ])
    for (const file of ["system.css", "app.css"] as const)
      for (const { body } of rulesWhere((s) => s === selector, file))
        expect(body).not.toMatch(/(min-)?height:[^;]*lh/);
  expect(rule(".steplist li:has(> .two-lines)", { file: "app.css" })).not.toMatch(/1lh\s+1lh/);
  // No hidden copy holds their room.
  expect(CSS["system.css"]).not.toContain(".field-note");
  expect(CSS["app.css"]).not.toContain(".rule-held.room");
});

test("setup's footer line, its refusal and First review's line hold no line, and no hidden copy holds setup's room (ADR 0086)", () => {
  for (const file of ["system.css", "app.css"] as const)
    for (const { selectors, body } of rulesWhere(
      (s) => /\.(setup-said|refused-line|first-reviewed-line|at-login-line|substep-detail)\b/.test(s),
      file,
    ))
      expect(`${selectors.join(", ")}: ${body}`).not.toMatch(/(min-)?height:\s*(calc\([^;]*em|[^;]*lh)/);
  for (const gone of [".held-detail", ".held-room", ".background-hold", ".setup-said.held"])
    for (const file of ["system.css", "app.css"] as const) expect(CSS[file]).not.toContain(gone);
});

test("the installs are rows of one card: square, title and action on one line, a hairline between rows (round 6)", () => {
  // The square and the action on the title's line, centred on it, the square as tall as a small button.
  expect(rule(".agent-row > .agent-act")).toMatch(/grid-area:\s*1 \/ 3;/);
  expect(rule(".substep > .lg")).toMatch(/grid-area:\s*1 \/ 1;/);
  expect(rule(".substep > .lg")).toMatch(/height:\s*var\(--h-sm\);/);
  // Rows of the card, not cards: no edge, no fill, a hairline between them.
  const row = rule(".agent-rows > .engine");
  expect(row).toMatch(/border:\s*0;/);
  expect(row).toMatch(/background:\s*none;/);
  expect(rule(".agent-rows > .engine ~ .engine")).toMatch(/border-top:\s*1px solid var\(--line\);/);
});

test("a setup sub-step: square, title and action on one line, its detail and list on the text column (round 6)", () => {
  expect(rule(".substep > b")).toMatch(/grid-area:\s*1 \/ 2;/);
  expect(rule(".substep > .substep-act")).toMatch(/grid-area:\s*1 \/ 3;/);
  expect(rule(".substep > .substep-detail")).toMatch(/grid-column:\s*2 \/ -1;/);
  // The accounts list on "Your accounts"' text column, not from under the square.
  expect(rule(".substep-below")).toMatch(/grid-column:\s*2 \/ -1;/);
});

/** Whether any rule of the accounts list holds a line count: no row holds a line it doesn't show (ADR 0086). */
const accountsHoldLines = () =>
  rulesWhere((sel) => /\.account-|\.accounts-list/.test(sel)).some(({ body }) =>
    /min-height:\s*[\d.]+lh/.test(body),
  );

test("setup's accounts card ends as it starts: no row holds a blank line, the list's band trimmed (round 6)", () => {
  // Round 5: the last row's held second line and its band's padding left the card about twice as deep under the list
  // as over "Your accounts" (screen 07). Row 52: every row's held second line went too; proof's layout pass measures it.
  expect(accountsHoldLines()).toBe(false);
  // The sum its comment names: the last band's `--s-2` and `--s-1` of the card's step.
  expect(rule(".substep-below > .accounts-list")).toMatch(
    /margin-bottom:\s*calc\(-1 \* \(var\(--s-2\) \+ var\(--s-1\)\)\);/,
  );
});

test("setup's sign-in card ends as it starts: its bottom as deep as the title's line over its top (round 6)", () => {
  // Round 5 then round 6's first pass: the title centred on a line as tall as a small button sat about 9 px lower
  // under the card's edge than its last line sat over the other (screen 07).
  // A card's 14 px named once, both rules reading it: the sub-step's bottom a step more.
  expect(rule(".engine")).toMatch(/--engine-pad:\s*14px;/);
  expect(rule(".engine")).toMatch(/padding:\s*var\(--engine-pad\);/);
  expect(rule(".substep")).toMatch(/padding-bottom:\s*calc\(var\(--engine-pad\) \+ var\(--s-2\)\);/);
  // On a phone a done sub-step holds no blank row for the action it no longer has (the sign-in card's empty band).
  expect(rule(".substep.done > .substep-act", { at: PHONE })).toMatch(/display:\s*none;/);
  // The installs' rows keep their own padding: rows of a card, not cards.
  expect(rule(".agent-rows > .engine")).toMatch(/padding:\s*var\(--s-3\) 0;/);
});

test("an intro never ends on one word alone: balanced, not only pretty (round 6)", () => {
  expect(rule(".sentence small")).toMatch(/text-wrap:\s*balance;/);
  // Settings' sections' intros too (Your coding agent's), by their class, never inline.
  expect(rule(".section-intro")).toMatch(/text-wrap:\s*balance;/);
});

test("a card's title is one size wherever a card is titled in a step (round 6)", () => {
  expect(rule(".card-title")).toMatch(/font:\s*700 var\(--t-14\)/);
});

test("the live log hugs its lines, eight at most, never an empty band under them (round 3)", () => {
  const live = rule(".code.live");
  expect(live).toMatch(/max-height:\s*calc\(8lh/);
  expect(live).not.toMatch(/(?:^|[\s;])height:/);
});

test("a commit in a sentence keeps a whole space either side: no margin draws it into them (round 4)", () => {
  for (const { body } of rulesWhere((s) => s.includes("code.sha"))) expect(body).not.toContain("margin");
  expect(rule("code.sha.tight, code.path.tight")).toMatch(/^\s*padding-right:\s*0;\s*$/);
});

test("Reviewing… is a status line, not a chip, a button nor a link: no fill, no edge, at the end of its place", () => {
  const busy = rule(".busy-status");
  expect(busy).not.toMatch(/background|border/);
  expect(busy).toMatch(/padding:\s*0 var\(--line-w\);/);
  // Right beside Open on GitHub, the room the place keeps on its other side (round 6: far from it, it read as stray).
  expect(busy).toMatch(/margin-inline:\s*auto 0/);
  // Its words in `--ink-2`, as a step's; only the eyes take the tone (round 6: lavender words read as a link).
  expect(busy).toMatch(/color:\s*var\(--ink-2\);/);
  expect(rule('.busy-status[data-tone="run"] .eyes')).toMatch(/color:\s*var\(--run-text\);/);
  expect(rule('.busy-status[data-tone="wait"] .eyes')).toMatch(/color:\s*var\(--warn-text\);/);
  expect(rulesWhere((s) => /^\.busy-status\[data-tone="\w+"\]$/.test(s))).toEqual([]);
  // Nothing of a chip's to take off: no rule draws it as one.
  expect(rulesWhere((s) => s.includes(".busy-status::before"))).toEqual([]);
});

test("a review's page: pending steps and a finding's meta in --ink-2, the meta and its file one block (round 6)", () => {
  expect(rule(".steplist li", { file: "app.css" })).toMatch(/color:\s*var\(--ink-2\);/);
  expect(rule(".steplist .dot", { file: "app.css" })).toMatch(/border:\s*1\.5px solid var\(--ink-2\);/);
  expect(rule(".finding .t")).toMatch(/color:\s*var\(--ink-2\);/);
  expect(rule(".finding-meta")).toMatch(/gap:\s*var\(--s-1\);/);
});

test("a step's new mark and the verdict come in only behind the first-paint gate, never on the page's first paint", () => {
  expect(rule(".steplist .step-mark[data-arrived]", { file: "app.css" })).toMatch(
    /animation:\s*step-mark-in var\(--d-2\) var\(--e-out\);/,
  );
  expect(CSS["app.css"]).toMatch(
    /@keyframes step-mark-in \{\s*from \{\s*opacity: 0;\s*transform: scale\(0\.9\);/,
  );
  expect(rule(".verdict[data-arrived]", { file: "app.css" })).toMatch(
    /animation:\s*page-in var\(--d-4\) var\(--e-out\);/,
  );
  // The mark's wrapper moves, never the eyes' own reading, and nothing moves without the gate's mark.
  expect(
    rulesWhere((s) => s === ".steplist .step-mark" || s === ".verdict").filter((r) =>
      /animation/.test(r.body),
    ),
  ).toEqual([]);
});

test("a needs-you finding among others is marked by its edge in the needs tone, never a chip (round 6)", () => {
  expect(rule(".finding.need")).toMatch(/^\s*border-color:\s*var\(--acc\);\s*$/);
});

test("a done finding's severity is quieter, never fainter than --muted (round 6)", () => {
  const done = rule(".findings .rowi .sev-label", { file: "app.css" });
  expect(done).toMatch(/color:\s*var\(--muted\);/);
  expect(done).not.toMatch(/opacity/);
});

test("every outcome's summary opens with the eyes in its tone: green settled, amber to fix (round 6)", () => {
  expect(rule(".verdict.ok .eyes", { file: "app.css" })).toMatch(/color:\s*var\(--ok-text\);/);
  expect(rule(".verdict.fix .eyes", { file: "app.css" })).toMatch(/color:\s*var\(--warn-text\);/);
});

test("Repositories' column heads stick under its bar, and its group heads under the column heads", () => {
  expect(rule(".repos-bar")).toMatch(/position:\s*sticky;\s*top:\s*var\(--h-top\)/);
  expect(rule(".repos-bar + .tbl.repos")).toContain("--repos-stuck: calc(var(--h-top) + var(--h-repos-bar))");
  expect(rule(".tbl.repos thead th")).toMatch(/position:\s*sticky;\s*top:\s*var\(--repos-stuck\)/);
  expect(rule(".tbl.repos .repos-group:not(.repos-group-more) > *")).toContain(
    "top: calc(var(--repos-stuck) + var(--h-thead) - var(--line-w))",
  );
});

test("a group head's second row scrolls with its group at every width, and no head holds a height it doesn't show", () => {
  // Row 52: every wide head held at 52 px kept a button's row on heads showing none, and a cause wrapping to two lines
  // still showed from under a later head. Only the first row sticks; the cause, its fix and the filter's line scroll.
  const second = rulesWhere((s) => /(?<!:not\()\.repos-group-more/.test(s));
  expect(second.some(({ body }) => /sticky|display:\s*none/.test(body))).toBe(false);
  expect(
    rulesWhere((s) => s.includes(".repos-group")).some(({ body }) => /(^|[^-])height:\s*calc/.test(body)),
  ).toBe(false);
});

test("an account row's action place is pinned to its top, so a detail growing a line moves no button", () => {
  // Row 52: centred on the login and its detail, a button moved half a line under the pointer when its detail grew.
  expect(rule(".account-row")).toMatch(/align-items:\s*start;/);
});

test("a group head's count wraps rather than take the account's width", () => {
  // Just past a phone's width the first column is narrow: a count held at its longest on one line left the account
  // none (Lookover's F4 on round 5).
  for (const { body } of rulesWhere((s) => s.startsWith(".repos-group-count")))
    expect(body).not.toContain("nowrap");
  expect(rule(".repos-group-title")).toMatch(
    /grid-template-columns:\s*var\(--chevron\) minmax\(0, max-content\) auto;/,
  );
});

test("a settings row's help takes the room its control leaves, never half the card", () => {
  expect(rule(".setrow span")).not.toContain("max-width");
});

test("a settings row's segmented control is as wide as the token says, the token among the others", () => {
  expect(rule(".setrow > .seg")).toMatch(/width:\s*var\(--setrow-control\);/);
  expect(CSS["tokens.css"]).toMatch(/\n {2}--setrow-control:\s*240px;/);
  expect(CSS["system.css"]).not.toMatch(/--setrow-control:/);
});

test("what opens under a notice starts on its text column and reaches its action edge, its ring room given back (round 6)", () => {
  const below = rule(".banner-below");
  expect(below).toMatch(/grid-column:\s*2 \/ -1;/);
  expect(below).toMatch(/margin-inline:\s*calc\(-1 \* var\(--s-1\)\);/);
  expect(rule(".banner-below > div")).toMatch(/padding-inline:\s*var\(--s-1\);/);
  // Closed, it takes no row gap: the notice is as tall as one with nothing under it.
  expect(rule(".banner:has(> .banner-below)")).toMatch(/row-gap:\s*0;/);
  // No layout of its own for the departed summary: it is laid out as every notice.
  expect(CSS["app.css"]).not.toMatch(/\.departed \.banner/);
});

test("a disclosure's content starts past the chevron and its gap, in their tokens, never in pixels", () => {
  expect(rule(".disc-in", { file: "app.css" })).toMatch(
    /padding:[^;]*calc\(var\(--ic\) \+ var\(--disc-gap\)\);/,
  );
  expect(rule(".disc-btn", { file: "app.css" })).toMatch(/gap:\s*var\(--disc-gap\);/);
  expect(CSS["tokens.css"]).toMatch(/--ic:\s*16px;[^}]*--disc-gap:\s*6px;/);
});

test("a settings row's checkbox list starts level with the row's title, as its other controls read", () => {
  expect(rule(".setrow > .stack")).toMatch(/align-self:\s*start;/);
});

test("a held switch is the off switch's one drawing, only its cursor saying it can't move", () => {
  expect(rule(".switch.held")).toMatch(/^\s*cursor:\s*not-allowed;\s*$/);
  expect(rulesWhere((s) => s.startsWith(".switch.held i"))).toEqual([]);
});

test("Settings' section labels scroll with their section: nothing sticks there to read as a section left empty", () => {
  expect(CSS["system.css"]).not.toContain('[data-screen="settings"] > .grp');
});

test("a group opened by link lands its label under the top bar, the card above it out of sight", () => {
  // The group above ends the page's gap and the label's margin, 32 px, over the label: more than the 20 px kept, so
  // nothing of its card shows under the top bar (round 5: a sliver of it did, screens 03, 05, 22).
  expect(rule(".page > .grp")).toMatch(/scroll-margin-top:\s*calc\(var\(--h-top\) \+ var\(--s-5\)\);/);
  expect(rule(".page > .grp + .grp")).toMatch(/margin-top:\s*var\(--s-3\);/);
  expect(rule(".page", { file: "app.css" })).toMatch(/gap:\s*var\(--s-5\);/);
});

test("Settings' GitHub card ends as it starts: no row holds a blank line, the list's end a settings row's", () => {
  // Round 5: every row's held second line left a band under Another account, the list's last row, which can show
  // nothing else, about twice the card's top padding (screens 03, 06, 22).
  // One rule, the accounts list's own, in setup and Settings alike: no row holds a blank line, so no Settings-only
  // copy of it (design-system.md "Accounts list").
  expect(accountsHoldLines()).toBe(false);
  expect(CSS["system.css"]).not.toContain(".setcard-accounts .account-row:last-child .held-detail");
  // One shorthand: the card's top, the sides none, the bottom a settings row's under the last row's band.
  expect(rule(".setcard-accounts")).toMatch(
    /padding:\s*var\(--s-3\) 0 calc\(var\(--setrow-y\) - var\(--s-2\)\);/,
  );
  expect(rule(".setcard-accounts")).not.toMatch(/padding-bottom/);
});

test("a settings row's checkbox list is the control column's width, words at its start, boxes at its end", () => {
  // Round 5: right-aligned words started at as many places as there were boxes, beside selects 240 wide (screen 06).
  expect(rule(".setrow > .stack")).toMatch(/width:\s*var\(--setrow-control\);/);
  expect(rule(".setrow > .stack > .check")).toMatch(/justify-content:\s*space-between;/);
  expect(rule(".setrow > .stack > .check")).toMatch(/text-align:\s*left;/);
});

// design-system.md "Type": metadata and labels are read without effort in dark, so the smallest text is 12 px, a
// key's cap and a setup step's numeral in its 18 px ring under it (and the developer drawer's, never in a shot of the product); metadata in the body face is 13.
const sizeOf = (selector: string) => {
  const found = RULES.find((r) => r.selectors.includes(selector) && /font(-size)?:/.test(r.body));
  if (!found) throw new Error(`no font rule for ${selector}`);
  return `${selector}: ${found.body.match(/font(?:-size)?:[^;]*?(var\(--t-\d+\)|\d+px)/)?.[1]}`;
};

test("no text is under 12 px but a key's cap, a setup step's numeral in its ring and the developer drawer's", () => {
  expect(
    RULES.filter((r) => /font(-size)?:[^;]*\b(1[01]|[0-9])px/.test(r.body))
      .flatMap((r) => r.selectors)
      .filter((s) => !s.startsWith(".kbd") && !s.startsWith(".steps-mark") && !s.startsWith(".drawer")),
  ).toEqual([]);
});

test("labels are 12 px mono caps, metadata in the body face 13", () => {
  const labels = [
    ".t-label",
    ".grp > h4",
    ".menu .h",
    ".tbl th",
    ".finding .sev",
    ".sev-label",
    ".alert-label",
  ];
  expect(labels.map(sizeOf)).toEqual(labels.map((s) => `${s}: var(--t-12)`));
  const meta = [".rowi .me", ".detail .v", ".rule-held", ".origin-line", ".disc-row .disc-v", ".menu .r"];
  expect(meta.map(sizeOf)).toEqual(meta.map((s) => `${s}: var(--t-13)`));
});

test("a state chip in a list is one width, set once on the chip, so every title after it starts at one x", () => {
  // the chip itself, not only its column: a chip as wide as its word moved its edge as the word changed
  expect(rule(".rowi.status > .chip, .cmdk-lead > .chip")).toMatch(/width:\s*var\(--w-chip\)/);
  // its column as wide as the chip: the width said once
  expect(rule(".rowi.status", { file: "app.css" })).toMatch(/grid-template-columns:\s*auto 1fr auto;/);
  expect(rule(".cmdk-lead", { file: "app.css" })).not.toContain("width");
  expect(RULES.filter((r) => r.file === "app.css" && r.body.includes("--w-chip"))).toEqual([]);
});

test("every state chip is one construction: its tone's soft fill, its tone's edge, its tone's word (round 6)", () => {
  // `.chip` draws; a tone only names its three colours, so no tone can draw itself apart again (round 5: filled,
  // outlined and tinted read as three components)
  const chip = rule(".chip");
  expect(chip).toMatch(/background:\s*var\(--tone-soft\);/);
  // the edge is the tone, half over its own fill: at full strength on dark it drew an outline button
  expect(chip).toMatch(
    /border:\s*var\(--line-w\) solid color-mix\(in srgb, var\(--tone\) 55%, var\(--tone-soft\)\);/,
  );
  expect(chip).toMatch(/color:\s*var\(--tone-text\);/);
  const tones = rulesWhere((s) => /^\.c-[a-z]+$/.test(s));
  expect(tones.map((r) => r.selectors.join(","))).toEqual([
    ".c-need",
    ".c-run",
    ".c-ok",
    // Waiting is To fix's three colours, said once: one rule for both
    ".c-warn,.c-wait",
    ".c-mute",
  ]);
  for (const t of tones) {
    const props = [...t.body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    expect(`${t.selectors[0]}: ${props.join(" ")}`).toBe(`${t.selectors[0]}: --tone --tone-soft --tone-text`);
  }
  // the light theme darkens every chip's word alike, never one tone apart
  expect(rule(':root[data-theme="light"] .chip')).toMatch(
    /color:\s*color-mix\(in srgb, var\(--tone-text\) 70%, var\(--ink\)\);/,
  );
  expect(rulesWhere((s) => /^:root\[data-theme="light"\] \.c-/.test(s))).toEqual([]);
  // Waiting is told from To fix by its ring dot alone, not by another construction
  expect(rule(".c-wait::before")).toMatch(/box-shadow:\s*inset 0 0 0 1.5px currentColor;/);
});

test("the palette's values end at the panel's edge, as the key cap does, each on one line (round 5)", () => {
  // In the design system by `.menu .r`, which it narrows: never an app.css rule overriding it from afar.
  expect(rule(".menu button .kbd, .menu button .r")).toMatch(/margin-left:\s*auto;/);
  const value = rule(".cmdk .menu button > .r");
  expect(value).toMatch(/text-align:\s*right;/);
  expect(value).toMatch(/white-space:\s*nowrap;/);
  // No column of its own: from one x in the middle of the row, the values floated, tied to nothing (round 4).
  expect(value).not.toMatch(/width:/);
  expect(CSS["tokens.css"]).not.toContain("--w-cmdk-value");
  expect(CSS["app.css"]).not.toContain(".cmdk .menu button > .r");
});

test("the Logs page's time steps down to --muted, so each line's words read first (round 5)", () => {
  expect(rule(".code.log.file .line")).toMatch(/color:\s*var\(--ink\);/);
  expect(rule(".code.log.file .when")).toMatch(/color:\s*var\(--muted\);/);
});

test("the Logs page names a pull request once, a head over its run's words, each run apart (ADR 0083, round 6)", () => {
  // Over the words' column, not the time's, so the times stay one column; read as a head, not as one more line.
  const head = rule(".code.log.file .head");
  expect(head).toMatch(/display:\s*block;/);
  expect(head).toMatch(/padding-left:\s*var\(--when\);/);
  expect(head).toMatch(/font-weight:\s*600;/);
  expect(head).toMatch(/color:\s*var\(--ink-2\);/);
  expect(rule(".code.log.file .run + .run")).toMatch(/margin-top:\s*var\(--s-2\);/);
  // The day's wider column is the run's, so the head and every line's words move together, across midnight too.
  expect(rule(".code.log.file .run.day")).toMatch(/--when:\s*16ch;/);
  expect(CSS["system.css"]).not.toMatch(/\.code\.log\.file \.(line|head)\.day/);
});

test("a Logs page line hangs 2 characters past its words' start, the name no longer on the line (rounds 4, 6)", () => {
  expect(rule(".code.log.file .line")).toMatch(/--hang:\s*calc\(var\(--when\) \+ 2ch\);/);
  expect(CSS["system.css"]).not.toContain("--about");
});

test("a severity label ends on a space, read and not seen: its margin is --s-2 less the mono space it ends on", () => {
  // The space is `1ch` in the mono face plus the label's letter-spacing, so the title still starts `--s-2` after it.
  expect(rule(".finding .sev")).toMatch(/letter-spacing:\s*0\.06em;/);
  expect(rule(".sev-label", { file: "app.css" })).toMatch(/letter-spacing:\s*0\.06em;/);
  for (const selector of [".finding h5 .sev", ".rowi .ti .sev-label"])
    expect(rule(selector)).toMatch(/^\s*margin-right:\s*calc\(var\(--s-2\) - 1ch - 0\.06em\);\s*$/);
});

test("the status menu's lines, fine or not, sit in wells of one inset, so the list has one left edge (round 5)", () => {
  const well = rule(".menu .st-block.leads, .menu .st-fine", { file: "app.css" });
  expect(well).toMatch(/margin-inline:/);
  expect(well).toMatch(/padding:/);
  expect(well).toMatch(/border:\s*var\(--line-w\) solid var\(--line-overlay\);/);
  expect(well).toMatch(/border-radius:\s*var\(--r-2\);/);
  // The problems on the page's ground, the fine ones on the menu's: they still stand apart.
  expect(rule(".menu .st-block.leads", { file: "app.css" })).toMatch(/background:\s*var\(--bg\);/);
});

test("the status menu's fine lines are set apart from its problems, quieter, never fainter than --muted (round 6)", () => {
  // a heading of the menu's own over the fine well, a step down from the problems
  expect(rule(".menu .st-h", { file: "app.css" })).toMatch(/padding:\s*var\(--s-3\) 0 var\(--s-1\);/);
  // the problems grow stronger, the fine lines and every detail read in --ink-2
  expect(rule(".menu .st-block.leads > span .st-text", { file: "app.css" })).toMatch(
    /color:\s*var\(--ink\);[\s\S]*font-weight:\s*600;/,
  );
  expect(rule(".menu .st")).toMatch(/color:\s*var\(--ink-2\);/);
  expect(rule(".st-note", { file: "app.css" })).toMatch(/color:\s*var\(--ink-2\);/);
});

test("what is under a dialog or the status menu is dimmed and out of focus", () => {
  for (const selector of [".scrim", "dialog.dlg::backdrop"]) {
    expect(rule(selector)).toContain("background: var(--scrim)");
    expect(rule(selector)).toContain("backdrop-filter: blur(var(--scrim-blur))");
  }
});

test("a closed dialog and its backdrop fade out over --d-2, easing in, displayed and on top until the fade ends", () => {
  const OVERLAY = "@supports (overlay: auto)";
  // Closed, they hold the end of the fade, the dialog where it came in from, and take no click: the page is live.
  expect(rule("dialog.dlg:not([open])")).toMatch(
    /opacity:\s*0;[\s\S]*transform:\s*translateY\(4px\) scale\(0\.98\);/,
  );
  expect(rule("dialog.dlg:not([open])::backdrop")).toMatch(/opacity:\s*0;/);
  expect(rule("dialog.dlg:not([open]), dialog.dlg:not([open])::backdrop")).toMatch(/pointer-events:\s*none;/);
  for (const [selector, moved] of [
    ["dialog.dlg", ["opacity", "transform"]],
    ["dialog.dlg::backdrop", ["opacity"]],
  ] as const) {
    // Only where `overlay` transitions: elsewhere a closed dialog still shown would be out of the top layer, without
    // its backdrop, so there it has no transition and is hidden at once.
    expect(rule(selector)).not.toMatch(/transition:/);
    const transition = /transition:([^;]*);/.exec(rule(selector, { at: OVERLAY }))?.[1] ?? "";
    for (const property of moved) expect(transition).toContain(`${property} var(--d-2) var(--e-in)`);
    // `display` and `overlay` change at the fade's end: the closed dialog stays shown, and over the page, until then.
    for (const property of ["display", "overlay"])
      expect(transition).toContain(`${property} var(--d-2) var(--e-in) allow-discrete`);
  }
  // That block holds the dialog's fade and nothing else.
  expect(RULES.filter((r) => r.at === OVERLAY).map((r) => r.selectors.join(", "))).toEqual([
    "dialog.dlg",
    "dialog.dlg::backdrop",
  ]);
  // Their entries play only as they open, so a closed dialog's fade is the transition's alone.
  expect(rule("dialog.dlg[open]")).toContain("animation: dlg-in var(--d-3) var(--e-out);");
  expect(rule("dialog.dlg[open]::backdrop")).toContain("animation: fade var(--d-3) var(--e-out);");
  expect(rule("dialog.dlg")).not.toMatch(/animation:/);
  expect(rule("dialog.dlg::backdrop")).not.toMatch(/animation:/);
});

test("the alert band is the design system's block, after the pill whose colours it shares, none of it in app.css", () => {
  const system = CSS["system.css"];
  expect(CSS["app.css"]).not.toMatch(/\.alerts?\b/);
  const pill = system.indexOf("\n.pill i.need {");
  const band = system.indexOf("\n.alerts {");
  const layers = system.indexOf("/* floating layers */");
  expect(pill).toBeGreaterThan(-1);
  expect(band).toBeGreaterThan(pill);
  expect(layers).toBeGreaterThan(band);
});

test("each line of the alert band is tinted by its own tone, edge to edge: pink needs you, amber waits or was refused", () => {
  // The band has no tint of its own, so a Waiting line in a band that also needs you is never on pink.
  expect(rule(".alerts")).not.toContain("background");
  expect(rule(".alerts-in")).toMatch(/padding:\s*0 var\(--s-5\);/);
  expect(rule(".alert.need")).toMatch(/--tint:\s*var\(--acc-soft\);/);
  expect(rule(".alert.warn")).toMatch(/--tint:\s*var\(--warn-soft\);/);
  // Past the line to the band's sides, painted only: a border image's outset neither lays out nor scrolls.
  expect(rule(".alert.need, .alert.warn")).toMatch(
    /border-image:\s*linear-gradient\(var\(--tint\) 0 0\) fill 0 \/ 0 \/ 0 100vmax;/,
  );
  // The border image paints in the border's place, so the hairline between two lines is drawn in it.
  expect(rule(".alert + .alert")).toMatch(
    /border-image-source:\s*linear-gradient\(var\(--line-2\) 0 1px, var\(--tint\) 1px\);/,
  );
  // The band's padding is its first and last lines', so the tints reach its top and bottom edges and every line keeps
  // the place it had.
  expect(rule(".alert:first-child")).toMatch(/padding-top:\s*calc\(2 \* var\(--s-2\)\);/);
  expect(rule(".alert:last-child")).toMatch(/padding-bottom:\s*calc\(2 \* var\(--s-2\)\);/);
});

test("Repositories' switches are boxes of their own height, centred by their cells, never sat on a line's baseline", () => {
  // An inline switch sits on the text's baseline, a few pixels above its row's centre (round 4's scorers).
  const switches = rule(".tbl.repos td > .switch, .tbl.repos .repos-group-switch", { file: "app.css" });
  expect(switches).toMatch(/display:\s*flex;/);
  expect(switches).not.toMatch(/inline/);
});

test("the Reviewing head sits centred over its switches, each switch centred in the column (round 6)", () => {
  expect(rule(".tbl.repos thead th:nth-child(3)", { file: "app.css" })).toMatch(/text-align:\s*center;/);
  expect(rule(".tbl.repos td > .switch, .tbl.repos .repos-group-switch", { file: "app.css" })).toMatch(
    /justify-content:\s*center;/,
  );
});

test("setup's open counts sit in one column at the row's right edge, at every size: one layout (round 6)", () => {
  // Each repository on one line, ten or fewer too: its name, then its count pushed to the row's end.
  expect(rule(".checklist-group > .check:not(:first-child) > span", { file: "app.css" })).toMatch(
    /display:\s*flex;[\s\S]*flex:\s*1;/,
  );
  const count = rule(".checklist-open", { file: "app.css" });
  expect(count).toMatch(/margin-left:\s*auto;/);
  expect(count).toMatch(/flex:\s*none;/);
  // Not scoped past ten any more: no rule of the large list's own places the count.
  expect(CSS["app.css"]).not.toMatch(/\.checklist-large[^{]*\.checklist-open/);
});

test("a row with open pull requests reads stronger than one with none: its count at 600, zero muted at 400 (round 6)", () => {
  expect(rule(".repos-open, .checklist-open", { file: "app.css" })).toMatch(/font-weight:\s*600;/);
  const zero = rule(".open-zero", { file: "app.css" });
  // Quieter by weight, never fainter than `--muted` (round 4's contrast).
  expect(zero).toMatch(/color:\s*var\(--muted\);/);
  expect(zero).toMatch(/font-weight:\s*400;/);
});

test("an account's rows sit a step past the account's edge, plainly nested under its head (round 6)", () => {
  expect(rule(".tbl.repos tr:not(.repos-group) > td:first-child")).toMatch(
    /padding-left:\s*calc\(var\(--cell-x\) \+ var\(--chevron\) \+ var\(--chevron-gap\) \+ var\(--s-4\)\);/,
  );
});

test("a quiet button is an action said in words with its edge: no fill, a control's outline, `--ink-2` (round 6)", () => {
  const quiet = rule(".btn-quiet");
  expect(quiet).toMatch(/background:\s*transparent;/);
  expect(quiet).toMatch(/border-color:\s*var\(--line-2\);/);
  expect(quiet).toMatch(/color:\s*var\(--ink-2\);/);
});

test("under reduced motion nothing moves: no animation, no transition, no smooth scroll (ADR 0087)", () => {
  const REDUCED = "@media (prefers-reduced-motion: reduce)";
  // One rule, on everything a page draws: an element, its generated boxes, a dialog's backdrop.
  const all = rule("*, *::before, *::after, ::backdrop", { at: REDUCED });
  expect(all).toMatch(/(^|;)\s*animation:\s*none !important;/);
  expect(all).toMatch(/(^|;)\s*transition:\s*none !important;/);
  // Cut to nothing, never to 0.01 ms: a transition that still runs still fires its events.
  expect(all).not.toMatch(/duration|iteration-count/);
  expect(rule("html", { at: REDUCED })).toMatch(/scroll-behavior:\s*auto;/);
  // Nothing else in the app's CSS asks for reduced motion: this block is the whole of it.
  expect(CSS["system.css"].match(/prefers-reduced-motion/g)).toHaveLength(1);
  expect(CSS["app.css"]).not.toContain("prefers-reduced-motion");
});
