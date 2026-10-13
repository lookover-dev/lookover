// The built web app served beside the API (ADR 0054), from a folder on disk: its files by their path, `index.html`
// for any other path, nothing but the API under `/api/`, the security headers on every answer, `index.html` never
// cached and the hashed assets cached for good.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { carriedWebFiles, diskWebFiles } from "./index.ts";
import { api, home, openApp, start, stopAll, TEST_LIMIT_MS } from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const INDEX =
  '<!doctype html><div id="root"></div><script type="module" src="/assets/index-a1b2.js"></script>';
const SCRIPT = "console.log('lookover');";
const ICON = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

/** A built app as `vite build` leaves it: `index.html`, a hashed script under `assets/`, the favicon. */
function builtApp(): string {
  const dir = join(home(), "dist");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "assets", "index-a1b2.js"), SCRIPT);
  writeFileSync(join(dir, "favicon.svg"), ICON);
  return dir;
}

const startServing = () => start({ webFiles: diskWebFiles(builtApp()) });

/** The security headers every answer carries (api.ts). */
function expectGuarded(res: Response): void {
  expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

const NEVER_CACHED = "no-cache";
const CACHED_FOR_GOOD = "public, max-age=31536000, immutable";

test("the app's page is served at its root, never cached, with the security headers", async () => {
  const { service } = await startServing();
  const res = await fetch(`${service.origin}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("text/html");
  expect(res.headers.get("cache-control")).toBe(NEVER_CACHED);
  expectGuarded(res);
  expect(await res.text()).toBe(INDEX);
});

test("a hashed asset is served by its path, cached for good", async () => {
  const { service } = await startServing();
  const res = await fetch(`${service.origin}/assets/index-a1b2.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("text/javascript");
  expect(res.headers.get("cache-control")).toBe(CACHED_FOR_GOOD);
  expectGuarded(res);
  expect(await res.text()).toBe(SCRIPT);
});

test("a file outside the assets is served by its path, never cached: its name carries no hash", async () => {
  const { service } = await startServing();
  const res = await fetch(`${service.origin}/favicon.svg`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("image/svg+xml");
  expect(res.headers.get("cache-control")).toBe(NEVER_CACHED);
  expect(await res.text()).toBe(ICON);
});

test("a deep link gets the app's page, which routes it", async () => {
  const { service } = await startServing();
  for (const path of ["/repos/sasensi/lookover-sandbox/pull/1", "/settings", "/index.html"]) {
    const res = await fetch(`${service.origin}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(res.headers.get("cache-control")).toBe(NEVER_CACHED);
    expectGuarded(res);
    expect(await res.text()).toBe(INDEX);
  }
});

test("an asset that isn't there is not found, never the app's page in its place", async () => {
  const { service } = await startServing();
  const res = await fetch(`${service.origin}/assets/index-gone.js`);
  expect(res.status).toBe(404);
  expectGuarded(res);
});

test("nothing outside the built app is served, however the path climbs: the app's page or not found", async () => {
  const dir = builtApp();
  writeFileSync(join(dir, "..", "beside.txt"), "not the app's");
  const { service } = await start({ webFiles: diskWebFiles(dir) });
  // Encoded, so fetch sends them as they are and the service decodes them.
  for (const path of ["/..%2fbeside.txt", "/assets/..%2f..%2fbeside.txt", "/%2E%2E%5Cbeside.txt"]) {
    const res = await fetch(`${service.origin}${path}`);
    const body = await res.text();
    if (res.status === 200) expect(body).toBe(INDEX);
    else expect(res.status).toBe(404);
  }
});

test("a path with a NUL in it is not found, never a failure", async () => {
  const { service } = await startServing();
  for (const path of ["/index%00.html", "/assets/index-a1b2.js%00"]) {
    const res = await fetch(`${service.origin}${path}`);
    expect(res.status).toBe(404);
    expectGuarded(res);
  }
});

test("the app's page is refused to a request for another host, as the API is", async () => {
  const { service } = await startServing();
  for (const path of ["/", "/assets/index-a1b2.js", "/settings"]) {
    const res = await fetch(`${service.origin}${path}`, { headers: { host: "evil.test" } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("<!doctype html>");
  }
});

test("under /api/ only the API answers: an unknown path is not found, never the app's page", async () => {
  const { service } = await startServing();
  const cookie = await openApp(service);
  const res = await fetch(api(service, "/nope"), { headers: { cookie } });
  expect(res.status).toBe(404);
  expectGuarded(res);
  expect(await res.text()).not.toContain("<!doctype html>");
  const bare = await fetch(`${service.origin}/api`, { headers: { cookie } });
  expect(bare.status).toBe(404);
});

test("the API still answers beside the app", async () => {
  const { service } = await startServing();
  const cookie = await openApp(service);
  const res = await fetch(api(service, "/snapshot"), { headers: { cookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).seq).toBeGreaterThan(0);
});

test("the files the compiled binary carries are served by their path in the built app, and no other", async () => {
  // What the build's generated entry hands on: each file's path in the built app, and where the binary keeps it.
  const dir = builtApp();
  const { service } = await start({
    webFiles: carriedWebFiles(
      new Map([
        ["index.html", join(dir, "index.html")],
        ["assets/index-a1b2.js", join(dir, "assets", "index-a1b2.js")],
      ]),
    ),
  });
  const page = await fetch(`${service.origin}/settings`);
  expect(page.headers.get("content-type")).toStartWith("text/html");
  expect(await page.text()).toBe(INDEX);
  const script = await fetch(`${service.origin}/assets/index-a1b2.js`);
  expect(script.headers.get("content-type")).toStartWith("text/javascript");
  expect(await script.text()).toBe(SCRIPT);
  // On disk beside them, but not carried: the page in its place, as for any path that names no file.
  expect(await (await fetch(`${service.origin}/favicon.svg`)).text()).toBe(INDEX);
});

test("without the built app, the service serves no page: the dev server does", async () => {
  const { service } = await start();
  expect((await fetch(`${service.origin}/`)).status).toBe(404);
});
