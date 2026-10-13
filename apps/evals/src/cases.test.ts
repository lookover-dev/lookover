import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EvalCase, loadCorpus, parseCase } from "./index.ts";

const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-evals-cases-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const VALID = `id: off-by-one
language: typescript
summary: Pages a list.
base:
  - path: src/page.ts
    content: |
      export const size = 10;
change:
  - path: src/page.ts
    content: |
      export const size = 10;

      export function page<T>(all: T[], n: number): T[] {
        return all.slice(n * size, n * size + size + 1);
      }
planted:
  path: src/page.ts
  ranges: [[4, 4]]
  what: The slice takes one item too many.
`;

/** The valid case with `from` replaced by `to`: the case under test differs from it by that line alone. */
const varied = (from: string, to: string) => {
  if (!VALID.includes(from)) throw new Error(`the valid case has no "${from}"`);
  return VALID.replace(from, to);
};

const refusal = (text: string, name = "off-by-one.yaml") => {
  try {
    parseCase(name, text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the case was read");
};

describe("parseCase", () => {
  test("reads a valid case", () => {
    const expected: EvalCase = {
      id: "off-by-one",
      language: "typescript",
      summary: "Pages a list.",
      base: [{ path: "src/page.ts", content: "export const size = 10;\n" }],
      change: [
        {
          path: "src/page.ts",
          content:
            "export const size = 10;\n\nexport function page<T>(all: T[], n: number): T[] {\n  return all.slice(n * size, n * size + size + 1);\n}\n",
        },
      ],
      planted: { path: "src/page.ts", ranges: [[4, 4]], what: "The slice takes one item too many." },
    };
    expect(parseCase("off-by-one.yaml", VALID)).toEqual(expected);
  });

  test("reads a CRLF file as LF", () => {
    expect(parseCase("off-by-one.yaml", VALID.replaceAll("\n", "\r\n"))).toEqual(
      parseCase("off-by-one.yaml", VALID),
    );
  });

  test("reads a clean case and a deleted file", () => {
    const clean = varied(
      "planted:\n  path: src/page.ts\n  ranges: [[4, 4]]\n  what: The slice takes one item too many.\n",
      "clean: true\n",
    )
      .replace("base:\n", "base:\n  - path: src/old.ts\n    content: |\n      export {};\n")
      .replace("change:\n", "change:\n  - path: src/old.ts\n    deleted: true\n");
    const read = parseCase("off-by-one.yaml", clean);
    expect(read.planted).toBeNull();
    expect(read.change[0]).toEqual({ path: "src/old.ts", deleted: true });
  });

  test("refuses a planted range outside the change's file", () => {
    expect(refusal(varied("[[4, 4]]", "[[4, 6]]"))).toContain(
      "planted range [4, 6] is outside src/page.ts's 5 lines",
    );
    expect(refusal(varied("[[4, 4]]", "[[0, 2]]"))).toContain("planted range [0, 2] is outside");
    expect(refusal(varied("[[4, 4]]", "[[4, 3]]"))).toContain("planted range [4, 3] is outside");
  });

  test("refuses a planted file the change doesn't write", () => {
    expect(refusal(varied("  path: src/page.ts\n  ranges", "  path: src/other.ts\n  ranges"))).toContain(
      "planted.path src/other.ts is not a file the change writes",
    );
  });

  test("reads a planted bug's other places, each a file the change writes", () => {
    const placed = varied(
      "change:\n",
      "change:\n  - path: src/page.test.ts\n    content: |\n      a\n      b\n      c\n",
    ).replace(
      "  what: The slice",
      "  also:\n    - path: src/page.test.ts\n      ranges: [[2, 3]]\n  what: The slice",
    );
    expect(parseCase("off-by-one.yaml", placed).planted).toEqual({
      path: "src/page.ts",
      ranges: [[4, 4]],
      also: [{ path: "src/page.test.ts", ranges: [[2, 3]] }],
      what: "The slice takes one item too many.",
    });
  });

  test("refuses another place on a file the change doesn't write, or outside its head lines", () => {
    const at = (place: string) => varied("  what: The slice", `  also:\n${place}  what: The slice`);
    expect(refusal(at("    - path: src/other.ts\n      ranges: [[1, 1]]\n"))).toContain(
      "planted.also[0].path src/other.ts is not a file the change writes",
    );
    expect(refusal(at("    - path: src/page.ts\n      ranges: [[5, 6]]\n"))).toContain(
      "planted.also[0] range [5, 6] is outside src/page.ts's 5 lines",
    );
    expect(refusal(at("    - path: src/page.ts\n      ranges: []\n"))).toContain(
      "planted.also[0].ranges must list one or more [start, end]",
    );
    expect(refusal(at("    - path: src/page.ts\n      ranges: [[1, 1]]\n      what: x\n"))).toContain(
      "unknown field planted.also[0].what",
    );
    const deleted = varied("base:\n", "base:\n  - path: src/old.ts\n    content: |\n      x\n")
      .replace("change:\n", "change:\n  - path: src/old.ts\n    deleted: true\n")
      .replace(
        "  what: The slice",
        "  also:\n    - path: src/old.ts\n      ranges: [[1, 1]]\n  what: The slice",
      );
    expect(refusal(deleted)).toContain("planted.also[0].path src/old.ts is not a file the change writes");
    expect(refusal(varied("  what: The slice", "  also: []\n  what: The slice"))).toContain(
      "planted.also must list one or more places: path and ranges",
    );
  });

  test("refuses a case both planted and clean, or neither", () => {
    expect(refusal(`${VALID}clean: true\n`)).toContain("either planted or clean: true, not both");
    expect(
      refusal(
        varied(
          "planted:\n  path: src/page.ts\n  ranges: [[4, 4]]\n  what: The slice takes one item too many.\n",
          "",
        ),
      ),
    ).toContain("needs planted or clean: true");
  });

  test("refuses a missing field", () => {
    expect(refusal(varied("summary: Pages a list.\n", ""))).toContain("summary is missing");
    expect(refusal(varied("  what: The slice takes one item too many.\n", ""))).toContain(
      "planted.what is missing",
    );
    expect(refusal(varied("    content: |\n      export const size = 10;\nchange", "change"))).toContain(
      "base[0].content is missing",
    );
  });

  test("refuses a duplicate path", () => {
    const twice = varied("change:\n", "change:\n  - path: src/page.ts\n    content: |\n      x\n");
    expect(refusal(twice)).toContain("change lists src/page.ts twice");
  });

  test("refuses a change file written as the base has it", () => {
    const same = varied("base:\n", "base:\n  - path: src/same.ts\n    content: |\n      x\n").replace(
      "change:\n",
      "change:\n  - path: src/same.ts\n    content: |\n      x\n",
    );
    expect(refusal(same)).toContain(
      "change[0].content is src/same.ts as the base has it: the change doesn't touch it",
    );
  });

  test("refuses an unknown field, an id that isn't its file's name, and a file that isn't YAML", () => {
    expect(refusal(`${VALID}hint: look at the slice\n`)).toContain("unknown field hint");
    expect(refusal(VALID, "another.yaml")).toContain("id off-by-one is not the file's name (another)");
    expect(refusal(VALID, "off-by-one.ts")).toContain("a case is a .yaml file");
  });
});

describe("loadCorpus", () => {
  test("loads the corpus: the cases in file order, and the shared REVIEW.md", () => {
    const corpus = loadCorpus(join(import.meta.dir, "..", "cases"));
    expect(corpus.cases.map((c) => [c.id, c.language, c.planted === null])).toEqual([
      ["py-cart-items", "python", false],
      ["py-city-customers", "python", false],
      ["py-daily-visits", "python", false],
      ["py-forecast-client", "python", false],
      ["py-print-jobs", "python", false],
      ["py-receipt-amounts", "python", true],
      ["py-rename-subtotal", "python", true],
      ["py-shipping-rates", "python", false],
      ["py-shop-hours", "python", true],
      ["ts-bill-invoice", "typescript", false],
      ["ts-cart-sums", "typescript", true],
      ["ts-checkout-all", "typescript", false],
      ["ts-daily-takings", "typescript", false],
      ["ts-document-list", "typescript", false],
      ["ts-loyalty-points", "typescript", false],
      ["ts-note-audit", "typescript", false],
      ["ts-order-discount", "typescript", false],
      ["ts-receipt-header", "typescript", false],
      ["ts-role-permissions", "typescript", true],
    ]);
    expect(corpus.review.startsWith("# Review rules\n")).toBe(true);
  });

  test("refuses a file with a source extension anywhere under the folder", () => {
    const dir = join(temp, "source");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "REVIEW.md"), "# Review rules\n");
    writeFileSync(join(dir, "off-by-one.yaml"), VALID);
    writeFileSync(join(dir, "nested", "page.ts"), "export {};\n");
    expect(() => loadCorpus(dir)).toThrow(/nested[\\/]page\.ts: only case files \(\.yaml\) and REVIEW\.md/);
  });

  test("refuses a folder with no REVIEW.md", () => {
    const dir = join(temp, "no-rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "off-by-one.yaml"), VALID);
    expect(() => loadCorpus(dir)).toThrow("has no REVIEW.md");
  });
});
