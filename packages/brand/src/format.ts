// How the copies the package writes into the apps are formatted: a `Formatter` given to the generators, Biome's
// by default, so each comes out as `bun run check` and `bun run format` find it. Tests give one that runs in their
// own process.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./checkout.ts";
import { BIOME_BINARY } from "./config.ts";

/** `text` formatted as the file at `path` (from the checkout's root). */
export type Formatter = (path: string, text: string) => Promise<string>;

/** How the cache's files are renamed and removed: Node's own unless a test gives others. */
type CacheFiles = { rename: (from: string, to: string) => void; remove: (file: string) => void };

/** Where Biome's formatter keeps its outputs, and which Biome it starts; `files` is for tests. */
export type BiomeOptions = { cache?: string; binary?: string; files?: CacheFiles };

const FILES: CacheFiles = {
  rename: renameSync,
  remove: (file) => {
    if (existsSync(file)) rmSync(file, { force: true });
  },
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const done = new Map<string, string>();

/** The checkout's `.bin` launcher of Biome, which finds the binary itself (one process more: Node). */
const launcher = () => Bun.which("biome", { PATH: join(ROOT, "node_modules", ".bin") });

/** Linux on musl (Alpine, say), as its dynamic loader says: `/lib/ld-musl-<arch>.so.1`. */
function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readdirSync("/lib").some((name) => name.startsWith("ld-musl-"));
  } catch {
    return false; // No `/lib` to read: not the musl layout.
  }
}

/**
 * The checkout's Biome: its platform's binary, picked as Biome's own launcher picks it (musl's on musl Linux), so a
 * format is one process, not three (the `.bin` launcher, Node, the binary); else the `.bin` launcher.
 */
function biomeBinary(): string | null {
  const biomePackage = join(ROOT, "node_modules", "@biomejs", "biome");
  if (!existsSync(biomePackage)) return launcher();
  const exe = process.platform === "win32" ? "biome.exe" : "biome";
  const platform = `${process.platform}-${process.arch}${isMusl() ? "-musl" : ""}`;
  try {
    const pkg = Bun.resolveSync(`@biomejs/cli-${platform}/package.json`, realpathSync(biomePackage));
    const bin = join(dirname(pkg), exe);
    return existsSync(bin) ? bin : launcher();
  } catch {
    // No package by this platform's name: the launcher knows the others.
    return launcher();
  }
}

/** Starts `bin` on `text`; when the binary picked does not start, the launcher, which may know better. */
function spawnBiome(bin: string, path: string, text: string) {
  const start = (exe: string) =>
    Bun.spawn([exe, "format", `--stdin-file-path=${path}`], {
      cwd: ROOT,
      stdin: new TextEncoder().encode(text),
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    return start(bin);
  } catch (error) {
    const fallback = launcher();
    if (!fallback || fallback === bin) throw error;
    return start(fallback);
  }
}

/**
 * Keeps `text` at `file`, or says why it could not: the cache is best-effort, a format never fails on it, nor on the
 * partial copy it leaves when that can't be removed either (on Windows, a scanner holding the new file refuses both
 * the rename, EPERM, and the removal, EBUSY or EPERM, which `force` does not hide).
 */
function keep(cache: string, file: string, text: string, files: CacheFiles): string | null {
  // Written whole under a name of its own, then renamed: a reader in another test process sees all or nothing.
  const partial = `${file}.${process.pid}.${crypto.randomUUID()}`;
  try {
    mkdirSync(cache, { recursive: true });
    writeFileSync(partial, text);
    files.rename(partial, file);
    return null;
  } catch (error) {
    return `lookover-brand: could not keep Biome's output in ${cache}: ${message(error)}${removePartial(partial, files)}`;
  }
}

/** Removes a partial write if there is one (there may be none: the folder could not be made); says when it stays. */
function removePartial(partial: string, files: CacheFiles): string {
  try {
    files.remove(partial);
    return "";
  } catch (error) {
    return `; its partial copy ${partial} stays: ${message(error)}`;
  }
}

/** Where Biome's outputs are kept, one file per input, as `bun run check` keeps its own (`node_modules/.cache`). */
const CACHE = join(ROOT, "node_modules", ".cache", "lookover-brand");

/**
 * The name Biome's output for `text` at `path` is kept under: a hash of everything that decides it, the Biome named
 * (`BIOME_BINARY`, else the checkout's), Biome's version and the checkout's `biome.jsonc` with the path and the
 * text. The generated text never comes from a copy on disk (only the stylesheet's hand-written rest does): it is what
 * the source renders, so a stale copy is compared with Biome's output for the source, never with itself.
 */
function cacheKey(binary: string, path: string, text: string): string {
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
  const version = read(join(ROOT, "node_modules", "@biomejs", "biome", "package.json"));
  const config = read(join(ROOT, "biome.jsonc"));
  return new Bun.CryptoHasher("sha256")
    .update([binary, version, config, path, text].join("\0"))
    .digest("hex");
}

/**
 * Biome's formatter, one process per text, never the same text twice: a text Biome formatted once, with this
 * version and configuration, is read back from `cache` (the checkout's `node_modules/.cache` unless given) instead
 * of starting Biome again. It starts `binary` (`BIOME_BINARY` unless given, as Biome's launcher honours it), else
 * the checkout's. Keeping an output is best-effort: when the cache can't be written, it says so and still returns.
 */
export function biomeFormatter({
  cache = CACHE,
  binary = BIOME_BINARY,
  files = FILES,
}: BiomeOptions = {}): Formatter {
  return async (path, text) => {
    const key = cacheKey(binary ?? "", path, text);
    const known = done.get(key);
    if (known !== undefined) return known;
    const kept = join(cache, `${key}.txt`);
    if (existsSync(kept)) {
      const out = readFileSync(kept, "utf8");
      done.set(key, out);
      return out;
    }
    const bin = binary ?? biomeBinary();
    if (!bin) throw new Error("biome is not installed: run bun install");
    const run = spawnBiome(bin, path, text);
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    if (code !== 0) throw new Error(`biome format failed on ${path}: ${err}`);
    done.set(key, out);
    const failed = keep(cache, kept, out, files);
    if (failed) console.warn(failed);
    return out;
  };
}

/** Biome's formatter on the checkout's cache: the copies' default. */
export const biome: Formatter = biomeFormatter();

/** A module's constant as TypeScript: its doc comment, then `export const` with its value as JSON. */
export const constant = (doc: string, name: string, value: unknown) =>
  `/** ${doc} */\nexport const ${name} = ${JSON.stringify(value)} as const;\n`;
