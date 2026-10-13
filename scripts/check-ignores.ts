// Every ignore comment gives a reason (ADR 0036). Biome already refuses a `biome-ignore` without one,
// and `noTsIgnore` bans the ignore directive; this covers the TypeScript directives Biome lets through.
// Run by `bun run check`. Exits 1 and lists each comment without a reason.
import { Glob } from "bun";

const ROOTS = ["apps", "packages", "scripts"];
const FILES = new Glob("**/*.{ts,tsx}");
// `// @ts-expect-error` or `/* @ts-nocheck */` with nothing after it but an optional `:` or `-`.
const BARE = /(?:\/\/|\/\*)\s*@ts-(?:expect-error|ignore|nocheck)\s*[:-]?\s*(?:\*\/)?\s*$/;

const bare: string[] = [];
for (const root of ROOTS) {
  for await (const path of FILES.scan({ cwd: root })) {
    if (path.includes("node_modules")) continue;
    const file = `${root}/${path.replaceAll("\\", "/")}`;
    const lines = (await Bun.file(file).text()).split("\n");
    lines.forEach((line, i) => {
      if (BARE.test(line)) bare.push(`${file}:${i + 1}`);
    });
  }
}

if (bare.length > 0) {
  console.error(
    "Ignore comments without a reason. Say why on the same line, e.g. `// @ts-expect-error: <why>`:",
  );
  for (const at of bare) console.error(`  ${at}`);
  process.exit(1);
}
