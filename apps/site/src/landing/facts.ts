// What the landing page says of the released program, in one place, so its five commands, its terminal, the systems
// it names and its links can't drift apart; facts.test.ts holds them to the README, the getting-started page and
// the LICENSE file.

/** Install, then the first run: shown and copied together, everywhere the page gives the command. */
export const COMMANDS = ["npm install -g lookover", "lookover start"] as const;

/** What `lookover start` prints on a first start (apps/service's background.ts, as the getting-started page quotes it). */
export const START_LINES = [
  "Lookover runs in the background.",
  "Lookover is opening in your browser.",
  "Don't see it? `lookover open --no-open` prints a link to paste (it works once, within 2 minutes).",
  "You can close this terminal.",
] as const;

/** The systems it runs on, as the README's "What you need" says: Windows on x64 only, macOS and Linux on both. */
export const PLATFORMS = "Windows (x64), macOS, Linux.";

/** The licence, as the LICENSE file names it. */
export const LICENCE = "MIT";

/** The public repository. */
export const GITHUB = "https://github.com/lookover-dev/lookover";

/** The docs' pages the landing page links to. */
export const DOCS = {
  index: "/docs/",
  codingAgent: "/docs/coding-agent/",
  terms: "/docs/terms/",
  extraUsage: "/docs/terms/#leave-paid-extra-usage-off",
  security: "/docs/security/",
} as const;
