// Whether a review job may start now, or why it waits (ADR 0029, ADR 0040): paused holds every trigger, then the
// engine chosen to review must be installed, signed in and under its limit.
import { expect, test } from "bun:test";
import type { EngineId, EngineState, Trigger } from "@lookover/contracts";
import { engineHold, mayStart } from "./index.ts";

test("what an engine's state makes a job wait for, on its own: the reason, naming the engine; nothing when ready", () => {
  expect(engineHold({ id: "codex", state: "limit", unusable: null })).toEqual({
    reason: "engine-limit",
    engine: "codex",
  });
  expect(engineHold({ id: "claude", state: "signed-out", unusable: null })).toEqual({
    reason: "engine-signed-out",
    engine: "claude",
  });
  expect(engineHold({ id: "codex", state: "failed-self-test", unusable: null })).toEqual({
    reason: "engine-failed-self-test",
    engine: "codex",
  });
  expect(engineHold({ id: "claude", state: "ready", unusable: null })).toBeNull();
});

test("a missing engine whose program was found but can't be used says why it waits", () => {
  const tooOld = { kind: "too-old", version: "0.161.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  expect(engineHold({ id: "codex", state: "missing", unusable: tooOld })).toEqual({
    reason: "engine-missing",
    engine: "codex",
    unusable: tooOld,
  });
  expect(engineHold({ id: "codex", state: "missing", unusable: null })).toEqual({
    reason: "engine-missing",
    engine: "codex",
    unusable: null,
  });
});

// Every trigger, in a record so a new one fails to compile here until it is tested.
const EVERY_TRIGGER = {
  opened: true,
  push: true,
  comment: true,
  manual: true,
  "first-review": true,
} satisfies Record<Trigger, true>;
const TRIGGERS: Trigger[] = Object.keys(EVERY_TRIGGER).filter((k): k is Trigger => k in EVERY_TRIGGER);
const ready = (id: EngineId): { id: EngineId; state: EngineState; unusable: null } => ({
  id,
  state: "ready",
  unusable: null,
});

test("with reviews not paused, nothing is held", () => {
  expect(TRIGGERS.map((trigger) => mayStart({ paused: false, trigger, engine: ready("claude") }))).toEqual([
    { kind: "start" },
    { kind: "start" },
    { kind: "start" },
    { kind: "start" },
    { kind: "start" },
  ]);
});

test("while reviews are paused, every trigger waits: automatic, a review request comment, the app, setup", () => {
  expect(
    TRIGGERS.map((trigger) => [trigger, mayStart({ paused: true, trigger, engine: ready("codex") })]),
  ).toEqual([
    ["opened", { kind: "deferred", deferral: { reason: "paused" } }],
    ["push", { kind: "deferred", deferral: { reason: "paused" } }],
    ["comment", { kind: "deferred", deferral: { reason: "paused" } }],
    ["manual", { kind: "deferred", deferral: { reason: "paused" } }],
    ["first-review", { kind: "deferred", deferral: { reason: "paused" } }],
  ]);
});

test("an engine that can't review holds the job, named: missing, signed out, at its limit, failed its self-test", () => {
  const cases: [EngineId, EngineState][] = [
    ["claude", "missing"],
    ["codex", "missing"],
    ["claude", "signed-out"],
    ["codex", "signed-out"],
    ["claude", "limit"],
    ["codex", "limit"],
    ["claude", "failed-self-test"],
  ];
  expect(
    cases.map(([id, state]) =>
      mayStart({ paused: false, trigger: "manual", engine: { id, state, unusable: null } }),
    ),
  ).toEqual([
    { kind: "deferred", deferral: { reason: "engine-missing", engine: "claude", unusable: null } },
    { kind: "deferred", deferral: { reason: "engine-missing", engine: "codex", unusable: null } },
    { kind: "deferred", deferral: { reason: "engine-signed-out", engine: "claude" } },
    { kind: "deferred", deferral: { reason: "engine-signed-out", engine: "codex" } },
    { kind: "deferred", deferral: { reason: "engine-limit", engine: "claude" } },
    { kind: "deferred", deferral: { reason: "engine-limit", engine: "codex" } },
    { kind: "deferred", deferral: { reason: "engine-failed-self-test", engine: "claude" } },
  ]);
});

test("paused comes before any engine reason: the owner's pause is what the job waits for", () => {
  const states: EngineState[] = ["missing", "signed-out", "limit"];
  expect(
    states.map((state) =>
      mayStart({ paused: true, trigger: "push", engine: { id: "claude", state, unusable: null } }),
    ),
  ).toEqual([
    { kind: "deferred", deferral: { reason: "paused" } },
    { kind: "deferred", deferral: { reason: "paused" } },
    { kind: "deferred", deferral: { reason: "paused" } },
  ]);
});
