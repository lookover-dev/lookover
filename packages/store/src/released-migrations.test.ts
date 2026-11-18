// The released migrations held (ADR 0103, ADR 0104): the comparison, the choice of its source in a scratch git
// repository, and the store's own folder against the last release, which is the check itself.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkReleased,
  type MigrationHashes,
  migrationProblems,
  releasedList,
  textHash,
} from "@lookover/store/released-migrations";
import { scratchRepository } from "@lookover/testkit";

// The scratch repository's git calls: Windows starts processes slowly under `check:full`'s load, past Bun's 5 s.
setDefaultTimeout(30_000);

/** `textHash` of `text`'s bytes, for inputs only: every expected hash is one of HASH, written by hand. */
const hashOf = (text: string) => textHash(new TextEncoder().encode(text));
/** SHA-256 of LF texts, computed once outside this code (node's crypto on the UTF-8 bytes). */
const HASH = {
  /** "one\n" */
  one: "2c8b08da5ce60398e1f19af0e5dccc744df274b826abe585eaba68c525434806",
  /** "two\n" */
  two: "27dd8ed44a83ff94d557f9fd0412ed5a8cbca69ea04922d88c01184a07300a5a",
  /** "one, edited\n" */
  oneEdited: "1c5fd34175552131e040fd2086826622cd6232639eb237383462be20090198d8",
  /** "other" */
  other: "d9298a10d1b0735837dc4bd85dac641b0f3cef27a47e5d53a54f2f3f5b2fcffa",
  /** "a\nb\n" */
  ab: "911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2",
  /** DASH_TEXT with LF: "-- one — café\nselect 1;\n" */
  dash: "79842e846ff064dc2796d0b968056311ac27740680b94cff454ee28da14cdee2",
};
const RELEASE = {
  release: "v0.3.0",
  migrations: { "20260101000000-one.sql": HASH.one, "20260102000000-two.sql": HASH.two },
};

test("the comparison: a released migration edited, renamed or deleted each fails, naming the file and ADR 0103", () => {
  const problems = migrationProblems(RELEASE, {
    "20260101000000-one.sql": HASH.oneEdited,
    "20260103000000-two-again.sql": HASH.two,
  });
  expect(problems.map(({ kind, file, to }) => ({ kind, file, to }))).toEqual([
    { kind: "edited", file: "20260101000000-one.sql", to: undefined },
    { kind: "renamed", file: "20260102000000-two.sql", to: "20260103000000-two-again.sql" },
  ]);
  const deleted = migrationProblems(RELEASE, { "20260101000000-one.sql": HASH.one });
  expect(deleted.map(({ kind, file }) => ({ kind, file }))).toEqual([
    { kind: "deleted", file: "20260102000000-two.sql" },
  ]);
  for (const { file, message } of [...problems, ...deleted]) {
    expect(message).toContain(file);
    expect(message).toContain("ADR 0103");
    expect(message).toContain("v0.3.0");
  }
  expect(problems[1]?.message).toContain("20260103000000-two-again.sql");
});

test("the comparison: a new migration, and an edit to one no release carries, pass", () => {
  expect(
    migrationProblems(RELEASE, {
      "20260101000000-one.sql": HASH.one,
      "20260102000000-two.sql": HASH.two,
      "20260104000000-three.sql": HASH.other,
    }),
  ).toEqual([]);
});

test("the text hash is SHA-256 of the text with CRLF made LF, so a CRLF checkout passes", () => {
  expect(hashOf("a\r\nb\r\n")).toBe(HASH.ab);
  expect(hashOf("a\nb\n")).toBe(HASH.ab);
  expect(hashOf("a\nb\n")).toBe(new Bun.CryptoHasher("sha256").update("a\nb\n").digest("hex"));
  const lf = { release: "v0.3.0", migrations: { "20260101000000-one.sql": HASH.one } };
  expect(migrationProblems(lf, { "20260101000000-one.sql": hashOf("one\r\n") })).toEqual([]);
});

const ONE = "20260101000000-one.sql";
const TWO = "20260102000000-two.sql";
/** Released with ONE and listed before it, so its bytes set where ONE's start: multi-byte text, with CRLF. */
const DASH = "20260100000000-dash.sql";
const DASH_TEXT = "-- one — café\r\nselect 1;\r\n";

/** A fast-import stream's text of `text`: its byte length, then the bytes. */
const data = (text: string) => `data ${new TextEncoder().encode(text).length}\n${text}\n`;
const WHO = "Test <test@example.com> 1767225600 +0000";
/**
 * The scratch repository's history: `main` is the commit of ONE (with CRLF) and DASH, tagged `v0.1.0` (annotated,
 * and the head of `at-tag`), then the commit of TWO, tagged `v0.2.0-rc.1` and `v9`, which are no plain version.
 * `v5.0.0` is on a side branch `main` never merged.
 */
const HISTORY = [
  `blob\nmark :1\n${data("one\r\n")}`,
  `blob\nmark :2\n${data("two\n")}`,
  `blob\nmark :3\n${data(DASH_TEXT)}`,
  `commit refs/heads/main\nmark :10\ncommitter ${WHO}\n${data("one")}M 100644 :1 src/migrations/${ONE}\nM 100644 :3 src/migrations/${DASH}\n\n`,
  `tag v0.1.0\nfrom :10\ntagger ${WHO}\n${data("release")}`,
  "reset refs/heads/at-tag\nfrom :10\n\n",
  `commit refs/heads/side\nmark :12\ncommitter ${WHO}\n${data("side")}from :10\nM 100644 :2 src/migrations/20260109000000-side.sql\n\n`,
  "reset refs/tags/v5.0.0\nfrom :12\n\n",
  `commit refs/heads/main\nmark :11\ncommitter ${WHO}\n${data("two")}from :10\nM 100644 :2 src/migrations/${TWO}\n\n`,
  "reset refs/tags/v0.2.0-rc.1\nfrom :11\n\n",
  "reset refs/tags/v9\nfrom :11\n\n",
].join("");

/** Runs git in `cwd` with no `GIT_*` from this process, so never on this repository. */
function git(cwd: string, args: string[], input = ""): void {
  const done = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { LC_ALL: "C" },
    stdin: new TextEncoder().encode(input),
    stderr: "pipe",
  });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${done.stderr.toString()}`);
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A new folder with a store's layout: `src/migrations/` and the list's path beside it. */
function storeFolder(within = tmpdir()) {
  const root = realpathSync(mkdtempSync(join(within, "lookover-released-")));
  scratch.push(root);
  const folder = join(root, "src", "migrations");
  mkdirSync(folder, { recursive: true });
  return { root, folder, list: join(root, "src", "released-migrations.json") };
}

/** `files` (name to text) as the folder's only migrations. */
function tree(folder: string, files: Record<string, string>): void {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text);
}

/** A list's text, for the fixtures; the writer's is spelled out where it is checked. */
const listText = (release: string, migrations: MigrationHashes) =>
  `${JSON.stringify({ release, migrations }, null, 2)}\n`;

let repo: ReturnType<typeof storeFolder>;
beforeAll(() => {
  repo = storeFolder();
  scratchRepository(repo.root);
  git(repo.root, ["fast-import", "--quiet"], HISTORY);
});

test("the tag: the writer writes the newest plain tag's list, whatever the tree; an edit after the tag fails", () => {
  tree(repo.folder, { [DASH]: DASH_TEXT, [ONE]: "one, edited\n", [TWO]: "two\n" });
  const written = releasedList({ folder: repo.folder });
  expect(written).toEqual({
    release: "v0.1.0",
    text: `{
  "release": "v0.1.0",
  "migrations": {
    "20260100000000-dash.sql": "${HASH.dash}",
    "20260101000000-one.sql": "${HASH.one}"
  }
}
`,
  });
  writeFileSync(repo.list, written.text);
  const edited = checkReleased({ folder: repo.folder, list: repo.list });
  expect(edited.source).toMatchObject({ from: "tag", release: "v0.1.0" });
  expect(edited.problems.map(({ kind, file }) => ({ kind, file }))).toEqual([{ kind: "edited", file: ONE }]);
  tree(repo.folder, { [DASH]: DASH_TEXT.replaceAll("\r\n", "\n"), [ONE]: "one\n", [TWO]: "two, edited\n" });
  expect(checkReleased({ folder: repo.folder, list: repo.list }).problems).toEqual([]);
  tree(repo.folder, { [DASH]: DASH_TEXT.replace("—", "-"), [ONE]: "one\n" });
  const dash = checkReleased({ folder: repo.folder, list: repo.list }).problems;
  expect(dash.map(({ kind, file }) => ({ kind, file }))).toEqual([{ kind: "edited", file: DASH }]);
});

test("the tag: a list behind it, or none, fails asking for `bun run migrations --released`", () => {
  tree(repo.folder, { [ONE]: "one\n" });
  for (const behind of [listText("v0.0.9", { [ONE]: HASH.one }), listText("v0.1.0", { [ONE]: HASH.other })]) {
    writeFileSync(repo.list, behind);
    expect(() => checkReleased({ folder: repo.folder, list: repo.list })).toThrow(
      "bun run migrations --released",
    );
  }
  expect(() => checkReleased({ folder: repo.folder, list: repo.list })).toThrow(
    `released-migrations.json's hashes differ from its tag v0.1.0's, first at ${DASH}`,
  );
  rmSync(repo.list);
  expect(() => checkReleased({ folder: repo.folder, list: repo.list })).toThrow(
    "bun run migrations --released",
  );
});

test("at the tag's own commit the list, the release before's, is the source; one newer than the tag, or none, fails", () => {
  git(repo.root, ["symbolic-ref", "HEAD", "refs/heads/at-tag"]);
  try {
    writeFileSync(repo.list, listText("v0.0.9", { [ONE]: HASH.one }));
    tree(repo.folder, { [DASH]: DASH_TEXT, [ONE]: "one\n" });
    const at = checkReleased({ folder: repo.folder, list: repo.list });
    expect(at).toMatchObject({ source: { from: "list", release: "v0.0.9" }, problems: [] });
    expect(at.source.says).toContain("v0.1.0");
    writeFileSync(repo.list, listText("v0.2.0", { [ONE]: HASH.one }));
    expect(() => checkReleased({ folder: repo.folder, list: repo.list })).toThrow("newer");
    rmSync(repo.list);
    expect(() => checkReleased({ folder: repo.folder, list: repo.list })).toThrow(
      "bun run migrations --released",
    );
  } finally {
    git(repo.root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
});

test("at the tag's own commit the tag is a source too: an uncommitted edit to a migration it brought fails", () => {
  git(repo.root, ["symbolic-ref", "HEAD", "refs/heads/at-tag"]);
  try {
    writeFileSync(repo.list, listText("v0.0.9", { [ONE]: HASH.one }));
    tree(repo.folder, { [DASH]: DASH_TEXT.replace("—", "-"), [ONE]: "one\n" });
    const at = checkReleased({ folder: repo.folder, list: repo.list });
    expect(at.source.says).toContain("its tag v0.1.0");
    expect(at.problems.map(({ kind, file }) => ({ kind, file }))).toEqual([{ kind: "edited", file: DASH }]);
    expect(at.problems[0]?.message).toContain("v0.1.0");
    tree(repo.folder, { [DASH]: DASH_TEXT, [ONE]: "one, edited\n" });
    const both = checkReleased({ folder: repo.folder, list: repo.list }).problems;
    expect(both.map(({ kind, file }) => ({ kind, file }))).toEqual([{ kind: "edited", file: ONE }]);
    expect(both[0]?.message).toContain(`${ONE}, which v0.1.0 and v0.0.9 carry, was edited`);
  } finally {
    git(repo.root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
});

test("a list newer than the reachable tag is a source beside the tag", () => {
  writeFileSync(repo.list, listText("v0.9.0", { [DASH]: HASH.dash, [ONE]: HASH.one, [TWO]: HASH.two }));
  tree(repo.folder, { [DASH]: DASH_TEXT, [ONE]: "one\n", [TWO]: "two, edited\n" });
  const newer = checkReleased({ folder: repo.folder, list: repo.list });
  expect(newer.source).toMatchObject({ from: "list", release: "v0.9.0" });
  expect(newer.source.says).toContain("newer than v0.1.0");
  expect(newer.problems.map(({ kind, file }) => ({ kind, file }))).toEqual([{ kind: "edited", file: TWO }]);
});

test("a list newer than the reachable tag still holds the tag's migrations: one edited, its hash listed anew, fails", () => {
  writeFileSync(repo.list, listText("v0.9.0", { [DASH]: HASH.dash, [ONE]: HASH.oneEdited, [TWO]: HASH.two }));
  tree(repo.folder, { [DASH]: DASH_TEXT, [ONE]: "one, edited\n", [TWO]: "two\n" });
  const both = checkReleased({ folder: repo.folder, list: repo.list });
  expect(both.source.says).toContain("v0.1.0");
  expect(both.source.says).toContain("v0.9.0");
  expect(both.problems.map(({ kind, file }) => ({ kind, file }))).toEqual([{ kind: "edited", file: ONE }]);
  expect(both.problems[0]?.message).toContain("ADR 0103");
  expect(both.problems[0]?.message).toContain("v0.1.0");
});

test("no tag: the list is the source and says why; neither fails; a malformed list fails naming the file", () => {
  // Inside another repository, as on a machine whose home or TMP is in one: git's search stops at its parent.
  const outer = storeFolder();
  scratchRepository(outer.root);
  const plain = { ...storeFolder(outer.root), ceiling: outer.root };
  tree(plain.folder, { [ONE]: "one, edited\n" });
  expect(() => checkReleased(plain)).toThrow("neither");
  expect(() => releasedList(plain)).toThrow("no vX.Y.Z tag");
  writeFileSync(plain.list, listText("v0.1.0", { [ONE]: HASH.one }));
  const outside = checkReleased(plain);
  expect(outside.source).toMatchObject({ from: "list", release: "v0.1.0" });
  expect(outside.source.says).toContain("not a git repository");
  expect(outside.problems.map(({ kind }) => kind)).toEqual(["edited"]);
  const noGit = checkReleased({ ...plain, git: join(plain.root, "no-such-git") });
  expect(noGit.source.says).toContain("git can't be started");
  writeFileSync(plain.list, '{ "release": "0.1" }\n');
  expect(() => checkReleased(plain)).toThrow(plain.list);
});

test("git runs in the caller's environment, every GIT_* dropped and LC_ALL=C, when no env is given", () => {
  const caller = storeFolder();
  writeFileSync(caller.list, listText("v0.1.0", { [ONE]: HASH.one }));
  tree(caller.folder, { [ONE]: "one\n" });
  // A git that writes the environment it got beside itself, then says there is no repository.
  const windows = process.platform === "win32";
  const fake = join(caller.root, windows ? "git.cmd" : "git.sh");
  writeFileSync(
    fake,
    windows
      ? '@echo off\r\nset > "%~dp0env.txt"\r\necho fatal: not a git repository 1>&2\r\nexit /b 128\r\n'
      : '#!/bin/sh\nenv > "$(dirname "$0")/env.txt"\necho "fatal: not a git repository" >&2\nexit 128\n',
  );
  if (!windows) chmodSync(fake, 0o755);
  const entry = Bun.fileURLToPath(import.meta.resolve("@lookover/store/released-migrations"));
  const script = join(caller.root, "caller.ts");
  writeFileSync(
    script,
    `import { checkReleased } from ${JSON.stringify(entry)};
console.log(checkReleased(${JSON.stringify({ folder: caller.folder, list: caller.list, git: fake })}).source.says);
`,
  );
  const done = Bun.spawnSync([process.execPath, script], {
    cwd: caller.root,
    env: {
      MARK: "kept",
      HOME: caller.root,
      USERPROFILE: caller.root,
      GIT_DIR: join(caller.root, "elsewhere"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ code: done.exitCode, err: done.stderr.toString() }).toEqual({ code: 0, err: "" });
  expect(done.stdout.toString()).toContain("not a git repository");
  const seen = new Map(
    readFileSync(join(caller.root, "env.txt"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")).toUpperCase(), line.slice(line.indexOf("=") + 1)]),
  );
  expect([seen.get("MARK"), seen.get("HOME"), seen.get("LC_ALL")]).toEqual(["kept", caller.root, "C"]);
  expect([...seen.keys()].filter((key) => key.startsWith("GIT_"))).toEqual([]);
});

// The check itself: the store's own migrations against the last release, from the source the test's name says
// (its tag where git has it, the list on CI's tagless checkout). Read as the file loads, so the name can say it.
const STORE = {
  folder: join(import.meta.dir, "migrations"),
  list: join(import.meta.dir, "released-migrations.json"),
};
const real = (() => {
  try {
    return checkReleased(STORE);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
})();

test(`the store's migrations keep what the last release carries, against ${real instanceof Error ? "no source it could read" : real.source.says}`, () => {
  if (real instanceof Error) throw real;
  expect(real.problems.map(({ message }) => message)).toEqual([]);
});
