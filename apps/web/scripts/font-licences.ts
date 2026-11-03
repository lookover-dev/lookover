// The licences of the faces the web app bundles, as files of its build (design-system.md "Device code"): every
// `@fontsource` package the app depends on gives its `LICENSE` (the OFL, with the face's copyright), put under
// `fonts/` beside the app's files, so the faces the program serves and carries go with their licence. Read by
// `vite.config.ts`; plain Node, as Vite runs it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** A file of the build: its path in it and what it holds. */
interface BuildFile {
  fileName: string;
  source: string;
}

const FACE = /^@fontsource(?:-variable)?\/(.+)$/;

/** The licence of each face the web app at `web` depends on, by the face's name: `fonts/<face>-LICENSE.txt`. */
export function fontLicences(web: string): BuildFile[] {
  const manifest: { dependencies?: Record<string, string> } = JSON.parse(
    readFileSync(join(web, "package.json"), "utf8"),
  );
  const resolve = createRequire(join(web, "package.json")).resolve;
  return Object.keys(manifest.dependencies ?? {}).flatMap((name) => {
    const face = FACE.exec(name)?.[1];
    if (face === undefined) return [];
    const folder = dirname(resolve(`${name}/index.css`));
    return [{ fileName: `fonts/${face}-LICENSE.txt`, source: readFileSync(join(folder, "LICENSE"), "utf8") }];
  });
}
