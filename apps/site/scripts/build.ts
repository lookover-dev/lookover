// `bun run site:build`: builds lookover.dev into apps/site/dist with Astro, its telemetry off (ADR 0064). Exits
// with Astro's code.
import { astro } from "./astro.ts";

process.exit(astro(["build"]));
