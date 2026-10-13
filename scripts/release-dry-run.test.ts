// `bun scripts/release-dry-run.ts`: which steps a command line asks for and where, and the build's target. The
// steps themselves are the real ones (`bun run release:dry-run`, recorded in the notes; CI runs it). `--touches`
// needs the private export, so its tests are private: `scripts/private/release-dry-run-touches.test.ts`.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildArgs, plan, STEPS } from "./release-dry-run.ts";

describe("the plan", () => {
  test("with nothing asked: every step, into a new temporary tree", () => {
    expect(plan([])).toEqual({ steps: [...STEPS], tree: undefined, keep: false });
    expect(STEPS).toEqual(["export", "install", "check", "build", "assets", "smoke"]);
  });

  test("--tree alone: every step but the export, on that tree (the public repository's own checkout)", () => {
    expect(plan(["--tree", "."])).toEqual({
      steps: ["install", "check", "build", "assets", "smoke"],
      tree: resolve("."),
      keep: false,
    });
  });

  test("the steps named, in the dry run's order", () => {
    expect(plan(["smoke", "build", "--tree", "pub"])).toEqual({
      steps: ["build", "smoke"],
      tree: resolve("pub"),
      keep: false,
    });
    expect(plan(["export", "--tree", "pub", "--keep"])).toEqual({
      steps: ["export"],
      tree: resolve("pub"),
      keep: true,
    });
  });

  test("a step on a tree it doesn't export needs --tree", () => {
    expect(plan(["check"])).toBe("check works on an exported tree: pass --tree <dir>, or ask for export too");
  });

  test("refuses an unknown step or option", () => {
    expect(plan(["deploy"])).toBe("no step deploy; the steps: export install check build assets smoke");
    expect(plan(["--fast"])).toContain("--fast");
  });

  test("--touches takes a base and nothing else", () => {
    expect(plan(["--touches", "origin/main"])).toEqual({ touches: "origin/main" });
    expect(plan(["--touches", "origin/main", "check"])).toBe(
      "--touches takes a base commit and nothing else",
    );
  });
});

describe("the build", () => {
  test("is the release's: Bun's baseline target on x64, the machine's own elsewhere", () => {
    expect(buildArgs("x64")).toEqual(["--baseline"]);
    expect(buildArgs("arm64")).toEqual([]);
  });
});
