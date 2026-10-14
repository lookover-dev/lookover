// `bun run --filter @lookover/site dev`: Astro's dev server on the site, its telemetry off, with what Astro prints
// (its address first). Arguments go through to Astro (`--port 4400`).
import { astro } from "./astro.ts";

process.exit(astro(["dev", ...process.argv.slice(2)]));
