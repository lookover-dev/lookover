// `bun run migrations` through what it writes: the store's embedded list matches its folder byte for byte (line
// endings aside, for a clone that checks files out with CRLF), and the module is as Biome formats it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDED_MIGRATIONS, migrationsModule } from "./migrations.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new folder holding `files`, empty, removed after the test. */
function folderOf(files: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lookover-migrations-")));
  dirs.push(dir);
  for (const file of files) writeFileSync(join(dir, file), "");
  return dir;
}

const lf = (text: string) => text.replaceAll("\r\n", "\n");

test("the store's embedded list is what `bun run migrations` writes from its folder", () => {
  expect(lf(readFileSync(EMBEDDED_MIGRATIONS, "utf8"))).toBe(lf(migrationsModule()));
});

test("the module imports each migration as text and lists them in name order", () => {
  const module = migrationsModule(folderOf(["20261002000000-b.sql", "20261001000000-a.sql"]));
  expect(module).toContain(
    'import m0 from "./migrations/20261001000000-a.sql" with { type: "text" };\nimport m1 from "./migrations/20261002000000-b.sql" with { type: "text" };',
  );
  expect(module).toContain(
    '  { name: "20261001000000-a", sql: m0 },\n  { name: "20261002000000-b", sql: m1 },',
  );
});

test("a name too long for one line is wrapped as Biome wraps it", () => {
  const name =
    "20261001000000-a-migration-whose-name-is-far-too-long-to-fit-on-one-line-of-the-embedded-list-module";
  const module = migrationsModule(folderOf([`${name}.sql`]));
  expect(module).toContain(`import m0 from "./migrations/${name}.sql" with {\n  type: "text",\n};\n`);
  expect(module).toContain(`  {\n    name: "${name}",\n    sql: m0,\n  },\n`);
});

test("a file in the folder not named as a migration is refused", () => {
  const dir = folderOf(["20261001000000-a.sql", "notes.md"]);
  expect(() => migrationsModule(dir)).toThrow(`notes.md in ${dir} is not named YYYYMMDDHHMMSS-<what>.sql`);
});
