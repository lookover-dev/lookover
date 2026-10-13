// Where every line the service writes goes (ADR 0054, "Logs"; exploration 09 J1, J2): one file a day,
// `<home>/logs/lookover-YYYY-MM-DD.log` (the machine's local day), each line stamped with the same local time and its
// offset (a text of several lines, as the start banner or a stack, one stamped line per line, ADR 0055); the files
// older than 30 days removed at start and when the day changes; `<home>` and `logs/` made user-only once, a marker in
// `logs/` saying it was done, so a start that failed at it is retried at the next. Every line passes one filter first,
// which removes the secrets the service registered as it learned them (the session secret, the one-time link's token,
// installation tokens, the App's key and the JWTs it signs) and anything shaped like one (GitHub tokens, private key
// blocks, JWTs, `Authorization` values, `token=` in a URL, a password in a URL). What the filter leaves is what the
// file keeps and what `write` prints. The one line printed whole is the program's own to the owner (`keep`: the URL to
// open, its token the owner's to use), which the file keeps filtered too. Every write is a synchronous append, so lines
// land in order and a crash loses none written before it. An append that fails (a full disk) throws nothing: the line
// is printed filtered with why (on the standard error when the sink prints nowhere), so a stop, an exit or an event
// never waits on the log, and no line is ever printed unfiltered. What the file gains can be read too (ADR 0055, the
// Logs page): its last lines (`tail`), and each new line as it is written (`subscribe`), stamped and filtered as the
// file keeps it.
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Clock, twoDigits } from "@lookover/contracts";
import { localDay } from "./local-day.ts";
import { DAY_MS, KEPT_DAYS } from "./retention.ts";
import { said } from "./said.ts";
import { makeUserOnly } from "./user-only.ts";

/** Where every line the service writes goes (ADR 0054): the log file, through the filter that removes secrets. */
export interface LogSink {
  /**
   * Writes `line`, its secrets removed, to the day's file, and prints it so. Never throws: a line the file can't take
   * (a full disk) is printed so, with why, so no stop, exit or event waits on the log.
   */
  write(line: string): void;
  /** A secret every later line must not show (a token, a key): the sink removes it from what it writes. */
  secret(value: string): void;
  /** A secret registered that is one no longer (a link used or expired): the sink stops looking for it. */
  forget(value: string): void;
  /**
   * `text` with its secrets removed as every line written is, but written nowhere: what else leaves the service (an
   * engine's activity, ADR 0055) passes here.
   */
  secretsRemoved(text: string): string;
}

/** What the file says, for the Logs page (ADR 0055): each line as the file keeps it, its stamp first. */
export interface LogReader {
  /** The last 200 lines, oldest first: today's file, topped up from yesterday's when today's holds fewer. */
  tail(): string[];
  /** Calls `listener` with each line the file gains, as it is written; the function returned stops it. */
  subscribe(listener: (line: string) => void): () => void;
}

/**
 * The program's sink: also a line for the file only, which the program prints itself as it is (the URL to open); and
 * what the file says, read back.
 */
export interface FileLogSink extends LogSink, LogReader {
  /** Never throws either: a line the file can't take is said not logged, never printed (it is the program's). */
  keep(line: string): void;
}

export interface LogSinkOptions {
  /** The data folder: the files are in its `logs` folder. */
  home: string;
  /** The time of each line, and the day that names its file. */
  clock: Clock;
  /** Leaves a folder to the user alone: `makeUserOnly` when not given. */
  userOnly?(path: string): Promise<void>;
  /** Where each written line is printed, filtered as the file keeps it; nowhere when not given. */
  print?(line: string): void;
}

/** How many lines the tail holds. */
const TAIL_LINES = 200;
/** How many bytes the tail reads at a time, from the file's end back. */
const CHUNK = 64 * 1024;
const REDACTED = "[redacted]";
const NEWLINE = 0x0a;
/** Shorter than this, a value is no secret this service holds: removing it would cut words out of every line. */
const SHORTEST_SECRET = 8;

const FILE = /^lookover-(\d{4})-(\d{2})-(\d{2})\.log$/;
/** Written in `logs/` once `<home>` and `logs/` are the user's alone: until it is, each start tries again. */
const USER_ONLY_DONE = ".user-only";

/** The local day before `at`'s, counted in calendar days: a day of 23 or 25 hours is still one day. */
const dayBefore = (at: number) => {
  const date = new Date(at);
  return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 12).getTime());
};
/** `at` in the local time its file's day is, with the offset from UTC: `2026-10-11T09:30:00.000+02:00`. */
const stampOf = (at: number) => {
  const date = new Date(at);
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const time = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${localDay(at)}T${time}.${ms}${sign}${twoDigits(Math.floor(Math.abs(offset) / 60))}:${twoDigits(Math.abs(offset) % 60)}`;
};

/**
 * What anything shaped like a secret is, whoever wrote it: each pattern's matches are replaced, and its first group,
 * when it has one, kept, so the line still says what was there.
 */
const SHAPES: readonly RegExp[] = [
  // A private key block, whole or cut short; its line breaks real or escaped (a key in JSON).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // GitHub's tokens: an App's installation token, a person's, OAuth, user-to-server, refresh, and fine-grained.
  /\bgh[opsur]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // A JWT: a JSON header and claims, base64url, and a signature.
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  // An `Authorization` value, as a header, a JSON field or a parameter: its scheme and what follows, or a value in
  // quotes. Prose ("refused the authorization: the key was revoked") is neither.
  /(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|token|basic)\s+[^\s"',;}]+|(?<=["'])[^\s"',;}]+)/gi,
  // A token in a URL's query.
  /([?&][A-Za-z_]*token=)[^&#\s"']+/gi,
  // A password in a URL's user part.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
];

/** `line` with anything shaped like a secret replaced: the filter of a service with no sink. */
export function secretShapesRemoved(line: string): string {
  return SHAPES.reduce(
    (text, shape) =>
      text.replace(shape, (_match, kept: unknown) => (typeof kept === "string" ? kept : "") + REDACTED),
    line,
  );
}

/** Every form a line may carry `value` in: as it is, in a URL, in JSON. */
const formsOf = (value: string) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];

/** The one filter (J1): the secrets registered, each in every form a line may carry it, then the shapes. */
function createFilter() {
  const secrets = new Set<string>();
  /** The secrets, the longest first, so one inside another is never left half removed: sorted when they change. */
  let longestFirst: string[] = [];
  const changed = () => {
    longestFirst = [...secrets].sort((a, b) => b.length - a.length);
  };
  const add = (value: string) => {
    if (value.length >= SHORTEST_SECRET) secrets.add(value);
  };
  return {
    secret(value: string) {
      if (value.length < SHORTEST_SECRET) return;
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
        // The block is removed by its shape; its lines are kept too, should one be written alone.
        for (const line of value.split(/\r?\n/)) if (!line.startsWith("-----")) add(line.trim());
        changed();
        return;
      }
      // A JWT or a GitHub token is removed by its shape whenever it is written: nothing to keep, however many.
      if (secretShapesRemoved(value) === REDACTED) return;
      for (const form of formsOf(value)) add(form);
      changed();
    },
    forget(value: string) {
      for (const form of formsOf(value)) secrets.delete(form);
      changed();
    },
    secretsRemoved(line: string): string {
      let text = line;
      for (const value of longestFirst) text = text.replaceAll(value, REDACTED);
      return secretShapesRemoved(text);
    },
  };
}

/**
 * The last `count` lines of `file`, oldest first; none when it has no file. Read from its end back, `CHUNK` bytes at a
 * time, until the bytes read hold `count` whole lines or the file's start: a day's file of any size costs a few reads.
 * The bytes are decoded once joined, so a character cut by a chunk's edge is whole again.
 */
function lastLines(file: string, count: number): string[] {
  if (count <= 0 || !existsSync(file)) return [];
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let position = fstatSync(fd).size;
    let newlines = 0;
    // One newline more than lines wanted: the line before the first kept ends there, so the first is whole.
    while (position > 0 && newlines <= count) {
      const size = Math.min(CHUNK, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, position);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === NEWLINE) newlines++;
    }
    const parts = Buffer.concat(chunks).toString("utf8").split("\n");
    // Before the first newline is the end of a line whose start was not read, unless the file starts there.
    if (position > 0) parts.shift();
    return parts.filter((line) => line !== "").slice(-count);
  } finally {
    closeSync(fd);
  }
}

/**
 * Opens the sink on `<home>/logs`: makes the folder (and leaves it and `home` to the user, until a start has), and
 * removes the files older than 30 days. Rejects when the folder can't be made or left to the user alone.
 */
export async function openLogSink(o: LogSinkOptions): Promise<FileLogSink> {
  const logs = join(o.home, "logs");
  const done = join(logs, USER_ONLY_DONE);
  if (!existsSync(done)) {
    mkdirSync(logs, { recursive: true });
    const userOnly = o.userOnly ?? makeUserOnly;
    await userOnly(o.home);
    await userOnly(logs);
    writeFileSync(done, "");
  }
  const { secret, forget, secretsRemoved } = createFilter();
  /** Removes the files of the days more than 30 days before `today`'s. */
  const prune = (now: number) => {
    const oldest = localDay(now - KEPT_DAYS * DAY_MS);
    for (const name of readdirSync(logs)) {
      const day = FILE.exec(name);
      if (day !== null && `${day[1]}-${day[2]}-${day[3]}` < oldest) rmSync(join(logs, name), { force: true });
    }
  };
  let today = localDay(o.clock.now());
  prune(o.clock.now());
  const fileOf = (day: string) => join(logs, `lookover-${day}.log`);
  /** The last `count` lines of `day`'s file, oldest first, read from its end; none when it has no file. */
  const lastOf = (day: string, count: number): string[] => lastLines(fileOf(day), count);
  const listeners = new Set<(line: string) => void>();
  const keep = (line: string): string => {
    const now = o.clock.now();
    const day = localDay(now);
    if (day !== today) {
      today = day;
      prune(now);
    }
    // Filtered whole, so a secret across lines (a key block) goes; then one stamped line per line (ADR 0055), its
    // indent and its blank lines left out.
    const kept = secretsRemoved(line);
    const stamp = stampOf(now);
    const lines = kept
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const stamped = lines.map((part) => `${stamp} ${part}`);
    if (stamped.length > 0) appendFileSync(fileOf(day), stamped.map((part) => `${part}\n`).join(""));
    for (const part of stamped) for (const listener of listeners) listener(part);
    return kept;
  };
  /** Where a line that can't be appended is said: where lines are printed, else the standard error. */
  const unlogged = o.print ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    secret,
    forget,
    secretsRemoved,
    tail: () => {
      const now = o.clock.now();
      const lines = lastOf(localDay(now), TAIL_LINES);
      if (lines.length >= TAIL_LINES) return lines;
      return [...lastOf(dayBefore(now), TAIL_LINES - lines.length), ...lines];
    },
    subscribe: (listener) => {
      // Wrapped, so the same function subscribed twice is called twice, and each leave removes its own.
      const own = (line: string) => listener(line);
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
    keep: (line) => {
      try {
        keep(line);
      } catch (error) {
        unlogged(`A line was not logged: ${secretsRemoved(said(error))}`);
      }
    },
    write: (line) => {
      let kept: string;
      try {
        kept = keep(line);
      } catch (error) {
        unlogged(`${secretsRemoved(line)} (not logged: ${secretsRemoved(said(error))})`);
        return;
      }
      o.print?.(kept);
    },
  };
}
