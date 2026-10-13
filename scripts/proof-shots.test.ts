// The shot list `bun run proof` takes (#126 F4): every shot on a scenario the service knows, each landing on a
// screen of its own, and none but the one shot without a session accepting the session screen; the route table
// it checks screens by is the app's own.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCENARIOS } from "@lookover/service";
import { ROUTES, SHOTS, screenOf } from "./proof-shots.ts";

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
  expect(screenOf({ name: "a", scenario: "S4", path: "/reviews/ledger-api/149" })).toBe(
    '[data-screen="review"]',
  );
  expect(screenOf({ name: "a", scenario: "S9", path: "/repositories" })).toBe('[data-screen="repositories"]');
  expect(screenOf({ name: "a", scenario: "S9", path: "/repositories/lookover-sandbox" })).toBe(
    '[data-screen="repository"]',
  );
  expect(screenOf({ name: "a", scenario: "S10", path: "/settings" })).toBe('[data-screen="settings"]');
  expect(screenOf({ name: "a", scenario: "S10", path: "/settings/rules" })).toBe(
    '[data-screen="settings-section"]',
  );
  expect(screenOf({ name: "a", scenario: "S10", path: "/logs" })).toBe('[data-screen="logs"]');
  // Only a pull request GitHub holds has the page: not the strip shown for a number it doesn't know.
  expect(screenOf({ name: "a", scenario: "S2", path: "/github/ledger-api/148" })).toBe(".gh .gh-page");
  expect(screenOf({ name: "a", scenario: "S1", screen: ".setup" })).toBe(".setup");
  expect(screenOf({ name: "a", scenario: "S14", noSession: true })).toBe(".session");
});

test("a path the app doesn't route can't pass as Home, which the app falls back to", () => {
  expect(() => screenOf({ name: "a", scenario: "S10", path: "/repositoriez" })).toThrow("/repositoriez");
  expect(() => screenOf({ name: "a", scenario: "S10", path: "/reviews/ledger-api" })).toThrow();
  expect(() => screenOf({ name: "a", scenario: "S10", path: "/github/ledger-api" })).toThrow();
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
