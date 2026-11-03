import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeId } from "@lookover/contracts";
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

test("one way in (ADR 0073): a setup left waiting for an App is back at the GitHub step's start", () => {
  const all = join(import.meta.dir, "migrations");
  const before = folder();
  for (const file of readdirSync(all).sort()) {
    if (file >= "20261102090000-one-way-in.sql") break;
    copyFileSync(join(all, file), join(before, file));
  }
  const home = folder();
  const old = openStore({ home, migrations: before, durable: false });
  old.close();
  const db = new Database(join(home, "lookover.sqlite"), { strict: true });
  db.run(
    "INSERT INTO setup (id, done, step, reached, github, github_refused, first_review_change) VALUES (1, 0, 'github', 'github', 'waiting-for-app', 'expired', NULL)",
  );
  db.close();
  const store = openStore({ home, migrations: all, durable: false });
  expect(store.migrated[0]).toBe("20261102090000-one-way-in");
  expect(store.setup.read()).toMatchObject({ step: "github", reached: "github", github: "start" });
  store.close();
});

test("the status block (ADR 0074): a round's or a dismissal's summary post, owed or sent, is its status post", () => {
  const all = join(import.meta.dir, "migrations");
  const before = folder();
  for (const file of readdirSync(all).sort()) {
    if (file >= "20261103090000-status-posts.sql") break;
    copyFileSync(join(all, file), join(before, file));
  }
  const home = folder();
  openStore({ home, migrations: before, durable: false }).close();
  const path = join(home, "lookover.sqlite");
  const db = new Database(path, { strict: true });
  db.run("INSERT INTO posts (run_id, seq, kind, host_id, tries) VALUES ('r1', 0, 'summary', '9001', 1)");
  db.run("INSERT INTO posts (run_id, seq, kind, host_id, tries) VALUES ('r1', 1, 'completed', NULL, 0)");
  db.run(
    "INSERT INTO dismissals (id, change_id, finding_id, run_id, check_id, at) VALUES ('d1', 'o/r#1', 'F1', 'r1', NULL, 0)",
  );
  db.run(
    "INSERT INTO dismissal_posts (dismissal_id, seq, kind, host_id, tries) VALUES ('d1', 0, 'reply', '7', 1)",
  );
  db.run(
    "INSERT INTO dismissal_posts (dismissal_id, seq, kind, host_id, tries) VALUES ('d1', 1, 'summary', NULL, 0)",
  );
  db.close();
  const store = openStore({ home, migrations: all, durable: false });
  expect(store.migrated[0]).toBe("20261103090000-status-posts");
  store.close();
  const after = new Database(path, { strict: true });
  expect(after.query("SELECT kind, host_id, tries FROM posts ORDER BY seq").all()).toEqual([
    { kind: "status", host_id: "9001", tries: 1 },
    { kind: "completed", host_id: null, tries: 0 },
  ]);
  expect(after.query("SELECT kind, host_id FROM dismissal_posts ORDER BY seq").all()).toEqual([
    { kind: "reply", host_id: "7" },
    { kind: "status", host_id: null },
  ]);
  expect(() =>
    after.run(
      "INSERT INTO dismissal_posts (dismissal_id, seq, kind, host_id, tries) VALUES ('d1', 2, 'summary', NULL, 0)",
    ),
  ).toThrow();
  after.close();
});

test("a finding's suggestion (ADR 0074): a finding stored before it reads back with none, one with it keeps it", () => {
  const all = join(import.meta.dir, "migrations");
  const before = folder();
  for (const file of readdirSync(all).sort()) {
    if (file >= "20261103100000-findings-suggestion.sql") break;
    copyFileSync(join(all, file), join(before, file));
  }
  const home = folder();
  openStore({ home, migrations: before, durable: false }).close();
  const path = join(home, "lookover.sqlite");
  const db = new Database(path, { strict: true });
  const old = { id: "F1", title: "Old" };
  const offered = { id: "F2", title: "New", suggestion: "return 1;" };
  const ledger = JSON.stringify([old, offered]);
  db.run("INSERT INTO rounds (change_id, n, sha, findings, posted_at) VALUES ('o/r#1', 1, 'abc', ?, 0)", [
    ledger,
  ]);
  const plan = { post: { round: 1, reconciled: { findings: [old, offered], raised: [old], post: [] } } };
  db.run("INSERT INTO plans (run_id, change_id, n, plan, ledger) VALUES ('r1', 'o/r#1', 1, ?, ?)", [
    JSON.stringify(plan),
    ledger,
  ]);
  db.close();
  const store = openStore({ home, migrations: all, durable: false });
  expect(store.migrated).toEqual(["20261103100000-findings-suggestion"]);
  const both = [
    { ...old, suggestion: null },
    { ...offered, suggestion: "return 1;" },
  ];
  expect(store.rounds.ledger(changeId("o/r#1"))).toEqual(JSON.parse(JSON.stringify(both)));
  store.close();
  const after = new Database(path, { strict: true });
  const row = after.query<{ plan: string; ledger: string }, []>("SELECT plan, ledger FROM plans").get();
  expect(JSON.parse(row?.ledger ?? "null")).toEqual(both);
  expect(JSON.parse(row?.plan ?? "null")).toEqual({
    post: { round: 1, reconciled: { findings: both, raised: [{ ...old, suggestion: null }], post: [] } },
  });
  after.close();
});

test("a file in a given migrations folder not named as a migration is refused", () => {
  const dir = folder();
  for (const file of ["20261001000000-a.sql", "notes.md"]) writeFileSync(join(dir, file), "");
  expect(() => openStore({ home: folder(), migrations: dir, durable: false })).toThrow(
    `notes.md in ${dir} is not named YYYYMMDDHHMMSS-<what>.sql`,
  );
});
