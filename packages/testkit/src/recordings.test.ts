// The committed engine recordings hold no trace of the machine they were recorded on: no user folder, no user
// name, in any spelling. `scripts/record-claude.ts` and `record-codex.ts` scrub them; a scrub once stopped at the space in a user
// name, leaving its second word behind, and a review missed it. This test reads every recording file, and it is the
// one place that scans every committed eval answer: every file of the runs kept in `apps/evals` (the real run in
// `recorded/`, once there, and the hand-made one in `fixtures/replay/recorded/`).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";

/** The fakes' folder: each fake's recordings are under `<fake>/recordings`. */
const FAKES = resolve(import.meta.dir, "..");

/**
 * The eval runs' stored answers (ADR 0050): the committed run behind the report, once there is one, and the
 * hand-made run its replay test reads. Real engines' answers, kept beside the cases, scrubbed like the fakes'.
 */
const EVALS = resolve(import.meta.dir, "..", "..", "..", "apps", "evals");
const EVAL_RUNS = [join(EVALS, "recorded"), join(EVALS, "fixtures", "replay", "recorded")];

/** Every file of every fake's recordings, and of every eval run stored in the repository. */
const recordingFiles = () =>
  [
    ...["fake-claude", "fake-codex"].map((fake) => join(FAKES, fake, "recordings")),
    ...EVAL_RUNS.filter((folder) => existsSync(folder)),
  ].flatMap((folder) =>
    readdirSync(folder, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()),
  );
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every spelling of this machine's user and home folder that a recording could carry. */
function machineSpellings(): RegExp[] {
  const user = userInfo().username;
  const home = homedir();
  const words = user.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  const dashed = (s: string) => s.replace(/[^A-Za-z0-9]/g, "-");
  const spellings = [
    // The home folder as written, with forward slashes, JSON-escaped, and dashed (Claude's project folders).
    home,
    home.replaceAll("\\", "/"),
    home.replaceAll("\\", "\\\\"),
    dashed(home),
    // The user name inside a path: `\Dell XPS\`, `/runner/`, `Users-Dell-XPS`.
    ...[user, dashed(user)].flatMap((u) => [`\\${u}`, `/${u}`, `Users-${u}`]),
  ].map((s) => new RegExp(literal(s), "i"));
  // A Windows 8.3 short name of the user folder: `DELLXP~1`.
  const short = words.join("").toUpperCase().slice(0, 6);
  if (short.length === 6) spellings.push(new RegExp(`${literal(short)}~\\d`));
  // A name of several words is distinctive anywhere: whole, dashed, underscored or joined, and any word left
  // after a scrub that stopped early (`~-XPS-`). A one-word name, such as a CI runner's, only in a path.
  if (words.length > 1) {
    for (const s of [user, words.join("-"), words.join("_"), words.join("")]) {
      spellings.push(new RegExp(literal(s), "i"));
    }
    for (const w of words) spellings.push(new RegExp(`~[-\\\\/]${literal(w)}\\b`, "i"));
  }
  return spellings;
}

/** A user folder on any machine, in any of the spellings the scrubber knows. */
const ANY_USER_FOLDER = [
  /[A-Z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)/,
  /[A-Z]--Users-/,
  /\/home\/[^/\s"]+\//,
  /\/Users\/[^/\s"]+\//,
  /(?<![A-Za-z0-9])[A-Z0-9]{6}~\d(?:\\|\/)/,
];

/** The patterns `text` matches, as one line each. */
function leaks(text: string): string[] {
  return [...machineSpellings(), ...ANY_USER_FOLDER].flatMap((p) => {
    const hit = p.exec(text);
    return hit === null ? [] : [`${p.source}: …${text.slice(Math.max(0, hit.index - 20), hit.index + 40)}…`];
  });
}

test("the leak check knows this machine's spellings", () => {
  const home = homedir();
  const dashedHome = home.replace(/[^A-Za-z0-9]/g, "-");
  for (const sample of [
    `{"cwd":"${home.replaceAll("\\", "\\\\")}\\\\work"}`,
    `${home.replaceAll("\\", "/")}/work`,
    `C:\\Users\\Your Name\\AppData`,
    `${dashedHome}-AppData-Local-Temp`,
    `/home/someone/repo`,
  ]) {
    expect(leaks(sample)).not.toEqual([]);
  }
  expect(leaks("~/AppData/Local/Temp and HEAD~1, git diff main...HEAD")).toEqual([]);
});

test("no recording names this machine's user or a user folder", () => {
  const files = recordingFiles();
  expect(files.length).toBeGreaterThan(0);
  const found = files.flatMap((d) => {
    const path = join(d.parentPath, d.name);
    const rel = relative(FAKES, path).replaceAll("\\", "/");
    return leaks(readFileSync(path, "utf8")).map((leak) => `${rel}: ${leak}`);
  });
  expect(found).toEqual([]);
});

test("every email in the recordings is the placeholder", () => {
  const files = recordingFiles();
  const emails = files.flatMap((d) =>
    [...readFileSync(join(d.parentPath, d.name), "utf8").matchAll(/"email": ?"([^"]*)"/g)].map((m) => m[1]),
  );
  expect(emails.filter((e) => e !== "user@example.com")).toEqual([]);
});
