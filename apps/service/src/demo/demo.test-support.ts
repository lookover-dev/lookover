// What the scenario tests share (ADR 0046): the service in demo mode on a scenario, in a temporary data folder,
// its clock standing still at `T0` once the seed is played, driven only as the drawer and the app drive it:
// `GET /api/v1/snapshot`, `GET /api/v1/demo`, `POST /api/v1/commands`, the event stream. The one read past the
// door is the room's whole event log (`logOf`), which no tab can replay from a number before the start (ADR 0038).
// Each test file starts its own services and stops them after each test (`stopAll`).
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_FLOW,
  DEMO_API,
  type DemoCommand,
  type Event,
  type FaultId,
  type State,
} from "@lookover/contracts";
import { openStore } from "@lookover/store";
import {
  type DemoServiceOptions,
  type RunningService,
  type Scenario,
  scenarioOf,
  startDemoService,
} from "../index.ts";
import { api, messages, openApp, SANDBOX, T0 } from "../service.test-support.ts";

export { T0, until } from "../service.test-support.ts";

const homes: string[] = [];
const running: RunningService[] = [];

/**
 * S10's world with a seed of five minutes, #135 opened and reviewed in it: what a test stands on when the story
 * behind it doesn't matter (a load's own steps, an engine's fault). Its room builds in a tenth of S10's time, whose
 * seed is two and a half hours of polls; its fourteen events are the start, the repository, #135 and its review, with
 * main's rules as its review read them and its outbox as it posted.
 */
export function brief(): Scenario {
  return {
    ...scenarioOf("S10"),
    id: "T-brief",
    script: [{ at: 60_000, move: { kind: "open", change: { repo: SANDBOX, number: 135 } } }],
    seed: 5 * 60_000,
  };
}
/** The events the brief story's seed sends. */
export const BRIEF_SEEDED = 14;

/**
 * The service on `scenario`, its seed played, standing at `T0` unless `at` says otherwise; and the app's session on
 * it. `scenarios`: what `demo.load` and the listing know (the catalogue by default), so a test loads one of its own.
 * `driver`: what builds each room, so a test holds a load at a point of its choosing or breaks one.
 */
export async function startScenario(
  scenario: Scenario,
  options: {
    at?: number;
    eventsKept?: number;
    scenarios?: Scenario[];
    driver?: DemoServiceOptions["driver"];
    /** The person's `gh` (ADR 0059): none unless given, read as not installed. */
    gh?: DemoServiceOptions["gh"];
  } = {},
) {
  const home = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-demo-"));
  homes.push(home);
  /** What no request hears of (the self-tests' lines): kept, not printed into the test's output. */
  const logged: string[] = [];
  const service = await startDemoService({
    home,
    scenario,
    frozen: options.at ?? T0,
    version: "0.1.0",
    log: (line) => logged.push(line),
    userOnly: async () => {}, // `icacls` is slow; the App store's own tests check it.
    ...(options.eventsKept === undefined ? {} : { eventsKept: options.eventsKept }),
    ...(options.scenarios === undefined ? {} : { scenarios: options.scenarios }),
    ...(options.driver === undefined ? {} : { driver: options.driver }),
    ...(options.gh === undefined ? {} : { gh: options.gh }),
  });
  running.push(service);
  const cookie = await openApp(service);
  return { service, cookie, home, logged };
}

/** After each test: stops the services it started, then removes their data folders. */
export async function stopAll(): Promise<void> {
  for (const s of running.splice(0)) await s.stop();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
}

type Door = { service: RunningService; cookie: string };

export async function snapshotOf({ service, cookie }: Door): Promise<State> {
  const res = await fetch(api(service, "/snapshot"), { headers: { cookie } });
  if (res.status !== 200) throw new Error(`The snapshot answered ${res.status}`);
  return res.json();
}

/** A command or a dev verb posted as the app and the drawer post them. */
export function send(
  { service, cookie }: Door,
  body: DemoCommand | { type: string; [key: string]: unknown },
) {
  return fetch(api(service, "/commands"), {
    method: "POST",
    headers: { cookie, origin: service.origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The drawer's fault, posted; the status it answered. */
export async function inject(door: Door, fault: FaultId): Promise<number> {
  return (await send(door, { type: "demo.inject", fault })).status;
}

/** The drawer's `demo.load`: the status it answered, and the body. */
export async function load(door: Door, id: string): Promise<{ status: number; body: unknown }> {
  const res = await send(door, { type: "demo.load", id });
  return { status: res.status, body: await res.json() };
}

/** The drawer's `demo.advance`: the clock moved on by `ms`. */
export async function advance(door: Door, ms: number): Promise<void> {
  const res = await send(door, { type: "demo.advance", ms });
  if (res.status !== 200) throw new Error(`demo.advance answered ${res.status}`);
}

/** The event stream from after number `after`, read as the browser reads it. */
export async function stream({ service, cookie }: Door, after: number) {
  return messages(await fetch(`${api(service, "/events")}?after=${after}`, { headers: { cookie } }));
}

/** The listing as the drawer reads it: the body and the status. */
export async function listing({ service, cookie }: Door) {
  const res = await fetch(api(service, "/demo"), { headers: { cookie } });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

/** The whole event log of the one room under `home`, as its store holds it. */
export function logOf({ home }: { home: string }): Event[] {
  const rooms = join(home, "rooms");
  const [room, ...others] = readdirSync(rooms);
  if (room === undefined || others.length > 0)
    throw new Error(`${rooms} holds ${others.length + 1} rooms, not one`);
  const store = openStore({ home: join(rooms, room) });
  const events = store.events.all();
  store.close();
  return events;
}

/** Text a page wrote in HTML, read back. */
const fromHtml = (s: string) =>
  s.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** A redirect's target, or an error saying what answered instead. */
function redirected(res: Response, what: string): string {
  const location = res.headers.get("location");
  if (res.status < 300 || res.status > 399 || location === null)
    throw new Error(`${what} answered ${res.status}`);
  return location;
}

/**
 * "Create it on GitHub" as the browser follows it (ADR 0053): the page it opens, its form posted to GitHub's "new
 * App" page (the fake's, which makes the App at once), GitHub's redirect to the callback followed with no session, as
 * from another site. The App's install page the callback sends the tab to.
 */
export async function makeApp({ service, cookie }: Door): Promise<string> {
  const page = await fetch(`${service.origin}${APP_FLOW.manifest}`, { headers: { cookie } });
  if (page.status !== 200) throw new Error(`The manifest page answered ${page.status}`);
  const html = await page.text();
  const action = fromHtml(/<form[^>]* action="([^"]*)"/.exec(html)?.[1] ?? "");
  const manifest = fromHtml(/name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "");
  const made = await fetch(new URL(action, service.origin), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: service.origin },
    body: new URLSearchParams({ manifest }),
  });
  const back = await fetch(new URL(redirected(made, "GitHub's new App page"), service.origin), {
    redirect: "manual",
    headers: { "sec-fetch-site": "cross-site" },
  });
  return redirected(back, "The callback");
}

/**
 * The App installed from its install page, on all the owner's repositories, as the owner does on GitHub; then
 * GitHub's redirect followed: to the install's setup page, or, for an App the pages didn't make, its installation's
 * page. Its words.
 */
export async function installApp({ service, cookie }: Door, installPage: string): Promise<string> {
  const installed = await fetch(new URL(installPage, service.origin), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: service.origin },
    body: new URLSearchParams({ selection: "all" }),
  });
  // Same-site in demo mode, as the browser goes: GitHub's fake pages are the service's own.
  const setup = await fetch(new URL(redirected(installed, "GitHub's install page"), service.origin), {
    headers: { cookie },
  });
  if (setup.status !== 200) throw new Error(`The install's setup page answered ${setup.status}`);
  return setup.text();
}

/**
 * GitHub's fake page at `path` under demo mode's web address, as the owner's browser opens it, or posts its form with
 * `fields`: its words (a key, for the App page's "Generate a private key"). Throws unless it answers 200.
 */
export async function onGitHub(
  { service, cookie }: Door,
  path: string,
  fields?: [string, string][],
): Promise<string> {
  const url = `${service.origin}${DEMO_API.github}${path}`;
  const res =
    fields === undefined
      ? await fetch(url, { headers: { cookie } })
      : await fetch(url, {
          method: "POST",
          headers: { cookie, origin: service.origin },
          body: new URLSearchParams(fields),
        });
  if (res.status !== 200) throw new Error(`GitHub's ${path} answered ${res.status}`);
  return res.text();
}

/**
 * A link the app shows, built on `Connection.web` (a path on the service in demo mode), followed as the owner's
 * browser does: GitHub's fake page there, as `onGitHub` gives it.
 */
export function following(door: Door, href: string, fields?: [string, string][]): Promise<string> {
  const url = new URL(href, door.service.origin);
  return onGitHub(door, `${url.pathname.slice(DEMO_API.github.length)}${url.search}`, fields);
}
