// The schema, as forward-only migrations: one SQL file each in `src/migrations/`, named by timestamp (ADR 0032),
// `YYYYMMDDHHMMSS-<what>.sql`, so two branches adding a table never edit the same file nor both create
// "migration 12". Each runs once, in name order, inside its own transaction, and is recorded in `migrations`.
// There is no downgrade before 1.0: reset the data folder instead (AGENTS.md rule 10).
// The store runs the embedded list, `embedded-migrations.ts`, which `bun run migrations` (scripts/migrations.ts)
// generates from the folder; a test may give a folder instead, read from the disk.
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EMBEDDED } from "./embedded-migrations.ts";
import { MIGRATION_FILE as NAME } from "./migration-name.ts";

interface Migration {
  name: string;
  sql: string;
}

/** Every migration in `folder`, in name order, read from the disk. A file not named as one is a programming error. */
function migrationsIn(folder: string): Migration[] {
  return readdirSync(folder)
    .sort()
    .map((file) => {
      const name = NAME.exec(file)?.[1];
      if (name === undefined) throw new Error(`${file} in ${folder} is not named YYYYMMDDHHMMSS-<what>.sql`);
      return { name, sql: readFileSync(join(folder, file), "utf8") };
    });
}
const applied = z.array(z.object({ name: z.string() }));

/**
 * Applies the migrations the database lacks, in name order: those of `folder` when a test gives one, the
 * embedded list otherwise. Returns their names.
 */
export function migrate(db: Database, folder: string | undefined): string[] {
  const migrations = folder === undefined ? EMBEDDED : migrationsIn(folder);
  db.run("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)");
  const done = new Set(applied.parse(db.query("SELECT name FROM migrations").all()).map((r) => r.name));
  const known = new Set(migrations.map((m) => m.name));
  for (const name of done) {
    if (!known.has(name)) {
      throw new Error(
        `The database holds migration ${name}, which this Lookover doesn't know. Reset the data folder.`,
      );
    }
  }
  const names: string[] = [];
  // `query`, not `prepare`: a prepared statement left unfinalized keeps the file busy after `close` on Windows.
  const record = db.query("INSERT INTO migrations (name) VALUES (?)");
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    db.transaction(() => {
      db.run(m.sql);
      record.run(m.name);
    })();
    names.push(m.name);
  }
  return names;
}
