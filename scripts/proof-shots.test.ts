// The shot list `bun run proof` takes (#126 F4): every shot on a scenario the service knows, each landing on a
// screen of its own, and none but the one shot without a session accepting the session screen; the route table
// it checks screens by is the app's own.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCENARIOS } from "@lookover/service";
import { type Demo, demoFor, ROUTES, SHOTS, screenOf } from "./proof-shots.ts";

test("every shot names a scenario the service can load", () => {
  const known = new Set(SCENARIOS.map((s) => s.id));
  expect(SHOTS.filter((s) => !known.has(s.scenario)).map((s) => s.name)).toEqual([]);
});

test("no two shots share a name: each is one file per theme", () => {
  const names = SHOTS.map((s) => s.name);
  expect(names.length).toBe(new Set(names).size);
});

test("only a shot without the session may land on the session screen", () => {
  const onSession = SHOTS.filter((s) => screenOf(s).includes(".session")).map((s) => s.name);
  expect(onSession).toEqual(SHOTS.filter((s) => s.noSession).map((s) => s.name));
  expect(onSession).toEqual(["service-session"]);
});

test("a shot lands on the screen its path routes to, or the one it names", () => {
  expect(screenOf({ name: "a", scenario: "S10" })).toBe('[data-screen="home"]');
  expect(screenOf({ name: "a", scenario: "S10", path: "/" })).toBe('[data-screen="home"]');
  expect(screenOf({ name: "a", scenario: "S12", path: "/reviews" })).toBe('[data-screen="reviews"]');
  expect(screenOf({ name: "a", scenario: "S4", path: "/reviews/sasensi/ledger-api/149" })).toBe(
    '[data-screen="review"]',
  );
  expect(screenOf({ name: "a", scenario: "S9", path: "/repositories" })).toBe('[data-screen="repositories"]');
  expect(screenOf({ name: "a", scenario: "S9", path: "/repositories/sasensi/lookover-sandbox" })).toBe(
    '[data-screen="repository"]',
  );
  expect(screenOf({ name: "a", scenario: "S10", path: "/settings" })).toBe('[data-screen="settings"]');
  // A place on the page (a section opened by link) routes as its page does.
  expect(screenOf({ name: "a", scenario: "S16", path: "/settings#github" })).toBe('[data-screen="settings"]');
  expect(screenOf({ name: "a", scenario: "S10", path: "/settings/rules" })).toBe(
    '[data-screen="settings-section"]',
  );
  expect(screenOf({ name: "a", scenario: "S10", path: "/logs" })).toBe('[data-screen="logs"]');
  // Only a pull request GitHub holds has the page: not the strip shown for a number it doesn't know.
  expect(screenOf({ name: "a", scenario: "S2", path: "/github/sasensi/ledger-api/148" })).toBe(
    ".gh .gh-page",
  );
  expect(screenOf({ name: "a", scenario: "S1", screen: ".setup" })).toBe(".setup");
  expect(screenOf({ name: "a", scenario: "S14", noSession: true })).toBe(".session");
});

test("a path the app doesn't route can't pass as Home, which the app falls back to", () => {
  expect(() => screenOf({ name: "a", scenario: "S10", path: "/repositoriez" })).toThrow("/repositoriez");
  expect(() => screenOf({ name: "a", scenario: "S10", path: "/reviews/ledger-api" })).toThrow();
  expect(() => screenOf({ name: "a", scenario: "S10", path: "/github/ledger-api" })).toThrow();
  // An address without the repository's owner, as before ADR 0066, names no pull request.
  expect(() => screenOf({ name: "a", scenario: "S10", path: "/reviews/ledger-api/149" })).toThrow();
  expect(() => screenOf({ name: "a", scenario: "S10", path: "/github/ledger-api/149" })).toThrow();
  expect(() => screenOf({ name: "a", scenario: "S10", path: "/repositories/ledger-api" })).toThrow();
});

test("every shot's path routes to a screen", () => {
  expect(
    SHOTS.flatMap((s) => {
      try {
        screenOf(s);
        return [];
      } catch {
        return [s.name];
      }
    }),
  ).toEqual([]);
});

test("the planted sandbox's shots are S14's", () => {
  const service = SHOTS.filter((s) => s.name.startsWith("service-"));
  expect(service.length).toBeGreaterThan(0);
  expect(service.filter((s) => s.scenario !== "S14").map((s) => s.name)).toEqual([]);
});

/** Every `<Route path>` app.tsx draws, but the fallback `*`: the routes proof's `ROUTES` must know. */
function appRoutes(): string[] {
  const app = readFileSync(resolve(import.meta.dir, "../apps/web/src/app.tsx"), "utf8");
  return [...app.matchAll(/<Route\s+path="([^"]+)"/g)].flatMap((m) => (m[1] === "*" ? [] : [m[1] ?? ""]));
}

/** A path the route matches: `:number` a number, any other parameter a name. */
const sample = (route: string) => route.replace(/:number\b/g, "7").replace(/:\w+/g, "name");

test("proof's ROUTES and the app's routes are the same list (apps/web/src/app.tsx)", () => {
  const routes = appRoutes();
  expect(routes.length).toBeGreaterThan(0);
  // Each route the app draws has its screen in ROUTES, and each entry of ROUTES matches a route the app draws.
  expect(routes.filter((r) => !ROUTES.some(([pattern]) => pattern.test(sample(r))))).toEqual([]);
  expect(
    ROUTES.filter(([pattern]) => !routes.some((r) => pattern.test(sample(r)))).map(([p]) => p.source),
  ).toEqual([]);
});

// ADR 0093: the shots of one world share its loaded demo, their pages at once, so an act that moved it moved every
// shot's world by however many acts had landed (#735).
test("an act on a shared world can't move the demo; an alone shot's act moves it once the page's commands are answered", async () => {
  const said: string[] = [];
  const loaded: Demo = {
    advance: async (ms) => {
      said.push(`advance ${ms}`);
    },
    inject: async (fault) => {
      said.push(`inject ${fault}`);
    },
  };
  const settled = async () => {
    said.push("settled");
  };
  const refusal = "a shot sharing its world can't move the demo: use afterFaults, or mark it alone";
  const shared = demoFor({ name: "a", scenario: "S2" }, loaded, settled);
  await expect(shared.advance(1_000)).rejects.toThrow(refusal);
  await expect(shared.inject("github-limit")).rejects.toThrow(refusal);
  expect(said).toEqual([]);
  const alone = demoFor({ name: "b", scenario: "S2", alone: true }, loaded, settled);
  await alone.advance(1_000);
  await alone.inject("github-limit");
  expect(said).toEqual(["settled", "advance 1000", "settled", "inject github-limit"]);
});
