// `bun run site:check`: builds lookover.dev and checks the built pages (ADR 0064, 8), in the machine's browser
// (`browser.ts`: Edge on Windows, Chrome elsewhere, CHROME_PATH to choose; never a downloaded one).
//
//   1. the self-test: each browser check on small pages, passing the good ones and naming each fault (`self-test.ts`)
//   2. the build, Astro's telemetry off
//   3. no internal link or fragment leads nowhere (`site-checks.ts`)
//   4. no script, style or font from another host: in the files, and what the open pages request
//   5. no page wider than the screen at 375 px
//   6. the theme switch: the system followed (dark when it says nothing, unless the browser reports one all the
//      same, as Chrome on Linux reports light: its status line says which), by click and by keyboard, the choice
//      carried between / and /docs/ (Back included), and kept on the page when the browser refuses to store it
//   7. the landing page's wordmark in the theme's accent once its intro is over and the theme switched
//   8. the landing page's story: its last frame and no "Play again" under reduced motion; with motion, "Play
//      again" once it ends, and the focus kept in the story when it is pressed
//   9. nothing moving under prefers-reduced-motion, a question opened and the theme switched included
//
// One line per finding, then one status line per check. Exit 0 when every check passed, 1 otherwise (no browser
// included). Nothing is requested from another host: the browser refuses it.
import type { Browser } from "playwright";
import { astro } from "./astro.ts";
import { launchBrowser, serve, sitePath } from "./browser.ts";
import {
  accentProblems,
  movingPages,
  requestsElsewhere,
  type SystemReport,
  silentSystem,
  storyProblems,
  themeProblems,
  widePages,
} from "./browser-checks.ts";
import { selfTest } from "./self-test.ts";
import { brokenLinks, foreignLoads, pagesOf } from "./site-checks.ts";

const status = (findings: readonly string[], ok: string, failed: string): string =>
  findings.length === 0 ? `  ok  ${ok}` : `  ✗   ${findings.length} ${failed}`;

/** Every step after the browser's start, in that browser; the exit code. */
async function checked(browser: Browser): Promise<number> {
  const selfFailures = await selfTest(browser);
  for (const failure of selfFailures) console.error(`self-test: ${failure}`);
  if (selfFailures.length > 0) {
    console.error("  ✗   the browser checks' self-test: a check missed its fault or failed a good page");
    return 1;
  }
  console.error("  ok  the browser checks' self-test: each check names its fault and passes the good pages");

  if (astro(["build"]) !== 0) {
    console.error("  ✗   the build failed");
    return 1;
  }

  const dist = sitePath("dist");
  const pages = pagesOf(dist);
  const broken = brokenLinks(dist);
  const foreign = foreignLoads(dist);
  const served = serve(dist);
  const site = { url: served.url, pages };
  try {
    return report(pages, broken, foreign, {
      requested: await requestsElsewhere(browser, site),
      wide: await widePages(browser, site),
      theme: await themeProblems(browser, site),
      silent: await silentSystem(browser),
      accent: await accentProblems(browser, site),
      story: await storyProblems(browser, site),
      moving: await movingPages(browser, site),
    });
  } finally {
    served.close();
  }
}

/** Prints each finding and each check's status line; the exit code. */
function report(
  pages: readonly string[],
  broken: readonly string[],
  foreign: readonly string[],
  {
    requested,
    wide,
    theme,
    accent,
    story,
    moving,
    silent,
  }: Readonly<Record<"requested" | "wide" | "theme" | "accent" | "story" | "moving", string[]>> & {
    readonly silent: SystemReport;
  },
): number {
  // Which theme the "system says nothing" step expected, as this browser reports such a system.
  const quiet =
    silent === "nothing"
      ? "dark when the system says nothing"
      : `${silent} when the system says nothing, as this browser reports it`;
  for (const line of broken) console.error(`broken link on ${line}`);
  for (const line of [...foreign, ...requested]) console.error(`from another host: ${line}`);
  for (const line of wide) console.error(`scrolls sideways: ${line}`);
  for (const line of theme) console.error(`theme switch: ${line}`);
  for (const line of accent) console.error(`accent: ${line}`);
  for (const line of story) console.error(`story: ${line}`);
  for (const line of moving) console.error(`moves: ${line}`);
  const hosts = [...foreign, ...requested];
  console.error(
    [
      status(broken, `internal links and fragments, ${pages.length} pages`, "broken link(s)"),
      status(hosts, "nothing loaded from another host", "load(s) from another host"),
      status(wide, "every page fits 375 px", "page(s) too wide"),
      status(theme, `the theme switch (${quiet})`, `theme switch problem(s) (${quiet})`),
      status(accent, "the wordmark's accent follows the theme after the intro", "accent problem(s)"),
      status(story, "the story: still at its end under reduced motion, then Play again", "story problem(s)"),
      status(moving, "nothing moves under reduced motion", "page(s) moving under reduced motion"),
    ].join("\n"),
  );
  return [broken, hosts, wide, theme, accent, story, moving].every((findings) => findings.length === 0)
    ? 0
    : 1;
}

const browser = await launchBrowser().catch((error: unknown) => {
  console.error(`  ✗   no browser: ${error instanceof Error ? error.message : String(error)}`);
  return undefined;
});
if (browser === undefined) process.exitCode = 1;
else {
  try {
    process.exitCode = await checked(browser);
  } finally {
    await browser.close();
  }
}
