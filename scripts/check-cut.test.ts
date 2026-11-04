// The cutter the pre-commit check shows a failed step through: the lines about the staged files, the others
// only counted. The outputs are the real tools' shapes: tsc's `a.ts(3,10): error …`, Biome's `a.ts:3:10 lint/…`
// (backslashes on Windows), the import check's indented `  a.ts:3: …`.
import { describe, expect, test } from "bun:test";
import { aboutFiles } from "./check-cut.ts";

describe("aboutFiles", () => {
  test("errors in the given files are kept; those in other files, and the lines under them, only counted", () => {
    const output = [
      "scripts/b.ts(3,10): error TS2305: Module './a.ts' has no exported member 'next'.",
      "packages/x/src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  The expected type comes from property 'n'.",
      "packages/x/src/moved.ts(2,5): error TS2304: Cannot find name 'gone'.",
    ].join("\n");
    expect(aboutFiles(output, ["scripts/b.ts"])).toEqual({
      text: "scripts/b.ts(3,10): error TS2305: Module './a.ts' has no exported member 'next'.\n(2 more in other files: `bun run check` lists them.)",
      mine: 1,
      others: 2,
      loose: 0,
    });
  });

  test("Biome's Windows paths name the file as its forward-slash path does", () => {
    const output = [
      "scripts\\c.ts:1:1 lint/style/useConst ━━━━",
      "",
      "  ! Use const.",
      "",
      "scripts\\b.ts:2:6 lint/correctness/noUnusedVariables  FIXABLE  ━━━━",
      "",
      "  ! This variable b is unused.",
      "Checked 2 files in 5ms. Found 2 errors.",
    ].join("\n");
    const cut = aboutFiles(output, ["scripts/b.ts"]);
    expect(cut.text).toBe(
      [
        "scripts\\b.ts:2:6 lint/correctness/noUnusedVariables  FIXABLE  ━━━━",
        "",
        "  ! This variable b is unused.",
        "Checked 2 files in 5ms. Found 2 errors.",
        "(1 more in other files: `bun run check` lists them.)",
      ].join("\n"),
    );
    expect([cut.mine, cut.others, cut.loose]).toEqual([1, 1, 0]);
  });

  test("the import check's indented lines name their file too", () => {
    const output = [
      "Module boundaries broken (ADR 0033, checked by scripts/check-deps.ts):",
      '  packages/core/src/a.ts:3: imports "node:fs". Fix it.',
      '  packages/core/package.json: names "x" it doesn\'t import.',
    ].join("\n");
    const cut = aboutFiles(output, ["packages/core/package.json"]);
    expect(cut.text).toBe(
      [
        "Module boundaries broken (ADR 0033, checked by scripts/check-deps.ts):",
        '  packages/core/package.json: names "x" it doesn\'t import.',
        "(1 more in other files: `bun run check` lists them.)",
      ].join("\n"),
    );
    expect([cut.mine, cut.others, cut.loose]).toEqual([1, 1, 0]);
  });

  test("an output that names no file is kept whole", () => {
    expect(aboutFiles("error: tsconfig.json not found", ["scripts/b.ts"])).toEqual({
      text: "error: tsconfig.json not found",
      mine: 0,
      others: 0,
      loose: 1,
    });
  });

  test("a diagnostic tied to no file, next to one in another file, is kept and counted loose", () => {
    const output = [
      "apps/app/src/b.ts(2,5): error TS2304: Cannot find name 'gone'.",
      "error TS5023: Unknown compiler option 'strictest'.",
      "  It was given in tsconfig.json.",
    ].join("\n");
    expect(aboutFiles(output, ["scripts/b.ts"])).toEqual({
      text: [
        "error TS5023: Unknown compiler option 'strictest'.",
        "  It was given in tsconfig.json.",
        "(1 more in other files: `bun run check` lists them.)",
      ].join("\n"),
      mine: 0,
      others: 1,
      loose: 1,
    });
  });

  test("an unnamed line under the import check's header is loose; Biome's summary is not", () => {
    const imports = [
      "Module boundaries broken (ADR 0033, checked by scripts/check-deps.ts):",
      '  packages/core/src/a.ts:3: imports "node:fs". Fix it.',
      "  a cycle: x -> y -> x",
    ];
    expect(aboutFiles(imports.join("\n"), ["scripts/b.ts"]).loose).toBe(1);
    const biome = [
      "scripts\\c.ts:1:1 lint/style/useConst ━━━━",
      "",
      "  ! Use const.",
      "",
      "Checked 2 files in 5ms. No fixes applied.",
      "Found 1 error.",
      "Found 2 warnings.",
      "check ━━━━━━━━",
      "",
      "  × Some errors were emitted while running checks.",
    ];
    expect(aboutFiles(biome.join("\n"), ["scripts/b.ts"])).toMatchObject({ mine: 0, others: 1, loose: 0 });
  });
});
