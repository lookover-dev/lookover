// A Bun macro (imported `with { type: "macro" }`): it runs when Bun transpiles `version.ts`, from a clone or while
// building the program, and its string is inlined there. So the program carries the version it was built with and
// never reads a clone, and the root `package.json` stays outside the service's imports (ADR 0033).
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The root `package.json`'s `version`, Lookover's one version (ADR 0061). */
export function rootVersion(): string {
  const root: { version?: unknown } = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"),
  );
  if (typeof root.version !== "string") throw new Error("the root package.json has no version");
  return root.version;
}
