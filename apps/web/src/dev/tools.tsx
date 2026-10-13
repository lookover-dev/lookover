// The developer's tools each mode mounts (ADR 0046, ADR 0054). `main.tsx` loads this module only in a build that is
// not the program's, so the drawer and the demo client stay out of the program's bundle.
import type { DevTools } from "../app.tsx";
import { type DemoApi, DemoFeed } from "./demo-api.ts";
import { Drawer, devRoutes } from "./drawer.tsx";
import type { WebMode } from "./mode.ts";

/**
 * The developer's tools a mode mounts: the drawer and the demo's pages in demo mode, on one listing of the demo
 * whose clock also paces the running times (ADR 0058), drawer or not (the phone preview has none); the drawer
 * alone in live mode (its demo verbs answer 501 there); nothing in the program.
 */
export function devTools(mode: WebMode, demo: DemoApi): DevTools | null {
  switch (mode) {
    case "demo": {
      const feed = new DemoFeed(() => demo.listing());
      return { routes: devRoutes(demo, feed), drawer: <Drawer api={demo} feed={feed} />, pace: feed };
    }
    case "live":
      return { routes: null, drawer: <Drawer api={demo} feed={null} /> };
    case "program":
      return null;
    default:
      return mode satisfies never;
  }
}
