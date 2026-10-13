// A port per worktree, derived from its path, so several worktrees run side by side (decision 0013).
// `bun dev` and `bun run proof` both take theirs from here, at different offsets inside the worktree's slot.
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { basename } from "node:path";

const RANGE_START = 20000; // 20000-29999, far from the usual 3000/5173/8080
const SLOTS = 1000;

const hashOf = (root: string) => createHash("sha1").update(root.toLowerCase()).digest();

/** "pensive-dubinsky-231526-a1b2c3": the worktree's folder and a short hash of its path. */
export const instanceOf = (root: string) => `${basename(root)}-${hashOf(root).toString("hex").slice(0, 6)}`;

function isFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer()
      .once("error", () => ok(false))
      .once("listening", () => s.close(() => ok(true)));
    s.listen(port, "127.0.0.1");
  });
}

/** The first free port from the worktree's own slot. `offset` (1-9) keeps `bun dev` (1) and proof (2) apart. */
export async function portFor(root: string, offset: number): Promise<number> {
  let slot = hashOf(root).readUInt32BE(0) % SLOTS;
  for (let i = 0; i < SLOTS; i++, slot = (slot + 1) % SLOTS) {
    const port = RANGE_START + slot * 10 + offset;
    if (await isFree(port)) return port;
  }
  throw new Error("No free port for the dev server");
}
