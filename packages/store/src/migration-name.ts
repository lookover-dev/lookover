// `@lookover/store/migration-name`, for `bun run migrations` (scripts/migrations.ts), which generates the store's
// embedded list from its folder: how a migration's file is named (ADR 0032), the one rule the store and the
// generator share. It imports nothing, so the generator reads it while the embedded list it replaces is stale.

/** A migration's file name, `YYYYMMDDHHMMSS-<what>.sql`; its first group is the migration's name. */
export const MIGRATION_FILE = /^(\d{14}-[a-z0-9-]+)\.sql$/;
