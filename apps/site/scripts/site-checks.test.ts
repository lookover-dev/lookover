// The site's browser-free checks, proven to bite on small built sites (ADR 0064, 8): a link or asset that leads to no
// file or to no element of that id fails; a script, style or font from another host fails. No build: each test
// writes the few pages it needs.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brokenLinks, foreignLoads } from "./site-checks.ts";

const temps: string[] = [];
afterAll(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
});

/** A build folder holding these files. */
function built(files: Readonly<Record<string, string>>): string {
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
