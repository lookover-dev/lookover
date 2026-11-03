// The copies `bun run brand` writes, through the package's entry: every copy on disk is what the source renders
// (line endings aside, for a clone that checks files out with CRLF), the check names a drifted copy, and the copies
// under `docs/` are left alone where `docs/` is absent (the public tree). Only the check of this checkout's copies
// runs Biome; the drift logic is checked with a formatter in the test's own process.
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asWritten } from "./brand.test-support.ts";
import { COPIES, driftedCopies, type Formatter, writeCopies } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new empty folder standing for a checkout, removed after the test. */
function checkout(withDocs: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookover-brand-")));
  dirs.push(dir);
  if (withDocs) mkdirSync(join(dir, "docs"));
  return dir;
}

const run = "run `bun run brand`";
const format = asWritten;

// One test per copy: each starts Biome at most once (the four it formats), never four in one test's time.
test.each(COPIES.map((c) => [c.path, c] as const))(
  "the copy %s in this checkout is what the source draws, as Biome formats it",
  async (_path, copy) => {
    expect(await driftedCopies(undefined, { copies: [copy] })).toEqual([]);
  },
);

test("the copies are the eleven brand files, the app's favicon, module, stylesheet and two wordmarks, the sheet, and the site's five", () => {
  expect(COPIES.map((c) => c.path)).toEqual([
    "docs/product/brand/lookover-wordmark.svg",
    "docs/product/brand/lookover-wordmark-on-dark.svg",
    "docs/product/brand/lookover-wordmark-mono.svg",
    "docs/product/brand/lookover-wordmark-mono-white.svg",
    "docs/product/brand/lookover-icon.svg",
    "docs/product/brand/lookover-icon-paper.svg",
    "docs/product/brand/lookover-icon-accent.svg",
    "docs/product/brand/lookover-icon-mono.svg",
    "docs/product/brand/lookover-mark.svg",
    "docs/product/brand/lookover-mark-on-dark.svg",
    "docs/product/brand/lookover-favicon.svg",
    "apps/web/public/favicon.svg",
    "apps/web/src/ui/eyes.generated.ts",
    "apps/web/src/styles/system.css",
    "apps/web/public/brand/lookover-wordmark.svg",
    "apps/web/public/brand/lookover-wordmark-on-dark.svg",
    "docs/product/brand/sheet.html",
    "apps/site/public/favicon.svg",
    "apps/site/public/brand/lookover-wordmark.svg",
    "apps/site/public/brand/lookover-wordmark-on-dark.svg",
    "apps/site/src/brand/eyes.generated.ts",
    "apps/site/src/brand/eyes.generated.css",
  ]);
});

test("the four copies Biome formats go through the formatter given, written and checked alike", async () => {
  const root = checkout(false);
  // Idempotent as Biome is: the stylesheet keeps its rest, the mark included, so the mark is not added twice.
  const marked: Formatter = async (path, text) => {
    const mark = `/* formatted as ${path} */\n`;
    return text.endsWith(mark) ? text : `${text}${mark}`;
  };
  await writeCopies(root, { format: marked });
  const formatted = [
    "apps/web/src/ui/eyes.generated.ts",
    "apps/web/src/styles/system.css",
    "apps/site/src/brand/eyes.generated.ts",
    "apps/site/src/brand/eyes.generated.css",
  ];
  for (const path of formatted) {
    expect(readFileSync(join(root, path), "utf8")).toEndWith(`/* formatted as ${path} */\n`);
  }
  expect(readFileSync(join(root, "apps/web/public/favicon.svg"), "utf8")).not.toContain("formatted as");
  expect(await driftedCopies(root, { format: marked })).toEqual([]);
  // A copy formatted otherwise than the check formats the source is not what the source draws (the stylesheet
  // keeps what follows its region as written by hand, the mark with it).
  expect(await driftedCopies(root, { format })).toEqual([
    `apps/web/src/ui/eyes.generated.ts is not what the source draws: ${run}.`,
    `apps/site/src/brand/eyes.generated.ts is not what the source draws: ${run}.`,
    `apps/site/src/brand/eyes.generated.css is not what the source draws: ${run}.`,
  ]);
});

test("a copy changed by one number fails, naming that file", async () => {
  const root = checkout(true);
  await writeCopies(root, { format });
  expect(await driftedCopies(root, { format })).toEqual([]);
  const icon = join(root, "docs/product/brand/lookover-icon.svg");
  writeFileSync(icon, readFileSync(icon, "utf8").replace('rx="14.4"', 'rx="14.5"'));
  expect(await driftedCopies(root, { format })).toEqual([
    `docs/product/brand/lookover-icon.svg is not what the source draws: ${run}.`,
  ]);
});

test("a missing copy fails, naming that file", async () => {
  const root = checkout(true);
  await writeCopies(root, { format });
  rmSync(join(root, "apps/web/public/favicon.svg"));
  expect(await driftedCopies(root, { format })).toEqual([`apps/web/public/favicon.svg is missing: ${run}.`]);
});

test("a copy checked out with CRLF line endings is the same copy", async () => {
  const root = checkout(true);
  await writeCopies(root, { format });
  const mark = join(root, "docs/product/brand/lookover-wordmark.svg");
  writeFileSync(mark, readFileSync(mark, "utf8").replaceAll("\n", "\r\n"));
  expect(await driftedCopies(root, { format })).toEqual([]);
});

test("without docs/, the copies under it are neither written nor checked", async () => {
  const root = checkout(false);
  await writeCopies(root, { format });
  expect(existsSync(join(root, "docs"))).toBe(false);
  expect(existsSync(join(root, "apps/web/public/favicon.svg"))).toBe(true);
  expect(await driftedCopies(root, { format })).toEqual([]);
});
