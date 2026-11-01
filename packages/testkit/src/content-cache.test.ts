// `cachedByContent`: what a test builds from some content (a compiled program, a repository), built once per content
// and kept outside the run, so the next run reads it instead of building it again (ADR 0071).
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedByContent } from "./index.ts";

const root = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-cache-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A build that writes `content` into its folder, counting its runs. */
function counting() {
  const runs: string[] = [];
  return {
    runs,
    build: (folder: string, content: string) => {
      runs.push(content);
      writeFileSync(join(folder, "made.txt"), content);
    },
  };
}

test("a content is built once: the next ask gets the same folder, built, without building again", async () => {
  const { runs, build } = counting();
  const ask = () =>
    cachedByContent({ name: "once", content: "alpha", root }, (folder) => build(folder, "alpha"));
  const first = await ask();
  expect(readFileSync(join(first, "made.txt"), "utf8")).toBe("alpha");
  expect(await ask()).toBe(first);
  expect(runs).toEqual(["alpha"]);
  // Kept under the cache's root, by its name.
  expect(first.startsWith(join(root, "once"))).toBe(true);
});

test("another content is another folder, built once too", async () => {
  const { runs, build } = counting();
  const of = (content: string) =>
    cachedByContent({ name: "two", content, root }, (folder) => build(folder, content));
  const a = await of("a");
  const b = await of("b");
  expect(a).not.toBe(b);
  expect(readFileSync(join(b, "made.txt"), "utf8")).toBe("b");
  expect(await of("a")).toBe(a);
  expect(runs).toEqual(["a", "b"]);
});

test("a build that fails leaves nothing behind: the next ask builds again", async () => {
  await expect(
    cachedByContent({ name: "failing", content: "x", root }, (folder) => {
      writeFileSync(join(folder, "half.txt"), "half");
      throw new Error("the compiler crashed");
    }),
  ).rejects.toThrow("the compiler crashed");
  expect(existsSync(join(root, "failing")) ? readdirSync(join(root, "failing")) : []).toEqual([]);
  const { runs, build } = counting();
  const made = await cachedByContent({ name: "failing", content: "x", root }, (folder) => build(folder, "x"));
  expect(readdirSync(made)).toEqual(["made.txt"]);
  expect(runs).toEqual(["x"]);
});

test("two builds of one content at once, as two test workers may start them: both get the one folder, whole", async () => {
  const { build } = counting();
  const slow = async (folder: string) => {
    await Bun.sleep(20);
    build(folder, "same");
  };
  const [a, b] = await Promise.all([
    cachedByContent({ name: "race", content: "same", root }, slow),
    cachedByContent({ name: "race", content: "same", root }, slow),
  ]);
  expect(a).toBe(b);
  expect(readFileSync(join(a ?? "", "made.txt"), "utf8")).toBe("same");
  expect(readdirSync(join(root, "race"))).toHaveLength(1);
});

/** A rename that fails as Windows does while Defender scans a new file (`code`), `times` times, then renames. */
function heldFor(times: number, code: string) {
  const tries: string[] = [];
  return {
    tries,
    rename: (from: string, to: string) => {
      tries.push(code);
      if (tries.length <= times)
        throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
      renameSync(from, to);
    },
  };
}

test("a rename held by another program for a moment is tried again: the build is put in place, built once", async () => {
  const { runs, build } = counting();
  const held = heldFor(2, "EPERM");
  const made = await cachedByContent({ name: "held", content: "h", root, rename: held.rename }, (folder) =>
    build(folder, "h"),
  );
  expect(readFileSync(join(made, "made.txt"), "utf8")).toBe("h");
  expect(held.tries).toHaveLength(3);
  expect(runs).toEqual(["h"]);
  expect(readdirSync(join(root, "held"))).toHaveLength(1);
});

test("a rename still held after a few tries fails, leaving nothing; another error fails at once", async () => {
  const busy = heldFor(Number.POSITIVE_INFINITY, "EBUSY");
  await expect(
    cachedByContent({ name: "stuck", content: "s", root, rename: busy.rename }, () => {}),
  ).rejects.toThrow("EBUSY");
  expect(busy.tries.length).toBeGreaterThan(1);
  expect(readdirSync(join(root, "stuck"))).toEqual([]);
  const missing = heldFor(Number.POSITIVE_INFINITY, "ENOENT");
  await expect(
    cachedByContent({ name: "stuck", content: "s", root, rename: missing.rename }, () => {}),
  ).rejects.toThrow("ENOENT");
  expect(missing.tries).toHaveLength(1);
  expect(readdirSync(join(root, "stuck"))).toEqual([]);
});
