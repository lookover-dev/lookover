// What the proof shots (`proof.ts`) and the story's strip (`strip.ts`) share: the two themes, where the checkout's
// root and its exploration pages are, and a browser context in one theme, the choice kept as the switch keeps it,
// nothing loaded from another host and the exploration pages' fonts the site's own.
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { storageKey, type Theme } from "../src/components/theme.ts";
import { localContext, sitePath } from "./browser.ts";
import { standInFonts } from "./fonts.ts";

/** Both themes, dark first as the site's default. */
export const THEMES = ["dark", "light"] as const satisfies readonly Theme[];

/** The checkout's root: the shots go into its `.proof/`. */
export const ROOT = sitePath("..", "..");

/** The explorations' pages, round 4 and the motion labs: only where the checkout has `docs/` (the private one). */
export const EXPLORATION_ASSETS = join(ROOT, "docs", "exploration", "assets");

/** A context at `width` × `height` in `theme`, with motion unless `reduced`, the theme stored under the switch's key. */
export async function themedContext(
  browser: Browser,
  {
    width,
    height,
    theme,
    reduced = false,
  }: { width: number; height: number; theme: Theme; reduced?: boolean },
): Promise<BrowserContext> {
  const context = await localContext(browser, {
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: reduced ? "reduce" : "no-preference",
  });
  await context.addInitScript(([key, chosen]) => localStorage.setItem(key, chosen), [
    storageKey,
    theme,
  ] as const);
  await standInFonts(context);
  return context;
}
