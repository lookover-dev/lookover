// `waitUntil`, the one deadline loop of the tests, and `templateFolder`, a folder made once and copied per test.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateFolder, waitUntil } from "./index.ts";

test("a wait that is done at once looks once and says so", async () => {
  let looks = 0;
  expect(
    await waitUntil(() => {
      looks++;
      return true;
    }, 1_000),
  ).toBe(true);
  expect(looks).toBe(1);
});

test("a wait looks again until done, an async look as well", async () => {
  let looks = 0;
  expect(await waitUntil(async () => ++looks === 3, 5_000, 1)).toBe(true);
  expect(looks).toBe(3);
});

test("a wait never done says so once its time ran out", async () => {
  const started = Date.now();
  expect(await waitUntil(() => false, 50, 5)).toBe(false);
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);
});

test("a look that throws ends the wait with its error", async () => {
  await expect(
    waitUntil(() => {
      throw new Error("unreadable");
    }, 1_000),
  ).rejects.toThrow("unreadable");
});

const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-template-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("a template folder is made once, each copy its own, and removed when asked", () => {
  let made = 0;
  let where = "";
  const template = templateFolder("lookover-template-", (folder) => {
    made++;
    where = folder;
    writeFileSync(join(folder, "store"), "migrated");
  });
  const first = mkdtempSync(join(scratch, "a-"));
  const second = mkdtempSync(join(scratch, "b-"));
  template.copy(first);
  template.copy(second);
  writeFileSync(join(first, "store"), "changed");
  expect(made).toBe(1);
  expect(readFileSync(join(second, "store"), "utf8")).toBe("migrated");
  template.remove();
  expect(existsSync(where)).toBe(false);
});
