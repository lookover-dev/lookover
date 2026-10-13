// The built web app, served beside the API (ADR 0054). Where its files come from is a port (`WebFiles`): a folder on
// disk from a clone (`diskWebFiles`, `apps/web/dist`), the files inside the compiled binary in the program. What is
// answered is decided here, whatever the source: a file by its path; `index.html` for any other path, so a deep link
// reaches the app's router; under `/api/` never a file, only the API; a path that can't be decoded, or names no
// file, is not found; under `/assets/` a missing file is not found, never the page (a tab from before an upgrade
// asks for a script that is gone). `index.html` and the other unhashed files are never cached, the hashed assets
// cached for good. Every answer goes through Hono's context, so the security headers the API's middleware sets are
// kept (a raw `Response` loses them). The files are no secret: they need no session, only the app's host.
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { API } from "@lookover/contracts";
import type { Env, Hono } from "hono";

/**
 * Where the built web app's files come from (ADR 0054): `apps/web/dist` from a clone, the files inside the compiled
 * binary. A file by its path under the app's root (`index.html`, `assets/<hash>.js`); null when there is none.
 */
export interface WebFiles {
  file(path: string): Promise<Blob | null>;
}

/** The app's files in `root`, a built app's folder: none outside it, and a folder is no file. */
export function diskWebFiles(root: string): WebFiles {
  const base = resolve(root);
  return {
    file: async (path) => {
      const full = resolve(base, path);
      if (!full.startsWith(`${base}${sep}`)) return null;
      const stat = statSync(full, { throwIfNoEntry: false });
      return stat?.isFile() ? Bun.file(full) : null;
    },
  };
}

/**
 * The app's files the compiled binary carries (`bun run build`, ADR 0054): `carried` maps each file's path in the
 * built app to where the binary keeps it (an embedded file's path, which `Bun.file` reads); a path it doesn't map
 * names no file.
 */
export function carriedWebFiles(carried: ReadonlyMap<string, string>): WebFiles {
  return {
    file: async (path) => {
      const kept = carried.get(path);
      return kept === undefined ? null : Bun.file(kept);
    },
  };
}

/**
 * The API's root, `/api`: the contract's prefix (`/api/v1`) without its version. Broader than the prefix on purpose:
 * no path under `/api`, another version's or a mistyped one, ever gets the app's page in place of an API's answer.
 */
const API_ROOT = API.prefix.slice(0, API.prefix.lastIndexOf("/"));

const INDEX = "index.html";
/** Where the build puts the files it names by their content's hash. */
const ASSETS = "assets/";
const NEVER_CACHED = "no-cache";
const CACHED_FOR_GOOD = "public, max-age=31536000, immutable";

/** The path under the app's root a request asks for, decoded; null when it can't be decoded or names no file. */
function pathOf(requested: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  // No file's name has a NUL in it, and the file system throws on one.
  return decoded.includes("\0") ? null : decoded.replace(/^\/+/, "");
}

/** What a request for `requested` is answered with: a file and how it is cached, or nothing to serve. */
async function lookUp(files: WebFiles, requested: string): Promise<{ file: Blob; cache: string } | null> {
  if (requested === API_ROOT || requested.startsWith(`${API_ROOT}/`)) return null;
  const path = pathOf(requested);
  if (path === null) return null;
  const file = path === "" ? null : await files.file(path);
  const asset = path.startsWith(ASSETS);
  if (file !== null) return { file, cache: asset ? CACHED_FOR_GOOD : NEVER_CACHED };
  if (asset) return null;
  const index = await files.file(INDEX);
  return index === null ? null : { file: index, cache: NEVER_CACHED };
}

/** Mounts the app's files on `app`, after every API route: what no route answered. */
export function serveWebFiles<E extends Env>(app: Hono<E>, files: WebFiles): void {
  app.get("*", async (c) => {
    const found = await lookUp(files, c.req.path);
    if (found === null) return c.json({ error: "not found" }, 404);
    c.header("Cache-Control", found.cache);
    c.header("Content-Type", found.file.type || "application/octet-stream");
    return c.body(found.file.stream());
  });
}
