// A pure package reaching the file system: the pure packages' Biome override and the import check refuse it.
import { readFileSync } from "node:fs";

export const read = (path: string) => readFileSync(path, "utf8");
