// The browser the site's checks and proof shots drive, and the local server they open the site on. The machine's
// own browser, never a downloaded one: Edge on Windows, as `bun run proof` takes it, Chrome on Linux and macOS (as
// GitHub's ubuntu runners have it), or the one at CHROME_PATH. Nothing leaves the machine: every request to another
// host is refused, and noted for the check that asks.
import { join } from "node:path";
import { type Browser, type BrowserContext, type BrowserContextOptions, chromium } from "playwright";
import { servedFile } from "./site-checks.ts";

/**
 * The machine's Edge on Windows or Chrome elsewhere, or the browser at CHROME_PATH. Without it, one line naming
 * what was tried and how to pick another, in place of Playwright's advice to download one.
 */
export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.CHROME_PATH;
  const chosen = executablePath !== undefined && executablePath !== "";
  const channel = process.platform === "win32" ? "msedge" : "chrome";
  try {
    // The pages are on 127.0.0.1: no proxy lookup, which can stall each load for seconds. The back-forward cache
    // stays on, as a visitor's browser has it: the theme check goes Back to a page the cache restores.
    return await chromium.launch({
      ...(chosen ? { executablePath } : { channel }),
      args: ["--no-proxy-server"],
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
    });
  } catch {
    const tried = chosen
      ? `the browser at CHROME_PATH (${executablePath})`
      : `Playwright's ${channel} channel`;
    throw new Error(`${tried} did not start; set CHROME_PATH to the path of another Chrome or Edge`);
  }
}

/** A folder served on a free local port, as the site's host serves it. */
export interface Served {
  readonly url: string;
  readonly close: () => void;
}

/**
 * Serves a build folder on 127.0.0.1, a page's path as a static host reads it (`/docs/` is `docs/index.html`), and
 * each of `mounts` under its prefix (`/round-4/` → a folder), for the proof shots' other pages.
 */
export function serve(dist: string, mounts: Readonly<Record<string, string>> = {}): Served {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const mount = Object.keys(mounts).find((prefix) => path.startsWith(prefix));
      const file =
        mount === undefined
          ? servedFile(dist, path)
          : servedFile(mounts[mount] ?? dist, `/${path.slice(mount.length)}`);
      return file === undefined ? new Response("Not found", { status: 404 }) : new Response(Bun.file(file));
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, close: () => void server.stop(true) };
}

/**
 * A browser context that loads only from 127.0.0.1: any other request is refused, so no check or shot calls the
 * network, and its URL is added to `elsewhere` when given.
 */
export async function localContext(
  browser: Browser,
  options: BrowserContextOptions,
  elsewhere?: string[],
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) => {
      elsewhere?.push(route.request().url());
      return route.abort("blockedbyclient");
    },
  );
  return context;
}

/** A path under the site's folder, for the scripts beside this one. */
export const sitePath = (...parts: string[]): string => join(import.meta.dir, "..", ...parts);
