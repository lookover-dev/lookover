// The site's checks that need a browser (ADR 0064, 8), each run on a served site in the machine's browser: no page
// wider than a phone, the theme switch by click and by keyboard with the choice carried between the landing page and
// the docs, the landing page's wordmark in the theme's accent once its intro is over, nothing running under reduced
// motion, and nothing requested from another host. Each finding is a line
// `<page>: <what>`; `self-test.ts` proves each one bites before `check.ts` runs them on the site.
import type { Browser, BrowserContext, Page } from "playwright";
import { otherTheme, type Theme } from "../src/components/theme.ts";
import { localContext } from "./browser.ts";

/** A served site: where, and its pages as a visitor asks for them. */
export interface Site {
  readonly url: string;
  readonly pages: readonly string[];
}

/** The width every page must fit without scrolling sideways. */
export const PHONE_WIDTH = 375;

/** Opens a page and waits for its fonts, so the layout is the one a visitor sees. */
async function open(tab: Page, site: Site, page: string): Promise<void> {
  await tab.goto(`${site.url}${page}`, { waitUntil: "load" });
  await tab.evaluate(() => document.fonts.ready);
}

/** The pages that scroll sideways at 375 px, CSS and fonts loaded. Each as `<page>: <width> px wide at 375 px`. */
export async function widePages(browser: Browser, site: Site): Promise<string[]> {
  const context = await localContext(browser, {
    viewport: { width: PHONE_WIDTH, height: 812 },
    deviceScaleFactor: 1,
  });
  try {
    const tab = await context.newPage();
    const wide: string[] = [];
    for (const page of site.pages) {
      await open(tab, site, page);
      const width = await tab.evaluate(() => document.documentElement.scrollWidth);
      const fits = await tab.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      if (!fits) wide.push(`${page}: ${width} px wide at ${PHONE_WIDTH} px`);
    }
    return wide;
  } finally {
    await context.close();
  }
}

/** The landing page and the docs' first page: the choice of theme must carry between them. */
export const LANDING = "/";
export const DOCS = "/docs/";

/** The theme a click goes to from the one shown: light from dark, dark from anything else (no theme too). */
const other = (shown: string): Theme => otherTheme(shown === "dark" ? "dark" : "light");
const SWITCH_NAME = /^Switch to (light|dark) theme$/;

/** The page's theme switch: one visible button named for what a click does. */
const themeSwitch = (tab: Page) => tab.getByRole("button", { name: SWITCH_NAME }).filter({ visible: true });

/** The theme the open page shows, and the theme its switch offers (`none` without one). */
async function state(tab: Page): Promise<{ theme: string; offers: string }> {
  const theme = await tab.evaluate(() => document.documentElement.dataset.theme ?? "none");
  // The accessible name as the browser computes it, from what is shown.
  const named = (offers: Theme) =>
    tab
      .getByRole("button", { name: `Switch to ${offers} theme`, exact: true })
      .filter({ visible: true })
      .count();
  const offers = (await named("light")) > 0 ? "light" : (await named("dark")) > 0 ? "dark" : "none";
  return { theme, offers };
}

/**
 * What a page's browser reports of the system's colour scheme, as the page's `matchMedia` answers it: `nothing` when
 * neither dark nor light matches. Asked for no colour scheme, Edge on Windows may report nothing or the system's,
 * and headless Chrome on Linux reports light: a page that follows the system rightly shows it there.
 */
export type SystemReport = Theme | "nothing";

async function systemReport(tab: Page): Promise<SystemReport> {
  return await tab.evaluate(() =>
    matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "nothing",
  );
}

/** What this browser reports of the system when a context asks for no colour scheme, for the theme check's line. */
export async function silentSystem(browser: Browser): Promise<SystemReport> {
  const context = await localContext(browser, { colorScheme: "no-preference" });
  try {
    return await systemReport(await context.newPage());
  } finally {
    await context.close();
  }
}

/**
 * The theme switch on the landing page and the docs (design-system.md, "The site"), with nothing stored: each page
 * has one switch, a button named for what a click does; a system that says nothing shows dark (where the browser
 * reports a colour scheme all the same, that one: the page follows the system), one that asks for dark shows dark,
 * one that asks for light shows light; then, the system asking for dark, so the steps start from the same theme in
 * every browser: Tab reaches the docs' switch, Enter on it and a click on the landing page's switch go to the other
 * theme, and the choice shows on the other page; a click back on the docs, then Back, and the landing page the
 * back-forward cache restores shows that last choice; where the browser refuses to store the choice, three clicks on
 * each page still go to the other theme and back (from the theme the page shows first). Each problem as
 * `<page>: <what>`, in the order met; a page without one switch stops the check.
 */
export async function themeProblems(browser: Browser, site: Site): Promise<string[]> {
  const problems: string[] = [];
  const viewport = { width: 1280, height: 800 };
  const context = await localContext(browser, { viewport, colorScheme: "dark" });
  const silent = await localContext(browser, { viewport, colorScheme: "no-preference" });
  const light = await localContext(browser, { viewport, colorScheme: "light" });
  try {
    const tab = await context.newPage();
    const visit = async (page: string): Promise<boolean> => {
      await open(tab, site, page);
      if ((await themeSwitch(tab).count()) === 1) return true;
      problems.push(
        `${page}: no theme switch (one button named "Switch to light theme" or "Switch to dark theme")`,
      );
      return false;
    };
    /** The open page shows `theme`, and its switch offers the other one. */
    const shows = async (page: string, theme: Theme, why: string, on = tab): Promise<void> => {
      const seen = await state(on);
      if (seen.theme === theme && seen.offers === other(theme)) return;
      const offers = seen.offers === "none" ? "a switch named for neither" : `a switch to ${seen.offers}`;
      problems.push(`${page}: ${why}, it should show ${theme} (it shows ${seen.theme}, ${offers})`);
    };

    if (!(await visit(LANDING)) || !(await visit(DOCS))) return problems;
    // The system saying nothing, then asking for dark (this tab), then for light: the docs follow it.
    const silentTab = await silent.newPage();
    await open(silentTab, site, DOCS);
    const report = await systemReport(silentTab);
    await shows(
      DOCS,
      report === "nothing" ? "dark" : report,
      report === "nothing"
        ? "the system says nothing"
        : `the system says nothing and the browser reports ${report}`,
      silentTab,
    );
    const onDark = (await state(tab)).theme;
    if (onDark !== "dark") problems.push(`${DOCS}: the system asks for dark, it shows ${onDark}`);
    const lightTab = await light.newPage();
    await open(lightTab, site, DOCS);
    const onLight = (await state(lightTab)).theme;
    if (onLight !== "light") problems.push(`${DOCS}: the system asks for light, it shows ${onLight}`);

    /** Whether Tab, pressed on the page just opened (nothing focused yet), reaches its switch. */
    const tabReaches = async (): Promise<boolean> => {
      for (let press = 0; press < MAX_TABS; press++) {
        await tab.keyboard.press("Tab");
        if (await themeSwitch(tab).evaluate((element) => element === document.activeElement)) return true;
      }
      return false;
    };
    /**
     * Switches on the open page, by the keyboard (Tab to the switch, then Enter) or a click; the theme chosen. When
     * Enter fails, a click goes on, so the rest of the check still judges the choice carried; when a click fails,
     * nothing was chosen.
     */
    const switchBy = async (page: string, how: "Enter" | "a click"): Promise<Theme> => {
      const before = (await state(tab)).theme;
      if (how === "Enter") {
        if (!(await tabReaches())) {
          problems.push(`${page}: Tab does not reach the switch`);
          await themeSwitch(tab).focus();
        }
        await tab.keyboard.press("Enter");
      } else await themeSwitch(tab).click();
      if ((await state(tab)).theme === other(before)) return other(before);
      problems.push(`${page}: ${how} on the switch does not switch the theme`);
      if (how === "a click") {
        clickless.add(page);
        return before === "light" ? "light" : "dark";
      }
      await themeSwitch(tab).click();
      return other(before);
    };
    const clickless = new Set<string>();
    // The keyboard on the docs, the choice seen on the landing page; a click there, the choice seen on the docs.
    const byKeyboard = await switchBy(DOCS, "Enter");
    await visit(LANDING);
    await shows(LANDING, byKeyboard, `${byKeyboard} was chosen on ${DOCS}`);
    const byClick = await switchBy(LANDING, "a click");
    await visit(DOCS);
    await shows(DOCS, byClick, `${byClick} was chosen on ${LANDING}`);
    // The other theme chosen on the docs, then Back: the landing page, as the back-forward cache kept it, shows it.
    if (!clickless.has(DOCS)) {
      const onDocs = await switchBy(DOCS, "a click");
      await back(tab);
      await shows(LANDING, onDocs, `${onDocs} was chosen on ${DOCS}, then Back`);
    }

    // A browser that refuses to store the choice: the switch still goes back and forth on the page.
    const refusing = await refusingContext(browser);
    try {
      const page = await refusing.newPage();
      for (const path of [LANDING, DOCS].filter((path) => !clickless.has(path))) {
        await open(page, site, path);
        const shown = () => page.evaluate(() => document.documentElement.dataset.theme ?? "none");
        const start = await shown();
        const seen: string[] = [];
        for (let click = 0; click < 3; click++) {
          await themeSwitch(page).click();
          seen.push(await shown());
        }
        const want = [other(start), start, other(start)].join(", ");
        if (seen.join(", ") !== want)
          problems.push(
            `${path}: the browser refuses to keep the choice, three clicks should show ${want} (they show ${seen.join(", ")})`,
          );
      }
    } finally {
      await refusing.close();
    }
    return problems;
  } finally {
    await context.close();
    await silent.close();
    await light.close();
  }
}

/**
 * Goes Back in the tab. A page the back-forward cache restores fires no `load`, so the wait is for the commit, then a
 * moment for its `pageshow` handlers.
 */
async function back(tab: Page): Promise<void> {
  await tab.goBack({ waitUntil: "commit" });
  await tab.waitForFunction(() => document.readyState === "complete");
  await tab.waitForTimeout(BACK_SETTLE_MS);
}

/** How long a page restored by Back has for its `pageshow` handlers. */
const BACK_SETTLE_MS = 200;

/** How many presses of Tab may go by before the switch has the focus: the docs' header comes first. */
const MAX_TABS = 40;

/** A context whose pages, the system asking for dark, can read the browser's storage but never write to it. */
async function refusingContext(browser: Browser): Promise<BrowserContext> {
  const context = await localContext(browser, {
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("The storage is full.", "QuotaExceededError");
    };
  });
  return context;
}

/** How long the landing page's intro may take before the accent check judges what it left. */
const INTRO_MAX_MS = 10000;

/**
 * The landing page's wordmarks follow the theme once their intro is over: with motion allowed, the page opened, its
 * wordmarks' animations let to end, then the theme switched by a click; each accent chunk (`.wordmark .chunk-acc`)
 * must then be filled with the new theme's `--acc`. An intro that holds the colour it read at the start fails. Each
 * problem as `/: <what>`; a page with no theme switch or no accent chunk is a problem too.
 */
export async function accentProblems(browser: Browser, site: Site): Promise<string[]> {
  const context = await localContext(browser, {
    viewport: { width: 1280, height: 800 },
    // The system asking for dark, so the switch goes to light in every browser (Chrome on Linux reports light).
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
  try {
    const tab = await context.newPage();
    await open(tab, site, LANDING);
    const ended = await tab
      .waitForFunction(
        () =>
          [...document.querySelectorAll(".wordmark")].every((wordmark) =>
            wordmark.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running"),
          ),
        undefined,
        { timeout: INTRO_MAX_MS },
      )
      .then(
        () => true,
        () => false,
      );
    if (!ended)
      return [`${LANDING}: the wordmark still moves ${INTRO_MAX_MS / 1000} s after the page loaded`];
    if ((await themeSwitch(tab).count()) !== 1)
      return [`${LANDING}: no theme switch to check the accent with`];
    await themeSwitch(tab).click();
    const theme = await tab.evaluate(() => document.documentElement.dataset.theme ?? "none");
    const chunks = await tab.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--acc)";
      document.body.append(probe);
      const acc = getComputedStyle(probe).color;
      probe.remove();
      return [...document.querySelectorAll(".wordmark .chunk-acc")].map((chunk) => ({
        fill: getComputedStyle(chunk).fill,
        acc,
      }));
    });
    if (chunks.length === 0) return [`${LANDING}: no wordmark with an accent chunk`];
    const stale = chunks
      .filter(({ fill, acc }) => fill !== acc)
      .map(
        ({ fill, acc }) =>
          `${LANDING}: after switching to ${theme}, the wordmark's accent stays ${fill} (--acc is ${acc})`,
      );
    return [...new Set(stale)];
  } finally {
    await context.close();
  }
}

/** How long the story's last stretch, played by the check, may take to end and show "Play again". */
const STORY_END_MS = 3000;
/** How far before its end the check plays the story from. */
const STORY_LEAD_MS = 600;
/** How long the story has to start once in view, before the check plays its end. */
const STORY_SEEN_MS = 300;

/**
 * What is wrong with the story's frame on the open page, the scene beside "Play again" (`.story-wide`): its last
 * frame shows the app's "Clean" chip alone (`[data-chip="clean"]`) and the review's second verdict alone
 * (`[data-verdict="2"]`), each shown by the browser (not hidden, not transparent).
 */
async function frameProblems(tab: Page): Promise<string[]> {
  return await tab.evaluate(() => {
    const scene = document.querySelector("[data-story] .story-wide");
    const shown = (selector: string) =>
      [...(scene?.querySelectorAll(selector) ?? [])].filter((element) =>
        element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      ).length;
    const problems: string[] = [];
    if (shown('[data-chip="clean"]') !== 1) problems.push('the "Clean" chip is not shown');
    if (shown('[data-chip]:not([data-chip="clean"])') > 0) problems.push("another chip shows");
    if (shown('[data-verdict="2"]') === 0) problems.push("the second verdict is not shown");
    if (shown('[data-verdict="1"]') > 0) problems.push("the first verdict shows");
    return problems;
  });
}

/** Whether the story's "Play again" is shown. */
const replayShown = (tab: Page): Promise<boolean> =>
  tab.evaluate(
    () =>
      document
        .querySelector("[data-story] [data-replay]")
        ?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ?? false,
  );

/**
 * The landing page's story at 1280 px. Under reduced motion it shows its last frame (the "Clean" chip, the second
 * verdict) and no "Play again". With motion, once it has started, played from just before its end (its `story:play`
 * hook, so the check doesn't sit through it): "Play again" shows, over the same last frame; pressed from the keyboard,
 * it hides and the focus stays in the story. Each problem as `/: <what>`; a page with no story is one.
 */
export async function storyProblems(browser: Browser, site: Site): Promise<string[]> {
  const problems: string[] = [];
  const still = await localContext(browser, {
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    const tab = await still.newPage();
    await open(tab, site, LANDING);
    const story = tab.locator("[data-story] .story-wide");
    if ((await story.count()) !== 1) return [`${LANDING}: no story (a [data-story] with its scene)`];
    await story.scrollIntoViewIfNeeded();
    await tab.waitForTimeout(400);
    for (const what of await frameProblems(tab)) problems.push(`${LANDING}: under reduced motion, ${what}`);
    if (await replayShown(tab)) problems.push(`${LANDING}: under reduced motion, "Play again" shows`);
  } finally {
    await still.close();
  }

  const moving = await localContext(browser, {
    viewport: { width: 1280, height: 800 },
    reducedMotion: "no-preference",
  });
  try {
    const tab = await moving.newPage();
    await open(tab, site, LANDING);
    const wrap = tab.locator("[data-story] .ts-wrap");
    await wrap.scrollIntoViewIfNeeded();
    const started = await tab
      .waitForFunction(
        () => document.querySelector("[data-story] .ts-wrap")?.hasAttribute("data-duration"),
        undefined,
        {
          timeout: STORY_END_MS,
        },
      )
      .then(
        () => true,
        () => false,
      );
    if (!started) return [...problems, `${LANDING}: the story never starts (no data-duration on its scene)`];
    // The scene starts on sight: a moment for that start, so the jump to its end comes after it.
    await tab.waitForTimeout(STORY_SEEN_MS);
    const duration = Number(await wrap.getAttribute("data-duration"));
    await wrap.evaluate(
      (element, at) => element.dispatchEvent(new CustomEvent("story:play", { detail: at })),
      Math.max(0, duration - STORY_LEAD_MS),
    );
    const ended = await tab
      .waitForFunction(
        () =>
          document
            .querySelector("[data-story] [data-replay]")
            ?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ?? false,
        undefined,
        { timeout: STORY_END_MS },
      )
      .then(
        () => true,
        () => false,
      );
    if (!ended) return [...problems, `${LANDING}: "Play again" does not show once the story ends`];
    for (const what of await frameProblems(tab)) problems.push(`${LANDING}: at the story's end, ${what}`);
    const replay = tab.locator("[data-story] [data-replay]");
    await replay.focus();
    await tab.keyboard.press("Enter");
    if (await replayShown(tab)) problems.push(`${LANDING}: "Play again" still shows once pressed`);
    const kept = await tab.evaluate(() => {
      const focused = document.activeElement;
      const story = document.querySelector("[data-story]");
      return focused instanceof HTMLElement && story?.contains(focused) === true && focused.checkVisibility();
    });
    if (!kept) problems.push(`${LANDING}: pressing "Play again" drops the focus out of the story`);
    return problems;
  } finally {
    await moving.close();
  }
}

/**
 * The pages where something moves under `prefers-reduced-motion: reduce`: each page opened, scrolled to its end (so
 * what starts on sight starts) and given a moment, then used: its first question opened (`details > summary`) and its
 * theme switched, by clicks, so the pointer rests on each. Every animation and transition still running after the
 * moment or right after a click, and every one that started at all (`animationstart`, `transitionrun`), however short.
 * Each page as `<page>: <names> running under reduced motion`.
 */
export async function movingPages(browser: Browser, site: Site): Promise<string[]> {
  const context = await localContext(browser, {
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  // What started since the page loaded, named as `running` names it.
  await context.addInitScript(() => {
    const started: string[] = [];
    Reflect.set(window, "__started", started);
    const note = (event: Event) => {
      if (event instanceof AnimationEvent) started.push(`animation ${event.animationName}`);
      if (event instanceof TransitionEvent) started.push(`transition of ${event.propertyName}`);
    };
    addEventListener("animationstart", note, true);
    addEventListener("transitionrun", note, true);
  });
  try {
    const tab = await context.newPage();
    const moving: string[] = [];
    const running = () =>
      tab.evaluate(() =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === "running")
          .map((animation) => {
            if (animation instanceof CSSAnimation) return `animation ${animation.animationName}`;
            if (animation instanceof CSSTransition) return `transition of ${animation.transitionProperty}`;
            return animation.id === "" ? "a script's animation" : `animation ${animation.id}`;
          }),
      );
    for (const page of site.pages) {
      await open(tab, site, page);
      await tab.evaluate(() =>
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }),
      );
      await tab.waitForTimeout(400);
      const names = await running();
      const question = tab.locator("details > summary").filter({ visible: true }).first();
      if ((await question.count()) > 0) {
        await question.click();
        names.push(...(await running()));
      }
      if ((await themeSwitch(tab).count()) === 1) {
        await themeSwitch(tab).click();
        names.push(...(await running()));
      }
      await tab.waitForTimeout(MOVED_SETTLE_MS);
      const started = await tab.evaluate(() => {
        const list: unknown = Reflect.get(window, "__started");
        return Array.isArray(list) ? list.map(String) : [];
      });
      names.push(...started);
      if (names.length > 0)
        moving.push(`${page}: ${[...new Set(names)].join(", ")} running under reduced motion`);
    }
    return moving;
  } finally {
    await context.close();
  }
}

/** How long after the last click a transition has to start, for the reduced-motion check to see it. */
const MOVED_SETTLE_MS = 100;

/**
 * What the pages request from another host once open and scrolled to their end: refused, so nothing leaves the
 * machine, and each named as `<page>: requests <host>`. The browser's half of the hosts check, for what the files
 * don't say outright (a script that adds a font, say).
 */
export async function requestsElsewhere(browser: Browser, site: Site): Promise<string[]> {
  const found: string[] = [];
  const elsewhere: string[] = [];
  const context = await localContext(browser, { viewport: { width: 1280, height: 800 } }, elsewhere);
  try {
    const tab = await context.newPage();
    for (const page of site.pages) {
      elsewhere.length = 0;
      await open(tab, site, page);
      await tab.evaluate(() =>
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }),
      );
      await tab.waitForTimeout(200);
      for (const host of new Set(elsewhere.map((url) => new URL(url).host)))
        found.push(`${page}: requests ${host}`);
    }
    return found;
  } finally {
    await context.close();
  }
}
