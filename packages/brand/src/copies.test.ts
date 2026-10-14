// The copies `bun run brand` writes, through the package's entry: every copy on disk is what the source renders
// (line endings aside, for a clone that checks files out with CRLF), the check names a drifted copy, and the copies
// under `docs/` are left alone where `docs/` is absent (the public tree).
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
import { COPIES, driftedCopies, writeCopies } from "./index.ts";

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

test("every copy in this checkout is what the source draws", () => {
  expect(driftedCopies()).toEqual([]);
});

test("the copies are the eleven brand files, the app's favicon, module and stylesheet, the sheet, and the site's three", () => {
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
    "docs/product/brand/sheet.html",
    "apps/site/public/favicon.svg",
    "apps/site/src/brand/eyes.generated.ts",
    "apps/site/src/brand/eyes.generated.css",
  ]);
});

test("a copy changed by one number fails, naming that file", () => {
  const root = checkout(true);
  writeCopies(root);
  expect(driftedCopies(root)).toEqual([]);
  const icon = join(root, "docs/product/brand/lookover-icon.svg");
  writeFileSync(icon, readFileSync(icon, "utf8").replace('rx="14.4"', 'rx="14.5"'));
  expect(driftedCopies(root)).toEqual([
    `docs/product/brand/lookover-icon.svg is not what the source draws: ${run}.`,
  ]);
});

test("a missing copy fails, naming that file", () => {
  const root = checkout(true);
  writeCopies(root);
  rmSync(join(root, "apps/web/public/favicon.svg"));
  expect(driftedCopies(root)).toEqual([`apps/web/public/favicon.svg is missing: ${run}.`]);
});

test("a copy checked out with CRLF line endings is the same copy", () => {
  const root = checkout(true);
  writeCopies(root);
  const mark = join(root, "docs/product/brand/lookover-wordmark.svg");
  writeFileSync(mark, readFileSync(mark, "utf8").replaceAll("\n", "\r\n"));
  expect(driftedCopies(root)).toEqual([]);
});

test("without docs/, the copies under it are neither written nor checked", () => {
  const root = checkout(false);
  writeCopies(root);
  expect(existsSync(join(root, "docs"))).toBe(false);
  expect(existsSync(join(root, "apps/web/public/favicon.svg"))).toBe(true);
  expect(driftedCopies(root)).toEqual([]);
});
