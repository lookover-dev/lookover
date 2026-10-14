// The checkout this package is in: the copies' paths are from its root, and Biome and its configuration are there.
import { resolve } from "node:path";

/** This checkout's root. */
export const ROOT = resolve(import.meta.dir, "..", "..", "..");
