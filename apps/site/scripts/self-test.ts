// The browser checks, proven to bite (ADR 0064, 8): `bun run site:check` runs each on small pages first, once on
// pages that pass and once on pages with its fault, and stops when one passes a fault or fails a good page. Too slow
// for `bun run test` (a browser), so the check proves itself each time it runs, in the same browser.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Browser } from "playwright";
import type { Theme } from "../src/components/theme.ts";
import { serve } from "./browser.ts";
import {
  accentProblems,
  movingPages,
  requestsElsewhere,
  type Site,
  type SystemReport,
  silentSystem,
  storyProblems,
  themeProblems,
  widePages,
} from "./browser-checks.ts";
import { pagesOf } from "./site-checks.ts";

type Check = (browser: Browser, site: Site) => Promise<string[]>;

type Lines = readonly (string | RegExp)[];

/**
 * One run of a check on a small site: the lines it must give, a pattern where a number may vary; or the lines for
 * what the browser reports of a system that says nothing (`silentSystem`).
 */
interface Case {
  readonly name: string;
  readonly check: Check;
  readonly files: Readonly<Record<string, string>>;
  readonly expected: Lines | ((report: SystemReport) => Lines);
}

const page = (body: string, head = ""): string =>
  [
    '<!doctype html><html><head><meta charset="utf-8"><title>x</title>',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<link rel="stylesheet" href="/site.css">${head}</head><body>${body}</body></html>`,
  ].join("");

const longLine = "lookover wait --pr 42 --app lookover-dev --json ".repeat(8);

const widthCases: Case[] = [
  {
    name: "pages that fit 375 px",
    check: widePages,
    files: {
      "site.css": ".scrolls { overflow-x: auto; } p { overflow-wrap: anywhere; }",
      "index.html": page("<p>A second look before merge.</p>"),
      "docs/index.html": page(`<pre class="scrolls"><code>${longLine}</code></pre><p>${"x".repeat(200)}</p>`),
    },
    expected: [],
  },
  {
    name: "a fixed-width block and a code block that push the page wider",
    check: widePages,
    files: {
      "site.css": ".wide { width: 600px; }",
      "index.html": page("<p>Fits.</p>"),
      "docs/index.html": page(`<pre><code>${longLine}</code></pre>`),
      "docs/commands/index.html": page('<div class="wide">Too wide.</div>'),
    },
    expected: [/^\/docs\/: \d+ px wide at 375 px$/, /^\/docs\/commands\/: \d+ px wide at 375 px$/],
  },
];

// A small switch of its own, kept where the site keeps it: the check judges what a page does, not how.
// `start`: the theme on load; `shown`: the theme a click goes from (the one on screen, or a fault's other source);
// `back`: the theme a page the back-forward cache restores shows (`chosen`: the last one clicked on this page).
const switchScript = (start: string, shown: string, back = "read() ?? system()"): string => `<script>
  const key = "starlight-theme";
  const read = () => { const s = localStorage.getItem(key); return s === "light" || s === "dark" ? s : undefined; };
  const system = () => matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const show = (t) => {
    document.documentElement.dataset.theme = t;
    for (const b of document.querySelectorAll("[data-switch]")) {
      b.setAttribute("aria-label", "Switch to " + (t === "dark" ? "light" : "dark") + " theme");
    }
  };
  let chosen;
  for (const b of document.querySelectorAll("[data-switch]")) {
    b.onclick = () => {
      const t = ${shown} === "dark" ? "light" : "dark";
      chosen = t;
      try { localStorage.setItem(key, t); } catch {}
      show(t);
    };
  }
  show(${start});
  addEventListener("pageshow", (e) => { if (e.persisted) show(${back}); });
</script>`;
const button = '<button type="button" data-switch>T</button>';
// Focusable and named, but nothing answers its keys.
const mouseOnly = '<span role="button" tabindex="0" data-switch>T</span>';
// A button the Tab key passes by.
const untabbable = '<button type="button" tabindex="-1" data-switch>T</button>';
// A switch whose clicks a script on the page stops before they reach it.
const deaf = `${button}<script>document.addEventListener("click", (e) => e.stopPropagation(), true);</script>`;
const radios = [
  '<div role="radiogroup" aria-label="Theme">',
  '<button role="radio" aria-label="Auto">A</button><button role="radio" aria-label="Light">L</button>',
  "</div>",
].join("");
const themed = (
  control: string,
  start = "read() ?? system()",
  shown = "document.documentElement.dataset.theme",
  back?: string,
): string => page(`<header>${control}</header>${switchScript(start, shown, back)}`);

const themeCases: Case[] = [
  {
    name: "one switch on each page, the choice carried",
    check: themeProblems,
    files: { "site.css": "", "index.html": themed(button), "docs/index.html": themed(button) },
    expected: [],
  },
  {
    name: "a three-way control in place of the switch",
    check: themeProblems,
    files: { "site.css": "", "index.html": themed(radios), "docs/index.html": themed(button) },
    expected: ['/: no theme switch (one button named "Switch to light theme" or "Switch to dark theme")'],
  },
  {
    name: "a switch the keyboard can't use",
    check: themeProblems,
    files: { "site.css": "", "index.html": themed(button), "docs/index.html": themed(mouseOnly) },
    expected: ["/docs/: Enter on the switch does not switch the theme"],
  },
  {
    name: "a switch the Tab key passes by",
    check: themeProblems,
    files: { "site.css": "", "index.html": themed(button), "docs/index.html": themed(untabbable) },
    expected: ["/docs/: Tab does not reach the switch"],
  },
  {
    name: "a switch that ignores clicks",
    check: themeProblems,
    files: { "site.css": "", "index.html": themed(deaf), "docs/index.html": themed(button) },
    expected: ["/: a click on the switch does not switch the theme"],
  },
  {
    name: "a switch that goes from the stored theme when the browser refuses to store it",
    check: themeProblems,
    files: {
      "site.css": "",
      "index.html": themed(button),
      "docs/index.html": themed(button, "read() ?? system()", "(read() ?? system())"),
    },
    expected: [
      "/docs/: the browser refuses to keep the choice, three clicks should show light, dark, light (they show light, light, light)",
    ],
  },
  {
    name: "a page back from the cache that shows its own last choice over the one made since",
    check: themeProblems,
    files: {
      "site.css": "",
      "index.html": themed(button, undefined, undefined, "chosen ?? read() ?? system()"),
      "docs/index.html": themed(button),
    },
    expected: [
      "/: light was chosen on /docs/, then Back, it should show light (it shows dark, a switch to light)",
    ],
  },
  {
    // Where the browser reports light all the same (Chrome on Linux), only the system asking for dark catches it.
    name: "light when the system says nothing or asks for dark",
    check: themeProblems,
    files: {
      "site.css": "",
      "index.html": themed(button, 'read() ?? "light"'),
      "docs/index.html": themed(button, 'read() ?? "light"'),
    },
    expected: (report) => [
      ...(report === "light" ? [] : [saysNothing(report, "light")]),
      "/docs/: the system asks for dark, it shows light",
    ],
  },
  {
    // Where the browser reports light for a system that says nothing, the page must show it there too.
    name: "pages that forget the choice and the system",
    check: themeProblems,
    files: {
      "site.css": "",
      "index.html": themed(button, '"dark"'),
      "docs/index.html": themed(button, '"dark"'),
    },
    expected: (report) => [
      ...(report === "light" ? [saysNothing(report, "dark")] : []),
      "/docs/: the system asks for light, it shows dark",
      "/: light was chosen on /docs/, it should show light (it shows dark, a switch to light)",
      "/docs/: light was chosen on /, it should show light (it shows dark, a switch to light)",
    ],
  },
];

/** The theme check's line for the docs when the system says nothing and the page shows `shown`, the wrong one. */
function saysNothing(report: SystemReport, shown: Theme): string {
  const want = report === "nothing" ? "dark" : report;
  const why =
    report === "nothing"
      ? "the system says nothing"
      : `the system says nothing and the browser reports ${report}`;
  return `/docs/: ${why}, it should show ${want} (it shows ${shown}, a switch to ${shown === "dark" ? "light" : "dark"})`;
}

// A wordmark's accent chunk in the theme's `--acc`, and a theme switch; `intro`: a script run on it at load.
const accentCss = ":root { --acc: rgb(200, 0, 0); } :root[data-theme='light'] { --acc: rgb(0, 0, 200); }";
const accented = (intro = ""): string =>
  page(
    [
      `<header>${button}</header>`,
      '<svg class="wordmark" viewBox="0 0 10 10"><rect class="chunk-acc" width="10" height="10"></rect></svg>',
      `<style>.wordmark .chunk-acc { fill: var(--acc); }</style>${switchScript('"dark"', "document.documentElement.dataset.theme")}`,
      intro === "" ? "" : `<script>${intro}</script>`,
    ].join(""),
  );
const accentCases: Case[] = [
  {
    name: "an intro that lets go of the accent at its end",
    check: accentProblems,
    files: {
      "site.css": accentCss,
      "index.html": accented(
        [
          'const chunk = document.querySelector(".chunk-acc");',
          'const a = chunk.animate([{ fill: "rgb(0, 0, 0)" }, { fill: "rgb(0, 0, 0)" }], { duration: 300 });',
          "a.onfinish = () => a.cancel();",
        ].join(""),
      ),
    },
    expected: [],
  },
  {
    name: "an intro that holds the accent it read at the start",
    check: accentProblems,
    files: {
      "site.css": accentCss,
      "index.html": accented(
        [
          'const chunk = document.querySelector(".chunk-acc");',
          "const acc = getComputedStyle(chunk).fill;",
          'chunk.animate([{ fill: acc }, { fill: acc }], { duration: 300, fill: "forwards" }).persist();',
        ].join(""),
      ),
    },
    expected: [
      "/: after switching to light, the wordmark's accent stays rgb(200, 0, 0) (--acc is rgb(0, 0, 200))",
    ],
  },
  {
    name: "a landing page with no accent chunk",
    check: accentProblems,
    files: { "site.css": "", "index.html": themed(button) },
    expected: ["/: no wordmark with an accent chunk"],
  },
];

const spin = "@keyframes spin { to { transform: rotate(1turn); } }";
// A question whose chevron turns when it opens, and a page whose colours change with the theme: what turns and
// what fades is in `transitions`, which a good page keeps for those who ask for no less motion.
const chevron = [
  'summary::after { content: "v"; display: inline-block; }',
  "details[open] summary::after { transform: rotate(180deg); }",
  ":root[data-theme='light'] body { background: rgb(255, 255, 255); }",
].join(" ");
const transitions = "summary::after { transition: transform 180ms; } body { transition: background 200ms; }";
const usedPage = (): string =>
  page(
    `<header>${button}</header><details><summary>Question</summary><p>Answer</p></details>${switchScript("read() ?? system()", "document.documentElement.dataset.theme")}`,
  );
const motionCases: Case[] = [
  {
    name: "motion only for those who don't ask for less",
    check: movingPages,
    files: {
      "site.css": `${spin} ${chevron} @media (prefers-reduced-motion: no-preference) { .spin { animation: spin 1s infinite; } ${transitions} }`,
      "index.html": page(
        [
          '<div class="spin">Eyes</div><div id="intro">Intro</div><script>',
          'if (!matchMedia("(prefers-reduced-motion: reduce)").matches)',
          '  document.getElementById("intro").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 5000 });',
          "</script>",
        ].join(""),
      ),
      "docs/index.html": usedPage(),
    },
    expected: [],
  },
  {
    name: "a chevron that turns and colours that fade with the theme under reduced motion",
    check: movingPages,
    files: { "site.css": `${chevron} ${transitions}`, "index.html": usedPage() },
    expected: ["/: transition of transform, transition of background-color running under reduced motion"],
  },
  {
    name: "an endless animation and a script's intro that ignore reduced motion",
    check: movingPages,
    files: {
      "site.css": `${spin} .spin { animation: spin 1s infinite; }`,
      "index.html": page('<div class="spin">Eyes</div>'),
      "docs/index.html": page(
        [
          '<div id="intro">Intro</div><script>',
          'document.getElementById("intro").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 5000, id: "intro" });',
          "</script>",
        ].join(""),
      ),
    },
    expected: [
      "/: animation spin running under reduced motion",
      "/docs/: animation intro running under reduced motion",
    ],
  },
];

// A small story of its own, with the site's hooks: the scene's last frame drawn by CSS, its first frame a class the
// script adds when it may play, `data-duration` and `story:play`, and "Play again" that shows at the end. Each
// fault turns one part off.
const storyCss = [
  '[data-chip="r1"], [data-verdict="1"] { opacity: 0; }',
  '.first [data-chip="clean"], .first [data-verdict="2"] { opacity: 0; }',
  '.first [data-chip="r1"], .first [data-verdict="1"] { opacity: 1; }',
].join(" ");
interface StoryFaults {
  /** The first frame drawn whatever the system asks. */
  readonly firstFrameAlways?: boolean;
  /** "Play again" shown under reduced motion. */
  readonly replayWhenStill?: boolean;
  /** The end never shows "Play again". */
  readonly endSilent?: boolean;
  /** "Play again" pressed leaves the focus on nothing. */
  readonly dropsFocus?: boolean;
}
const storyPage = (faults: StoryFaults = {}): string =>
  page(
    [
      '<div data-story><div class="story-wide" tabindex="-1"><div class="ts-wrap">',
      '<span data-chip="r1">Reviewing</span><span data-chip="clean">Clean</span>',
      '<p data-verdict="1">One thing to fix.</p><p data-verdict="2">Nothing new to fix.</p>',
      '</div><button type="button" data-replay hidden>Play again</button></div></div><script>',
      'const wrap = document.querySelector(".ts-wrap"), again = document.querySelector("[data-replay]");',
      'const still = matchMedia("(prefers-reduced-motion: reduce)").matches;',
      'const first = () => wrap.classList.add("first");',
      faults.firstFrameAlways ? "first();" : "",
      faults.replayWhenStill ? "if (still) again.hidden = false;" : "",
      "if (!still) {",
      '  first(); wrap.dataset.duration = "1000";',
      '  wrap.addEventListener("story:play", (e) => setTimeout(() => {',
      `    wrap.classList.remove("first"); ${faults.endSilent ? "" : "again.hidden = false;"}`,
      "  }, 1000 - e.detail));",
      "  again.onclick = () => {",
      "    const focused = document.activeElement === again; again.hidden = true; first();",
      faults.dropsFocus ? "" : "    if (focused) again.parentElement.focus();",
      "  };",
      "}",
      "</script>",
    ].join("\n"),
  );
const storyCases: Case[] = [
  {
    name: "a story still at its end under reduced motion, played to its end with motion",
    check: storyProblems,
    files: { "site.css": storyCss, "index.html": storyPage() },
    expected: [],
  },
  {
    name: "a story that shows its first frame and Play again under reduced motion",
    check: storyProblems,
    files: {
      "site.css": storyCss,
      "index.html": storyPage({ firstFrameAlways: true, replayWhenStill: true }),
    },
    expected: [
      '/: under reduced motion, the "Clean" chip is not shown',
      "/: under reduced motion, another chip shows",
      "/: under reduced motion, the second verdict is not shown",
      "/: under reduced motion, the first verdict shows",
      '/: under reduced motion, "Play again" shows',
    ],
  },
  {
    name: "a story whose end never offers Play again",
    check: storyProblems,
    files: { "site.css": storyCss, "index.html": storyPage({ endSilent: true }) },
    expected: ['/: "Play again" does not show once the story ends'],
  },
  {
    name: "a Play again that drops the focus when it hides",
    check: storyProblems,
    files: { "site.css": storyCss, "index.html": storyPage({ dropsFocus: true }) },
    expected: ['/: pressing "Play again" drops the focus out of the story'],
  },
  {
    name: "a landing page with no story",
    check: storyProblems,
    files: { "site.css": "", "index.html": page("<p>A second look before merge.</p>") },
    expected: ["/: no story (a [data-story] with its scene)"],
  },
];

const hostCases: Case[] = [
  {
    name: "pages that load only from the site",
    check: requestsElsewhere,
    files: {
      "site.css": "",
      "index.html": page('<a href="https://github.com/lookover-dev/lookover">GitHub</a>'),
    },
    expected: [],
  },
  {
    name: "a script that adds a font from another host",
    check: requestsElsewhere,
    files: {
      "site.css": "",
      "index.html": page(
        [
          '<script>const link = document.createElement("link"); link.rel = "stylesheet";',
          'link.href = "https://fonts.example.com/css2?family=Figtree"; document.head.append(link);</script>',
        ].join(""),
      ),
    },
    expected: ["/: requests fonts.example.com"],
  },
];

/** Every case, each check's good pages first. */
export const CASES: readonly Case[] = [
  ...widthCases,
  ...themeCases,
  ...accentCases,
  ...motionCases,
  ...storyCases,
  ...hostCases,
];

/** Whether the lines a check gave are the expected ones, in order. */
const matches = (got: readonly string[], expected: Lines): boolean =>
  got.length === expected.length &&
  got.every((line, i) => {
    const want = expected[i];
    return typeof want === "string" ? line === want : want?.test(line) === true;
  });

/** Writes a case's files into a new folder. */
function written(files: Readonly<Record<string, string>>): string {
  const dist = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-site-check-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

/** Runs every case; the ones whose check gave other lines than expected, each with what it gave. Empty: all bite. */
export async function selfTest(browser: Browser): Promise<string[]> {
  const failures: string[] = [];
  const report = await silentSystem(browser);
  for (const { name, check, files, expected: lines } of CASES) {
    const expected = typeof lines === "function" ? lines(report) : lines;
    const dist = written(files);
    const served = serve(dist);
    try {
      const got = await check(browser, { url: served.url, pages: pagesOf(dist) });
      if (!matches(got, expected)) {
        const want = expected.map(String).join(" | ") || "nothing";
        failures.push(`${name}: expected ${want}; got ${got.join(" | ") || "nothing"}`);
      }
    } finally {
      served.close();
      rmSync(dist, { recursive: true, force: true });
    }
  }
  return failures;
}
