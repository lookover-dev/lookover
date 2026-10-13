// The log file (ADR 0054, "Logs"; exploration 09 J1, J2): one file a day under `<home>/logs`, the old ones removed,
// the folders user-only, and every line through the one filter that removes secrets, on a clock the test holds.
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { openLogSink } from "./index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function newHome(): string {
  const home = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-logs-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Sunday 11 October 2026, 09:30 in the machine's own time zone: the file is named after the local day. */
const AT = new Date(2026, 9, 11, 9, 30).getTime();
const DAY = 86_400_000;

/** A sink on `home` at the clock `now()` reads, with the folders it made user-only and the lines it printed. */
async function sinkOn(home: string, now: () => number) {
  const userOnly: string[] = [];
  const printed: string[] = [];
  const sink = await openLogSink({
    home,
    clock: { now },
    userOnly: async (path) => {
      userOnly.push(path);
    },
    print: (line) => printed.push(line),
  });
  return { sink, userOnly, printed };
}

const fileOf = (home: string, day: string) => readFileSync(join(home, "logs", `lookover-${day}.log`), "utf8");

test("a line lands in the day's file, stamped with that day's local time and its offset, and is printed as kept", async () => {
  const home = newHome();
  const { sink, printed } = await sinkOn(home, () => AT);
  sink.write("the pull requests could not be listed: GitHub is out of reach");
  const stamp =
    /^(2026-10-11T09:30:00\.000[+-]\d{2}:\d{2}) the pull requests could not be listed: GitHub is out of reach\n$/.exec(
      fileOf(home, "2026-10-11"),
    );
  expect(stamp).not.toBeNull();
  // The stamp names the instant itself, whatever the machine's zone.
  expect(new Date(stamp?.[1] ?? "").getTime()).toBe(AT);
  expect(printed).toEqual(["the pull requests could not be listed: GitHub is out of reach"]);
});

test("a text of several lines lands as one stamped line per line, its indent and blank lines left out (ADR 0055)", async () => {
  const home = newHome();
  const { sink, printed } = await sinkOn(home, () => AT);
  sink.write(
    "\n  Lookover service (program) · http://127.0.0.1:4000\n  Open the app: http://127.0.0.1:4000\n",
  );
  const lines = fileOf(home, "2026-10-11").split("\n");
  expect(lines.map((line) => line.slice(line.indexOf(" ") + 1))).toEqual([
    "Lookover service (program) · http://127.0.0.1:4000",
    "Open the app: http://127.0.0.1:4000",
    "",
  ]);
  for (const line of lines.slice(0, 2)) expect(line).toMatch(/^2026-10-11T09:30:00\.000[+-]\d{2}:\d{2} /);
  // Printed as written.
  expect(printed).toEqual([
    "\n  Lookover service (program) · http://127.0.0.1:4000\n  Open the app: http://127.0.0.1:4000\n",
  ]);
});

test("a kept line goes to the file only", async () => {
  const home = newHome();
  const { sink, printed } = await sinkOn(home, () => AT);
  sink.keep("Open the app: http://127.0.0.1:4000/?token=abcdefghijklmnop");
  expect(fileOf(home, "2026-10-11")).toContain("Open the app: http://127.0.0.1:4000/?token=[redacted]");
  expect(printed).toEqual([]);
});

test("a line that can't be appended (a full disk) throws nothing: it is printed filtered, with why, never as given", async () => {
  const home = newHome();
  const { sink, printed } = await sinkOn(home, () => AT);
  mkdirSync(join(home, "logs", "lookover-2026-10-11.log"));
  const token = `ghs_${"c".repeat(36)}`;
  expect(() => sink.write(`refused ${token}`)).not.toThrow();
  expect(() => sink.keep(`Open the app: http://127.0.0.1:4000/?token=${token}`)).not.toThrow();
  expect(printed).toHaveLength(2);
  expect(printed[0]).toStartWith("refused [redacted] (not logged: ");
  // A kept line is the program's to print: only that it wasn't logged, never the line.
  expect(printed[1]).toStartWith("A line was not logged: ");
  expect(printed.join("\n")).not.toContain(token);
});

const SESSION = "Q2hhbmdlZC1zZXNzaW9uLXNlY3JldA0123456789ab";
const INSTALLATION_TOKEN = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";
const KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAuJh0bK8mQ0bL8mA5xYdWZpZJv4aR3W1n0kQ9oGq1M7dXxw2c",
  "Hn5fP3kq2c3y0rZzZQ8W6mF9xS2rGxvJw5fQ1lQb3l7tYcUoH0cQ4x8mN3mQkPq1",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3OTE2NDAwMDAsImV4cCI6MTc5MTY0MDYwMCwiaXNzIjoiNTIwMjA5MyJ9.c2lnbmF0dXJlLW9mLXRoZS1hcHA";

test("each secret the service registers is removed from every later line, in each form it is written", async () => {
  const home = newHome();
  const { sink, printed } = await sinkOn(home, () => AT);
  const oneTime = "Zm9yLW9uZS1saW5rLW9ubHktMTIzNDU2Nzg5MA";
  const plain = "plain-installation-token-0123456789";
  for (const value of [SESSION, oneTime, plain, KEY, JWT, INSTALLATION_TOKEN]) sink.secret(value);
  sink.write(`cookie ${SESSION}; link ${oneTime}`);
  sink.write(`git fetch with ${plain} and ${encodeURIComponent(`${plain}/=`)}`);
  sink.write(`the key: ${JSON.stringify(KEY)}`);
  sink.write(`a key line alone: ${KEY.split("\n")[1]}`);
  sink.write(`signed ${JWT}, bought ${INSTALLATION_TOKEN}`);
  const file = fileOf(home, "2026-10-11");
  for (const shown of [file, printed.join("\n")]) {
    for (const value of [SESSION, oneTime, plain, JWT, INSTALLATION_TOKEN, ...KEY.split("\n").slice(1, 3)])
      expect(shown).not.toContain(value);
    expect(shown).toContain("cookie [redacted]; link [redacted]");
    expect(shown).not.toContain("PRIVATE KEY-----\\n");
  }
});

test("a secret forgotten is removed no longer, in any of its forms, and the others still are", async () => {
  const home = newHome();
  const { sink } = await sinkOn(home, () => AT);
  const used = "dXNlZC1saW5rLXRva2VuLTAxMjM0NTY3ODk/=";
  const kept = "a-later-link-token-0123456789";
  sink.secret(used);
  sink.secret(kept);
  sink.forget(used);
  sink.forget("never-registered-0123456789");
  sink.write(`used ${used} and ${encodeURIComponent(used)}, kept ${kept}`);
  expect(fileOf(home, "2026-10-11")).toContain(
    `used ${used} and ${encodeURIComponent(used)}, kept [redacted]`,
  );
});

test("a secret too short to be one is not registered: it would cut words out of every line", async () => {
  const home = newHome();
  const { sink } = await sinkOn(home, () => AT);
  sink.secret("the");
  sink.secret("");
  sink.write("the pull requests are listed again");
  expect(fileOf(home, "2026-10-11")).toContain("the pull requests are listed again");
});

test("anything shaped like a secret is removed, registered or not", async () => {
  const home = newHome();
  const { sink, printed } = await sinkOn(home, () => AT);
  const lines = [
    `token ${INSTALLATION_TOKEN}`,
    "a person's ghp_aBcDeF0123456789aBcDeF0123456789aBcD and a fine-grained github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "oauth gho_0123456789abcdefghijABCDEFGHIJ, user-to-server ghu_0123456789abcdefghijABCDEFGHIJ, refresh ghr_0123456789abcdefghijABCDEFGHIJ",
    `the key ${KEY} was refused`,
    `an open block ${KEY.split("\n").slice(0, 2).join("\n")}`,
    `a JWT ${JWT}`,
    "Authorization: Bearer some-opaque-value-0123",
    'headers {"authorization":"token another-opaque-value"}',
    "authorization=Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0",
    "authorization: 'quoted-opaque-value'",
    "GET https://api.example.com/x?page=2&token=opaque-url-value&per_page=100",
    "clone https://x-access-token:opaque-password-value@github.com/lookover-dev/lookover-private.git",
  ];
  for (const line of lines) sink.write(line);
  const file = fileOf(home, "2026-10-11");
  for (const value of [
    INSTALLATION_TOKEN,
    "ghp_aBcDeF0123456789aBcDeF0123456789aBcD",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "gho_0123456789abcdefghijABCDEFGHIJ",
    "ghu_0123456789abcdefghijABCDEFGHIJ",
    "ghr_0123456789abcdefghijABCDEFGHIJ",
    KEY.split("\n")[1] ?? "",
    KEY.split("\n")[2] ?? "",
    JWT,
    "some-opaque-value-0123",
    "another-opaque-value",
    "eC1hY2Nlc3MtdG9rZW46c2VjcmV0",
    "quoted-opaque-value",
    "opaque-url-value",
    "opaque-password-value",
  ]) {
    expect(file).not.toContain(value);
    expect(printed.join("\n")).not.toContain(value);
  }
  // What surrounds a secret stays, so the line still says what happened.
  expect(file).toContain("&per_page=100");
  expect(file).toContain("@github.com/lookover-dev/lookover-private.git");
  expect(file).toContain("was refused");
});

test("prose about an authorization keeps its words: only a scheme or a quoted value after it is a secret", async () => {
  const home = newHome();
  const { sink } = await sinkOn(home, () => AT);
  sink.write("GitHub refused the authorization: the key was revoked");
  sink.write("authorization=pending for the installation");
  const file = fileOf(home, "2026-10-11");
  expect(file).toContain("GitHub refused the authorization: the key was revoked");
  expect(file).toContain("authorization=pending for the installation");
});

test("the file is named after the day the line is written, and a new day starts a new file", async () => {
  const home = newHome();
  let now = AT;
  const { sink } = await sinkOn(home, () => now);
  sink.write("before midnight");
  now = new Date(2026, 9, 12, 0, 0, 1).getTime();
  sink.write("after midnight");
  expect(fileOf(home, "2026-10-11")).toContain("before midnight");
  expect(fileOf(home, "2026-10-11")).not.toContain("after midnight");
  expect(fileOf(home, "2026-10-12")).toContain("after midnight");
});

/** The day `days` before AT's, as a file names it. */
const dayBefore = (days: number) => {
  const at = new Date(AT - days * DAY + 12 * 3_600_000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
};

test("files older than 30 days are removed at start; the month kept and what isn't a day's file stay", async () => {
  const home = newHome();
  const logs = join(home, "logs");
  mkdirSync(logs, { recursive: true });
  const kept = ["lookover-2026-09-11.log", "lookover-2026-10-10.log", "notes.txt", "lookover-latest.log"];
  const removed = ["lookover-2026-09-10.log", "lookover-2025-12-31.log"];
  for (const name of [...kept, ...removed]) writeFileSync(join(logs, name), "old\n");
  await sinkOn(home, () => AT);
  expect(
    readdirSync(logs)
      .filter((name) => !name.startsWith("."))
      .sort(),
  ).toEqual([...kept].sort());
});

test("the day changing removes the file that just turned 31 days old", async () => {
  const home = newHome();
  let now = AT;
  const { sink } = await sinkOn(home, () => now);
  sink.write("today");
  const logs = join(home, "logs");
  writeFileSync(join(logs, `lookover-${dayBefore(30)}.log`), "old\n");
  sink.write("later today");
  expect(existsSync(join(logs, `lookover-${dayBefore(30)}.log`))).toBe(true);
  now = AT + DAY;
  sink.write("tomorrow");
  expect(existsSync(join(logs, `lookover-${dayBefore(30)}.log`))).toBe(false);
});

test("the data folder and its logs folder are made user-only once, at the first start that succeeds at it", async () => {
  const home = newHome();
  const first = await sinkOn(home, () => AT);
  expect(first.userOnly).toEqual([home, join(home, "logs")]);
  const second = await sinkOn(home, () => AT);
  expect(second.userOnly).toEqual([]);
});

test("a start that failed to make the folders user-only is retried at the next, though the logs folder exists", async () => {
  const home = newHome();
  const refusing = openLogSink({
    home,
    clock: { now: () => AT },
    userOnly: async (path) => {
      if (path.endsWith("logs")) throw new Error("icacls: access is denied");
    },
  });
  await expect(refusing).rejects.toThrow("access is denied");
  expect(existsSync(join(home, "logs"))).toBe(true);
  const next = await sinkOn(home, () => AT);
  expect(next.userOnly).toEqual([home, join(home, "logs")]);
  const after = await sinkOn(home, () => AT);
  expect(after.userOnly).toEqual([]);
});

/** Who may open `path`: on Windows its access list as `icacls` prints it, one entry a line; elsewhere its mode. */
function accessOf(path: string): string[] {
  const printed = Bun.spawnSync(["icacls", path]).stdout.toString();
  return (printed.split(/\r?\n\s*\r?\n/)[0] ?? "")
    .slice(path.length)
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "");
}

test("for real, the data folder and its logs folder are left to the user alone, and so is the day's file", async () => {
  const home = newHome();
  const sink = await openLogSink({ home, clock: { now: () => AT } });
  sink.write("a line");
  const file = join(home, "logs", "lookover-2026-10-11.log");
  if (process.platform !== "win32") {
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
    return;
  }
  const me = userInfo().username.toLowerCase();
  // One entry each, not inherited and passed on to what the folder holds: the user (`DOMAIN\user`), full control.
  for (const folder of [home, join(home, "logs")])
    expect(accessOf(folder)).toEqual([
      expect.stringMatching(new RegExp(`\\\\${me}:\\(oi\\)\\(ci\\)\\(f\\)$`)),
    ]);
  // The day's file holds the one entry its folder passed on.
  expect(accessOf(file)).toEqual([expect.stringMatching(new RegExp(`\\\\${me}:\\(i\\)\\(f\\)$`))]);
});

test("each subscriber gets every line the file gains, filtered and stamped as the file keeps it, until it leaves (ADR 0055)", async () => {
  const home = newHome();
  const { sink } = await sinkOn(home, () => AT);
  sink.secret(SESSION);
  const heard: string[] = [];
  const leave = sink.subscribe((line) => heard.push(line));
  sink.write(`the session ${SESSION} was refused`);
  sink.keep(
    "\n  Lookover service (demo mode, S1)\n  Open the app: http://127.0.0.1:4000/?token=abcdefghijklmnop\n",
  );
  leave();
  sink.write("nobody hears this one");
  expect(heard.map((line) => line.replace(/^2026-10-11T09:30:00\.000[+-]\d{2}:\d{2} /, ""))).toEqual([
    "the session [redacted] was refused",
    "Lookover service (demo mode, S1)",
    "Open the app: http://127.0.0.1:4000/?token=[redacted]",
  ]);
  // What a subscriber hears is the file's line, as it is.
  expect(fileOf(home, "2026-10-11").split("\n").slice(0, 3)).toEqual(heard);
});

test("the tail is today's last 200 lines, oldest first, topped up from yesterday's when today's is short (ADR 0055)", async () => {
  const home = newHome();
  let now = new Date(2026, 9, 10, 23, 0).getTime();
  const { sink } = await sinkOn(home, () => now);
  for (let n = 1; n <= 250; n++) sink.write(`yesterday ${n}`);
  now = new Date(2026, 9, 11, 0, 5).getTime();
  for (let n = 1; n <= 3; n++) sink.write(`today ${n}`);
  const words = (lines: string[]) => lines.map((line) => line.slice(line.indexOf(" ") + 1));
  const tail = sink.tail();
  expect(tail).toHaveLength(200);
  expect(words(tail.slice(0, 2))).toEqual(["yesterday 54", "yesterday 55"]);
  expect(words(tail.slice(-4))).toEqual(["yesterday 250", "today 1", "today 2", "today 3"]);
  // Today's alone once it holds 200.
  for (let n = 4; n <= 205; n++) sink.write(`today ${n}`);
  expect(words(sink.tail())).toEqual(Array.from({ length: 200 }, (_, i) => `today ${i + 6}`));
});

test("the tail is empty with no file yet, and today's alone when yesterday has none", async () => {
  const home = newHome();
  const { sink } = await sinkOn(home, () => AT);
  expect(sink.tail()).toEqual([]);
  sink.write("the first line");
  expect(sink.tail().map((line) => line.slice(line.indexOf(" ") + 1))).toEqual(["the first line"]);
});

test("the tail of a day's file of many megabytes is its last 200 lines, read from its end, yesterday's left unread", async () => {
  const home = newHome();
  const { sink } = await sinkOn(home, () => AT);
  const logs = join(home, "logs");
  // Characters of two and three bytes, so the edges of what is read at a time cut some of them.
  const big = Array.from(
    { length: 100_000 },
    (_, n) => `2026-10-11T09:00:00.000+02:00 line ${n} été ${"✓".repeat(n % 700)}`,
  );
  writeFileSync(join(logs, "lookover-2026-10-11.log"), big.map((line) => `${line}\n`).join(""));
  // Yesterday's is a folder: read, it would throw.
  mkdirSync(join(logs, "lookover-2026-10-10.log"));
  expect(sink.tail()).toEqual(big.slice(-200));
});

test("yesterday's file tops the tail up with only the lines today's lacks, read from its end too", async () => {
  const home = newHome();
  const { sink } = await sinkOn(home, () => AT);
  const logs = join(home, "logs");
  const yesterday = Array.from(
    { length: 50_000 },
    (_, n) => `2026-10-10T20:00:00.000+02:00 old ${n} ${"é".repeat(n % 90)}`,
  );
  writeFileSync(join(logs, "lookover-2026-10-10.log"), yesterday.map((line) => `${line}\n`).join(""));
  // A last line not yet ended is a line too.
  writeFileSync(
    join(logs, "lookover-2026-10-11.log"),
    "2026-10-11T09:00:00.000+02:00 new 1\n2026-10-11T09:00:00.000+02:00 new 2",
  );
  expect(sink.tail()).toEqual([
    ...yesterday.slice(-198),
    "2026-10-11T09:00:00.000+02:00 new 1",
    "2026-10-11T09:00:00.000+02:00 new 2",
  ]);
});
