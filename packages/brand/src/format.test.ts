// Biome's formatter keeps each output on disk, as a cache: keeping it is best-effort, so a cache that can't be
// written is said and the text is still formatted. Each test, one real Biome format.
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { biomeFormatter } from "./index.ts";

let scratch: string | null = null;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** An error as Node's file calls throw it, with its `code`. */
const fsError = (code: string, call: string) => Object.assign(new Error(`${code}: ${call}`), { code });

test("a cache that can't be written is said, and the text is still formatted", async () => {
  scratch = mkdtempSync(join(tmpdir(), "lookover-brand-format-"));
  // A file where the cache's folder goes: neither the folder nor a file in it can be made.
  const cache = join(scratch, "cache");
  writeFileSync(cache, "");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // A text of its own, so no other test's output, kept in this process, answers for it.
    const name = `unwritable${Date.now()}`;
    const out = await biomeFormatter({ cache })("packages/brand/src/x.ts", `export const   ${name}=1\n`);
    expect(out).toBe(`export const ${name} = 1;\n`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`could not keep Biome's output in ${cache}`);
  } finally {
    warn.mockRestore();
  }
});

test("a rename refused and a partial copy that can't be removed (a scanner holds them) are said, and the text is still formatted", async () => {
  scratch = mkdtempSync(join(tmpdir(), "lookover-brand-format-"));
  const cache = scratch;
  const removed: string[] = [];
  const files = {
    rename: () => {
      throw fsError("EPERM", "rename");
    },
    remove: (file: string) => {
      removed.push(file);
      throw fsError("EBUSY", "unlink");
    },
  };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const name = `held${Date.now()}`;
    const out = await biomeFormatter({ cache, files })(
      "packages/brand/src/x.ts",
      `export const   ${name}=1\n`,
    );
    expect(out).toBe(`export const ${name} = 1;\n`);
    expect(removed).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0]?.[0]);
    expect(said).toContain(`could not keep Biome's output in ${cache}: EPERM: rename`);
    expect(said).toContain(`${removed[0]} stays: EBUSY: unlink`);
    // The partial copy is all there is: no output kept under its key.
    expect(readdirSync(cache).map((file) => join(cache, file))).toEqual(removed);
    expect(existsSync(removed[0] ?? "")).toBe(true);
  } finally {
    warn.mockRestore();
  }
});
