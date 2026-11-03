// The web app's build carries the licence of every face it bundles (design-system.md "Device code"): the OFL asks
// that each copy of a font goes with its copyright and licence, and the build is what the program serves and carries.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fontLicences } from "./font-licences.ts";

const WEB = join(import.meta.dir, "..");

test("every face the app imports has its licence in the build, under fonts/, the device code's included", () => {
  const imported = [
    ...readFileSync(join(WEB, "src", "main.tsx"), "utf8").matchAll(/import "(@fontsource[^/]*\/[^/"]+)/g),
  ].map((m) => m[1]);
  const licences = fontLicences(WEB);
  expect(new Set(imported)).toEqual(
    new Set([
      "@fontsource-variable/figtree",
      "@fontsource-variable/hanken-grotesk",
      "@fontsource/ibm-plex-mono",
      "@fontsource/atkinson-hyperlegible-mono",
    ]),
  );
  expect(licences.map((l) => l.fileName).sort()).toEqual([
    "fonts/atkinson-hyperlegible-mono-LICENSE.txt",
    "fonts/figtree-LICENSE.txt",
    "fonts/hanken-grotesk-LICENSE.txt",
    "fonts/ibm-plex-mono-LICENSE.txt",
  ]);
  const atkinson = licences.find((l) => l.fileName === "fonts/atkinson-hyperlegible-mono-LICENSE.txt");
  expect(atkinson?.source).toContain("The Atkinson Hyperlegible Mono Project Authors");
  expect(atkinson?.source).toContain("SIL Open Font License, Version 1.1");
});
