// The web app's build-time mode (ADR 0054): what each one mounts of the developer's tools.
import { expect, test } from "bun:test";
import { HttpApi } from "../api/http.ts";
import { DemoApi } from "./demo-api.ts";
import { modeOf, scenarioFromAddress } from "./mode.ts";
import { devTools } from "./tools.tsx";

const demo = () => new DemoApi({ lost: () => new HttpApi().endSession(null) });

test("a build names its mode; one that names none is demo mode's", () => {
  expect(modeOf("program")).toBe("program");
  expect(modeOf("live")).toBe("live");
  expect(modeOf("demo")).toBe("demo");
  expect(modeOf(undefined)).toBe("demo");
});

test("a mode the app doesn't know fails the start, never falls back to the demo's tools", () => {
  expect(() => modeOf("prod")).toThrow("prod");
});

test("the program mounts no drawer and no demo page, and loads no scenario the address names", () => {
  expect(devTools("program", demo())).toBeNull();
  expect(scenarioFromAddress("program")).toBe(false);
});

test("live mode mounts the drawer without the demo's pages; demo mode mounts both", () => {
  const live = devTools("live", demo());
  expect(live?.drawer).not.toBeNull();
  expect(live?.routes).toBeNull();
  expect(scenarioFromAddress("live")).toBe(false);
  const demoTools = devTools("demo", demo());
  expect(demoTools?.drawer).not.toBeNull();
  expect(demoTools?.routes).not.toBeNull();
  expect(scenarioFromAddress("demo")).toBe(true);
});
