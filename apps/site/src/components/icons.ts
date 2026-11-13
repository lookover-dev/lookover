// The icons every page of lookover.dev links, the icon full bleed (ADR 0098): ink to every edge, so a search result
// or a home screen that crops it to a circle takes only ink around the mark. `bun run brand` writes the files into
// `public/`; Icons.astro renders this list in the landing page's head and the docs' (Head.astro), and `site:check`
// fails a page that lacks a link, or a PNG at another side than its `sizes` (site-checks.ts, `iconProblems`).
// Starlight's own `rel="shortcut icon"` link to /favicon.svg stays beside these on the docs.

/** One icon link: where it points, its `rel`, its MIME type and, for a PNG, its side as `sizes` says it. */
export type IconLink = {
  readonly href: string;
  readonly rel: "icon" | "apple-touch-icon";
  readonly type?: string;
  readonly sizes?: string;
};

/** The icon links, in the order a page's head holds them. */
export const ICON_LINKS: readonly IconLink[] = [
  { href: "/favicon.svg", rel: "icon", type: "image/svg+xml" },
  { href: "/favicon-48.png", rel: "icon", type: "image/png", sizes: "48x48" },
  { href: "/favicon-96.png", rel: "icon", type: "image/png", sizes: "96x96" },
  { href: "/favicon-192.png", rel: "icon", type: "image/png", sizes: "192x192" },
  { href: "/apple-touch-icon.png", rel: "apple-touch-icon", sizes: "180x180" },
];
