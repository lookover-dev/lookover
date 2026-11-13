// The site's browser-free checks, proven to bite on small built sites (ADR 0064, 8): a link or asset that leads to no
// file or to no element of that id fails; a script, style or font from another host fails. No build: each test
// writes the few pages it needs. The wordmark every post on GitHub opens with (ADR 0074) is served at the two URLs
// contracts freezes: a build without either fails, and so does the site's `public/` folder, which Astro copies into
// the build as it is. Every page links the icons full bleed (ADR 0098), each PNG at the side its `sizes` says.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORDMARK_URLS } from "@lookover/contracts";
import { ICON_LINKS } from "../src/components/icons.ts";
import { brokenLinks, foreignLoads, iconProblems, unservedUrls } from "./site-checks.ts";

const temps: string[] = [];
afterAll(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
});

/** A build folder holding these files. */
function built(files: Readonly<Record<string, string | Uint8Array>>): string {
  const dist = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-site-"));
  temps.push(dist);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

const page = (head: string, body = ""): string =>
  `<!doctype html><html><head><title>x</title>${head}</head><body>${body}</body></html>`;

const site = {
  "docs/index.html": page("", '<h1 id="_top">Getting started</h1><h2 id="install">Install</h2>'),
  "docs/commands/index.html": page("", '<h2 id="start">start</h2>'),
  "_astro/site.css": "body{}",
  "favicon.svg": "<svg/>",
};

describe("internal links, proven to bite", () => {
  test("passes links to pages, anchors, assets and other hosts", () => {
    const dist = built({
      ...site,
      "index.html": page(
        '<link rel="stylesheet" href="/_astro/site.css"><link rel="icon" href="/favicon.svg">',
        [
          '<a href="/docs/">docs</a>',
          '<a href="/docs">docs</a>',
          '<a href="docs/commands/">commands</a>',
          '<a href="/docs/#install">install</a>',
          '<a href="https://lookover.dev/docs/commands/#start">start</a>',
          '<a href="#top">top</a><span id="top"></span>',
          '<a href="https://github.com/lookover-dev/lookover">GitHub</a>',
          '<a href="mailto:someone@example.com">mail</a>',
          '<script>const notALink = "<a href=\\"/nowhere/\\">";</script>',
        ].join(""),
      ),
    });
    expect(brokenLinks(dist)).toEqual([]);
  });

  test("passes the 404 page's canonical link, which no visitor follows", () => {
    const dist = built({
      ...site,
      "404.html": page('<link rel="canonical" href="https://lookover.dev/404/">', '<a href="/docs/">x</a>'),
    });
    expect(brokenLinks(dist)).toEqual([]);
  });

  test("names a link to a page that is not built", () => {
    const dist = built({ ...site, "index.html": page("", '<a href="/nowhere/">x</a>') });
    expect(brokenLinks(dist)).toEqual(["/: /nowhere/"]);
  });

  test("names a link to an id the page does not hold", () => {
    const dist = built({ ...site, "docs/commands/index.html": page("", '<a href="/docs/#nope">x</a>') });
    expect(brokenLinks(dist)).toEqual(["/docs/commands/: /docs/#nope"]);
  });

  test("names a missing asset and a relative link that misses, in the page's order", () => {
    const dist = built({
      ...site,
      "docs/commands/index.html": page(
        '<link rel="icon" href="/favicon.png">',
        '<a href="../missing/">x</a>',
      ),
    });
    expect(brokenLinks(dist)).toEqual(["/docs/commands/: /favicon.png", "/docs/commands/: ../missing/"]);
  });

  test("names a lookover.dev link to a page that is not built", () => {
    const dist = built({ ...site, "index.html": page("", '<a href="https://lookover.dev/docs/gone">x</a>') });
    expect(brokenLinks(dist)).toEqual(["/: https://lookover.dev/docs/gone"]);
  });

  test("checks links to http://lookover.dev and www.lookover.dev against the build too", () => {
    const dist = built({
      ...site,
      "index.html": page(
        "",
        [
          '<a href="http://lookover.dev/docs/">docs</a>',
          '<a href="https://www.lookover.dev/docs/commands/#start">start</a>',
          '<a href="http://lookover.dev/gone/">x</a>',
          '<a href="https://www.lookover.dev/docs/#nope">x</a>',
          '<a href="http://www.lookover.dev/missing">x</a>',
        ].join(""),
      ),
    });
    expect(brokenLinks(dist)).toEqual([
      "/: http://lookover.dev/gone/",
      "/: https://www.lookover.dev/docs/#nope",
      "/: http://www.lookover.dev/missing",
    ]);
  });
});

describe("nothing loaded from another host, proven to bite", () => {
  test("passes the site's own scripts, styles and fonts, links to other hosts and inline data", () => {
    const dist = built({
      ...site,
      "_astro/fonts.css":
        '@font-face{font-family:"Figtree";src:url(./figtree.woff2) format("woff2"),url(data:font/woff2;base64,AA==)}',
      "index.html": page(
        [
          '<link rel="stylesheet" href="/_astro/fonts.css">',
          '<link rel="preload" href="/_astro/figtree.woff2" as="font" crossorigin>',
          '<link rel="canonical" href="https://lookover.dev/">',
          '<script type="module" src="/_astro/page.js"></script>',
        ].join(""),
        '<a href="https://github.com/lookover-dev/lookover">GitHub</a><img src="/eyes.svg" alt="">',
      ),
    });
    expect(foreignLoads(dist)).toEqual([]);
  });

  test("names a script, a stylesheet, a font, a preconnect and a protocol-relative script, with their host", () => {
    const dist = built({
      ...site,
      "index.html": page(
        [
          '<link rel="preconnect" href="https://fonts.googleapis.com">',
          '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree">',
          '<link rel="preload" href="https://cdn.example.com/f.woff2" as="font">',
          '<script src="https://stats.example.com/s.js"></script>',
          '<script src="//cdn.example.com/x.js"></script>',
        ].join(""),
      ),
    });
    expect(foreignLoads(dist)).toEqual([
      "/: preconnect to fonts.googleapis.com",
      "/: style from fonts.googleapis.com",
      "/: font from cdn.example.com",
      "/: script from stats.example.com",
      "/: script from cdn.example.com",
    ]);
  });

  test("names a preloaded module, a preloaded style and a stylesheet's image from another host", () => {
    const dist = built({
      ...site,
      "_astro/site.css": "body{background:url(https://images.example.com/paper.png)}",
      "index.html": page(
        [
          '<link rel="modulepreload" href="https://cdn.example.com/m.js">',
          '<link rel="preload" href="https://styles.example.com/s.css" as="style">',
          '<link rel="stylesheet" href="/_astro/site.css">',
        ].join(""),
      ),
    });
    expect(foreignLoads(dist)).toEqual([
      "/: script from cdn.example.com",
      "/: style from styles.example.com",
      "/_astro/site.css: file from images.example.com",
    ]);
  });

  test("counts loads from http://lookover.dev and www.lookover.dev as the site's own", () => {
    const dist = built({
      ...site,
      "index.html": page(
        [
          '<link rel="stylesheet" href="http://lookover.dev/_astro/site.css">',
          '<script src="https://www.lookover.dev/_astro/page.js"></script>',
        ].join(""),
      ),
    });
    expect(foreignLoads(dist)).toEqual([]);
  });

  test("names a style's import and a font face from another host, in a stylesheet and in a page's style", () => {
    const dist = built({
      ...site,
      "_astro/site.css": [
        '@import url("https://fonts.googleapis.com/css2?family=Figtree");',
        "@font-face{font-family:x;src:url(https://fonts.gstatic.com/x.woff2)}",
        "body{background:url(/paper.png)}",
      ].join("\n"),
      "index.html": page("<style>@import 'https://cdn.example.com/a.css';</style>"),
    });
    expect(foreignLoads(dist)).toEqual([
      "/: style from cdn.example.com",
      "/_astro/site.css: style from fonts.googleapis.com",
      "/_astro/site.css: font from fonts.gstatic.com",
    ]);
  });
});

describe("the wordmark's URLs, proven to bite", () => {
  const urls = Object.values(WORDMARK_URLS);

  test("passes a build serving both", () => {
    const dist = built({
      "brand/lookover-wordmark.svg": "<svg/>",
      "brand/lookover-wordmark-on-dark.svg": "<svg/>",
    });
    expect(unservedUrls(dist, urls)).toEqual([]);
  });

  test("names each one the build lacks", () => {
    expect(unservedUrls(built({ "brand/lookover-wordmark.svg": "<svg/>" }), urls)).toEqual([
      "https://lookover.dev/brand/lookover-wordmark-on-dark.svg: not in the build",
    ]);
    expect(unservedUrls(built({ "brand/lookover-wordmark-on-dark.svg": "<svg/>" }), urls)).toEqual([
      "https://lookover.dev/brand/lookover-wordmark.svg: not in the build",
    ]);
  });

  test("names a folder by that name, which serves a page, not the file", () => {
    const dist = built({
      "brand/lookover-wordmark.svg/index.html": page(""),
      "brand/lookover-wordmark-on-dark.svg": "<svg/>",
    });
    expect(unservedUrls(dist, urls)).toEqual([
      "https://lookover.dev/brand/lookover-wordmark.svg: not in the build",
    ]);
  });

  test("names a URL on another host, which the site can't serve", () => {
    expect(unservedUrls(built({ "x.svg": "<svg/>" }), ["https://example.com/x.svg"])).toEqual([
      "https://example.com/x.svg: not on lookover.dev",
    ]);
  });

  test("the site's public folder, which the build copies as it is, serves both", () => {
    expect(unservedUrls(fileURLToPath(new URL("../public", import.meta.url)), urls)).toEqual([]);
  });
});

/** The first 24 bytes of a PNG: the signature, then the IHDR chunk's length, type, width and height. */
function png(width: number, height = width): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A PNG's 24 bytes under a JPEG's signature: long enough to read, not a PNG. */
function notPng(side: number): Uint8Array {
  const bytes = png(side);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

/** Every icon link, as the list says it; the SVG's in Starlight's `shortcut icon` form when `shortcut` is set. */
const iconLinks = (shortcut = false): string =>
  ICON_LINKS.map(({ href, rel, type, sizes }) =>
    [
      `<link rel="${shortcut && href === "/favicon.svg" ? "shortcut icon" : rel}" href="${href}"`,
      type === undefined ? "" : ` type="${type}"`,
      sizes === undefined ? "" : ` sizes="${sizes}"`,
      ">",
    ].join(""),
  ).join("");

const icons = {
  "favicon.svg": "<svg/>",
  "favicon-48.png": png(48),
  "favicon-96.png": png(96),
  "favicon-192.png": png(192),
  "apple-touch-icon.png": png(180),
};

describe("the icons full bleed, proven to bite", () => {
  test("the list links the five icons ADR 0098 fixes", () => {
    expect(ICON_LINKS.map(({ href }) => href)).toEqual([
      "/favicon.svg",
      "/favicon-48.png",
      "/favicon-96.png",
      "/favicon-192.png",
      "/apple-touch-icon.png",
    ]);
  });

  test("names a page without the SVG link, written by hand", () => {
    const dist = built({
      ...icons,
      "index.html": page(
        [
          '<link rel="icon" href="/favicon-48.png" type="image/png" sizes="48x48">',
          '<link rel="icon" href="/favicon-96.png" type="image/png" sizes="96x96">',
          '<link rel="icon" href="/favicon-192.png" type="image/png" sizes="192x192">',
          '<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">',
        ].join(""),
      ),
    });
    expect(iconProblems(dist)).toEqual(["/: no icon link to /favicon.svg"]);
  });

  test("passes pages linking every icon, Starlight's shortcut icon and the 404 page included", () => {
    const dist = built({
      ...icons,
      "index.html": page(iconLinks()),
      "docs/index.html": page(iconLinks(true)),
      "404.html": page(iconLinks(true)),
    });
    expect(iconProblems(dist)).toEqual([]);
    expect(brokenLinks(dist)).toEqual([]);
  });

  test("names each link a page lacks, a link of another rel included", () => {
    const dist = built({
      ...icons,
      "index.html": page(
        iconLinks().replace('<link rel="icon" href="/favicon-96.png" type="image/png" sizes="96x96">', ""),
      ),
      "404.html": page(iconLinks().replace('rel="apple-touch-icon"', 'rel="icon"')),
    });
    expect(iconProblems(dist)).toEqual([
      "/: no icon link to /favicon-96.png",
      "/404.html: no apple-touch-icon link to /apple-touch-icon.png",
    ]);
  });

  test("names a PNG linked at other sizes than the list says", () => {
    const dist = built({
      ...icons,
      "index.html": page(iconLinks().replace('sizes="48x48"', 'sizes="32x32"')),
    });
    expect(iconProblems(dist)).toEqual(['/: /favicon-48.png linked at sizes "32x32", not 48x48']);
  });

  test("names a PNG of another side and a file that isn't a PNG", () => {
    const dist = built({
      ...icons,
      "favicon-96.png": png(48),
      "favicon-192.png": "<svg/>",
      "index.html": page(iconLinks()),
    });
    expect(iconProblems(dist)).toEqual(["/favicon-96.png: 48x48, not 96x96", "/favicon-192.png: not a PNG"]);
  });

  test("names a PNG of the right width but another height", () => {
    const dist = built({ ...icons, "favicon-96.png": png(96, 48), "index.html": page(iconLinks()) });
    expect(iconProblems(dist)).toEqual(["/favicon-96.png: 96x48, not 96x96"]);
  });

  test("names a file long enough to read under another signature", () => {
    const dist = built({ ...icons, "favicon-192.png": notPng(192), "index.html": page(iconLinks()) });
    expect(iconProblems(dist)).toEqual(["/favicon-192.png: not a PNG"]);
  });

  test("leaves a missing file to the broken-link check, named once", () => {
    const { "apple-touch-icon.png": _, ...rest } = icons;
    const dist = built({ ...rest, "index.html": page(iconLinks()) });
    expect(iconProblems(dist)).toEqual([]);
    expect(brokenLinks(dist)).toEqual(["/: /apple-touch-icon.png"]);
  });

  test("the site's public folder, which the build copies as it is, holds each PNG at its side", () => {
    expect(iconProblems(fileURLToPath(new URL("../public", import.meta.url)))).toEqual([]);
  });

  test("the site's public folder holds every listed icon, and every icon at its root is listed", () => {
    const pub = fileURLToPath(new URL("../public", import.meta.url));
    const listed = ICON_LINKS.map(({ href }) => href);
    expect(listed.filter((href) => !existsSync(join(pub, href)))).toEqual([]);
    const icons = readdirSync(pub).filter((name) => /^(favicon|apple-touch-icon)/.test(name));
    expect(icons.map((name) => `/${name}`).filter((href) => !listed.includes(href))).toEqual([]);
  });
});
