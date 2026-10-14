// `bun run site:strip [--out <dir>]`: builds lookover.dev and shoots the landing page's three-sided story every
// 500 ms from its start to its end, in both themes, at 1280 px, with motion lab 3's scene beside it at the same
// times (exploration 18's `lookover-motion-3.html`, only where the checkout has `docs/`). Each theme gets a contact
// sheet, `sheet-<theme>.png`, shot by the browser from a page of the frames; the frames are `<theme>/site-<ms>.png`
// and `<theme>/lab-<ms>.png`. Into `.proof/site-strip/` unless `--out` says where. Nothing from another host: the
// lab asks Google for its fonts and gets the site's own.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import type { Theme } from "../src/components/theme.ts";
import { astro } from "./astro.ts";
import { launchBrowser, serve, sitePath } from "./browser.ts";
import { FONT_MOUNTS } from "./fonts.ts";
import { EXPLORATION_ASSETS, ROOT, THEMES, themedContext } from "./shots.ts";

const STEP_MS = 500;
const WIDTH = 1280;

const LAB = join(EXPLORATION_ASSETS, "18");
const LAB_PAGE = "/lab/lookover-motion-3.html?still";

const outAt = process.argv.indexOf("--out");
const out =
  outAt > 0 && process.argv[outAt + 1]
    ? resolve(process.argv[outAt + 1] ?? "")
    : join(ROOT, ".proof", "site-strip");

/** A tab at 1280 px in `theme`, with motion, nothing from another host. */
async function tab(browser: Browser, theme: Theme): Promise<Page> {
  const context = await themedContext(browser, { width: WIDTH, height: 900, theme });
  return await context.newPage();
}

/** The site's story: its length in ms, and a function that stops it at a time and shoots it. */
async function siteStory(
  page: Page,
  url: string,
): Promise<{ duration: number; shoot: (ms: number, file: string) => Promise<void> }> {
  await page.goto(url, { waitUntil: "load" });
  const wrap = page.locator("[data-story] .ts-wrap");
  await wrap.scrollIntoViewIfNeeded();
  await page.waitForFunction(() =>
    document.querySelector("[data-story] .ts-wrap")?.hasAttribute("data-duration"),
  );
  await page.evaluate(() => document.fonts.ready);
  const duration = Number(await wrap.getAttribute("data-duration"));
  return {
    duration,
    shoot: async (ms, file) => {
      await wrap.evaluate((el, t) => el.dispatchEvent(new CustomEvent("story:seek", { detail: t })), ms);
      await wrap.screenshot({ path: file, animations: "allow" });
    },
  };
}

/** Motion lab 3's scene, in `theme`: a function that stops it at a time and shoots it. */
async function labStory(
  page: Page,
  url: string,
  theme: Theme,
): Promise<(ms: number, file: string) => Promise<void>> {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  if (theme === "light") await page.click("[data-theme-toggle]");
  const host = page.locator('[data-scene="three"] .host');
  await host.scrollIntoViewIfNeeded();
  return async (ms, file) => {
    await page.evaluate((t) => {
      // The lab's own hook (lookover-motion-3.html): its scenes and their timelines.
      const scene = Reflect.get(window, "__motion")?.scenes?.get("three");
      scene?.tl.pause();
      scene?.tl.seek(t);
    }, ms);
    await host.screenshot({ path: file, animations: "allow" });
  };
}

if (astro(["build"]) !== 0) {
  console.error("The build failed: no strip.");
  process.exit(1);
}
const hasLab = existsSync(join(LAB, "lookover-motion-3.html"));
const served = serve(sitePath("dist"), { ...(hasLab ? { "/lab/": LAB } : {}), ...FONT_MOUNTS });
// Only what an earlier strip wrote goes: `--out` may name a folder with other things in it.
const STRIP_FILE = /^(?:site|lab)-\d+\.png$|^sheet\.html$/;
for (const theme of THEMES) {
  const dir = join(out, theme);
  if (existsSync(dir))
    for (const file of readdirSync(dir)) if (STRIP_FILE.test(file)) rmSync(join(dir, file), { force: true });
  rmSync(join(out, `sheet-${theme}.png`), { force: true });
}

const browser = await launchBrowser();
try {
  for (const theme of THEMES) {
    const dir = join(out, theme);
    mkdirSync(dir, { recursive: true });
    const site = await siteStory(await tab(browser, theme), `${served.url}/`);
    const lab = hasLab ? await labStory(await tab(browser, theme), `${served.url}${LAB_PAGE}`, theme) : null;
    const times: number[] = [];
    for (let ms = 0; ms <= site.duration; ms += STEP_MS) times.push(ms);
    if (times.at(-1) !== site.duration) times.push(site.duration);
    for (const ms of times) {
      await site.shoot(ms, join(dir, `site-${ms}.png`));
      await lab?.(ms, join(dir, `lab-${ms}.png`));
    }
    // The contact sheet: a proof-only page, never shipped, so its colours stand outside the design system.
    const cell = (ms: number) =>
      `<figure><b>${(ms / 1000).toFixed(1)} s</b><img src="site-${ms}.png">${lab ? `<img src="lab-${ms}.png">` : ""}</figure>`;
    const sheet = join(dir, "sheet.html");
    writeFileSync(
      sheet,
      [
        `<!doctype html><meta charset="utf-8"><title>three sides, ${theme}</title>`,
        "<style>body{margin:16px;background:#111;color:#ddd;font:12px system-ui}h1{font-size:14px;margin:0 0 12px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0;display:flex;flex-direction:column;gap:4px}img{width:100%;display:block;border:1px solid #333}</style>",
        `<h1>The story on lookover.dev, ${theme}${lab ? ", with motion lab 3 under each frame" : ""}, every ${STEP_MS} ms</h1>`,
        `<main>${times.map(cell).join("")}</main>`,
      ].join(""),
    );
    const frames = serve(dir);
    try {
      const page = await tab(browser, theme);
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`${frames.url}/sheet.html`, { waitUntil: "load" });
      await page.screenshot({ path: join(out, `sheet-${theme}.png`), fullPage: true });
    } finally {
      frames.close();
    }
    console.log(`${theme}: ${times.length} frames${lab ? " of each" : ""}, sheet-${theme}.png`);
  }
} finally {
  await browser.close();
  served.close();
}
console.log(`The strip is in ${out}${hasLab ? "" : " (no docs/: no lab frames)"}`);
