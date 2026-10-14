// The site's checks that need no browser (ADR 0064, 8), run on a build folder by `bun run site:check`: no internal
// link or asset leads nowhere, and nothing is loaded from another host. Pure reads of the files; each finding is a
// line `<page or file>: <what>`, so the check prints them as they are.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Where the site is served: a link to it is a link inside the site. */
const ORIGIN = "https://lookover.dev";

/** Whether a URL is the site's own: lookover.dev or www.lookover.dev, by http or https. */
const isSite = (url: URL): boolean =>
  /^https?:$/.test(url.protocol) && (url.host === "lookover.dev" || url.host === "www.lookover.dev");

/** Every file of the build folder with this extension, as paths relative to it with `/`, sorted. */
function filesOf(dist: string, extension: string): string[] {
  return readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => relative(dist, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/** Every .html file of the build folder, sorted by the path a visitor asks for (`/` before `/docs/`). */
const pageFiles = (dist: string): string[] =>
  filesOf(dist, ".html").sort((a, b) => (pageOf(a) < pageOf(b) ? -1 : pageOf(a) > pageOf(b) ? 1 : 0));

/** Every page of the build folder, as a visitor asks for it: `docs/index.html` is `/docs/`, sorted. */
export function pagesOf(dist: string): string[] {
  return pageFiles(dist).map(pageOf);
}

/** The path a visitor uses for a file: `docs/index.html` is `/docs/`, `404.html` is `/404.html`. */
const pageOf = (file: string): string => `/${file.replace(/(^|\/)index\.html$/, "$1")}`;

/** The file of the build folder a site path is served from, if there is one, as a static host serves it. */
export function servedFile(dist: string, path: string): string | undefined {
  const candidates = path.endsWith("/")
    ? [`${path}index.html`]
    : [path, `${path}/index.html`, `${path}.html`];
  return candidates
    .map((candidate) => join(dist, ...candidate.split("/")))
    .find((file) => existsSync(file) && statSync(file).isFile());
}

/** The HTML without the bodies of its scripts, whose strings are not links. */
const markup = (html: string): string => html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, "$1");

/** The values of one attribute in a tag or a page, `&amp;` decoded, in order. */
function attributeValues(html: string, name: string): string[] {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "gi");
  return [...html.matchAll(pattern)].map((match) =>
    (match[1] ?? match[2] ?? match[3] ?? "").replaceAll("&amp;", "&"),
  );
}

/** One attribute of a tag, or undefined. */
const attributeOf = (tag: string, name: string): string | undefined => attributeValues(tag, name)[0];

/** The page's opening tags, in order. */
const tagsOf = (html: string): string[] =>
  [...markup(html).matchAll(/<[a-z][^>]*>/gi)].map((match) => match[0]);

/** A canonical link names the page itself for search engines; no visitor follows it. */
const isCanonical = (tag: string): boolean => /^<link\b/i.test(tag) && relsOf(tag).includes("canonical");

const relsOf = (tag: string): string[] => (attributeOf(tag, "rel") ?? "").toLowerCase().split(/\s+/);

/** A reference as a URL, or undefined when it can't be read as one. */
function urlOf(reference: string, base: string): URL | undefined {
  try {
    return new URL(reference, base);
  } catch {
    return undefined;
  }
}

/**
 * The links and assets of the site that lead nowhere: no file for the path, or no element of that id for the
 * `#fragment`; a link to lookover.dev or www.lookover.dev, by http or https, is checked as the site's. Links to
 * other hosts, `mailto:` and the like are not the site's to check. Each as `<page>: <href>`, pages sorted, links in
 * the page's order.
 */
export function brokenLinks(dist: string): string[] {
  const ids = new Map<string, Set<string>>();
  const idsOf = (file: string): Set<string> => {
    const known = ids.get(file);
    if (known !== undefined) return known;
    const found = new Set(attributeValues(markup(readFileSync(file, "utf8")), "id"));
    ids.set(file, found);
    return found;
  };
  /** Whether a reference on a page leads somewhere: another host's, or a file of the site and its id. */
  const leads = (page: string, reference: string): boolean => {
    const url = urlOf(reference, `${ORIGIN}${page}`);
    if (url === undefined) return false;
    if (!isSite(url)) return true;
    const target = servedFile(dist, decodeURIComponent(url.pathname));
    const fragment = decodeURIComponent(url.hash.slice(1));
    return (
      target !== undefined && (fragment === "" || !target.endsWith(".html") || idsOf(target).has(fragment))
    );
  };
  return pageFiles(dist).flatMap((file) => {
    const page = pageOf(file);
    return tagsOf(readFileSync(join(dist, file), "utf8"))
      .filter((tag) => !isCanonical(tag))
      .flatMap((tag) => [...attributeValues(tag, "href"), ...attributeValues(tag, "src")])
      .filter((reference) => !leads(page, reference))
      .map((reference) => `${page}: ${reference}`);
  });
}

/** What a page or a stylesheet loads, and from where. */
type Load = { readonly kind: string; readonly reference: string };

/** What a `<link>` loads: a stylesheet, a preloaded script, style or font, or a connection opened ahead. */
function linkLoad(tag: string): Load | undefined {
  const href = attributeOf(tag, "href");
  if (href === undefined) return undefined;
  const rels = relsOf(tag);
  if (rels.includes("stylesheet")) return { kind: "style", reference: href };
  if (rels.includes("modulepreload")) return { kind: "script", reference: href };
  if (rels.includes("preload") || rels.includes("prefetch")) {
    const as = attributeOf(tag, "as") ?? "file";
    return { kind: as === "fetch" ? "file" : as, reference: href };
  }
  if (rels.includes("preconnect") || rels.includes("dns-prefetch"))
    return { kind: "preconnect", reference: href };
  return undefined;
}

/** What a stylesheet loads: its imports as styles, the sources of its font faces as fonts, other urls as files. */
function cssLoads(css: string): Load[] {
  const loads: Load[] = [];
  const pattern =
    /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)|@font-face\s*\{([^}]*)\}|url\(\s*["']?([^"')\s]+)["']?\s*\)/gi;
  for (const match of css.matchAll(pattern)) {
    if (match[1] !== undefined) loads.push({ kind: "style", reference: match[1] });
    else if (match[2] !== undefined) {
      for (const source of match[2].matchAll(/url\(\s*["']?([^"')\s]+)/gi))
        loads.push({ kind: "font", reference: source[1] ?? "" });
    } else if (match[3] !== undefined) loads.push({ kind: "file", reference: match[3] });
  }
  return loads;
}

/** What a page loads, in its order: its scripts, its links' loads and what its own `<style>` blocks load. */
function pageLoads(html: string): Load[] {
  const loads: Load[] = [];
  for (const match of markup(html).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>|<[a-z][^>]*>/gi)) {
    const tag = match[0];
    if (match[1] !== undefined) loads.push(...cssLoads(match[1]));
    else if (/^<script\b/i.test(tag)) {
      const src = attributeOf(tag, "src");
      if (src !== undefined) loads.push({ kind: "script", reference: src });
    } else if (/^<link\b/i.test(tag)) {
      const load = linkLoad(tag);
      if (load !== undefined) loads.push(load);
    }
  }
  return loads;
}

/**
 * The scripts, styles and fonts the site would load from another host (ADR 0064, 5: the site loads nothing from
 * another host), from its pages and its stylesheets. Each as `<page or stylesheet>: <kind> from <host>`, pages
 * sorted then stylesheets sorted, loads in their order. `data:` and the site's own URLs (lookover.dev and
 * www.lookover.dev, by http or https) are not loads from elsewhere.
 */
export function foreignLoads(dist: string): string[] {
  const foreign = (where: string, loads: Load[]): string[] =>
    loads.flatMap(({ kind, reference }) => {
      const url = urlOf(reference, `${ORIGIN}${where}`);
      const elsewhere = url !== undefined && /^https?:$/.test(url.protocol) && !isSite(url);
      return elsewhere
        ? [`${where}: ${kind === "preconnect" ? "preconnect to" : `${kind} from`} ${url.host}`]
        : [];
    });
  return [
    ...pageFiles(dist).flatMap((file) =>
      foreign(pageOf(file), pageLoads(readFileSync(join(dist, file), "utf8"))),
    ),
    ...filesOf(dist, ".css").flatMap((file) =>
      foreign(`/${file}`, cssLoads(readFileSync(join(dist, file), "utf8"))),
    ),
  ];
}
