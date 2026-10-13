// The corpus itself, case by case (ADR 0050): every case loads and builds, its id is its own, each of its planted
// bug's places points into what the change wrote, and nothing a reviewer reads hints at the bug.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCase, type EvalCase, loadCorpus, type Place, type Planted } from "./index.ts";

// Every case is built with git: more than Bun's 5 s for the whole corpus on a busy machine.
setDefaultTimeout(60_000);

const GIT = Bun.which("git") ?? "";
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-evals-corpus-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const CASES = join(import.meta.dir, "..", "cases");
const corpus = loadCorpus(CASES);

/** Words that would tell a reviewer where to look, whole words in any case: "prefix" and "debug" pass. */
const HINT = /\b(?:bugs?|buggy|fix|fixes|fixed|fixme|todo|planted|wrong|wrongly)\b/i;

/** The extension a case's planted file has in its language. */
const EXTENSION = { typescript: ".ts", python: ".py" } satisfies Record<EvalCase["language"], string>;

/** git's output, run without waiting on the others: the cases' diffs are asked for all at once. */
async function git(repo: string, ...args: string[]): Promise<string> {
  const env = { HOME: temp, USERPROFILE: temp, GIT_CONFIG_NOSYSTEM: "1" };
  const child = Bun.spawn([GIT, ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out;
}

/** The head-side lines the change adds to `path`, from git's own diff (no context lines). */
const addedLines = async (repo: string, path: string): Promise<number[]> =>
  (await git(repo, "diff", "-U0", "main", "change", "--", path)).split("\n").flatMap((line) => {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) return [];
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    return Array.from({ length: count }, (_, i) => start + i);
  });

/** A planted bug's places: its own first, then the others the case lists. */
const placesOf = (planted: Planted): Place[] => [planted, ...(planted.also ?? [])];

/** Each planted case's added lines in each file it has a place in (`<id> <path>`), once every case is built. */
const added = new Map<string, Set<number>>();
beforeAll(async () => {
  const built = corpus.cases.map((evalCase) => ({
    evalCase,
    repo: buildCase({ evalCase, review: corpus.review, root: mkdtempSync(join(temp, "case-")), git: GIT })
      .cloneUrl,
  }));
  await Promise.all(
    built.flatMap(({ evalCase, repo }) =>
      evalCase.planted === null
        ? []
        : placesOf(evalCase.planted).map(async ({ path }) => {
            added.set(`${evalCase.id} ${path}`, new Set(await addedLines(repo, path)));
          }),
    ),
  );
});

describe("the corpus", () => {
  test("has its cases", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
    expect(readdirSync(CASES).filter((f) => f.endsWith(".yaml")).length).toBe(corpus.cases.length);
  });

  test("counts nineteen cases: fourteen planted, five clean", () => {
    const planted = corpus.cases.filter((c) => c.planted !== null).length;
    expect([corpus.cases.length, planted, corpus.cases.length - planted]).toEqual([19, 14, 5]);
  });

  test("lists another place for each bug a test the change writes, or a callee it writes, also names", () => {
    const placed = corpus.cases.flatMap((c) =>
      (c.planted?.also ?? []).map((place) => [c.id, place.path, place.ranges]),
    );
    expect(placed).toEqual([
      ["py-cart-items", "tests/test_cart.py", [[12, 13]]],
      ["py-city-customers", "tests/test_customers.py", [[16, 16]]],
      ["py-daily-visits", "tests/test_visits.py", [[11, 11]]],
      ["py-forecast-client", "tests/test_weather.py", [[14, 15]]],
      ["py-print-jobs", "tests/test_printing.py", [[19, 20]]],
      ["ts-checkout-all", "src/store.ts", [[9, 13]]],
      ["ts-loyalty-points", "src/loyalty.test.ts", [[23, 32]]],
      ["ts-order-discount", "src/orders.test.ts", [[11, 11]]],
    ]);
  });

  test("gives every case its own id", () => {
    const ids = corpus.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("REVIEW.md holds no hint word", () => {
    expect(corpus.review).not.toMatch(HINT);
  });

  for (const evalCase of corpus.cases) {
    describe(evalCase.id, () => {
      test("holds no hint word in its id, summary or files", () => {
        const texts = [
          evalCase.id,
          evalCase.summary,
          ...[...evalCase.base, ...evalCase.change].flatMap((f) =>
            "content" in f ? [f.path, f.content] : [f.path],
          ),
        ];
        expect(texts.filter((t) => HINT.test(t))).toEqual([]);
      });

      // The one neutral commit on top of `main` is the builder's, the same for every case: build.test.ts proves it.
      // Built in `beforeAll`, which throws, failing every test, when a case doesn't build.
      test("builds, and changes what it plants at each of its places", () => {
        const { planted } = evalCase;
        if (planted === null) return;
        for (const place of placesOf(planted)) {
          expect([place.path, place.path.endsWith(EXTENSION[evalCase.language])]).toEqual([place.path, true]);
          // A range may sit on an untouched line (a callee's signature), but one at least of each place is on what
          // the change wrote: the bug is the change's, and so is every place said to name it.
          const lines = added.get(`${evalCase.id} ${place.path}`) ?? new Set<number>();
          const touching = place.ranges.filter(([start, end]) =>
            Array.from({ length: end - start + 1 }, (_, i) => start + i).some((line) => lines.has(line)),
          );
          expect([place.path, touching.length > 0]).toEqual([place.path, true]);
        }
      });
    });
  }
});
