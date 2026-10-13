// The two routes the `lookover` commands reach a running service through (ADR 0054), over HTTP on the held clock:
// a minted link opens the app once, within two minutes; stop answers, then stops the service. Both under the API's
// own checks: the session cookie, the app's Origin and Host.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { API, type MintedLink } from "@lookover/contracts";
import type { LogReader, LogSink, RunningService } from "./index.ts";
import { openApp, start, stopAll, TEST_LIMIT_MS } from "./service.test-support.ts";

setDefaultTimeout(TEST_LIMIT_MS);
afterEach(stopAll);

const TWO_MINUTES = 120_000;

/** A POST to one of the two routes, as a `lookover` command makes it: the cookie and the exact Origin. */
function postTo(
  service: RunningService,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${service.origin}${path}`, {
    method: "POST",
    headers: { origin: service.origin, ...headers },
  });
}

async function mint(service: RunningService, cookie: string): Promise<string> {
  const res = await postTo(service, API.link, { cookie });
  expect(res.status).toBe(200);
  const { url }: MintedLink = await res.json();
  expect(url).toStartWith(`${service.origin}${API.session}?token=`);
  return url;
}

/** What following a link answers: 303 with the cookie once, 403 "this link was used" otherwise. */
const follow = async (url: string) => (await fetch(url, { redirect: "manual" })).status;

test("a minted link opens the app once, not twice, and not once two minutes have passed", async () => {
  const { service, time } = await start();
  const cookie = await openApp(service);

  const once = await mint(service, cookie);
  const opened = await fetch(once, { redirect: "manual" });
  expect(opened.status).toBe(303);
  expect(opened.headers.get("set-cookie")?.split(";")[0]).toBe(cookie);
  expect(await follow(once)).toBe(403);

  // Several live at once, each its own.
  const first = await mint(service, cookie);
  const second = await mint(service, cookie);
  expect(second).not.toBe(first);
  expect(await follow(second)).toBe(303);
  await time.advance(TWO_MINUTES - 1);
  expect(await follow(first)).toBe(303);

  const late = await mint(service, cookie);
  await time.advance(TWO_MINUTES);
  expect(await follow(late)).toBe(403);
});

test("a minted token leaves the log's filter once used or expired: the secrets it holds don't grow", async () => {
  // The filter's secrets as the service registers and forgets them, the session's included.
  const held = new Set<string>();
  const logSink: LogSink & LogReader = {
    write: () => {},
    tail: () => [],
    subscribe: () => () => {},
    secret: (value) => held.add(value),
    forget: (value) => held.delete(value),
    secretsRemoved: (text) => text,
  };
  const { service, time } = await start({ logSink });
  const cookie = await openApp(service);
  const before = held.size;

  const used = await mint(service, cookie);
  const token = new URL(used).searchParams.get("token") ?? "";
  expect(held.has(token)).toBe(true);
  expect(await follow(used)).toBe(303);
  expect(held.has(token)).toBe(false);

  const expired = new URL(await mint(service, cookie)).searchParams.get("token") ?? "";
  await time.advance(TWO_MINUTES);
  for (let i = 0; i < 5; i++) {
    await mint(service, cookie);
    await time.advance(TWO_MINUTES);
  }
  expect(held.has(expired)).toBe(false);
  // The last one expired too, seen at the next link followed.
  expect(await follow(used)).toBe(403);
  expect(held.size).toBe(before);
});

test("the start's own link still works once, with no expiry, beside the minted ones", async () => {
  const { service, time } = await start();
  await time.advance(10 * TWO_MINUTES);
  const cookie = await openApp(service);
  expect(await follow(await mint(service, cookie))).toBe(303);
  expect(await follow(service.openUrl ?? "")).toBe(403);
});

test("link and stop are refused without the cookie, from another Origin, with no Origin or with a wrong Host", async () => {
  const { service } = await start();
  const cookie = await openApp(service);
  for (const path of [API.link, API.stop]) {
    expect((await postTo(service, path)).status).toBe(401);
    expect((await postTo(service, path, { cookie: `${cookie}x` })).status).toBe(401);
    expect((await postTo(service, path, { cookie, origin: "http://evil.test" })).status).toBe(403);
    expect((await postTo(service, path, { cookie, host: "lookover.evil.test" })).status).toBe(403);
    const noOrigin = await fetch(`${service.origin}${path}`, { method: "POST", headers: { cookie } });
    expect(noOrigin.status).toBe(403);
    // Only a POST.
    expect((await fetch(`${service.origin}${path}`, { headers: { cookie } })).status).toBe(404);
  }
  // Nothing was stopped, and every refused link minted nothing.
  expect((await fetch(`${service.origin}${API.snapshot}`, { headers: { cookie } })).status).toBe(200);
});

test("stop answers, then stops the service: nothing answers on its port any more", async () => {
  const { service } = await start();
  const cookie = await openApp(service);
  const res = await postTo(service, API.stop, { cookie });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  for (let i = 0; i < 250; i++) {
    const answered = await fetch(`${service.origin}${API.snapshot}`, { headers: { cookie } }).then(
      () => true,
      () => false,
    );
    if (!answered) return;
    await Bun.sleep(20);
  }
  throw new Error("the service still answers");
});
