// Which mark a setup row's state square draws (design-system.md "State square"): an AI's in the first step by its
// engine, a sub-step's by its state unless its row gives one of its own.
import { expect, test } from "bun:test";
import type { Engine } from "@lookover/contracts";
import { engineMark, subStepMark } from "./state-square.ts";

const claude: Engine = {
  id: "claude",
  name: "Claude",
  cli: "claude",
  version: "1.0.0",
  state: "ready",
  detail: "",
  unusable: null,
  since: 0,
  limitUntil: null,
  signingIn: false,
};

test("an AI's square: done once ready, the eyes while it signs in, else what it still needs", () => {
  expect(engineMark(claude)).toBe("done");
  expect(engineMark({ ...claude, state: "signed-out", signingIn: true })).toBe("busy");
  expect(engineMark({ ...claude, state: "signed-out" })).toBe("sign-in");
  expect(engineMark({ ...claude, state: "missing", version: null })).toBe("install");
  // Installed, but its version failed the check: something to fix, never to install.
  expect(engineMark({ ...claude, state: "failed-self-test" })).toBe("fix");
  expect(engineMark({ ...claude, state: "limit" })).toBe("wait");
  expect(engineMark({ ...claude, state: "self-test-unfinished" })).toBe("wait");
  // Ready wins over a sign-in that hasn't ended yet.
  expect(engineMark({ ...claude, signingIn: true })).toBe("done");
});

// A coding agent's row draws its own mark, stale or refused (`rowView`; coding-agent.test.tsx renders it).
test("a sub-step's square: done and busy as they are, current and later what it still needs", () => {
  expect(subStepMark("done", "sign-in")).toBe("done");
  expect(subStepMark("busy", "sign-in")).toBe("busy");
  expect(subStepMark("current", "sign-in")).toBe("sign-in");
  expect(subStepMark("later", "install")).toBe("install");
});
