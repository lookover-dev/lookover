// Biome's formatter, for the copies the package writes into the apps: each comes out as `bun run check` and
// `bun run format` find it.
import { join } from "node:path";
import { spawnSync } from "bun";
import { ROOT } from "./checkout.ts";

const done = new Map<string, string>();

/** `text` as Biome formats the file at `path` (from the checkout's root). */
export function formatted(path: string, text: string): string {
  const key = `${path}\n${text}`;
  const known = done.get(key);
  if (known !== undefined) return known;
  const biome = Bun.which("biome", { PATH: join(ROOT, "node_modules", ".bin") });
  if (!biome) throw new Error("biome is not installed: run bun install");
  const run = spawnSync([biome, "format", `--stdin-file-path=${path}`], {
    cwd: ROOT,
    stdin: new TextEncoder().encode(text),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`biome format failed on ${path}: ${run.stderr.toString()}`);
  const out = run.stdout.toString();
  done.set(key, out);
  return out;
}

/** A module's constant as TypeScript: its doc comment, then `export const` with its value as JSON. */
export const constant = (doc: string, name: string, value: unknown) =>
  `/** ${doc} */\nexport const ${name} = ${JSON.stringify(value)} as const;\n`;
