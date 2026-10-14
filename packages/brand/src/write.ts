// `@lookover/brand/write`, for `bun run brand`: writes every copy of the eyes from the source (the brand files in
// docs/product/brand/, the brand sheet's regions, the app's and the site's copies; those under docs/ only where
// docs/ exists), then names each one.
import { writeCopies } from "./copies.ts";

if (import.meta.main) {
  for (const path of writeCopies()) console.log(`Wrote ${path}.`);
}
