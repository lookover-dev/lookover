// What a test builds from some content and only reads afterwards (a compiled program, a repository), kept by the
// content's hash outside the run, in this clone's `node_modules/.cache` (ADR 0071): built once per content, read by
// every later run. A new file costs Defender a scan and a compile seconds; a folder already there costs a stat.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** This clone's cache folder: `node_modules/.cache` at its root. */
const CLONE_CACHE = join(import.meta.dir, "..", "..", "..", "node_modules", ".cache");

/** What to keep: under which name, built from what. */
export interface CachedContent {
  /** The kind of thing kept, a folder name: `<name>` in the cache. */
  name: string;
  /**
   * Everything the build reads, as text: a script, a list of files, and what else changes its output (Bun's version
   * for a compiled program). Two equal contents are one build.
   */
  content: string;
  /** Where the cache lives: this clone's `node_modules/.cache` unless a test of the cache gives a scratch one. */
  root?: string;
  /** How the built folder is put in place: `renameSync` unless a test of the cache gives one that fails. */
  rename?: (from: string, to: string) => void;
}

/** What Windows answers a rename while another program (Defender scanning a new file) holds one of its files. */
const HELD = new Set(["EPERM", "EBUSY", "EACCES"]);
/** How often a held rename is tried, and how long it waits before the next try, in milliseconds. */
const TRIES = 5;
const PAUSE = 50;

function isHeld(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && HELD.has(error.code);
}

/**
 * The folder `build` filled for `kept.content`: built now into a fresh folder when the cache holds none for that
 * content, else the one a run built before, unbuilt. The folder is put in place whole once `build` returns, so a
 * reader never sees one half built: a build that throws leaves nothing, and of two builds of one content at once (two
 * test workers), the second to finish is dropped and both get the first's. A rename refused while another program
 * holds a new file (Windows' Defender) is tried again a few times. A caller only reads what it gets.
 */
export async function cachedByContent(
  kept: CachedContent,
  build: (folder: string) => Promise<void> | void,
): Promise<string> {
  const hash = createHash("sha256").update(kept.content).digest("hex").slice(0, 16);
  const kind = join(kept.root ?? CLONE_CACHE, kept.name);
  const done = join(kind, hash);
  if (existsSync(done)) return done;
  mkdirSync(kind, { recursive: true });
  // Beside the one it becomes, on the same disk, so the rename puts it in place at once.
  const building = mkdtempSync(join(kind, `${hash}.building-`));
  try {
    await build(building);
  } catch (error) {
    rmSync(building, { recursive: true, force: true });
    throw error;
  }
  const rename = kept.rename ?? renameSync;
  for (let tried = 1; ; tried++) {
    try {
      rename(building, done);
      return done;
    } catch (error) {
      // Another worker put the same content in place first: theirs is as good.
      if (existsSync(done)) break;
      // A file of ours held a moment (Windows): tried again briefly; anything else, or held too long, fails.
      if (!isHeld(error) || tried >= TRIES) {
        rmSync(building, { recursive: true, force: true });
        throw error;
      }
      await Bun.sleep(PAUSE * tried);
    }
  }
  rmSync(building, { recursive: true, force: true });
  return done;
}
