// `bun run site:proof`: builds lookover.dev and shoots every page in both themes at 1280 and 375 px into
// `.proof/site/`, with a contact sheet (`index.html`) beside them. Round 4's own landing page (exploration 19's
// `d1-command-4.html`, only where the checkout has `docs/`) is shot at the same widths beside the landing page, and the
// landing page once more under reduced motion. In the machine's browser (`browser.ts`); nothing from another host:
// round 4 asks Google for its fonts, and gets the same faces from the site's own packages instead.
//
// Every built page is shot: a new page needs nothing here. A shot is `<page>-<theme>-<width>.png`, the page's path
// with `-` for `/` (`docs-commands`), `index` for `/`.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContext } from "playwright";
import { astro } from "./astro.ts";
import { launchBrowser, serve, sitePath } from "./browser.ts";
import { PHONE_WIDTH } from "./browser-checks.ts";
import { FONT_MOUNTS } from "./fonts.ts";
import { EXPLORATION_ASSETS, ROOT, THEMES, themedContext } from "./shots.ts";
import { pagesOf } from "./site-checks.ts";

const WIDTHS = [1280, PHONE_WIDTH] as const;
const HEIGHT = 800;

const out = join(ROOT, ".proof", "site");
const ROUND_4_PAGE = "/round-4/19/d1-command-4.html";

/** A shot's name: the page's path with `-` for `/`, `index` for `/`. */
const nameOf = (page: string): string => page.replace(/^\/|\/$|\.html$/g, "").replaceAll("/", "-") || "index";

/** Shoots one page, whole, once its fonts are in and every animation that ends has ended. */
async function shoot(context: BrowserContext, url: string, file: string): Promise<void> {
  const tab = await context.newPage();
  await tab.goto(url, { waitUntil: "load" });
  await tab.evaluate(async () => {
    await document.fonts.ready;
    // Down the page a screen at a time, so what appears on sight has appeared, then back to the top: at once, as a
    // page that scrolls smoothly would still be on its way after the pause.
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
      scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    scrollTo({ top: 0, behavior: "instant" });
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY) animation.finish();
    }
  });
  mkdirSync(dirname(file), { recursive: true });
  await tab.screenshot({ path: file, fullPage: true });
  await tab.close();
}

if (astro(["build"]) !== 0) {
  console.error("The build failed: no shots.");
  process.exit(1);
}
const dist = sitePath("dist");
const pages = pagesOf(dist);
const hasRound4 = existsSync(join(EXPLORATION_ASSETS, "19", "d1-command-4.html"));
const served = serve(dist, {
  ...(hasRound4 ? { "/round-4/": EXPLORATION_ASSETS } : {}),
  ...FONT_MOUNTS,
});
rmSync(out, { recursive: true, force: true });

/** Each row of the contact sheet: a title and its shots. */
const rows: { title: string; shots: string[] }[] = [];
const browser = await launchBrowser();
try {
  for (const page of pages) {
    const sources = [{ title: page, url: `${served.url}${page}`, name: nameOf(page) }];
    if (page === "/" && hasRound4)
      sources.push({
        title: "round 4 (exploration 19)",
        url: `${served.url}${ROUND_4_PAGE}`,
        name: "index-round-4",
      });
    for (const source of sources) {
      const row: string[] = [];
      for (const theme of THEMES) {
        for (const width of WIDTHS) {
          const context = await themedContext(browser, { width, height: HEIGHT, theme });
          const shot = `${source.name}-${theme}-${width}.png`;
          const url = source.name === "index-round-4" ? `${source.url}?theme=${theme}` : source.url;
          await shoot(context, url, join(out, shot));
          await context.close();
          row.push(shot);
        }
      }
      rows.push({ title: source.title, shots: row });
    }
    if (page === "/") {
      const row: string[] = [];
      for (const theme of THEMES) {
        const context = await themedContext(browser, {
          width: WIDTHS[0],
          height: HEIGHT,
          theme,
          reduced: true,
        });
        const shot = `index-reduced-motion-${theme}-${WIDTHS[0]}.png`;
        await shoot(context, `${served.url}/`, join(out, shot));
        await context.close();
        row.push(shot);
      }
      rows.push({ title: "/ under reduced motion", shots: row });
    }
  }
} finally {
  await browser.close();
  served.close();
}

const figure = (shot: string) =>
  `<figure><img loading="lazy" src="${shot}" alt=""><figcaption>${shot}</figcaption></figure>`;
// The contact sheet is a proof-only page, never shipped: its colours stand outside the design system on purpose.
writeFileSync(
  join(out, "index.html"),
  [
    '<!doctype html><meta charset="utf-8"><title>lookover.dev proof</title>',
    "<style>body{font:14px system-ui;background:#111;color:#ddd;margin:24px}section{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;align-items:start}img{width:100%;border:1px solid #333}figure{margin:0}figcaption{padding:4px 0 12px;color:#999}</style>",
    "<h1>lookover.dev proof</h1>",
    ...rows.map(({ title, shots }) => `<h2>${title}</h2><section>${shots.map(figure).join("")}</section>`),
  ].join(""),
);
const count = rows.reduce((total, row) => total + row.shots.length, 0);
console.log(
  `${count} shots of ${pages.length} pages in ${out}${hasRound4 ? "" : " (no docs/: no round 4 shots)"}`,
);
if (!pages.includes("/")) console.log("No landing page at / yet: no round 4 or reduced-motion shots.");
