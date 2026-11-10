// The checker of what a web build emitted, against a content security policy (ADR 0085), proven to bite: each rule
// on a small file with its fault, and on files that pass. The policy is the service's own (`CSP`); the web-build
// test runs the same checker on a real build.
import { expect, test } from "bun:test";
import { CSP } from "@lookover/service";
import { cspFaults } from "./csp-faults.ts";

const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Lookover</title>',
  '<script type="module" crossorigin src="/assets/index-a1b2.js"></script>',
  '<link rel="stylesheet" crossorigin href="/assets/index-a1b2.css"></head>',
  '<body><div id="root"></div></body></html>',
].join("");

const FACE_AS_FILE =
  '@font-face{font-family:Hanken Grotesk Variable;src:url(/assets/hanken-grotesk-cyrillic-ext-wght-normal-a1b2.woff2) format("woff2-variations");unicode-range:U+0460-052F}';
const FACE_INLINED =
  '@font-face{font-family:Hanken Grotesk Variable;src:url(data:font/woff2;base64,d09GMgABAAAAAAZ0) format("woff2-variations");unicode-range:U+0460-052F}';
// An image as `data:` is no font: `img-src` allows it.
const IMAGE_INLINED = ".mark{background:url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)}";

test("a build whose faces are files, its page with no inline script or style, has nothing the policy blocks", () => {
  expect(
    cspFaults({ "index.html": PAGE, "assets/index-a1b2.css": `${FACE_AS_FILE}${IMAGE_INLINED}` }, CSP),
  ).toEqual([]);
});

test("a face inlined as data: is blocked when font-src doesn't allow data:", () => {
  expect(
    cspFaults({ "index.html": PAGE, "assets/index-a1b2.css": `${FACE_AS_FILE}${FACE_INLINED}` }, CSP),
  ).toEqual(["assets/index-a1b2.css: a @font-face with a data: font, which font-src 'self' blocks"]);
});

test("a face inlined as data: passes a policy whose font-src allows data:, or whose default-src does", () => {
  const files = { "index.html": PAGE, "assets/index-a1b2.css": FACE_INLINED };
  expect(cspFaults(files, "default-src 'self'; font-src 'self' data:")).toEqual([]);
  expect(cspFaults(files, "default-src 'self' data:")).toEqual([]);
});

test("a face inlined as data: passes a policy that names neither font-src nor default-src: nothing limits fonts", () => {
  expect(cspFaults({ "assets/index-a1b2.css": FACE_INLINED }, "script-src 'self'")).toEqual([]);
});

test("an inline script in the page is blocked; one with src is not", () => {
  const page = PAGE.replace("</head>", "<script>window.started = true;</script></head>");
  expect(cspFaults({ "index.html": page }, CSP)).toEqual([
    "index.html: a <script> without src, which script-src 'self' blocks",
  ]);
});

test("a <style> in the page is blocked", () => {
  const page = PAGE.replace("</head>", "<style>body{margin:0}</style></head>");
  expect(cspFaults({ "index.html": page }, CSP)).toEqual([
    "index.html: a <style>, which style-src 'self' blocks",
  ]);
});

test("a style= attribute in the page is blocked", () => {
  const page = PAGE.replace('<div id="root">', '<div id="root" style="background:#000">');
  expect(cspFaults({ "index.html": page }, CSP)).toEqual([
    "index.html: a style= attribute, which style-src 'self' blocks",
  ]);
});

test("inline scripts and styles pass a policy that allows them inline", () => {
  const page = PAGE.replace(
    "</head>",
    '<script>window.started = true;</script><style>body{margin:0}</style></head><p style="margin:0">',
  );
  expect(cspFaults({ "index.html": page }, "default-src 'self' 'unsafe-inline'")).toEqual([]);
});
