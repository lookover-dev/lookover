import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./index.ts";

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new empty folder, removed after the test. */
function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookover-store-")));
  homes.push(dir);
  return dir;
}

test("a fresh store has every migration of the folder applied: one added or renamed needs `bun run migrations`", () => {
  const store = openStore({ home: folder(), durable: false });
  expect(store.migrated).toEqual(
    readdirSync(join(import.meta.dir, "migrations"))
      .sort()
      .map((file) => file.replace(/\.sql$/, "")),
  );
  store.close();
});

test("a file in a given migrations folder not named as a migration is refused", () => {
  const dir = folder();
  for (const file of ["20261001000000-a.sql", "notes.md"]) writeFileSync(join(dir, file), "");
  expect(() => openStore({ home: folder(), migrations: dir, durable: false })).toThrow(
    `notes.md in ${dir} is not named YYYYMMDDHHMMSS-<what>.sql`,
  );
});
